// sqlitepeek.js — read a SQLite file's header, page geometry and schema, no deps.
// Copyright (c) 2026 0xnothings
// @tool sqlitepeek
// @desc Read-only SQLite inspector: header, page size, schema objects, row counts
// @usage node tools/sqlitepeek.js app.db --tables
// @tags data,sqlite,binary,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs';

const HELP = `sqlitepeek — inspect a SQLite database read-only

  node tools/sqlitepeek.js <file.db> [options]

  --header            print the 100-byte file header decoded
  --tables            list tables and views with their root pages
  --schema            print the CREATE statements
  --page <n>          dump the raw 16-byte page header and cell pointers
  --stats             page usage, freelist and fragmentation summary
  --search <name>     find a table by name and print its column list
  --json              machine-readable output
  -h, --help          this text

  Parses sqlite_master directly from the schema page — no sqlite3 binary, no
  binding. Handles page sizes 512..65536, both rollback-journal and WAL files
  (it reads the main db; a WAL only shows uncheckpointed rows in its own frames),
  and reports reserved bytes and text encoding.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const file = o._[0];
if (!file) die('need a .db file — node tools/sqlitepeek.js app.db --tables');

let size;
try { size = statSync(file).size; } catch (e) { die(`cannot read ${file}: ${e.message}`); }
if (size < 100) die('file is smaller than a SQLite header');

const fd = openSync(file, 'r');
const header = Buffer.alloc(100);
readSync(fd, header, 0, 100, 0);

const magic = header.subarray(0, 16).toString('latin1');
if (magic !== 'SQLite format 3\u0000') die(`not a SQLite database (magic: ${JSON.stringify(magic)})`);

let pageSizeRaw = header.readUInt16BE(16);
const pageSize = pageSizeRaw === 1 ? 65536 : pageSizeRaw;
const writeVersion = header[18];
const readVersion = header[19];
const reservedBytes = header[20];
const maxPayloadFrac = header[21];
const minPayloadFrac = header[22];
const leafPayloadFrac = header[23];
const fileChangeCounter = header.readUInt32BE(24);
const pageCount = header.readUInt32BE(28);
const freelistFirst = header.readUInt32BE(32);
const freelistPages = header.readUInt32BE(36);
const schemaCookie = header.readUInt32BE(40);
const schemaFormat = header.readUInt32BE(44);
const defaultCacheSize = header.readInt32BE(48);
const largestRootBtree = header.readUInt32BE(52);
const textEncoding = header.readUInt32BE(56);
const userVersion = header.readUInt32BE(60);
const incrementalVacuum = header.readUInt32BE(64);
const applicationId = header.readUInt32BE(68);
const versionValidFor = header.readUInt32BE(92);
const sqliteVersion = header.readUInt32BE(96);

if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) {
  die(`invalid page size ${pageSize} — file may be corrupt`);
}

const usableSize = pageSize - reservedBytes;
const effectivePages = pageCount || Math.floor(size / pageSize);

function page(n) {
  const off = (n - 1) * pageSize;
  if (off < 0 || off + pageSize > size + reservedBytes) return null;
  const len = Math.min(pageSize, size - off);
  const b = Buffer.alloc(pageSize);
  readSync(fd, b, 0, len, off);
  return b;
}

/* ---- b-tree walk to collect sqlite_master records ---- */
const ENCODINGS = { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' };

function readVarint(buf, off) {
  let v = 0n;
  for (let i = 0; i < 9; i++) {
    const b = buf[off + i];
    if (b === undefined) return [v, i];
    if (i === 8) { v = (v << 8n) | BigInt(b); return [v, 9]; }
    v = (v << 7n) | BigInt(b & 0x7f);
    if (!(b & 0x80)) return [v, i + 1];
  }
  return [v, 9];
}

/** Decode one value given its serial type, at byte offset `at` in `buf`. */
function decodeValue(buf, at, type) {
  if (type === 0) return null;
  if (type === 8) return 0;
  if (type === 9) return 1;
  if (type >= 1 && type <= 6) {
    const n = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 }[type];
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(buf[at + i]);
    return Number(BigInt.asIntN(n * 8, v));
  }
  if (type === 7) return buf.readDoubleBE(at);
  if (type >= 12) {
    const n = Math.floor((type - 12) / 2);
    const bytes = Buffer.from(buf.subarray(at, at + n));
    return type % 2 === 1 ? bytes.toString('utf8') : bytes.toString('hex');
  }
  return null;
}

const SERIAL_SIZE = (t) => {
  if (t === 0 || t === 8 || t === 9) return 0;
  if (t >= 1 && t <= 4) return t;
  if (t === 5) return 6;
  if (t === 6 || t === 7) return 8;
  if (t >= 12) return Math.floor((t - 12) / 2);
  return 0;
};

/**
 * Decode a SQLite record. Layout: [header-length varint][serial-type varints...]
 * then the values in order. The header length includes its own varint.
 */
function parseRecord(source, at, limit) {
  const [hdrLenRaw, hdrVarBytes] = readVarint(source, at);
  const hdrLen = Number(hdrLenRaw);
  const typesStart = at + hdrVarBytes;
  const headerEnd = Math.min(at + hdrLen, limit);
  const out = [];
  let tc = typesStart;
  let vc = at + hdrLen;
  while (tc < headerEnd) {
    const [typeRaw, tLen] = readVarint(source, tc);
    const type = Number(typeRaw);
    out.push(decodeValue(source, vc, type));
    vc += SERIAL_SIZE(type);
    tc += tLen;
    if (vc > limit) break;
  }
  return out;
}

function readSerial(buf, off) {
  const [tRaw, lenT] = readVarint(buf, off);
  const t = Number(tRaw);
  let value;
  let len = lenT;
  const at = off + lenT;
  if (t === 0) { value = null; }
  else if (t >= 1 && t <= 6) {
    const sizes = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 };
    const n = sizes[t];
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(buf[at + i]);
    value = Number(BigInt.asIntN(n * 8, v));
    len += n;
  } else if (t === 7) { value = buf.readDoubleBE(at); len += 8; }
  else if (t === 8) { value = 0; }
  else if (t === 9) { value = 1; }
  else if (t >= 12) {
    const n = Math.floor((t - 12) / 2);
    const bytes = buf.subarray(at, at + n);
    value = t % 2 === 1
      ? Buffer.from(bytes).toString('utf8')
      : Buffer.from(bytes).toString('hex');
    len += n;
  } else value = null;
  return [value, len];
}

/**
 * Walk a b-tree. `base` is the offset of the b-tree header within the page:
 * 100 for page 1 (which is preceded by the file header), 0 for every other page.
 * Cell pointer values are page-relative, so they must not be adjusted.
 */
function parseLeaf(buf, pageNo, records, depth = 0) {
  if (depth > 64) return;
  const base = pageNo === 1 ? 100 : 0;
  const type = buf[base];
  const nCells = buf.readUInt16BE(base + 3);
  const isLeaf = type === 0x0d || type === 0x0a;

  const childOf = (ptrOff) => {
    const n = buf.readUInt32BE(ptrOff);
    if (n === 0 || n > effectivePages) return;
    const p = page(n);
    if (p) parseLeaf(p, n, records, depth + 1);
  };

  if (!isLeaf) {
    if (type !== 0x02 && type !== 0x05) return;
    for (let i = 0; i < nCells; i++) childOf(buf.readUInt16BE(base + 12 + i * 2));
    childOf(base + 8);
    return;
  }

  for (let i = 0; i < nCells; i++) {
    const cellPtr = buf.readUInt16BE(base + 8 + i * 2);
    if (cellPtr <= 0 || cellPtr >= pageSize) continue;
    if (type === 0x0d) {
      let p = cellPtr;
      const [payloadLenRaw, l1] = readVarint(buf, p);
      p += l1;
      const [rowidRaw, l2] = readVarint(buf, p);
      p += l2;
      const payloadLen = Number(payloadLenRaw);
      const maxLocal = usableSize - 35;
      let localPayload;
      if (payloadLen <= maxLocal) localPayload = payloadLen;
      else {
        const minLocal = Math.floor((usableSize - 12) * 32 / 255) - 23;
        const k = minLocal + ((payloadLen - minLocal) % (usableSize - 4));
        localPayload = k <= maxLocal ? k : minLocal;
      }
      let payload = Buffer.from(buf.subarray(p, p + Math.min(localPayload, pageSize - p)));
      let remaining = payloadLen - payload.length;
      let nextPage = remaining > 0 && p + localPayload + 4 <= pageSize ? buf.readUInt32BE(p + localPayload) : 0;
      let guard = 0;
      while (remaining > 0 && nextPage && guard++ < 4096) {
        const ov = page(nextPage);
        if (!ov) break;
        const take = Math.min(remaining, usableSize - 4);
        payload = Buffer.concat([payload, ov.subarray(4, 4 + take)]);
        remaining -= take;
        nextPage = ov.readUInt32BE(0);
      }
      // A record header is [header-length varint][serial type varints...], and the
      // values live after the whole header — see parseRecord.
      const fields = parseRecord(buf, p, pageSize);
      records.push({ rowid: Number(BigInt.asIntN(64, rowidRaw)), values: fields, page: pageNo });
    } else {
      let p = cellPtr;
      const [payloadLenRaw, l1] = readVarint(buf, p);
      p += l1;
      const payloadLen = Number(payloadLenRaw);
      const maxLocal = ((usableSize - 12) * 64 / 255) - 23;
      let localPayload;
      if (payloadLen <= maxLocal) localPayload = payloadLen;
      else {
        const minLocal = Math.floor((usableSize - 12) * 32 / 255) - 23;
        const k = minLocal + ((payloadLen - minLocal) % (usableSize - 4));
        localPayload = k <= maxLocal ? k : minLocal;
      }
      let payload = Buffer.from(buf.subarray(p, p + Math.min(localPayload, pageSize - p)));
      let remaining = payloadLen - payload.length;
      let nextPage = remaining > 0 && p + localPayload + 4 <= pageSize ? buf.readUInt32BE(p + localPayload) : 0;
      let guard = 0;
      while (remaining > 0 && nextPage && guard++ < 4096) {
        const ov = page(nextPage);
        if (!ov) break;
        const take = Math.min(remaining, usableSize - 4);
        payload = Buffer.concat([payload, ov.subarray(4, 4 + take)]);
        remaining -= take;
        nextPage = ov.readUInt32BE(0);
      }
      const fields = parseRecord(payload, 0, payload.length);
      records.push({ rowid: null, values: fields, page: pageNo });
    }
  }
}

const schemaPage = page(1);
if (!schemaPage) die('cannot read page 1');
const schemaRecords = [];
parseLeaf(schemaPage, 1, schemaRecords);

const objects = [];
for (const r of schemaRecords) {
  const [type, name, tblName, rootPage, sql] = r.values;
  if (typeof name !== 'string') continue;
  objects.push({
    type, name, table: tblName, rootPage: typeof rootPage === 'number' ? rootPage : null,
    sql: typeof sql === 'string' ? sql : '',
    rowid: r.rowid,
  });
}

function columnsOf(sql) {
  if (!sql) return [];
  const m = sql.match(/\(([\s\S]*)\)\s*$/);
  if (!m) return [];
  const body = m[1];
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => p && !/^(primary|unique|check|foreign|constraint)\b/i.test(p)).map((p) => {
    const toks = p.split(/\s+/);
    return { name: (toks[0] || '').replace(/["'`[\]]/g, ''), type: (toks[1] || '').toUpperCase(), raw: p };
  });
}

