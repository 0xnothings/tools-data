// icoextract.js — read ICO/CUR containers: enumerate embedded PNG/BMP frames, extract by index.
// Copyright (c) 2026 0xnothings
// @tool icoextract
// @desc Enumerate and extract the PNG/BMP frames inside ICO and CUR icon files
// @usage node tools/icoextract.js app.ico --out ./icons --json
// @tags data,image,binary,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `icoextract — ICO / CUR frame reader

  node tools/icoextract.js <file.ico|file.cur> [options]

  --out <dir>      extract every frame into <dir>
  --index <n>      only the frame at index n (0-based)
  --largest        only the largest frame
  --json           machine-readable output
  -h, --help       this text

  Reports directory-entry metadata (width/height/planes/bit-count, CUR hotspot)
  and detects the payload of each frame: PNG (magic 89 50 4E 47) or DIB
  BITMAPINFOHEADER, including its true height (DIB height is doubled by the
  AND mask) and the embedded palette size.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'largest']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/icoextract.js app.ico');

const buf = readFileSync(src);
if (buf.length < 6) die('file too short to be an ICO/CUR');
const reserved = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);
if (reserved !== 0 || (type !== 1 && type !== 2)) die(`not an ICO/CUR (reserved=${reserved} type=${type}) — expected reserved 0, type 1 (ICO) or 2 (CUR)`);
const isCur = type === 2;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const frames = [];
for (let i = 0; i < count; i++) {
  const at = 6 + i * 16;
  if (at + 16 > buf.length) die(`directory entry ${i} truncated`);
  const w = buf[at] === 0 ? 256 : buf[at];
  const h = buf[at + 1] === 0 ? 256 : buf[at + 1];
  const colorCount = buf[at + 2];
  const planesOrHotX = buf.readUInt16LE(at + 4);
  const bppOrHotY = buf.readUInt16LE(at + 6);
  const bytesInRes = buf.readUInt32LE(at + 8);
  const imageOffset = buf.readUInt32LE(at + 12);
  const payload = buf.slice(imageOffset, Math.min(buf.length, imageOffset + bytesInRes));
  const frame = {
    index: i, dirWidth: w, dirHeight: h, dirColorCount: colorCount,
    entryPlanes: planesOrHotX, entryBitCountOrHotspotY: bppOrHotY,
    hotspot: isCur ? { x: planesOrHotX, y: bppOrHotY } : null,
    bytesInRes, offset: imageOffset, available: payload.length,
  };
  if (payload.length >= 8 && payload.slice(0, 8).equals(PNG_MAGIC)) {
    let ihdr = { width: null, height: null, bitDepth: null, colorType: null, interlace: null };
    const ihdrAt = payload.indexOf(Buffer.from('IHDR', 'ascii'));
    if (ihdrAt > 0) {
      ihdr = {
        width: payload.readUInt32BE(ihdrAt + 4), height: payload.readUInt32BE(ihdrAt + 8),
        bitDepth: payload[ihdrAt + 12], colorType: payload[ihdrAt + 13],
        compression: payload[ihdrAt + 14], filter: payload[ihdrAt + 15], interlace: payload[ihdrAt + 16],
      };
    }
    frame.payload = 'png';
    frame.image = ihdr;
    frame.bitDepth = ihdr.bitDepth;
    frame.channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType] ?? null;
  } else if (payload.length >= 40) {
    const dibSize = payload.readUInt32LE(0);
    const dw = payload.readInt32LE(4);
    const dh = payload.readInt32LE(8);
    const planes = payload.readUInt16LE(12);
    const bpp = payload.readUInt16LE(14);
    if (dibSize === 40 && payload.readUInt16LE(0) === 40 && dw > 0 && dw < 4096) {
      const compression = payload.readUInt32LE(16);
      const paletteEntries = buf.readUInt32LE(payload.length >= 36 ? 0 : 0);
      const colorsUsed = payload.length >= 36 ? payload.readUInt32LE(32) : 0;
      const realHeight = Math.abs(dh) / 2;
      const palCount = colorsUsed || (bpp <= 8 ? (1 << bpp) : 0);
      frame.payload = 'dib';
      frame.image = {
        width: dw, height: Math.round(realHeight), dibHeight: dh, topDown: dh < 0,
        planes, bitDepth: bpp, compression, colorsUsed: palCount,
        headerBytes: dibSize,
      };
      frame.bitDepth = bpp;
      frame.channels = bpp >= 32 ? 4 : bpp >= 24 ? 3 : 1;
      const pixelBytes = Math.abs(dh) * (((dw * bpp + 31) >> 5) << 2);
      frame.dibLayout = {
        pixelDataBytes: pixelBytes,
        maskRowBytes: (((dw + 31) >> 5) << 2),
        maskBytes: (((dw + 31) >> 5) << 2) * Math.round(realHeight),
        expectedTotal: 40 + palCount * 4 + pixelBytes + (((dw + 31) >> 5) << 2) * Math.round(realHeight),
        pngCompressed: false,
        paletteEntries: palCount,
      };
    } else {
      frame.payload = 'dib-unknown';
      frame.image = { dibSize, width: dw, height: dh };
      frame.bitDepth = bpp;
    }
  } else {
    frame.payload = 'truncated';
    frame.image = null;
  }
  frame.dimensions = frame.image ? { width: frame.image.width, height: frame.image.height } : { width: w, height: h };
  frames.push(frame);
}

