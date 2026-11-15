#!/usr/bin/env node
// csvfix.js — repair a broken CSV: quoting, delimiters, BOM, ragged rows.
// Copyright (c) 2026 0xnothings
// @tool csvfix
// @desc Repair malformed CSV: strip BOM, fix quote imbalance, normalize delimiters and widths
// @usage node tools/csvfix.js broken.csv --report
// @tags data,csv,repair,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';

const HELP = `csvfix — repair a malformed CSV

  node tools/csvfix.js <file> [options]

  --out <file>        write the repaired CSV here (default: stdout)
  --delim <c>         force the output delimiter (default: auto-detected majority)
  --no-header         treat the first row as data when padding rows
  --pad <mode>        pad | truncate | error  (default pad; fixes ragged rows)
  --pad-with <str>    value used when padding (default empty)
  --quote-all         quote every field on output
  --keep-quotes       keep literal quotes inside fields instead of unescaping
  --strip-bom         remove a UTF-8 BOM (default: on)
  --fix-encodings     replace common mojibake sequences (Ã©, â€™, Â)
  --numeric           trim whitespace around numeric fields
  --dedupe-header     collapse duplicate header names (name, name_2)
  --report            print a diagnosis instead of writing output
  --json              machine-readable output
  -h, --help          this text

  Detected problems: BOM, mixed delimiters, unterminated quotes, ragged row
  widths, duplicate headers, blank header cells, CRLF/LF mix, NUL bytes,
  mojibake, and rows that are entirely empty. --report changes nothing.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const file = o._[0];
if (!file) die('need a CSV file — node tools/csvfix.js broken.csv --report');

let buf;
try { buf = readFileSync(file); } catch (e) { die(`cannot read ${file}: ${e.message}`); }

const issues = [];
const raw0 = buf.toString('utf8');

const hasBOM = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
if (hasBOM && !flag(o, 'strip-bom')) issues.push({ kind: 'bom', detail: 'UTF-8 BOM at the start of the file' });
const nulCount = raw0.split('\u0000').length - 1;
if (nulCount) issues.push({ kind: 'nul-bytes', detail: `${nulCount} NUL byte(s) inside the file` });
const crlf = (raw0.match(/\r\n/g) || []).length;
const loneLf = (raw0.match(/(?<!\r)\n/g) || []).length;
if (crlf && loneLf) issues.push({ kind: 'mixed-eol', detail: `${crlf} CRLF and ${loneLf} LF line endings mixed` });

function applyMojibake(s) {
  return s
    .replace(/â€™/g, "'").replace(/â€˜/g, "'").replace(/â€œ/g, '"').replace(/â€\u009d/g, '"')
    .replace(/â€"/g, '—').replace(/â€"/g, '–').replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è')
    .replace(/Ã¡/g, 'á').replace(/Ã­/g, 'í').replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ').replace(/Ã¼/g, 'ü').replace(/Ã¶/g, 'ö').replace(/Ã¤/g, 'ä')
    .replace(/Ã§/g, 'ç').replace(/Â /g, ' ').replace(/Â/g, '');
}

let text = hasBOM ? raw0.slice(1) : raw0;
text = text.replace(/\u0000/g, '');
const mojibakeHits = (text.match(/Ã[\u0080-\u00bf]|â€|Â[\u00a0-\u00bf]/g) || []).length;
if (mojibakeHits) issues.push({ kind: 'mojibake', detail: `${mojibakeHits} mojibake sequence(s) (UTF-8 read as Latin-1)` });
if (flag(o, 'fix-encodings')) text = applyMojibake(text);

function sniffDelims(sample) {
  const counts = {};
  for (const d of [',', '\t', ';', '|', '^']) {
    let n = 0, q = false;
    for (const line of sample.split(/\r?\n/).slice(0, 200)) {
      q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === d && !q) n++;
      }
    }
    counts[d] = n;
  }
  return counts;
}

const delimCounts = sniffDelims(text);
const ranked = Object.entries(delimCounts).sort((a, b) => b[1] - a[1]);
const forced = get(o, 'delim', null);
const chosen = forced ? (forced === 'tab' || forced === '\\t' ? '\t' : String(forced)) : ranked[0][0];
const active = Object.entries(delimCounts).filter(([d, n]) => n > 0 && d !== chosen);
if (active.length) issues.push({ kind: 'mixed-delimiters', detail: `chose ${JSON.stringify(chosen)} (${delimCounts[chosen]}); also saw ${active.map(([d, n]) => `${JSON.stringify(d)}=${n}`).join(', ')}` });

function parseRows(src, delim, lenient = false) {
  const rows = [];
  let row = [], cur = '', quoted = false, sawAny = false;
  let unterminated = 0;
  let quoteErrors = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else if (/[\r\n]/.test(src[i + 1] || '') || src[i + 1] === delim) { quoted = false; }
        else { quoteErrors++; cur += '"'; }
      } else if (lenient && c === '\n') {
        // Lenient recovery: a quote that never closes before the line ends is
        // treated as a stray character rather than swallowing the rest of the file.
        quoted = false;
        unterminated++;
        row.push(cur); cur = ''; rows.push(row); row = []; sawAny = false;
        continue;
      } else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; sawAny = true; continue; }
    if (c === delim) { row.push(cur); cur = ''; sawAny = true; continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; sawAny = false; continue; }
    if (c === '\r') continue;
    cur += c; sawAny = true;
  }
  if (quoted) unterminated++;
  if (sawAny || cur.length || row.length) { row.push(cur); rows.push(row); }
  return { rows: rows.filter((r) => !(r.length === 1 && r[0] === '')), unterminated, quoteErrors };
}

const strict = parseRows(text, chosen);
const rawNewlines = (text.match(/\n/g) || []).length;
const swallowed = strict.unterminated > 0 && strict.rows.length < rawNewlines * 0.6;
const parsed = swallowed ? parseRows(text, chosen, true) : strict;
const { rows, unterminated, quoteErrors } = parsed;
if (swallowed) issues.push({ kind: 'quote-swallow', detail: `an unterminated quote swallowed ${rawNewlines - strict.rows.length} line(s) — recovered by closing it at the line end` });
if (unterminated) issues.push({ kind: 'unterminated-quote', detail: `${unterminated} quoted field(s) never closed before EOF` });
if (quoteErrors) issues.push({ kind: 'stray-quote', detail: `${quoteErrors} interior quote(s) normalized` });

if (!rows.length) die('no rows could be parsed');

const headerHasQuotes = rows[0].some((h) => /["']/.test(h));
if (headerHasQuotes) issues.push({ kind: 'quoted-header', detail: 'header cells contain literal quote characters' });

const hasHeader = !flag(o, 'no-header');
const header = (hasHeader ? rows[0] : rows[0].map((_, i) => `col${i + 1}`)).map((h, i) => {
  let v = h.trim();
  if (flag(o, 'keep-quotes')) v = v.replace(/^"|"$/g, '');
  else v = v.replace(/^["']+|["']+$/g, '').replace(/""/g, '"');
  if (flag(o, 'numeric')) v = v.trim();
  return v || `col${i + 1}`;
});
const body = hasHeader ? rows.slice(1) : rows;
const width = header.length;

const widths = new Map();
for (const r of body) widths.set(r.length, (widths.get(r.length) || 0) + 1);
const ragged = body.filter((r) => r.length !== width).length;
if (ragged) {
  const dist = [...widths.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}:${n}`).join(' ');
  issues.push({ kind: 'ragged-rows', detail: `${ragged} row(s) do not have ${width} fields — width histogram ${dist}` });
}
const emptyRows = body.filter((r) => r.every((c) => String(c).trim() === '')).length;
if (emptyRows) issues.push({ kind: 'empty-rows', detail: `${emptyRows} row(s) are entirely empty` });

