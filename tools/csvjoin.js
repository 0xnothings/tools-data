#!/usr/bin/env node
// csvjoin.js — join two CSV files on a key column, report unmatched counts.
// Copyright (c) 2026 0xnothings
// @tool csvjoin
// @desc Inner/left/right/full join of two CSVs on a key column with unmatched counts
// @usage node tools/csvjoin.js left.csv right.csv --on id --how left
// @tags data,csv,cli
import { args, get, flag, die, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `csvjoin — join two CSVs on a key

  node tools/csvjoin.js <left.csv> <right.csv> [options]

  --on <col>          key column present in both files (default: first column)
  --left-on <col>     key column for the left file
  --right-on <col>    key column for the right file
  --how <type>        inner | left | right | full   (default: inner)
  --prefix <p>        prefix for right-side column name clashes (default: right_)
  --delim <c>         input delimiter for both files (default: sniffed per file)
  --vmode <m>         value for missing cells in an outer join (default: empty)
  --json              machine-readable output
  --csv               emit CSV
  --stats             only print join statistics
  -h, --help          this text

  Duplicate keys on either side fan out (cartesian per key), like SQL.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const leftPath = o._[0], rightPath = o._[1];
if (!leftPath || !rightPath) die('need two input files — node tools/csvjoin.js left.csv right.csv --on id');

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
  return { header, rows: grid.slice(1), delim };
}

const forced = get(o, 'delim', null);
const L = load(leftPath, forced);
const R = load(rightPath, forced);
const how = String(get(o, 'how', 'inner')).toLowerCase();
if (!['inner', 'left', 'right', 'full'].includes(how)) die(`--how must be inner|left|right|full (got ${how})`);

const leftKey = String(get(o, 'left-on', get(o, 'on', L.header[0])));
const rightKey = String(get(o, 'right-on', get(o, 'on', R.header[0])));
if (!L.header.includes(leftKey)) die(`left file has no column '${leftKey}' — has: ${L.header.join(', ')}`);
if (!R.header.includes(rightKey)) die(`right file has no column '${rightKey}' — has: ${R.header.join(', ')}`);

const li = L.header.indexOf(leftKey);
const ri = R.header.indexOf(rightKey);
void li; void ri;
const leftRecs = L.rows.map((r) => Object.fromEntries(L.header.map((h, i) => [h, r[i] ?? ''])));
const rightRecs = R.rows.map((r) => Object.fromEntries(R.header.map((h, i) => [h, r[i] ?? ''])));

const prefix = String(get(o, 'prefix', 'right_'));
const vmode = get(o, 'vmode', '');
const rightCols = R.header
  .filter((h) => h !== rightKey || rightKey !== leftKey)
  .map((h) => (L.header.includes(h) && h !== leftKey ? { from: h, to: prefix + h } : { from: h, to: h }));

const index = new Map();
for (const r of rightRecs) {
  const k = String(r[rightKey]);
  if (!index.has(k)) index.set(k, []);
  index.get(k).push(r);
}

const matchedLeft = new Set();
const out = [];
let leftMatched = 0, leftUnmatched = 0, rightMatched = 0, rightUnmatched = 0, dupFanout = 0;

for (const l of leftRecs) {
  const k = String(l[leftKey]);
  const hits = index.get(k);
  if (!hits) {
    leftUnmatched++;
    if (how === 'left' || how === 'full') {
      const rec = { ...l };
      for (const c of rightCols) rec[c.to] = vmode;
      if (!L.header.includes(rightKey)) rec[rightKey] = vmode;
      out.push(rec);
    }
    continue;
  }
  leftMatched++;
  matchedLeft.add(k);
  if (hits.length > 1) dupFanout += hits.length - 1;
  for (const rr of hits) {
    const rec = { ...l };
    for (const c of rightCols) rec[c.to] = rr[c.from] ?? '';
    out.push(rec);
  }
}

const cols = [...L.header, ...rightCols.map((c) => c.to).filter((c) => !L.header.includes(c))];

if (how === 'right' || how === 'full') {
  for (const rr of rightRecs) {
    const k = String(rr[rightKey]);
    if (matchedLeft.has(k)) continue;
    rightUnmatched++;
    const rec = {};
    for (const h of L.header) rec[h] = vmode;
    for (const c of rightCols) rec[c.to] = rr[c.from] ?? '';
    if (!L.header.includes(rightKey)) rec[rightKey] = rr[rightKey] ?? '';
    out.push(rec);
  }
} else {
  for (const rr of rightRecs) if (!matchedLeft.has(String(rr[rightKey]))) rightUnmatched++;
}

const stats = {
  how,
  leftFile: leftPath, rightFile: rightPath,
  leftKey, rightKey,
  leftRows: leftRecs.length, rightRows: rightRecs.length,
  joinedRows: out.length,
  leftMatched, leftUnmatched, rightMatched: leftMatched, rightUnmatched,
  duplicateFanout: dupFanout,
};

if (flag(o, 'stats')) {
  if (flag(o, 'json')) process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  else process.stdout.write(table([stats]) + '\n');
  process.exit(0);
}

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ stats, columns: cols, rows: out }, null, 2) + '\n');
} else if (flag(o, 'csv')) {
  const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  process.stdout.write([cols.map(esc).join(','), ...out.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
} else {
  process.stdout.write(table(out.slice(0, 500), cols) + '\n');
  const s = stats;
  process.stdout.write(`\n${s.how} join on ${s.leftKey}=${s.rightKey}: ${s.leftRows} x ${s.rightRows} -> ${s.joinedRows} rows\n`);
  process.stdout.write(`left matched ${s.leftMatched}, unmatched ${s.leftUnmatched} | right unmatched ${s.rightUnmatched} | dup fanout ${s.duplicateFanout}\n`);
  if (out.length > 500) process.stdout.write(`(display truncated to 500 rows — use --json or --csv for all)\n`);
}