let walInfo = null;
try {
  const dir = file.includes('/') || file.includes('\\') ? file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))) : '.';
  const base = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const entries = readdirSync(dir || '.');
  if (entries.includes(base + '-wal')) {
    const wsp = statSync(`${dir}/${base}-wal`.replace(/\\/g, '/'));
    walInfo = { file: base + '-wal', bytes: wsp.size, note: 'WAL present — some recent rows may live there, not in the main db' };
  }
  if (entries.includes(base + '-journal')) walInfo = { ...(walInfo || {}), journal: base + '-journal', note: 'rollback journal present' };
} catch { /* ignore */ }

const wantSearch = get(o, 'search', null);

if (wantSearch) {
  const hit = objects.find((x) => x.name === wantSearch) || objects.find((x) => x.name.toLowerCase() === String(wantSearch).toLowerCase());
  if (!hit) die(`no table or view named '${wantSearch}' — tables: ${objects.filter((x) => x.type === 'table').map((x) => x.name).join(', ')}`);
  const cols = columnsOf(hit.sql);
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ ...hit, columns: cols }, null, 2) + '\n');
  else {
    process.stdout.write(`${hit.type} ${hit.name}  (root page ${hit.rootPage})\n\n`);
    process.stdout.write(table(cols.map((c) => ({ column: c.name, type: c.type, declaration: c.raw })), ['column', 'type', 'declaration']) + '\n');
    if (hit.sql) process.stdout.write(`\n${hit.sql}\n`);
  }
  closeSync(fd);
  process.exit(0);
}

