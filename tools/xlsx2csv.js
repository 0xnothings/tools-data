// xlsx2csv.js — minimal XLSX reader (zip + sharedStrings + sheet) to CSV, no deps.
// Copyright (c) 2026 0xnothings
// @tool xlsx2csv
// @desc Read an .xlsx workbook using a hand-rolled ZIP reader + zlib and emit CSV
// @usage node tools/xlsx2csv.js book.xlsx --sheet 1 --out out.csv
// @tags data,xlsx,csv,convert,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { basename } from 'node:path';

const HELP = `xlsx2csv — .xlsx -> CSV without dependencies

  node tools/xlsx2csv.js <book.xlsx> [options]

  --sheet <n|name>   sheet by 1-based index or by name (default 1)
  --list             list sheets and exit
  --out <file>       write CSV to a file instead of stdout
  --delim <c>        output delimiter (default ',')
  --no-header        treat row 1 as data
  --values           render formulas as their cached values only (default)
  --trim             trim whitespace from every cell
  --empty            keep fully empty rows/columns (default: dropped)
  --json             machine-readable output
  -h, --help         this text

  Implements the OOXML essentials: ZIP central-directory reading, inflateRaw,
  xl/sharedStrings.xml, xl/worksheets/sheetN.xml, inline strings, date serials
  via styles.xml number formats (dates become ISO-8601).`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const path = o._[0];
if (!path) die('need an .xlsx file — node tools/xlsx2csv.js book.xlsx [--sheet 1]');

let buf;
try { buf = readFileSync(path); } catch (e) { die(`cannot read ${path}: ${e.message}`); }

/* ---- ZIP reader ------------------------------------------------------- */
const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;

function findEOCD(b) {
  const back = Math.min(b.length, 66000);
  for (let i = b.length - 22; i >= b.length - back && i >= 0; i--) {
    if (b.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

const eocd = findEOCD(buf);
if (eocd < 0) die('not a zip container (no end-of-central-directory) — is this really an .xlsx?');

let count = buf.readUInt16LE(eocd + 10);
let cdOff = buf.readUInt32LE(eocd + 16);
if (cdOff === 0xffffffff || count === 0xffff) {
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
    const z = Number(buf.readBigUInt64LE(loc + 8));
    if (z + 56 <= buf.length && buf.readUInt32LE(z) === 0x06064b50) {
      count = Number(buf.readBigUInt64LE(z + 32));
      cdOff = Number(buf.readBigUInt64LE(z + 48));
    }
  }
}

const zipEntries = new Map();
let cp = cdOff;
for (let i = 0; i < count; i++) {
  if (cp + 46 > buf.length || buf.readUInt32LE(cp) !== CD_SIG) break;
  const method = buf.readUInt16LE(cp + 10);
  let compSize = buf.readUInt32LE(cp + 20);
  let uncompSize = buf.readUInt32LE(cp + 24);
  const nameLen = buf.readUInt16LE(cp + 28);
  const extraLen = buf.readUInt16LE(cp + 30);
  const cmtLen = buf.readUInt16LE(cp + 32);
  let lfh = buf.readUInt32LE(cp + 42);
  const name = buf.subarray(cp + 46, cp + 46 + nameLen).toString('utf8');
  if (lfh === 0xffffffff || compSize === 0xffffffff) {
    const extra = buf.subarray(cp + 46 + nameLen, cp + 46 + nameLen + extraLen);
    let e = 0;
    while (e + 4 <= extra.length) {
      const hid = extra.readUInt16LE(e), hsz = extra.readUInt16LE(e + 2);
      if (hid === 0x0001) {
        let q = e + 4;
        if (uncompSize === 0xffffffff) q += 8;
        if (compSize === 0xffffffff && q + 8 <= extra.length) { compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (lfh === 0xffffffff && q + 8 <= extra.length) { lfh = Number(extra.readBigUInt64LE(q)); }
      }
      e += 4 + hsz;
    }
  }
  zipEntries.set(name, { method, compSize, lfh, name });
  cp += 46 + nameLen + extraLen + cmtLen;
}

function unzip(name) {
  const e = zipEntries.get(name);
  if (!e) return null;
  if (buf.readUInt32LE(e.lfh) !== LFH_SIG) return null;
  const nl = buf.readUInt16LE(e.lfh + 26);
  const xl = buf.readUInt16LE(e.lfh + 28);
  const start = e.lfh + 30 + nl + xl;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data);
  return null;
}

/* ---- XML helpers ------------------------------------------------------ */
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
const esc = (s) => { const v = s === undefined || s === null ? '' : String(s); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };

function colToIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function serialToISO(serial) {
  // Excel epoch: 1899-12-30 for the 1900 date system (accounting for the leap bug).
  if (!Number.isFinite(serial)) return null;
  const ms = Math.round(serial * 86400000) + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  const frac = serial - Math.floor(serial);
  if (frac === 0) return d.toISOString().slice(0, 10);
  return d.toISOString().replace('.000Z', 'Z');
}

/* ---- shared strings --------------------------------------------------- */
const shared = [];
const ssXml = unzip('xl/sharedStrings.xml');
if (ssXml) {
  const text = ssXml.toString('utf8');
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(text))) {
    const inner = m[1];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t, acc = '';
    while ((t = tRe.exec(inner))) acc += unesc(t[1]);
    shared.push(acc);
  }
}

