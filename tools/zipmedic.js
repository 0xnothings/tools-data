#!/usr/bin/env node
// zipmedic.js — inspect a ZIP: central directory, compression, CRCs, corruption.
// Copyright (c) 2026 0xnothings
// @tool zipmedic
// @desc Parse a ZIP central directory, list entries/CRCs, verify and decompress members
// @usage node tools/zipmedic.js archive.zip --verify
// @tags archive,zip,cli,forensics
import { args, get, num, flag, die, table } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { basename, join } from 'node:path';

const HELP = `zipmedic — ZIP structure inspector and verifier

  node tools/zipmedic.js <archive.zip> [options]

  -l, --list        list entries (default action)
  --extract <dir>   extract all (or --only) entries to a directory
  --only <regex>    restrict --list/--extract to matching entry names
  --verify          decompress every member and check CRC-32 + sizes
  --cat <name>      print one entry's bytes to stdout
  --json            machine-readable output
  -h, --help        this text

  Reads the real End-Of-Central-Directory + central directory records (not
  local headers), so it survives streamed archives, data descriptors and
  prepended self-extractor stubs. Detects stored (0) and deflate (8).`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const zipPath = o._[0];
if (!zipPath) die('need a zip file — node tools/zipmedic.js archive.zip --list');

let buf;
try { buf = readFileSync(zipPath); } catch (e) { die(`cannot read ${zipPath}: ${e.message}`); }
if (buf.length < 22) die('file too small to be a zip');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

let eocd = -1;
const maxBack = Math.min(buf.length, 66000);
for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
  if (i < 0) break;
  if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
}
if (eocd < 0) die('no End-Of-Central-Directory record found — not a zip (or truncated)');

let entryCount = buf.readUInt16LE(eocd + 10);
let cdSize = buf.readUInt32LE(eocd + 12);
let cdOffset = buf.readUInt32LE(eocd + 16);
const commentLen = buf.readUInt16LE(eocd + 20);
let zip64 = false;