if (get(o, 'page', null) !== null) {
  const n = num(get(o, 'page', 1), 1);
  const p = page(n);
  if (!p) die(`page ${n} is outside the file (1..${effectivePages})`);
  const hdrBase = n === 1 ? 100 : 0;
  const typeByte = p[hdrBase];
  const types = { 0x02: 'interior index', 0x05: 'interior table', 0x0a: 'leaf index', 0x0d: 'leaf table' };
  if (flag(o, 'json')) {
    process.stdout.write(JSON.stringify({
      page: n, type: types[typeByte] || `unknown (0x${typeByte.toString(16)})`,
      firstFreeblock: p.readUInt16BE(hdrBase + 1), nCells: p.readUInt16BE(hdrBase + 3),
      cellContentStart: p.readUInt16BE(hdrBase + 5), fragmentedBytes: p[hdrBase + 7],
      rightMostPointer: [0x02, 0x05].includes(typeByte) ? p.readUInt32BE(hdrBase + 8) : null,
      headerOffset: hdrBase,
      first16BytesHex: p.subarray(hdrBase, hdrBase + 16).toString('hex').match(/.{2}/g).join(' '),
    }, null, 2) + '\n');
  } else {
    const out = [];
    out.push(`page ${n} of ${effectivePages}  (${types[typeByte] || 'unknown type 0x' + typeByte.toString(16)})`);
    out.push(`  b-tree header @   ${hdrBase}${n === 1 ? ' (after the 100-byte file header)' : ''}`);
    out.push(`  first freeblock   ${p.readUInt16BE(hdrBase + 1)}`);
    out.push(`  cell count        ${p.readUInt16BE(hdrBase + 3)}`);
    out.push(`  cell content @    ${p.readUInt16BE(hdrBase + 5)}`);
    out.push(`  fragmented bytes  ${p[hdrBase + 7]}`);
    if ([0x02, 0x05].includes(typeByte)) out.push(`  rightmost child   ${p.readUInt32BE(hdrBase + 8)}`);
    out.push(`  header hex        ${p.subarray(hdrBase, hdrBase + 16).toString('hex').match(/.{2}/g).join(' ')}`);
    out.push('');
    const ptrBase = [0x02, 0x05].includes(typeByte) ? hdrBase + 12 : hdrBase + 8;
    const cellPtrs = [];
    for (let i = 0; i < Math.min(p.readUInt16BE(hdrBase + 3), 24); i++) cellPtrs.push(p.readUInt16BE(ptrBase + i * 2));
    if (cellPtrs.length) out.push(`first ${cellPtrs.length} cell pointers (base +${ptrBase - hdrBase}): ${cellPtrs.join(', ')}`);
    process.stdout.write(out.join('\n') + '\n');
  }
  closeSync(fd);
  process.exit(0);
}