/* ---- styles (date detection) ----------------------------------------- */
const dateStyles = new Set();
const stXml = unzip('xl/styles.xml');
if (stXml) {
  const st = stXml.toString('utf8');
  const builtinDate = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  const numFmts = new Map();
  const nfRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let nf;
  while ((nf = nfRe.exec(st))) numFmts.set(Number(nf[1]), unesc(nf[2]));
  const cellXfs = st.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (cellXfs) {
    const xfRe = /<xf\b[^>]*numFmtId="(\d+)"/g;
    let xf, idx = 0;
    while ((xf = xfRe.exec(cellXfs[1]))) {
      const id = Number(xf[1]);
      const code = numFmts.get(id);
      const isDate = builtinDate.has(id) || (code ? /(^|[^\\])[ymdhs]/i.test(code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')) && !/^[0#.,%]+$/.test(code) : false);
      if (isDate) dateStyles.add(idx);
      idx++;
    }
  }
}

/* ---- workbook: sheet names ------------------------------------------- */
const sheets = [];
const wbXml = unzip('xl/workbook.xml');
if (wbXml) {
  const wb = wbXml.toString('utf8');
  const re = /<sheet\b[^>]*name="([^"]*)"[^>]*sheetId="(\d+)"[^>]*?(?:r:id="([^"]*)")?[^>]*\/?>/g;
  let m;
  while ((m = re.exec(wb))) sheets.push({ name: unesc(m[1]), sheetId: Number(m[2]), rid: m[3] || '' });
  if (!sheets.length) {
    const re2 = /<sheet\b([^>]*)\/?>/g;
    let m2;
    while ((m2 = re2.exec(wb))) {
      const nm = /name="([^"]*)"/.exec(m2[1]);
      const rid = /r:id="([^"]*)"/.exec(m2[1]);
      if (nm) sheets.push({ name: unesc(nm[1]), sheetId: sheets.length + 1, rid: rid ? rid[1] : '' });
    }
  }
}

/* ---- workbook rels -> sheet paths ------------------------------------ */
const sheetPathByRid = new Map();
const relsXml = unzip('xl/_rels/workbook.xml.rels');
if (relsXml) {
  const rels = relsXml.toString('utf8');
  const re = /<Relationship\b[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/?>/g;
  let m;
  while ((m = re.exec(rels))) {
    const target = unesc(m[2]).replace(/^\/?xl\//, '').replace(/^\//, '');
    sheetPathByRid.set(m[1], 'xl/' + target);
  }
}
const sheetFiles = [...zipEntries.keys()].filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/i.test(n)).sort((a, b) => {
  const na = Number((a.match(/sheet(\d*)\.xml/) || [])[1] || 0);
  const nb = Number((b.match(/sheet(\d*)\.xml/) || [])[1] || 0);
  return na - nb;
});

if (flag(o, 'list')) {
  const rows = sheets.map((s, i) => ({ '#': i + 1, name: s.name, sheetId: s.sheetId, file: sheetPathByRid.get(s.rid) || sheetFiles[i] || '(unknown)' }));
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ file: basename(path), sheets: rows }, null, 2) + '\n');
  else process.stdout.write((rows.length ? table(rows) : 'no sheets found') + '\n');
  process.exit(0);
}

