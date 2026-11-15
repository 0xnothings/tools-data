#!/usr/bin/env node
// csvjson.js — convert CSV to JSON and JSON to CSV with correct quoting.
// Copyright (c) 2026 0xnothings
// @tool csvjson
// @desc Convert between CSV and JSON in either direction with RFC4180 quoting
// @usage node tools/csvjson.js data.csv --to json --typed
// @tags data,csv,json,convert,cli
import { args, get, flag, die, readInput } from '../_lib.js';

const HELP = `csvjson — CSV <-> JSON converter

  node tools/csvjson.js <file|-> [options]

  --to <fmt>        json | ndjson | csv   (default: the opposite of the input)
  --delim <c>       CSV delimiter ('tab' also accepted, default sniffed)
  --typed           coerce numbers/booleans/null when reading CSV
  --no-header       CSV has no header row (columns become col1..colN)
  --key <col,..>    JSON -> CSV: restrict/reorder the output columns
  --flatten         JSON -> CSV: flatten nested objects into dotted columns
  --arrays <mode>   JSON -> CSV: json | join | length | first (default json)
  --pretty          pretty-print JSON output
  --json            machine-readable envelope (stats + payload together)
  -h, --help        this text

  The input format is detected from content (leading { or [ = JSON, else CSV),
  so a .txt holding CSV still works. --to only chooses the output format.

  Examples:
    node tools/csvjson.js data.csv --to json --typed
    node tools/csvjson.js api.json --to csv --flatten
    cat events.ndjson | node tools/csvjson.js - --to csv`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a file or pipe on stdin');
const raw = await readInput(src);
if (!raw.trim()) die('empty input');

function parseCSV(text, delim) {
  const rows = [];
  let row = [], cur = '', quoted = false, sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; sawAny = true; continue; }
    if (c === delim) { row.push(cur); cur = ''; sawAny = true; continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; sawAny = false; continue; }
    if (c === '\r') continue;
    cur += c; sawAny = true;
  }
  if (sawAny || cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function sniffDelim(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  let best = ',', bestN = -1;
  for (const c of [',', '\t', ';', '|']) {
    let n = 0, q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === c && !q) n++; }
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

const coerce = (v) => {
  const t = v.trim();
  if (t === '') return v;
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (/^null$/i.test(t)) return null;
  if (/^[+-]?\d+$/.test(t) && t.replace(/^[+-]/, '').length < 16) return Number(t);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return v;
};

const delimOpt = get(o, 'delim', null);
const delim = delimOpt ? (delimOpt === 'tab' || delimOpt === '\\t' ? '\t' : String(delimOpt)) : sniffDelim(raw);

const escCSV = (v, d = ',') => {
  const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.includes(d) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const trimmed = raw.trimStart();
const inputKind = /^[\[{]/.test(trimmed) ? 'json' : 'csv';
const toOpt = get(o, 'to', null);
const outKind = toOpt ? String(toOpt).toLowerCase() : (inputKind === 'json' ? 'csv' : 'json');
if (!['json', 'ndjson', 'csv'].includes(outKind)) die(`--to must be json | ndjson | csv (got ${outKind})`);

if (inputKind === 'csv' && outKind === 'csv') die('input already looks like CSV and --to csv would be a no-op — did you mean --to json?');
if (inputKind === 'json' && outKind === 'json') die('input already looks like JSON and --to json would be a no-op — did you mean --to csv?');

let records, stats;

if (inputKind === 'csv') {
  const grid = parseCSV(raw.replace(/^\uFEFF/, ''), delim);
  if (!grid.length) die('no rows parsed from the CSV input');
  const hasHeader = !flag(o, 'no-header');
  const header = hasHeader ? grid[0].map((h, i) => h.trim() || `col${i + 1}`) : grid[0].map((_, i) => `col${i + 1}`);
  const body = hasHeader ? grid.slice(1) : grid;
  const typed = flag(o, 'typed');
  records = body.map((r) => {
    const rec = {};
    header.forEach((h, i) => { const v = r[i] ?? ''; rec[h] = typed ? coerce(v) : v; });
    return rec;
  });
  stats = {
    direction: 'csv->' + outKind, input: 'csv',
    delimiter: delim === '\t' ? 'tab' : delim,
    header: hasHeader, columns: header.length, rows: records.length, typed,
  };
} else {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    // NDJSON fallback: parse line by line.
    const ls = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const recs = [];
    let badLine = null;
    for (const line of ls) {
      try { recs.push(JSON.parse(line)); } catch (le) { badLine = le; recs.length = 0; break; }
    }
    if (!recs.length) die(`invalid JSON: ${badLine ? badLine.message : e.message}`);
    doc = recs;
  }
  const rows = Array.isArray(doc) ? doc : [doc];
  const arrMode = String(get(o, 'arrays', 'json'));
  const flatFn = flag(o, 'flatten') || (outKind === 'csv' && rows.some((r) => r && typeof r === 'object' && Object.values(r).some((v) => v && typeof v === 'object')));
  records = rows.map((r) => {
    if (!flatFn || r === null || typeof r !== 'object' || Array.isArray(r)) return r;
    const out = {};
    const rec = (node, prefix) => {
      if (node === null || typeof node !== 'object') { out[prefix || 'value'] = node; return; }
      if (Array.isArray(node)) {
        if (arrMode === 'length') out[prefix] = node.length;
        else if (arrMode === 'join') out[prefix] = node.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',');
        else if (arrMode === 'first') out[prefix] = node.length ? (node[0] && typeof node[0] === 'object' ? JSON.stringify(node[0]) : node[0]) : '';
        else out[prefix] = JSON.stringify(node);
        return;
      }
      for (const [k, v] of Object.entries(node)) rec(v, prefix ? `${prefix}.${k}` : k);
    };
    rec(r, '');
    return out;
  });
  stats = { direction: 'json->' + outKind, input: 'json', rows: records.length, flattened: flatFn, arrayMode: arrMode };
}

if (outKind === 'json') {
  const payload = flag(o, 'pretty') || true ? JSON.stringify(records, null, 2) : JSON.stringify(records);
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ stats: { ...stats, direction: 'csv->json' }, rows: records }, null, 2) + '\n');
  else process.stdout.write(payload + '\n');
} else if (outKind === 'ndjson') {
  const payload = records.map((r) => JSON.stringify(r)).join('\n');
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ stats, ndjson: payload }, null, 2) + '\n');
  else process.stdout.write(payload + '\n');
} else {
  const colSet = new Set();
  const forced = get(o, 'key', null);
  if (forced) String(forced).split(',').map((s) => s.trim()).filter(Boolean).forEach((c) => colSet.add(c));
  else for (const r of records) if (r && typeof r === 'object' && !Array.isArray(r)) for (const k of Object.keys(r)) colSet.add(k);
  const cols = [...colSet];
  if (!cols.length) die('nothing tabular to emit — JSON is not an object or array of objects');
  const d = delimOpt ? delim : ',';
  const body = [cols.map((c) => escCSV(c, d)).join(d), ...records.map((r) => cols.map((c) => escCSV(r && typeof r === 'object' ? r[c] : undefined, d)).join(d))].join('\n');
  stats.columns = cols.length;
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ stats, columns: cols, csv: body }, null, 2) + '\n');
  else process.stdout.write(body + '\n');
}
