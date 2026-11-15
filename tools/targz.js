#!/usr/bin/env node
// targz.js — tar (ustar/GNU/PAX) header parser and gzip reader: list entries or extract.
// Copyright (c) 2026 0xnothings
// @tool targz
// @desc List, inspect and extract tar / tar.gz archives without shelling out to tar
// @usage node tools/targz.js archive.tar.gz --json
// @tags data,archive,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, normalize, isAbsolute } from 'node:path';

const HELP = `targz — tar / tar.gz reader

  node tools/targz.js <archive.tar|.tar.gz|.tgz> [options]

  --list              list entries (default)
  --extract <dir>     extract entries under <dir>
  --type <flag>       only entries with this type flag (f d l g x L K)
  --grep <substr>     only entries whose path contains <substr>
  --data <n>          also hexdump the first <n> bytes of each matched entry
  --checksum          verify the ustar header checksum of every entry
  --json              machine-readable output
  -h, --help          this text

  Handles ustar, GNU longname/longlink (L/K) and PAX (x/g) extended headers.
  Extraction sanitises paths: no absolute paths, no .. traversal, no symlink escape.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['checksum', 'json']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need an archive — node tools/targz.js backup.tar.gz');

const TYPE_NAMES = {
  '0': 'file', '\0': 'file', 'f': 'file', '1': 'hardlink', '2': 'symlink',
  '3': 'char', '4': 'block', '5': 'dir', '6': 'fifo', '7': 'contig',
  'g': 'pax-global', 'x': 'pax-extended', 'L': 'gnu-longname', 'K': 'gnu-longlink',
  'D': 'gnu-dumpdir', 'M': 'gnu-multivol', 'S': 'gnu-sparse', 'V': 'gnu-volhdr',
};

function load(path) {
  // A missing input is a user error, not a crash: without this the raw ENOENT
  // escapes as an uncaught exception (exit 7 with a Node stack trace) instead of
  // a one-line message and a clean exit code.
  if (!existsSync(path)) die(`no such file: ${path}`);
  const raw = readFileSync(path);
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try { return { bytes: gunzipSync(raw), gzip: true }; }
    catch (e) { die(`gzip decode failed: ${e.message}`); }
  }
  if (raw.length > 3 && raw[0] === 0x42 && raw[1] === 0x5a) die('bzip2 archives are not supported — decompress first');
  return { bytes: raw, gzip: false };
}

function str(buf, off, len) {
  const end = buf.indexOf(0, off);
  const stop = end === -1 || end > off + len ? off + len : end;
  return buf.slice(off, stop).toString('utf8');
}

function octal(buf, off, len) {
  const s = str(buf, off, len).trim().replace(/\0/g, '');
  if (!s) return 0;
  if (s.startsWith('0x') || /[^0-7]/.test(s)) return 0;
  return parseInt(s, 8) || 0;
}

function base256(buf, off, len) {
  if (!(buf[off] & 0x80)) return octal(buf, off, len);
  let v = buf[off] & 0x7f;
  for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
  return v;
}

function isZeroBlock(buf, off) {
  for (let i = 0; i < 512; i++) if (buf[off + i] !== 0) return false;
  return true;
}

function parsePax(buf) {
  const out = {};
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp === -1) break;
    const len = parseInt(buf.slice(p, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.slice(sp + 1, p + len).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1).replace(/\n$/, '');
    p += len;
  }
  return out;
}

const { bytes, gzip } = load(src);
const entries = [];
let pos = 0, warnings = [], endBlocks = 0, pendingLongName = null, pendingLongLink = null, pendingPax = null, globalPax = {};

while (pos + 512 <= bytes.length) {
  if (isZeroBlock(bytes, pos)) {
    endBlocks++; pos += 512;
    if (endBlocks >= 2) break;
    continue;
  }
  endBlocks = 0;
  const h = bytes.slice(pos, pos + 512);
  let stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  const chkOk = sum === stored;

  let nm = str(h, 0, 100);
  const prefix = str(h, 345, 155);
  if (prefix) nm = prefix + '/' + nm;
  const mode = octal(h, 100, 8);
  const uid = octal(h, 108, 8);
  const gid = octal(h, 116, 8);
  let size = base256(h, 124, 12);
  const mtime = base256(h, 136, 12);
  let type = String.fromCharCode(h[156]) || '0';
  if (type === '\0') type = '0';
  let link = str(h, 157, 100);
  const magic = str(h, 257, 6);
  const uname = str(h, 265, 32);
  const gname = str(h, 297, 32);

  const dataStart = pos + 512;
  const dataEnd = Math.min(bytes.length, dataStart + size);
  const data = bytes.slice(dataStart, dataEnd);
  const padded = size + ((512 - (size % 512)) % 512);
  pos = dataStart + padded;

  if (type === 'x') { pendingPax = { ...(pendingPax || {}), ...parsePax(data) }; continue; }
  if (type === 'g') { globalPax = { ...globalPax, ...parsePax(data) }; continue; }
  if (type === 'L') { pendingLongName = data.toString('utf8').replace(/\0+$/, ''); continue; }
  if (type === 'K') { pendingLongLink = data.toString('utf8').replace(/\0+$/, ''); continue; }

  const pax = { ...globalPax, ...(pendingPax || {}) };
  if (pax.path) nm = pax.path;
  else if (pendingLongName) nm = pendingLongName;
  if (pendingLongLink) link = pendingLongLink;
  if (pax.linkpath) link = pax.linkpath;
  if (pax.size !== undefined) size = Number(pax.size);
  if (pax.mtime !== undefined) { /* keep numeric mtime from header */ }

  entries.push({
    name: nm,
    type,
    typeName: TYPE_NAMES[type] || `unknown(${JSON.stringify(type)})`,
    size,
    mode: '0' + mode.toString(8).padStart(3, '0'),
    uid, gid, uname, gname,
    mtime: Math.round(mtime) ? new Date(mtime * 1000).toISOString() : null,
    mtimeEpoch: Math.round(mtime),
    linkTarget: link || null,
    format: magic.startsWith('ustar') ? (pax.path || pax.size !== undefined ? 'pax' : 'ustar') : (magic ? magic : 'v7'),
    devMajor: octal(h, 329, 8), devMinor: octal(h, 337, 8),
    checksumOk: chkOk,
    dataOffset: dataStart,
  });
  if (!chkOk) warnings.push(`${nm}: header checksum mismatch (stored=${stored} computed=${sum})`);
  pendingLongName = pendingLongLink = null; pendingPax = null;
}

const typeF = get(o, 'type', null);
const grep = get(o, 'grep', null);
let view = entries;
if (typeF) view = view.filter((e) => e.type === typeF || e.typeName === typeF);
if (grep) view = view.filter((e) => e.name.includes(String(grep)));

if (flag(o, 'checksum') && warnings.length === 0 && entries.length) warnings.push('(all header checksums valid)');

const dataHexBytes = num(get(o, 'data', 0), 0);
const extractDir = get(o, 'extract', null);

const out = {
  archive: src,
  compressed: gzip,
  size: bytes.length,
  entries: entries.length,
  matched: view.length,
  totalUncompressed: entries.reduce((a, e) => a + e.size, 0),
  counts: entries.reduce((a, e) => { a[e.typeName] = (a[e.typeName] || 0) + 1; return a; }, {}),
  warnings,
};

if (extractDir) {
  const base = String(extractDir);
  mkdirSync(base, { recursive: true });
  const written = [];
  const old = bytes;
  for (const e of view) {
    let rel = e.name.replace(/^[A-Za-z]:/, '').replace(/^[/\\]+/, '');
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const relPosix = rel.split('\\').join('/');
    if (!relPosix || relPosix.startsWith('..') || isAbsolute(relPosix)) { warnings.push(`skipped unsafe path: ${e.name}`); continue; }
    const dest = join(base, relPosix);
    if (e.type === '5' || relPosix.endsWith('/')) {
      mkdirSync(dest, { recursive: true });
      written.push({ path: relPosix, kind: 'dir' });
      continue;
    }
    if (e.type === '2' || e.type === '1') { written.push({ path: relPosix, kind: e.type === '2' ? 'symlink->' + e.linkTarget : 'hardlink->' + e.linkTarget, skipped: true }); continue; }
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, old.slice(e.dataOffset, e.dataOffset + e.size));
    written.push({ path: relPosix, kind: 'file', bytes: e.size });
  }
  out.extracted = { dir: base, files: written.filter((w) => w.kind === 'file').length, items: written };
}

if (flag(o, 'json')) {
  out.listing = view.map((e) => ({
    path: e.name, type: e.typeName, size: e.size, mode: e.mode, uid: e.uid, gid: e.gid,
    mtime: e.mtime, link: e.linkTarget, format: e.format, checksumOk: e.checksumOk,
    ...(dataHexBytes ? { hexHead: bytes.slice(e.dataOffset, e.dataOffset + Math.min(dataHexBytes, e.size)).toString('hex') } : {}),
  }));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const rows = view.map((e) => ({
    type: e.typeName.slice(0, 9),
    size: fmt(e.size),
    mode: e.mode,
    mtime: e.mtime ? e.mtime.slice(0, 19).replace('T', ' ') : '-',
    path: e.name + (e.linkTarget ? ' -> ' + e.linkTarget : ''),
  }));
  console.log(`${src}${gzip ? ' (gzip)' : ''} — ${entries.length} entries, ${fmt(out.totalUncompressed)} bytes uncompressed`);
  console.log(table(rows.slice(0, 500), ['type', 'size', 'mode', 'mtime', 'path']));
  if (view.length > 500) console.log(`... ${view.length - 500} more entries`);
  if (warnings.length) console.log('\n' + warnings.slice(0, 20).join('\n'));
  if (extractDir) console.log(`\nextracted ${out.extracted.files} file(s) under ${extractDir}`);
  if (dataHexBytes && view.length) {
    console.log('\nHEAD BYTES');
    for (const e of view.slice(0, 10)) {
      console.log(e.name);
      console.log(bytes.slice(e.dataOffset, e.dataOffset + Math.min(dataHexBytes, e.size)).toString('hex').replace(/(.{32})/g, '$1\n').trim());
    }
  }
}