if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entryCount === 0xffff) {
  // Zip64 EOCD locator sits 20 bytes before EOCD.
  const loc = eocd - 20;
  if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    if (z64 + 56 <= buf.length && buf.readUInt32LE(z64) === 0x06064b50) {
      entryCount = Number(buf.readBigUInt64LE(z64 + 32));
      cdSize = Number(buf.readBigUInt64LE(z64 + 40));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      zip64 = true;
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(msdosDate, msdosTime) {
  const y = 1980 + ((msdosDate >> 9) & 0x7f);
  const mo = (msdosDate >> 5) & 0x0f;
  const d = msdosDate & 0x1f;
  const h = (msdosTime >> 11) & 0x1f;
  const mi = (msdosTime >> 5) & 0x3f;
  const s = (msdosTime & 0x1f) * 2;
  const dt = new Date(Date.UTC(y, Math.max(0, mo - 1), d || 1, h, mi, s));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().replace('.000Z', 'Z');
}

const entries = [];
let p = cdOffset;
for (let n = 0; n < entryCount; n++) {
  if (p + 46 > buf.length) { die(`central directory truncated at entry ${n} (offset ${p})`); }
  if (buf.readUInt32LE(p) !== CD_SIG) { die(`bad central directory signature at offset ${p} (entry ${n})`); }
  const versionMadeBy = buf.readUInt16LE(p + 4);
  const versionNeeded = buf.readUInt16LE(p + 6);
  const gpFlags = buf.readUInt16LE(p + 8);
  const method = buf.readUInt16LE(p + 10);
  const modTime = buf.readUInt16LE(p + 12);
  const modDate = buf.readUInt16LE(p + 14);
  const crc = buf.readUInt32LE(p + 16);
  let compSize = buf.readUInt32LE(p + 20);
  let uncompSize = buf.readUInt32LE(p + 24);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const cmtLen = buf.readUInt16LE(p + 32);
  const diskStart = buf.readUInt16LE(p + 34);
  const intAttr = buf.readUInt16LE(p + 36);
  const extAttr = buf.readUInt32LE(p + 38);
  let lfhOffset = buf.readUInt32LE(p + 42);
  const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
  let name = nameBuf.toString('utf8');
  const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

  // Zip64 extended information extra field (0x0001)
  if ((compSize === 0xffffffff || uncompSize === 0xffffffff || lfhOffset === 0xffffffff) && extra.length >= 4) {
    let e = 0;
    while (e + 4 <= extra.length) {
      const hid = extra.readUInt16LE(e);
      const hsz = extra.readUInt16LE(e + 2);
      if (hid === 0x0001) {
        let q = e + 4;
        if (uncompSize === 0xffffffff && q + 8 <= extra.length) { uncompSize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff && q + 8 <= extra.length) { compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (lfhOffset === 0xffffffff && q + 8 <= extra.length) { lfhOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (diskStart === 0xffff && q + 4 <= extra.length) q += 4;
      }
      e += 4 + hsz;
    }
  }

  if (gpFlags & 0x800) { /* UTF-8 name */ }
  else if (!/^[\x20-\x7e]*$/.test(name)) name = nameBuf.toString('latin1');

  entries.push({
    name, method, versionMadeBy, versionNeeded, gpFlags,
    crc32: crc.toString(16).padStart(8, '0'),
    crcValue: crc,
    compressedSize: compSize,
    uncompressedSize: uncompSize,
    modified: dosTime(modDate, modTime),
    directory: name.endsWith('/'),
    encrypted: !!(gpFlags & 0x1),
    dataDescriptor: !!(gpFlags & 0x8),
    deflateLevel: (gpFlags >> 1) & 0x3,
    diskStart, internalAttrs: intAttr,
    unixMode: (versionMadeBy >> 8) === 3 ? (extAttr >>> 16) : null,
    externalAttrs: extAttr,
    lfhOffset,
    headerOffset: p,
    comment: buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + cmtLen).toString('utf8'),
    ratio: compSize > 0 && uncompSize > 0 ? 1 - compSize / uncompSize : 0,
  });
  p += 46 + nameLen + extraLen + cmtLen;
}

function readMember(entry) {
  const off = entry.lfhOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) {
    return { ok: false, error: 'local file header missing or misaligned' };
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  if (start + entry.compressedSize > buf.length) return { ok: false, error: 'data extends past end of file (truncated)' };
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.encrypted) return { ok: false, error: 'encrypted entry — cannot decompress' };
  let out;
  try {
    if (entry.method === 0) out = Buffer.from(data);
    else if (entry.method === 8) out = inflateRawSync(data);
    else return { ok: false, error: `unsupported compression method ${entry.method}` };
  } catch (e) {
    return { ok: false, error: `inflate failed: ${e.message}` };
  }
  const problems = [];
  if (out.length !== entry.uncompressedSize) problems.push(`size mismatch: got ${out.length}, header says ${entry.uncompressedSize}`);
  const c = crc32(out);
  if (c !== entry.crcValue) problems.push(`crc mismatch: got ${c.toString(16).padStart(8, '0')}, header says ${entry.crc32}`);
  return { ok: problems.length === 0, data: out, problems };
}

const totalComp = entries.reduce((s, e) => s + e.compressedSize, 0);
const totalUncomp = entries.reduce((s, e) => s + e.uncompressedSize, 0);
const dirs = entries.filter((e) => e.directory).length;
const junk = entries.filter((e) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)/i.test(e.name));
const suspicious = entries.filter((e) => /\.\.(\/|\\)|^\/|[A-Za-z]:\\/.test(e.name));
const dupNames = (() => {
  const seen = new Map(), dups = [];
  for (const e of entries) {
    if (seen.has(e.name)) dups.push(e.name);
    seen.set(e.name, true);
  }
  return dups;
})();

const onlyRaw = get(o, 'only', null);
let onlyRe = null;
if (onlyRaw) { try { onlyRe = new RegExp(String(onlyRaw), 'i'); } catch (e) { die(`bad --only regex: ${e.message}`); } }
let sel = onlyRe ? entries.filter((e) => onlyRe.test(e.name)) : entries;

const catName = get(o, 'cat', null);
if (catName) {
  const e = entries.find((x) => x.name === catName);
  if (!e) die(`no entry named ${catName}`);
  const m = readMember(e);
  if (!m.ok) die(`cannot read ${catName}: ${(m.problems || [m.error]).join('; ')}`);
  process.stdout.write(m.data);
  process.exit(0);
}

let verification = null;
if (flag(o, 'verify')) {
  verification = [];
  for (const e of sel) {
    if (e.directory) continue;
    const m = readMember(e);
    verification.push({ name: e.name, ok: m.ok, bytes: m.data ? m.data.length : 0, problems: m.problems || (m.error ? [m.error] : []) });
  }
}

const extractDir = get(o, 'extract', null);
if (extractDir) {
  const { mkdirSync } = await import('node:fs');
  let ok = 0, failed = 0;
  for (const e of sel) {
    const safe = e.name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
    if (!safe) continue;
    if (e.directory) { mkdirSync(join(extractDir, safe), { recursive: true }); continue; }
    const m = readMember(e);
    if (!m.ok && !m.data) { failed++; if (!flag(o, 'quiet')) process.stderr.write(`skip ${e.name}: ${(m.problems || [m.error]).join('; ')}\n`); continue; }
    const target = join(extractDir, safe);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, m.data);
    ok++;
  }
  const out = { archive: zipPath, extracted: ok, failed, dir: extractDir };
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ ...out, verification }, null, 2) + '\n');
  else process.stdout.write(`extracted ${ok} file(s) to ${extractDir}${failed ? `, ${failed} failed` : ''}\n`);
  process.exit(failed ? 2 : 0);
}

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    archive: basename(zipPath),
    zip64,
    comment: buf.subarray(eocd + 22, eocd + 22 + commentLen).toString('utf8'),
    entryCount: entries.length,
    directories: dirs,
    totalCompressed: totalComp,
    totalUncompressed: totalUncomp,
    compressionRatio: totalUncomp ? 1 - totalComp / totalUncomp : 0,
    endOfCentralDirectory: eocd,
    centralDirectoryOffset: cdOffset,
    centralDirectorySize: cdSize,
    warnings: {
      macMetadata: junk.map((e) => e.name),
      pathTraversal: suspicious.map((e) => e.name),
      duplicateNames: dupNames,
      encrypted: entries.filter((e) => e.encrypted).map((e) => e.name),
    },
    verification,
    entries,
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`archive     ${basename(zipPath)}  (${buf.length.toLocaleString('en-US')} bytes${zip64 ? ', zip64' : ''})`);
  out.push(`entries     ${entries.length} (+${dirs} directories)`);
  out.push(`payload     ${totalUncomp.toLocaleString('en-US')} bytes -> ${totalComp.toLocaleString('en-US')} bytes compressed (${totalUncomp ? ((1 - totalComp / totalUncomp) * 100).toFixed(1) : '0.0'}% saved)`);
  out.push(`eocd @      ${eocd}   central dir @ ${cdOffset} (${cdSize} bytes)`);
  if (eocd + 22 + commentLen > buf.length) out.push('WARN        archive comment length runs past EOF — structurally odd');
  if (junk.length) out.push(`WARN        ${junk.length} macOS/Windows metadata entries`);
  if (suspicious.length) out.push(`WARN        ${suspicious.length} entry name(s) with path traversal — ${suspicious.slice(0, 3).map((e) => e.name).join(', ')}`);
  if (dupNames.length) out.push(`WARN        duplicate entry names: ${dupNames.slice(0, 3).join(', ')}`);
  const enc = entries.filter((e) => e.encrypted);
  if (enc.length) out.push(`WARN        ${enc.length} encrypted entr(ies)`);
  out.push('');
  const shown = sel.slice(0, 300).map((e) => ({
    name: e.name.length > 52 ? e.name.slice(0, 49) + '...' : e.name,
    size: e.uncompressedSize.toLocaleString('en-US'),
    comp: e.compressedSize.toLocaleString('en-US'),
    method: e.method === 0 ? 'store' : e.method === 8 ? 'deflate' : `m${e.method}`,
    crc: e.crc32,
    mod: (e.modified || '').slice(0, 10),
    flags: [e.directory ? 'dir' : '', e.encrypted ? 'enc' : '', e.dataDescriptor ? 'dd' : ''].filter(Boolean).join(','),
  }));
  out.push(table(shown, ['name', 'size', 'comp', 'method', 'crc', 'mod', 'flags']));
  if (entries.length > 300) out.push(`... ${entries.length - 300} more`);
  if (verification) {
    const bad = verification.filter((v) => !v.ok);
    out.push('', `VERIFY ${verification.length - bad.length}/${verification.length} entries clean`);
    for (const b of bad.slice(0, 20)) out.push(`  BAD ${b.name}: ${b.problems.join('; ')}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (verification && verification.some((v) => !v.ok)) process.exit(2);