const want = get(o, 'sheet', '1');
let sheetFile;
if (/^\d+$/.test(String(want))) {
  const idx = Number(want) - 1;
  const s = sheets[idx];
  sheetFile = (s && sheetPathByRid.get(s.rid)) || sheetFiles[idx];
} else {
  const s = sheets.find((x) => x.name === String(want));
  if (s) sheetFile = sheetPathByRid.get(s.rid);
}
if (!sheetFile || !zipEntries.has(sheetFile)) {
  sheetFile = sheetFiles[Number(want) - 1] || sheetFiles[0];
}
if (!sheetFile) die(`sheet '${want}' not found — available: ${sheets.map((s, i) => `${i + 1}:${s.name}`).join(', ') || sheetFiles.join(', ')}`);

const sheetXml = unzip(sheetFile);
if (!sheetXml) die(`cannot decompress ${sheetFile}`);
const sx = sheetXml.toString('utf8');

/* ---- parse rows ------------------------------------------------------- */
const grid = [];
const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
let rm;
while ((rm = rowRe.exec(sx))) {
  const rowAttrs = rm[1] || rm[3] || '';
  const body = rm[2] || '';
  const rNum = Number((/r="(\d+)"/.exec(rowAttrs) || [])[1] || grid.length + 1);
  const cells = [];
  const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let cm;
  while ((cm = cRe.exec(body))) {
    const attrs = cm[1] || '';
    const inner = cm[2] || '';
    const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
    const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
    const sIdx = (/s="(\d+)"/.exec(attrs) || [])[1];
    const col = ref ? colToIndex(ref) : cells.length;
    let value = '';
    let formula = null;
    const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
    if (f) formula = unesc(f[1]);
    if (t === 'inlineStr') {
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm, acc = '';
      while ((tm = tRe.exec(inner))) acc += unesc(tm[1]);
      value = acc;
    } else {
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      const rawV = v ? unesc(v[1]) : '';
      if (t === 's') value = shared[Number(rawV)] !== undefined ? shared[Number(rawV)] : rawV;
      else if (t === 'b') value = rawV === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str') value = rawV;
      else if (t === 'e') value = rawV;
      else if (t === 'n' || t === undefined) {
        if (rawV === '') value = '';
        else if (sIdx !== undefined && dateStyles.has(Number(sIdx)) && Number.isFinite(Number(rawV))) value = serialToISO(Number(rawV)) ?? rawV;
        else value = rawV;
      } else value = rawV;
    }
    cells[col] = flag(o, 'trim') ? String(value).trim() : String(value);
    if (formula && !flag(o, 'values')) cells[col] = String(value);
  }
  while (grid.length < rNum - 1) grid.push([]);
  grid[rNum - 1] = cells;
}

let width = 0;
for (const r of grid) for (let i = 0; i < r.length; i++) if (r[i] !== undefined && r[i] !== '') width = Math.max(width, i + 1);

const keepEmpty = flag(o, 'empty');
let rows = grid.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
if (!keepEmpty) {
  rows = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  const used = new Set();
  for (const r of rows) r.forEach((c, i) => { if (String(c).trim() !== '') used.add(i); });
  rows = rows.map((r) => r.filter((_, i) => used.has(i)));
  width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  rows = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}

if (!rows.length) die(`sheet ${want} has no data rows`);

const delim = (() => {
  const d = get(o, 'delim', ',');
  return d === 'tab' || d === '\\t' ? '\t' : String(d);
})();
const escD = (v) => { const s = String(v ?? ''); return delim === ',' ? esc(s) : (s.includes(delim) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s); };
const header = flag(o, 'no-header') ? [] : rows[0];
const body = flag(o, 'no-header') ? rows : rows.slice(1);
const csv = [header.length ? header.map(escD).join(delim) : null, ...body.map((r) => r.map(escD).join(delim))].filter((x) => x !== null).join('\n') + '\n';

const outFile = get(o, 'out', null);
if (outFile) writeFileSync(outFile, csv, 'utf8');

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    file: basename(path), sheet: sheetFile,
    sheetName: (sheets[Number(want) - 1] || {}).name || null,
    rows: body.length, columns: width,
    sharedStrings: shared.length,
    dateStyles: [...dateStyles],
    out: outFile || null,
    data: outFile ? undefined : body,
  }, null, 2) + '\n');
} else if (outFile) {
  process.stdout.write(`wrote ${outFile}: ${body.length} data row(s), ${width} column(s)\n`);
} else {
  process.stdout.write(csv);
}