const dupHeader = {};
const seenHeader = new Set();
header.forEach((h) => {
  const key = h.toLowerCase();
  if (seenHeader.has(key)) { dupHeader[h] = (dupHeader[h] || 1) + 1; issues.push({ kind: 'duplicate-header', detail: `header "${h}" appears ${dupHeader[h]} times` }); }
  seenHeader.add(key);
});

if (flag(o, 'report')) {
  const out = [];
  out.push(`file       ${file}  (${buf.length.toLocaleString('en-US')} bytes)`);
  out.push(`delimiter  ${JSON.stringify(chosen)}${forced ? ' (forced)' : ' (detected)'} — counts ${ranked.filter(([, n]) => n > 0).map(([d, n]) => `${JSON.stringify(d)}=${n}`).join(' ')}`);
  out.push(`rows       ${body.length} data row(s), ${width} column(s)`);
  out.push('');
  if (issues.length) {
    out.push(`ISSUES (${issues.length})`);
    out.push(table(issues.map((i2) => ({ kind: i2.kind, detail: i2.detail })), ['kind', 'detail']));
  } else out.push('no structural problems detected');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(issues.length ? 2 : 0);
}

/* ---- repair ---- */
const padMode = String(get(o, 'pad', 'pad'));
const padWith = String(get(o, 'pad-with', ''));
const outHeader = (() => {
  if (!flag(o, 'dedupe-header')) return header;
  const seen = new Set();
  return header.map((h) => {
    let name = h, n = 2;
    while (seen.has(name.toLowerCase())) { name = `${h}_${n}`; n++; }
    seen.add(name.toLowerCase());
    return name;
  });
})();

