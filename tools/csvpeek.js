#!/usr/bin/env node
// csvpeek.js — sniff delimiter, headers, column types and a sample from CSV/TSV.
// Copyright (c) 2026 0xnothings
// @tool csvpeek
// @desc Sniff delimiter, headers, column types, uniqueness and a sample from a CSV/TSV file
// @usage node tools/csvpeek.js data.csv --rows 5
// @tags data,csv,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const HELP = `csvpeek — CSV/TSV sniff and preview

  node tools/csvpeek.js <file|-> [options]

  --delim <c>     force a delimiter (default: sniffed from , \\t ; |)
  --no-header     treat the first row as data
  --rows <n>      sample rows to show (default 5)
  --json          machine-readable output
  -h, --help      this text

  Column types are inferred as integer | float | bool | date | string | empty.
  RFC4180 quoting ("a,b" and "" escapes) is honoured.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a file path or pipe CSV on stdin');

function parseCSV(text, delim) {
  const rows = [];
  let row = [], cur = '', quoted = false, sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
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
  const line = (text.split(/\r?\n/).find((l) => l.trim()) || '');
  const cands = [',', '\t', ';', '|'];
  let best = ',', bestN = -1;
  for (const c of cands) {
    let n = 0, q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === c && !q) n++; }
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/;
const BOOL_RE = /^(true|false|yes|no|y|n|t|f|0|1)$/i;
const DATE_RE = /^(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/;

function inferType(values) {
  let int = 0, flo = 0, bool = 0, date = 0, str = 0, empty = 0;
  for (const raw of values) {
    const v = raw.trim();
    if (v === '') { empty++; continue; }
    if (INT_RE.test(v)) { int++; continue; }
    if (FLOAT_RE.test(v)) { flo++; continue; }
    if (DATE_RE.test(v)) { date++; continue; }
    if (BOOL_RE.test(v) && v.length <= 5) { bool++; continue; }
    str++;
  }
  const tally = [['integer', int], ['float', flo], ['date', date], ['bool', bool], ['string', str]]
    .filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
  if (!tally.length) return 'empty';
  if (tally.length > 1 && tally[1][1] > 0 && tally[0][0] === 'string') return 'mixed';
  return tally[0][0];
}

const text = await readInput(src);
if (!text) die('empty input');
const sniffed = get(o, 'delim', null);
const delim = sniffed ? (sniffed === '\\t' ? '\t' : sniffed) : sniffDelim(text);
const rows = parseCSV(text, delim);
if (!rows.length) die('no rows parsed');

const hasHeader = !flag(o, 'no-header');
const header = hasHeader ? rows[0].map((h, i) => h.trim() || `col${i + 1}`) : rows[0].map((_, i) => `col${i + 1}`);
const body = hasHeader ? rows.slice(1) : rows;
const sampleN = num(get(o, 'rows', 5), 5);
const ragged = body.filter((r) => r.length !== header.length).length;

const cols = header.map((h, idx) => {
  const vals = body.map((r) => (r[idx] === undefined ? '' : r[idx]));
  const nonEmpty = vals.filter((v) => v.trim() !== '');
  const uniq = new Set(nonEmpty).size;
  const lens = nonEmpty.map((v) => v.length);
  return {
    column: h,
    position: idx + 1,
    type: inferType(vals),
    empty: vals.length - nonEmpty.length,
    unique: uniq,
    minLen: lens.length ? Math.min(...lens) : 0,
    maxLen: lens.length ? Math.max(...lens) : 0,
    sample: nonEmpty[0] ?? '',
  };
});

const delimName = delim === '\t' ? 'tab' : delim === ',' ? 'comma' : delim === ';' ? 'semicolon' : delim;

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    file: src && src !== '-' ? src : '<stdin>',
    delimiter: delim === '\t' ? 'tab' : delim,
    header: hasHeader,
    columns: header.length,
    rows: body.length,
    raggedRows: ragged,
    schema: cols,
    sample: body.slice(0, sampleN).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))),
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`file       ${src && src !== '-' ? src : '<stdin>'}`);
  out.push(`delimiter  ${delimName === 'tab' ? 'tab (\\t)' : JSON.stringify(delimName)}`);
  out.push(`header     ${hasHeader ? 'yes' : 'no (generated col1..colN)'}`);
  out.push(`rows       ${body.length}`);
  out.push(`columns    ${header.length}`);
  if (ragged) out.push(`ragged     ${ragged} row(s) with wrong field count`);
  out.push('');
  out.push('COLUMNS');
  out.push(table(cols.map((c) => ({
    '#': c.position, column: c.column, type: c.type,
    empty: c.empty, unique: c.unique, len: `${c.minLen}-${c.maxLen}`, sample: c.sample.slice(0, 24),
  }))));
  out.push('');
  out.push(`SAMPLE (${Math.min(sampleN, body.length)} of ${body.length})`);
  out.push(table(body.slice(0, sampleN).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))));
  process.stdout.write(out.join('\n') + '\n');
}