let view = frames;
const idx = get(o, 'index', null);
if (idx !== null) {
  const n = num(idx, -1);
  view = frames.filter((f) => f.index === n);
  if (!view.length) die(`no frame at index ${n}`);
}
if (flag(o, 'largest') && frames.length) {
  const best = frames.reduce((a, b) => ((b.dimensions.width * b.dimensions.height) > (a.dimensions.width * a.dimensions.height) ? b : a));
  view = [best];
}

const outDir = get(o, 'out', null);
const report = {
  file: src, kind: isCur ? 'cursor' : 'icon', frames: frames.length,
  sizes: frames.map((f) => `${f.dimensions.width}x${f.dimensions.height}@${f.bitDepth ?? '?'}`),
  payloads: frames.reduce((a, f) => { a[f.payload] = (a[f.payload] || 0) + 1; return a; }, {}),
};

if (outDir) {
  mkdirSync(String(outDir), { recursive: true });
  const written = [];
  for (const f of view) {
    const ext = f.payload === 'png' ? 'png' : 'bmp';
    const p = join(String(outDir), `frame_${String(f.index).padStart(2, '0')}_${f.dimensions.width}x${f.dimensions.height}.${ext}`);
    writeFileSync(p, buf.slice(f.offset, f.offset + f.bytesInRes));
    written.push(p);
  }
  report.written = written;
}

if (flag(o, 'json')) {
  report.listing = view.map((f) => ({ ...f, dimensions: f.dimensions, dataOffset: f.offset }));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`${src} — ${isCur ? 'CUR' : 'ICO'}, ${count} frame(s)`);
  console.log(table(view.map((f) => ({
    idx: f.index, dir: `${f.dirWidth}x${f.dirHeight}`, image: f.payload,
    dims: f.image ? `${f.dimensions.width}x${f.dimensions.height}` : '-',
    depth: f.bitDepth ?? '-', bytes: fmt(f.bytesInRes), off: '0x' + f.offset.toString(16),
    hotspot: f.hotspot ? `${f.hotspot.x},${f.hotspot.y}` : '',
  })), ['idx', 'dir', 'image', 'dims', 'depth', 'bytes', 'off', 'hotspot']));
  for (const f of view) {
    if (f.dibLayout) console.log(`\n[${f.index}] DIB layout: ${JSON.stringify(f.dibLayout)}`);
    if (f.payload === 'dib' && f.bytesInRes && f.dibLayout && f.dibLayout.expectedTotal !== f.bytesInRes) {
      console.log(`  note: bytesInRes=${f.bytesInRes} vs computed=${f.dibLayout.expectedTotal}`);
    }
  }
  if (outDir) console.log(`\nwrote ${report.written.length} frame(s) to ${outDir}`);
}
