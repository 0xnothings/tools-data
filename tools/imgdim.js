#!/usr/bin/env node
// imgdim.js — read image dimensions from magic bytes, no dependencies.
// Copyright (c) 2026 0xnothings
// @tool imgdim
// @desc Read width/height/format from PNG, JPEG, GIF, WebP, BMP and TIFF headers
// @usage node tools/imgdim.js photo.jpg logo.png --json
// @tags media,images,metadata,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const HELP = `imgdim — image dimensions from magic bytes

  node tools/imgdim.js <file...> [options]

  --dir <path>        scan a directory (non-recursive unless --recursive)
  --recursive         recurse into subdirectories
  --ext <list>        restrict --dir scans to these extensions
  --min <n>           only report images with width*height >= n pixels
  --sort <mode>       none (default) | area | ratio | name
  --wide              only images wider than tall
  --tall              only images taller than wide
  --json              machine-readable output
  -h, --help          this text

  Supported: PNG (IHDR), JPEG (SOF0-15 walk), GIF87a/89a, WebP (VP8/VP8L/VP8X),
  BMP (BITMAPINFOHEADER / COREHEADER), TIFF (little and big endian IFD).
  Nothing is decoded — only the header is read, so huge files cost nothing.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const inputs = o._.slice();
const dirArg = get(o, 'dir', null);
if (!inputs.length && !dirArg) die('need at least one image path, or --dir <path>');

const extFilter = get(o, 'ext', null)
  ? String(get(o, 'ext')).split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase())
  : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'];

const targets = [...inputs];
if (dirArg) {
  const walk = (d, depth) => {
    if (depth > 32) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) { if (flag(o, 'recursive')) walk(full, depth + 1); continue; }
      if (!ent.isFile()) continue;
      const e = extname(ent.name).replace(/^\./, '').toLowerCase();
      if (extFilter.includes(e)) targets.push(full);
    }
  };
  walk(String(dirArg), 0);
}

function parseImage(buf) {
  if (buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.readUInt32BE(12) === 0x49484452) {
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      const bitDepth = buf[24], colorType = buf[25];
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 0;
      return { format: 'png', width: w, height: h, bitDepth, colorType, interlaced: buf[28] === 1, estimatedRaw: w * h * channels };
    }
    return null;
  }
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const version = buf.subarray(3, 6).toString('latin1');
    const w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
    return { format: 'gif', width: w, height: h, version, animated: buf.includes(Buffer.from('NETSCAPE2.0')) };
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    const dibSize = buf.length >= 18 ? buf.readUInt32LE(14) : 0;
    if (dibSize === 12) {
      return { format: 'bmp', width: buf.readUInt16LE(18), height: buf.readUInt16LE(20), bitDepth: buf.readUInt16LE(24), dib: 'CORE' };
    }
    const w = buf.readInt32LE(18);
    const hRaw = buf.readInt32LE(22);
    const topDown = hRaw < 0;
    const bitDepth = buf.length >= 30 ? buf.readUInt16LE(28) : 0;
    const compression = buf.length >= 34 ? buf.readUInt32LE(30) : 0;
    return { format: 'bmp', width: Math.abs(w), height: Math.abs(hRaw), bitDepth, topDown, compression, dib: 'INFO' };
  }
  // WebP
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ') {
      return { format: 'webp', variant: 'lossy', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { format: 'webp', variant: 'lossless', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'webp', variant: 'extended', width: w, height: h, alpha: !!(buf[20] & 0x10), animated: !!(buf[20] & 0x02) };
    }
    return { format: 'webp', variant: kind.trim(), width: 0, height: 0 };
  }
  // TIFF
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    const le = buf[0] === 0x49;
    const u16 = (o2) => (le ? buf.readUInt16LE(o2) : buf.readUInt16BE(o2));
    const u32 = (o2) => (le ? buf.readUInt32LE(o2) : buf.readUInt32BE(o2));
    const magic = u16(2);
    if (magic !== 42) return null;
    const ifd = u32(4);
    const count = u16(ifd);
    let width = 0, height = 0;
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > buf.length) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
      if (tag === 256) width = value;
      if (tag === 257) height = value;
    }
    return { format: 'tiff', width, height, littleEndian: le };
  }
  // JPEG: walk segments for a SOFn marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    const sofNames = {
      0xc0: 'baseline', 0xc1: 'extended', 0xc2: 'progressive', 0xc3: 'lossless',
      0xc5: 'differential', 0xc6: 'differential-progressive', 0xc7: 'differential-lossless',
      0xc9: 'arithmetic', 0xca: 'arithmetic-progressive', 0xcb: 'arithmetic-lossless',
      0xcd: 'differential-arithmetic', 0xce: 'differential-arithmetic-progressive', 0xcf: 'differential-arithmetic-lossless',
    };
    while (p < buf.length - 1) {
      if (buf[p] !== 0xff) { p++; continue; }
      let marker = buf[p + 1];
      while (marker === 0xff) { p++; marker = buf[p + 1]; }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
      if (p + 4 > buf.length) break;
      const len = buf.readUInt16BE(p + 2);
      if (sofNames[marker]) {
        const precision = buf[p + 4];
        const height = buf.readUInt16BE(p + 5);
        const width = buf.readUInt16BE(p + 7);
        const components = buf[p + 9];
        return { format: 'jpeg', width, height, kind: sofNames[marker], precision, components };
      }
      p += 2 + len;
    }
    return { format: 'jpeg', width: 0, height: 0, kind: 'no-sof-found' };
  }
  return null;
}