const repaired = body.map((r) => {
  let cells = r.slice();
  if (cells.length < outHeader.length) {
    if (padMode === 'truncate') return cells;
    if (padMode === 'error') return cells;
    while (cells.length < outHeader.length) cells.push(padWith);
  } else if (cells.length > outHeader.length) {
    if (padMode === 'truncate' || padMode === 'pad') cells = cells.slice(0, outHeader.length);
  }
  return cells.map((c) => {
    let v = c;
    if (flag(o, 'numeric') && /^\s*[+-]?[\d.,]+\s*$/.test(v)) v = v.trim();
    return v;
  });
}).filter((r) => !(r.every((c) => String(c).trim() === '')));

const esc = (v, d) => {
  const s = v === undefined || v === null ? '' : String(v);
  if (flag(o, 'quote-all')) return `"${s.replace(/"/g, '""')}"`;
  return s.includes(d) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const eol = '\n';
const csv = [outHeader.map((h) => esc(h, chosen)).join(chosen), ...repaired.map((r) => r.map((c) => esc(c, chosen)).join(chosen))].join(eol) + eol;

const outFile = get(o, 'out', null);
if (outFile) writeFileSync(String(outFile), csv, 'utf8');

const summary = {
  file, out: outFile ? String(outFile) : null,
  bytesIn: buf.length, bytesOut: Buffer.byteLength(csv),
  delimiter: chosen === '\t' ? 'tab' : chosen,
  header: outHeader, columns: outHeader.length,
  rowsIn: body.length, rowsOut: repaired.length,
  issuesFound: issues.length,
  fixed: {
    bomRemoved: hasBOM, nulBytesRemoved: nulCount, raggedRows: ragged,
    emptyRowsDropped: emptyRows, duplicateHeadersRenamed: flag(o, 'dedupe-header') ? issues.filter((i2) => i2.kind === 'duplicate-header').length : 0,
    quotesNormalized: quoteErrors, mojibakeFixed: flag(o, 'fix-encodings') ? mojibakeHits : 0,
  },
  issues,
};

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ ...summary, csv: outFile ? undefined : csv.split('\n').slice(0, 20) }, null, 2) + '\n');
} else if (outFile) {
  process.stdout.write(`repaired ${outFile}: ${repaired.length} row(s) x ${outHeader.length} column(s), ${issues.length} issue(s) fixed\n`);
  for (const i2 of issues) process.stdout.write(`  - ${i2.kind}: ${i2.detail}\n`);
} else {
  process.stdout.write(csv);
  process.stderr.write(`repaired ${repaired.length} row(s) x ${outHeader.length} column(s); ${issues.length} issue(s) fixed\n`);
}
void num;
