#!/usr/bin/env node
// csvdiff.js — key-based diff of two CSVs: added, removed, changed rows.
// Copyright (c) 2026 0xnothings
// @tool csvdiff
// @desc Key-based CSV diff reporting added, removed and changed rows field by field
// @usage node tools/csvdiff.js old.csv new.csv --key id
// @tags data,csv,diff,cli
import { args, get, flag, die } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `csvdiff — row-level diff of two CSVs

  node tools/csvdiff.js <old.csv> <new.csv> [options]

  --key <col[,col]>   primary key column(s) (default: first column)
  --delim <c>         input delimiter for both files
  --ignore <col,..>   columns to skip when comparing values
  --limit <n>         max rows to print per section (default 50, 0 = all)
  --json              machine-readable output
  -h, --help          this text

  Exit codes: 0 = identical, 2 = differences found, 1 = error.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const aPath = o._[0], bPath = o._[1];
if (!aPath || !bPath) die('need two files — node tools/csvdiff.js old.csv new.csv --key id');

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

function load(path, forced) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const delim = forced ? (forced === '\\t' ? '\t' : forced) : sniffDelim(text);
  const grid = parseCSV(text, delim);
  if (!grid.length) die(`no rows in ${path}`);
  const header = grid[0].map((h, i) => h.trim() || `col${i + 1}`);
  const rows = grid.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  return { header, rows };
}

const forced = get(o, 'delim', null);
const A = load(aPath, forced);
const B = load(bPath, forced);
const keyCols = String(get(o, 'key', A.header[0])).split(',').map((s) => s.trim()).filter(Boolean);
const ignore = new Set(String(get(o, 'ignore', '')).split(',').map((s) => s.trim()).filter(Boolean));
const limit = Number(get(o, 'limit', 50));

for (const k of keyCols) if (!A.header.includes(k)) die(`old file has no key column '${k}' — has: ${A.header.join(', ')}`);

const allCols = [...new Set([...A.header, ...B.header])];
const cmpCols = allCols.filter((c) => !keyCols.includes(c) && !ignore.has(c));
const keyOf = (r) => keyCols.map((k) => r[k] ?? '').join('\u0001');

const aMap = new Map(A.rows.map((r) => [keyOf(r), r]));
const bMap = new Map(B.rows.map((r) => [keyOf(r), r]));

const added = [], removed = [], changed = [];
for (const [k, rb] of bMap) if (!aMap.has(k)) added.push(rb);
for (const [k, ra] of aMap) if (!bMap.has(k)) removed.push(ra);
for (const [k, ra] of aMap) {
  const rb = bMap.get(k);
  if (!rb) continue;
  const fields = [];
  for (const c of cmpCols) {
    const x = ra[c] ?? '', y = rb[c] ?? '';
    if (x !== y) fields.push({ column: c, from: x, to: y });
  }
  if (fields.length) changed.push({ key: k.split('\u0001').join('|'), keyValues: Object.fromEntries(keyCols.map((c) => [c, rb[c]])), fields });
}

const summary = {
  oldFile: aPath, newFile: bPath, key: keyCols,
  comparedColumns: cmpCols,
  oldRows: A.rows.length, newRows: B.rows.length,
  added: added.length, removed: removed.length, changed: changed.length,
  unchanged: A.rows.length - removed.length - changed.length,
  identical: added.length + removed.length + changed.length === 0,
};

const show = (arr) => (limit > 0 ? arr.slice(0, limit) : arr);
const omitted = (n) => (limit > 0 && n > limit ? `\n  ... ${n - limit} more (use --limit 0)\n` : '');

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ summary, added: show(added), removed: show(removed), changed: show(changed) }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`old ${summary.oldFile}  (${summary.oldRows} rows)`);
  out.push(`new ${summary.newFile}  (${summary.newRows} rows)`);
  out.push(`key ${keyCols.join(', ')}  | compared ${cmpCols.join(', ')}`);
  out.push('');
  out.push(`+ ${added.length} added   - ${removed.length} removed   ~ ${changed.length} changed   = ${summary.unchanged} unchanged`);
  if (added.length) {
    out.push('', `ADDED (${added.length})`);
    for (const r of show(added)) out.push('  + ' + keyOf(r).split('\u0001').join('|') + '  ' + JSON.stringify(r));
    out.push(omitted(added.length).trim());
  }
  if (removed.length) {
    out.push('', `REMOVED (${removed.length})`);
    for (const r of show(removed)) out.push('  - ' + keyOf(r).split('\u0001').join('|') + '  ' + JSON.stringify(r));
    out.push(omitted(removed.length).trim());
  }
  if (changed.length) {
    out.push('', `CHANGED (${changed.length})`);
    for (const c of show(changed)) {
      out.push(`  ~ ${c.key}`);
      for (const f of c.fields) out.push(`      ${f.column}: ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
    }
    out.push(omitted(changed.length).trim());
  }
  if (summary.identical) out.push('', 'files are identical on the compared columns');
  process.stdout.write(out.filter((l) => l !== '').join('\n') + '\n');
}

process.exit(summary.identical ? 0 : 2);