const rows = [];
let errors = 0;
for (const t of targets) {
  let buf;
  try {
    const st = statSync(t);
    // Read only the head — enough for every supported header.
    const fd = readFileSync(t);
    buf = fd.length > 512 * 1024 ? fd.subarray(0, 512 * 1024) : fd;
    const info = parseImage(buf);
    if (!info) { rows.push({ file: t, format: 'unknown', width: 0, height: 0, bytes: st.size }); errors++; continue; }
    rows.push({
      file: t,
      format: info.format,
      width: info.width,
      height: info.height,
      megapixels: Number(((info.width * info.height) / 1e6).toFixed(2)),
      ratio: info.height ? Number((info.width / info.height).toFixed(3)) : 0,
      orientation: info.width === info.height ? 'square' : info.width > info.height ? 'landscape' : 'portrait',
      bytes: st.size,
      detail: info,
    });
  } catch (e) {
    rows.push({ file: t, format: 'error', error: e.message, width: 0, height: 0 });
    errors++;
  }
}

let filtered = rows;
const minPx = num(get(o, 'min', 0), 0);
if (minPx) filtered = filtered.filter((r) => r.width * r.height >= minPx);
if (flag(o, 'wide')) filtered = filtered.filter((r) => r.width > r.height);
if (flag(o, 'tall')) filtered = filtered.filter((r) => r.height > r.width);

const sortMode = String(get(o, 'sort', 'none'));
if (sortMode === 'area') filtered = [...filtered].sort((a, b) => b.width * b.height - a.width * a.height);
else if (sortMode === 'ratio') filtered = [...filtered].sort((a, b) => b.ratio - a.ratio);
else if (sortMode === 'name') filtered = [...filtered].sort((a, b) => a.file.localeCompare(b.file));

const byFormat = filtered.reduce((acc, r) => { acc[r.format] = (acc[r.format] || 0) + 1; return acc; }, {});

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    count: filtered.length, errors, byFormat,
    totalPixels: filtered.reduce((s, r) => s + r.width * r.height, 0),
    images: filtered,
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(table(filtered.map((r) => ({
    file: basename(r.file),
    format: r.format,
    size: r.width && r.height ? `${r.width}x${r.height}` : '?',
    mp: r.megapixels ?? '',
    ratio: r.ratio ?? '',
    orient: r.orientation ?? '',
    kb: r.bytes ? Math.round(r.bytes / 1024) : '',
  })), ['file', 'format', 'size', 'mp', 'ratio', 'orient', 'kb']));
  out.push('');
  out.push(`${filtered.length} image(s)${errors ? `, ${errors} unreadable/unknown` : ''} — ${Object.entries(byFormat).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  process.stdout.write(out.join('\n') + '\n');
}
process.exit(errors && !filtered.length ? 2 : 0);