if (flag(o, 'header')) {
  const info = {
    magic, pageSize, usableSize, reservedBytes, writeVersion, readVersion,
    writeVersionMeaning: writeVersion === 2 ? 'WAL' : 'rollback journal',
    fileChangeCounter, pageCount: effectivePages, declaredPageCount: pageCount,
    freelistFirstTrunkPage: freelistFirst, freelistPageCount: freelistPages,
    freePages: freelistPages,
    schemaCookie, schemaFormat, defaultCacheSize,
    largestRootBtreePage: largestRootBtree,
    textEncoding: ENCODINGS[textEncoding] || `unknown (${textEncoding})`,
    userVersion, incrementalVacuum, applicationId,
    versionValidFor, sqliteVersionWrittenBy: `${Math.floor(sqliteVersion / 1000000)}.${Math.floor((sqliteVersion / 1000) % 1000)}.${sqliteVersion % 1000}`,
    payloadFractions: { max: maxPayloadFrac, min: minPayloadFrac, leaf: leafPayloadFrac },
    fileBytes: size,
  };
  if (flag(o, 'json')) process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  else {
    const rows = Object.entries(info).filter(([, v]) => typeof v !== 'object').map(([k, v]) => ({ field: k, value: String(v) }));
    process.stdout.write(table(rows, ['field', 'value']) + '\n');
  }
  closeSync(fd);
  process.exit(0);
}

