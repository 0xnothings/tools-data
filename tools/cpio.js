#!/usr/bin/env node
// cpio.js — cpio archive reader (newc/crc/odc/odc-binary): entries with names, sizes, modes.
// Copyright (c) 2026 0xnothings
// @tool cpio
// @desc Read cpio archives (newc/crc/odc/binary) listing names, sizes, inodes and modes
// @usage node tools/cpio.js rootfs.cpio.gz --json
// @tags data,archive,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, normalize, isAbsolute } from 'node:path';

const HELP = `cpio — cpio archive reader

  node tools/cpio.js <archive.cpio|.cpio.gz> [options]

  --list                  list entries (default)
  --extract <dir>         extract regular files under <dir>
  --data <n>              hexdump first <n> bytes of each regular file
  --grep <substr>         filter by path
  --json                  machine-readable output
  -h, --help              this text

  Supported formats: newc (070701), crc (070702), odc (070707 ASCII) and the
  legacy binary format (magic 0x71c7). gzip/bzip2-less archives auto-detected.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need an archive — node tools/cpio.js initramfs.cpio.gz');

let bytes = readFileSync(src);
let gzip = false;
if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) { bytes = gunzipSync(bytes); gzip = true; }
if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x5a) die('bzip2 compressed cpio not supported — decompress first');

const MODE_TYPES = { 1: 'fifo', 2: 'char', 4: 'dir', 6: 'block', 8: 'file', 10: 'symlink', 12: 'socket' };

function modeInfo(mode) {
  const t = (mode >>> 12) & 0xf;
  const perms = (mode & 0o7777).toString(8).padStart(4, '0');
  return { kind: MODE_TYPES[t] || `type${t}`, perms, text: (t === 4 ? 'd' : t === 10 ? 'l' : '-') + perms };
}

const entries = [];
let pos = 0, format = null, warnings = [];

const align4 = (n) => n + ((4 - (n % 4)) % 4);

function hexField(buf, at, len) { return parseInt(buf.slice(at, at + len).toString('ascii'), 16); }
function octField(buf, at, len) { return parseInt(buf.slice(at, at + len).toString('ascii'), 8); }

if (bytes.slice(0, 6).toString('ascii') === '070701' || bytes.slice(0, 6).toString('ascii') === '070702') {
  format = bytes.slice(0, 6).toString('ascii') === '070702' ? 'crc' : 'newc';
  while (pos + 110 <= bytes.length) {
    const magic = bytes.slice(pos, pos + 6).toString('ascii');
    if (magic === '070707' || !/^07070[12]$/.test(magic)) break;
    const f = (i) => hexField(bytes, pos + 6 + i * 8, 8);
    const ino = f(0), mode = f(1), uid = f(2), gid = f(3), nlink = f(4), mtime = f(5), filesize = f(6);
    const namesize = f(11), check = f(12);
    const nmStart = pos + 110;
    let nm = bytes.slice(nmStart, nmStart + namesize - 1).toString('utf8');
    const dataStart = align4(nmStart + namesize);
    const data = bytes.slice(dataStart, dataStart + filesize);
    pos = align4(dataStart + filesize);
    if (nm === 'TRAILER!!!') break;
    const mi = modeInfo(mode);
    entries.push({
      name: nm, inode: ino, mode: '0o' + mode.toString(8), modeText: mi.text, kind: mi.kind,
      uid, gid, nlink, mtime: new Date(mtime * 1000).toISOString(), size: filesize,
      checksum: format === 'crc' ? { stored: check, computed: [...data].reduce((a, b) => (a + b) >>> 0, 0) } : null,
      dataOffset: dataStart,
      symlink: mi.kind === 'symlink' ? data.toString('utf8') : null,
    });
  }
} else if (bytes.slice(0, 6).toString('ascii') === '070707') {
  format = 'odc';
  while (pos + 76 <= bytes.length) {
    if (bytes.slice(pos, pos + 6).toString('ascii') !== '070707') break;
    const off = (i, len) => pos + 6 + i;
    const ino = octField(bytes, off(0), 6), mode = octField(bytes, off(1), 6);
    const uid = octField(bytes, off(2), 6), gid = octField(bytes, off(3), 6), nlink = octField(bytes, off(4), 6);
    const mtime = octField(bytes, pos + 48, 11), namesize = octField(bytes, pos + 59, 6), filesize = octField(bytes, pos + 65, 11);
    const nmStart = pos + 76;
    const nm = bytes.slice(nmStart, nmStart + namesize - 1).toString('utf8');
    const dataStart = nmStart + namesize;
    const data = bytes.slice(dataStart, dataStart + filesize);
    pos = dataStart + filesize;
    if (nm === 'TRAILER!!!') break;
    const mi = modeInfo(mode);
    entries.push({
      name: nm, inode: ino, mode: '0o' + mode.toString(8), modeText: mi.text, kind: mi.kind,
      uid, gid, nlink, mtime: new Date(mtime * 1000).toISOString(), size: filesize,
      checksum: null, dataOffset: dataStart, symlink: mi.kind === 'symlink' ? data.toString('utf8') : null,
    });
  }
} else if (bytes.length > 2 && ((bytes[0] === 0xc7 && bytes[1] === 0x71) || (bytes[0] === 0x71 && bytes[1] === 0xc7))) {
  format = bytes[0] === 0xc7 ? 'bin-le' : 'bin-be';
  const le = format === 'bin-le';
  const u16 = (p) => (le ? bytes.readUInt16LE(p) : bytes.readUInt16BE(p));
  while (pos + 26 <= bytes.length) {
    if (u16(pos) !== 0x71c7) break;
    const ino = u16(pos + 2), mode = u16(pos + 4), uid = u16(pos + 6), gid = u16(pos + 8);
    const nlink = u16(pos + 10), rdev = u16(pos + 12), mtimeHi = u16(pos + 14), mtimeLo = u16(pos + 16);
    const namesize = u16(pos + 18), filesizeHi = u16(pos + 20), filesizeLo = u16(pos + 22);
    const mtime = (mtimeHi << 16) | mtimeLo;
    const filesize = (filesizeHi << 16) | filesizeLo;
    const nmStart = pos + 26;
    const nm = bytes.slice(nmStart, nmStart + namesize - 1).toString('utf8');
    const dataStart = nmStart + namesize + ((namesize % 2) ? 1 : 0);
    pos = dataStart + filesize + ((filesize % 2) ? 1 : 0);
    if (nm === 'TRAILER!!!') break;
    const mi = modeInfo(mode);
    entries.push({
      name: nm, inode: ino, mode: '0o' + mode.toString(8), modeText: mi.text, kind: mi.kind,
      uid, gid, nlink, mtime: new Date(mtime * 1000).toISOString(), size: filesize,
      checksum: null, dataOffset: dataStart, symlink: mi.kind === 'symlink' ? bytes.slice(dataStart, dataStart + filesize).toString('utf8') : null,
    });
  }
} else {
  die(`unrecognised cpio magic (${bytes.slice(0, 6).toString('hex')}) — expected newc/crc/odc/binary`);
}

const grep = get(o, 'grep', null);
let view = entries;
if (grep) view = view.filter((e) => e.name.includes(String(grep)));

let badCrc = 0;
for (const e of entries) if (e.checksum && e.checksum.stored !== e.checksum.computed) { badCrc++; warnings.push(`${e.name}: crc mismatch`); }

const dataHex = num(get(o, 'data', 0), 0);
const extractDir = get(o, 'extract', null);
const totals = {
  files: entries.filter((e) => e.kind === 'file').length,
  dirs: entries.filter((e) => e.kind === 'dir').length,
  symlinks: entries.filter((e) => e.kind === 'symlink').length,
  bytes: entries.reduce((a, e) => a + e.size, 0),
};

const report = {
  archive: src, compressed: gzip, format, headerBytes: bytes.length,
  entries: entries.length, matched: view.length, totals, badCrc, warnings,
};

if (extractDir) {
  const base = String(extractDir);
  mkdirSync(base, { recursive: true });
  let n = 0;
  for (const e of view) {
    let rel = e.name.replace(/^[/\\]+/, '');
    rel = normalize(rel).replace(/^(\.\.[/\\])+/, '').split('\\').join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) { warnings.push(`unsafe path skipped: ${e.name}`); continue; }
    const dest = join(base, rel);
    if (e.kind === 'dir') { mkdirSync(dest, { recursive: true }); continue; }
    if (e.kind !== 'file') continue;
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, bytes.slice(e.dataOffset, e.dataOffset + e.size));
    n++;
  }
  report.extracted = { dir: base, files: n };
}

if (flag(o, 'json')) {
  report.listing = view.map((e) => ({
    path: e.name, kind: e.kind, size: e.size, mode: e.modeText, inode: e.inode,
    uid: e.uid, gid: e.gid, nlink: e.nlink, mtime: e.mtime, symlink: e.symlink,
    crcOk: e.checksum ? e.checksum.stored === e.checksum.computed : null,
  }));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`${src} — format ${format}${gzip ? ' (gzip)' : ''}, ${entries.length} entries, ${fmt(totals.bytes)} bytes`);
  console.log(table(view.slice(0, 400).map((e) => ({
    mode: e.modeText, size: fmt(e.size), inode: String(e.inode), mtime: e.mtime.slice(0, 19),
    path: e.name + (e.symlink ? ' -> ' + e.symlink : ''),
  })), ['mode', 'size', 'inode', 'mtime', 'path']));
  if (view.length > 400) console.log(`... ${view.length - 400} more`);
  console.log(`\nfiles=${totals.files} dirs=${totals.dirs} symlinks=${totals.symlinks} badCrc=${badCrc}`);
  if (badCrc) console.log(warnings.slice(0, 10).join('\n'));
  if (extractDir) console.log(`extracted ${report.extracted.files} file(s) under ${extractDir}`);
  if (dataHex) {
    for (const e of view.filter((x) => x.kind === 'file').slice(0, 8)) {
      console.log(`\n${e.name}`);
      console.log(bytes.slice(e.dataOffset, e.dataOffset + Math.min(dataHex, e.size)).toString('hex').replace(/(.{32})/g, '$1\n').trim());
    }
  }
}
