// tsv2md.js — convert TSV/CSV into markdown tables with alignment inference and width control.
// Copyright (c) 2026 0xnothings
// @tool tsv2md
// @desc Convert TSV/CSV/PSV data into GitHub-flavoured markdown tables with inferred alignment and column widths
// @usage node tools/tsv2md.js data.tsv --align --max-width 40 --json
// @tags data,markdown,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `tsv2md — delimited data to markdown table

  node tools/tsv2md.js <data.tsv|data.csv|-> [options]

  --delim <c>       delimiter: auto (default), tab, comma, pipe, semicolon
  --header          force the first row to be a header (default when detected)
  --no-header       treat every row as data and synthesise column names
  --align           infer :--- / :---: / ---: alignment per column
  --rotate          transpose the table before rendering
  --max-width <n>   truncate cells longer than n characters (default 60)
  --max-rows <n>    emit at most n data rows (default 0 = all)
  --skip <n>        skip the first n lines (banners, metadata)
  --select <list>   keep only these columns (name or 1-based index)
  --number          right-align columns that are fully numeric
  --escape          escape | and newlines inside cells (default on)
  --json            machine-readable output
  -h, --help        this text

  Quoting follows RFC4180 for CSV ("" escapes, embedded delimiters and newlines).
  Header detection compares the first row's types against the rest: a row of all
  non-numeric values over predominantly numeric data is treated as a header.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['align', 'escape', 'header', 'json', 'no-header', 'number', 'rotate']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/tsv2md.js data.tsv');
let text;
try { text = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
if (!text.trim()) die('input is empty');

const delimArg = String(get(o, 'delim', 'auto')).toLowerCase();
const DELIMS = { tab: '\t', comma: ',', pipe: '|', semicolon: ';', '\t': '\t', ',': ',', '|': '|', ';': ';' };

function detectDelim(t) {
  const lines = t.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (!lines.length) return '\t';
  const cands = ['\t', ',', ';', '|'];
  let best = '\t', bestScore = -1;
  for (const d of cands) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts), max = Math.max(...counts);
    const score = min > 0 && min === max ? min * 10 : min > 0 ? min : -1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const delim = delimArg === 'auto' ? detectDelim(text) : (DELIMS[delimArg] || delimArg);

function parseDelimited(t, d) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { q = true; continue; }
    if (c === d) { row.push(cell); cell = ''; continue; }
    if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim() !== '');
}

const skip = num(get(o, 'skip', 0), 0);
let rows = parseDelimited(text, delim);
if (skip) rows = rows.slice(skip);
if (!rows.length) die('no data rows parsed — check --delim');

const looksNumeric = (v) => v !== '' && v !== null && v !== undefined && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(String(v).trim().replace(/,/g, ''));
let hasHeader;
if (flag(o, 'header')) hasHeader = true;
else if (flag(o, 'no-header')) hasHeader = false;
else {
  const first = rows[0], rest = rows.slice(1);
  const firstNumeric = first.filter(looksNumeric).length;
  const restNumeric = rest.flat().filter(looksNumeric).length / Math.max(1, rest.flat().length);
  const allUnique = new Set(first).size === first.length;
  const noEmpty = first.every((c) => c.trim() !== '');
  hasHeader = firstNumeric === 0 && noEmpty && allUnique && restNumeric > 0.3;
}

let headers = hasHeader ? rows[0].map((h) => h.trim() || '(unnamed)') : rows[0].map((_, i) => `col${i + 1}`);
let data = (hasHeader ? rows.slice(1) : rows).map((r) => headers.map((_, i) => (r[i] === undefined ? '' : String(r[i]))));

if (flag(o, 'rotate')) {
  const transposed = [headers, ...data];
  const newRows = transposed[0].map((_, ci) => transposed.map((r) => r[ci] ?? ''));
  headers = newRows[0];
  data = newRows.slice(1);
}

const selectArg = get(o, 'select', null);
if (selectArg !== null) {
  const want = String(selectArg).split(',').map((s) => s.trim());
  const idx = want.map((w) => (/^\d+$/.test(w) ? Number(w) - 1 : headers.indexOf(w))).filter((i) => i >= 0 && i < headers.length);
  if (!idx.length) die(`--select matched no columns (available: ${headers.join(', ')})`);
  headers = idx.map((i) => headers[i]);
  data = data.map((r) => idx.map((i) => r[i]));
}

const maxWidth = num(get(o, 'max-width', 60), 60);
const maxRows = num(get(o, 'max-rows', 0), 0);
const truncate = (s) => (maxWidth > 0 && s.length > maxWidth ? s.slice(0, Math.max(1, maxWidth - 1)) + '…' : s);
const escCell = (s) => (flag(o, 'escape') ? s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') : s);

const shown = maxRows > 0 ? data.slice(0, maxRows) : data;

const alignment = headers.map((_, ci) => {
  const col = shown.map((r) => r[ci]);
  const allNum = col.length > 0 && col.every((c) => looksNumeric(c) || c === '');
  if (flag(o, 'align')) return allNum ? 'right' : 'left';
  if (flag(o, 'number')) return allNum ? 'right' : 'left';
  return 'left';
});

const widths = headers.map((h, i) => Math.max(h.length, ...shown.map((r) => truncate(r[i]).length), 3));
const pad = (s, w, a) => (a === 'right' ? String(s).padStart(w) : String(s).padEnd(w));

const md = [];
md.push('| ' + headers.map((h, i) => pad(h, widths[i], alignment[i])).join(' | ') + ' |');
md.push('| ' + headers.map((_, i) => {
  const w = widths[i];
  if (alignment[i] === 'right') return '-'.repeat(Math.max(3, w - 1)) + ':';
  if (alignment[i] === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
  return ':' + '-'.repeat(Math.max(2, w - 1));
}).join(' | ') + ' |');
for (const r of shown) md.push('| ' + r.map((c, i) => pad(escCell(truncate(c)), widths[i], alignment[i])).join(' | ') + ' |');

const markdown = md.join('\n') + '\n';

const report = {
  input: src, delimiter: delim === '\t' ? 'TAB' : delim, skippedLines: skip,
  headerDetected: hasHeader, columns: headers.length, dataRows: data.length, emittedRows: shown.length,
  truncatedCells: shown.flat().filter((c) => c.length > maxWidth).length,
  alignment: Object.fromEntries(headers.map((h, i) => [h, alignment[i]])),
  columnTypes: Object.fromEntries(headers.map((h, i) => [h, shown.every((r) => looksNumeric(r[i]) || r[i] === '') ? 'numeric' : 'text'])),
  markdown,
};

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — delimiter ${report.delimiter}, ${headers.length} column(s), ${data.length} row(s) (header ${hasHeader ? 'detected' : 'absent'})`);
  console.log(table(headers.map((h, i) => ({ column: h, align: alignment[i], type: report.columnTypes[h], width: widths[i] })), ['column', 'align', 'type', 'width']));
  console.log('');
  process.stdout.write(markdown);
  if (maxRows > 0 && data.length > maxRows) console.log(`\n... ${data.length - maxRows} more row(s) omitted by --max-rows`);
}