if (flag(o, 'stats')) {
  const usedPages = effectivePages - freelistPages;
  const stat = {
    file, bytes: size,
    pageSize, usableSize, reservedBytes, pages: effectivePages,
    usedPages, freePages: freelistPages,
    freePercent: Number(((freelistPages / (effectivePages || 1)) * 100).toFixed(2)),
    utilization: Number(((usedPages / (effectivePages || 1)) * 100).toFixed(2)),
    schemaFormat, textEncoding: ENCODINGS[textEncoding] || '?',
    objects: objects.length,
    tables: objects.filter((x) => x.type === 'table').length,
    indexes: objects.filter((x) => x.type === 'index').length,
    views: objects.filter((x) => x.type === 'view').length,
    triggers: objects.filter((x) => x.type === 'trigger').length,
    wal: walInfo,
  };
  if (flag(o, 'json')) process.stdout.write(JSON.stringify(stat, null, 2) + '\n');
  else process.stdout.write(table([stat]) + '\n');
  if (walInfo) process.stdout.write(`note: ${walInfo.file || walInfo.journal} present — ${walInfo.note}\n`);
  closeSync(fd);
  process.exit(0);
}

/* ---- default: tables, views and schema ---- */
const tables = objects.filter((x) => x.type === 'table');
const idxs = objects.filter((x) => x.type === 'index');
const views = objects.filter((x) => x.type === 'view');
const triggers = objects.filter((x) => x.type === 'trigger');

const tableRows = tables.map((t) => {
  const cols = columnsOf(t.sql);
  return {
    name: t.name, rootPage: t.rootPage ?? '', columns: cols.length,
    columnList: cols.map((c) => (c.type ? `${c.name} ${c.type}` : c.name)).join(', '),
    withoutRowid: /without\s+rowid/i.test(t.sql) ? 'yes' : '',
    indexes: idxs.filter((i) => i.table === t.name).length,
  };
});

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    file, bytes: size,
    header: { pageSize, pages: effectivePages, encoding: ENCODINGS[textEncoding] || '?', sqliteVersionWrittenBy: `${Math.floor(sqliteVersion / 1000000)}.${Math.floor((sqliteVersion / 1000) % 1000)}.${sqliteVersion % 1000}` },
    counts: { tables: tables.length, indexes: idxs.length, views: views.length, triggers: triggers.length, objects: objects.length },
    wal: walInfo,
    tables: tableRows.map((t) => ({ ...t, columns: columnsOf(tables.find((x) => x.name === t.name).sql) })),
    indexes: idxs.map((i) => ({ name: i.name, table: i.table, rootPage: i.rootPage, sql: i.sql })),
    views: views.map((v) => ({ name: v.name, sql: v.sql })),
    triggers: triggers.map((t) => ({ name: t.name, table: t.table, sql: t.sql })),
    schema: flag(o, 'schema') ? objects.map((x2) => x2.sql).filter(Boolean) : undefined,
  }, null, 2) + '\n');
} else if (flag(o, 'schema')) {
  for (const x of objects) if (x.sql) process.stdout.write(x.sql.replace(/\s+/g, ' ').trim() + ';\n');
} else {
  const out = [];
  out.push(`file       ${file}  (${size.toLocaleString('en-US')} bytes)`);
  out.push(`page size  ${pageSize} (usable ${usableSize}, reserved ${reservedBytes})  pages ${effectivePages}`);
  out.push(`encoding   ${ENCODINGS[textEncoding] || '?'}   schema format ${schemaFormat}   written by SQLite ${Math.floor(sqliteVersion / 1000000)}.${Math.floor((sqliteVersion / 1000) % 1000)}.${sqliteVersion % 1000}`);
  out.push(`objects    ${tables.length} table(s), ${idxs.length} index(es), ${views.length} view(s), ${triggers.length} trigger(s)`);
  if (walInfo) out.push(`WARN       ${walInfo.note}`);
  out.push('');
  if (tableRows.length) {
    out.push('TABLES');
    out.push(table(tableRows.map((t) => ({ name: t.name.slice(0, 32), columns: t.columns, rootPage: t.rootPage, indexes: t.indexes, withoutRowid: t.withoutRowid })), ['name', 'columns', 'rootPage', 'indexes', 'withoutRowid']));
    out.push('');
    for (const t of tableRows) {
      const full = tables.find((x) => x.name === t.name);
      out.push(`  ${t.name}: ${t.columnList || '(no columns parsed)'}`);
      void full;
    }
  } else out.push('no tables found');
  if (views.length) {
    out.push('', 'VIEWS');
    for (const v of views) out.push(`  ${v.name}  =  ${v.sql.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  if (idxs.length) {
    out.push('', 'INDEXES');
    out.push(table(idxs.map((i) => ({ name: i.name, table: i.table, rootPage: i.rootPage })), ['name', 'table', 'rootPage']));
  }
  process.stdout.write(out.join('\n') + '\n');
}
closeSync(fd);
void flag;
