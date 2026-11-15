// csvsample.js — reservoir sampling of N rows from a huge CSV in one pass.
// Copyright (c) 2026 0xnothings
// @tool csvsample
// @desc Single-pass reservoir/head/systematic sampling of a huge CSV with O(1) memory
// @usage node tools/csvsample.js huge.csv --n 100 --seed 42 --json
// @tags data,csv,sampling,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { openSync, readSync, closeSync, statSync, writeSync } from 'node:fs';

const HELP = `csvsample — sample rows from a huge CSV in one pass

  node tools/csvsample.js <file> [options]

  -n <count>        rows to sample (default 10)
  --mode <m>        reservoir (default) | head | systematic | random-key
  --seed <n>        deterministic RNG seed (default: random)
  --header          also emit the header row (default: on unless --no-header)
  --no-header       input has no header row
  --check-header    verify every row has the header's field count, report ragged rows
  --rate <f>        for --mode systematic, keep every k-th row computed from -n
  --csv             emit CSV (default)
  --json            machine-readable output
  --stats           only print row-count and size stats, no rows
  -h, --help        this text

  Reservoir sampling keeps a uniform random sample with memory proportional only
  to -n, never to the file size. The whole file is still read once (streaming).`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const file = o._[0];
if (!file) die('need a CSV file — node tools/csvsample.js huge.csv -n 100');

let size;
try { size = statSync(file).size; } catch (e) { die(`cannot stat ${file}: ${e.message}`); }

const want = num(get(o, 'n', 10), 10);
if (want < 0 || want > 10_000_000) die('-n must be between 0 and 10000000');
const mode = String(get(o, 'mode', 'reservoir'));
const seedOpt = get(o, 'seed', null);
const seed = seedOpt !== null ? (Number.isFinite(Number(seedOpt)) ? Number(seedOpt) >>> 0 : hash32(String(seedOpt))) : (Date.now() ^ 0x9e3779b9) >>> 0;
const checkHeader = flag(o, 'check-header');
const headerOut = !flag(o, 'no-header');

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
let rngState = seed || 1;
function rnd() {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5; rngState >>>= 0;
  return rngState / 4294967296;
}

/* ---- streaming CSV row reader (handles quotes spanning buffer boundaries) ---- */
const READ = 1 << 20;
const fd = openSync(file, 'r');
const raw = Buffer.allocUnsafe(READ);
let carry = '';
let eof = false;

function* csvRows() {
  let field = '', row = [], inQuotes = false, quotePending = false;
  for (;;) {
    const n = eof ? 0 : readSync(fd, raw, 0, READ, null);
    if (n <= 0) eof = true;
    const text = carry + (n > 0 ? raw.subarray(0, n).toString('utf8') : '');
    carry = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (quotePending) {
        quotePending = false;
        if (c === '"') { field += '"'; i++; continue; }
      }
      if (inQuotes) {
        if (c === '"') { quotePending = true; i++; continue; }
        field += c; i++;
        continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n') {
        row.push(field); field = '';
        yield row; row = [];
        i++;
        continue;
      }
      if (c === '\r') { i++; continue; }
      field += c; i++;
    }
    if (n <= 0) break;
  }
  if (field.length || row.length) { row.push(field); yield row; }
  if (!eof) { eof = true; }
}

const headerRow = [];
const reservoir = [];
const headRows = [];
const systematicRows = [];
const randomKey = [];
let rowIndex = 0;
let dataRows = 0;
let raggedRows = 0;
let maxFields = 0;
let minFields = Infinity;
let sampledAny = false;

const systematicEvery = (() => {
  const explicit = get(o, 'rate', null);
  if (explicit !== null) return Math.max(1, Math.round(1 / num(explicit, 1)));
  return 0;
})();

for (const row of csvRows()) {
  if (rowIndex === 0) {
    headerRow.push(...row);
    rowIndex++;
    sampledAny = true;
    continue;
  }
  const isEmpty = row.length === 1 && row[0] === '';
  if (isEmpty) continue;
  dataRows++;
  const idx = dataRows;
  maxFields = Math.max(maxFields, row.length);
  minFields = Math.min(minFields, row.length);
  if (checkHeader && headerRow.length && row.length !== headerRow.length) raggedRows++;

  if (mode === 'head') {
    if (headRows.length < want) headRows.push(row);
  } else if (mode === 'reservoir') {
    if (reservoir.length < want) reservoir.push(row);
    else {
      const j = Math.floor(rnd() * idx);
      if (j < want) reservoir[j] = row;
    }
  } else if (mode === 'random-key') {
    randomKey.push([rnd(), row]);
    if (randomKey.length > want * 4) {
      randomKey.sort((a, b) => a[0] - b[0]);
      randomKey.length = want;
    }
  } else if (mode === 'systematic') {
    const stride = systematicEvery || Math.max(1, Math.floor(dataRows / Math.max(1, want)));
    if (systematicEvery) {
      if (idx % stride === 0) systematicRows.push(row);
    } else {
      if ((idx - 1) % stride === 0 && systematicRows.length < want) systematicRows.push(row);
    }
  } else die(`--mode must be reservoir | head | systematic | random-key (got ${mode})`);
}
closeSync(fd);

if (!sampledAny) die('file is empty');

let sample;
if (mode === 'head') sample = headRows;
else if (mode === 'reservoir') sample = reservoir;
else if (mode === 'systematic') sample = systematicRows;
else {
  randomKey.sort((a, b) => a[0] - b[0]);
  sample = randomKey.slice(0, want).map((x) => x[1]);
}
if (mode === 'systematic' || flag(o, 'sort')) sample.sort((a, b) => String(a.join('\u0001')).localeCompare(String(b.join('\u0001'))));

const stats = {
  file, bytes: size,
  mode,
  seed,
  headerRow: headerOut ? headerRow : undefined,
  dataRows,
  columns: headerRow.length,
  fieldRange: Number.isFinite(minFields) ? `${minFields}-${maxFields}` : '0',
  raggedRows: checkHeader ? raggedRows : undefined,
  requested: want,
  sampled: sample.length,
  coveragePercent: dataRows ? Number(((sample.length / dataRows) * 100).toFixed(4)) : 0,
};

const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvOut = [headerOut && headerRow.length ? headerRow.map(esc).join(',') : null, ...sample.map((r) => r.map(esc).join(','))].filter((x) => x !== null).join('\n') + '\n';

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ ...stats, rows: sample.map((r) => Object.fromEntries(headerRow.map((h, i) => [h || `col${i + 1}`, r[i] ?? ''])) ) }, null, 2) + '\n');
} else if (flag(o, 'stats')) {
  process.stdout.write(table([{
    bytes: size, dataRows, columns: headerRow.length,
    fieldRange: stats.fieldRange, ragged: stats.raggedRows ?? '', mode, sampled: sample.length,
  }]) + '\n');
} else {
  process.stdout.write(csvOut);
  process.stderr.write(`${mode}: sampled ${sample.length} of ${dataRows} data row(s) from ${size.toLocaleString('en-US')} bytes (seed ${seed})\n`);
}
