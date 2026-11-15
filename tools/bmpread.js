#!/usr/bin/env node
// bmpread.js — BMP header parser (v2/v3/v4/v5 DIB): geometry, bpp, compression, palette.
// Copyright (c) 2026 0xnothings
// @tool bmpread
// @desc Parse BMP files: DIB variant, geometry, bit depth, compression, palette and pixel-byte validation
// @usage node tools/bmpread.js image.bmp --json
// @tags data,image,binary,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `bmpread — BMP header / pixel layout parser

  node tools/bmpread.js <file.bmp> [options]

  --palette          print the colour table (max 256 entries)
  --pixels           decode and print the first N pixels as hex (needs --n)
  --n <count>        how many pixels to print (default 8)
  --json             machine-readable output
  -h, --help         this text

  Understands BITMAPCOREHEADER (12), BITMAPINFOHEADER (40), V2 (52), V3 (56),
  V4 (108), V5 (124) and OS/2 v2 (64). Validates that the declared file size,
  pixel offset and computed pixel array size agree — the usual tell for a
  truncated or deliberately malformed BMP.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'palette', 'pixels']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/bmpread.js image.bmp');

const b = readFileSync(src);
if (b.length < 26) die('file too short to be a BMP');
if (b[0] !== 0x42 || b[1] !== 0x4d) die(`bad magic ${b.slice(0, 2).toString('hex')} — expected 424d ("BM")`);

const declaredSize = b.readUInt32LE(2);
const reserved1 = b.readUInt16LE(6);
const reserved2 = b.readUInt16LE(8);
const pixelOffset = b.readUInt32LE(10);
const dibSize = b.readUInt32LE(14);

const DIB_NAMES = { 12: 'BITMAPCOREHEADER (v2)', 40: 'BITMAPINFOHEADER (v3)', 52: 'BITMAPV2INFOHEADER', 56: 'BITMAPV3INFOHEADER', 64: 'OS/2 v2', 108: 'BITMAPV4HEADER', 124: 'BITMAPV5HEADER' };
const COMPRESSION = { 0: 'BI_RGB', 1: 'BI_RLE8', 2: 'BI_RLE4', 3: 'BI_BITFIELDS', 4: 'BI_JPEG', 5: 'BI_PNG', 6: 'BI_ALPHABITFIELDS', 11: 'BI_CMYK', 12: 'BI_CMYKRLE8', 13: 'BI_CMYKRLE4' };

let header, paletteEntries = 0, palette = [];
if (dibSize === 12) {
  header = {
    width: b.readUInt16LE(18), height: b.readUInt16LE(20),
    planes: b.readUInt16LE(22), bitDepth: b.readUInt16LE(24),
    compression: 0, imageSize: 0, xppm: 0, yppm: 0, colorsUsed: 0, colorsImportant: 0, topDown: false,
  };
} else {
  header = {
    width: b.readInt32LE(18),
    height: b.readInt32LE(22),
    planes: b.readUInt16LE(26),
    bitDepth: b.readUInt16LE(28),
    compression: b.readUInt32LE(30),
    imageSize: b.readUInt32LE(34),
    xppm: b.readInt32LE(38),
    yppm: b.readInt32LE(42),
    colorsUsed: b.readUInt32LE(46),
    colorsImportant: b.readUInt32LE(50),
    topDown: b.readInt32LE(22) < 0,
  };
  header.height = Math.abs(header.height);
  if (dibSize >= 108 && b.length >= 14 + 108) {
    header.masks = { r: b.readUInt32LE(54), g: b.readUInt32LE(58), bl: b.readUInt32LE(62), a: b.readUInt32LE(66) };
    header.colorSpace = '0x' + b.readUInt32LE(70).toString(16);
    header.gamma = { r: b.readUInt32LE(74), g: b.readUInt32LE(78), b: b.readUInt32LE(82) };
  }
}

const dibHeaderBytes = Math.min(dibSize, b.length - 14);
const paletteStart = 14 + (dibSize === 40 && header.compression === 3 ? 40 + 12 : dibSize);
const entrySize = dibSize === 12 ? 3 : 4;
const maxPal = header.bitDepth <= 8 ? (1 << header.bitDepth) : 0;
paletteEntries = header.colorsUsed || (header.bitDepth <= 8 ? maxPal : 0);
if (paletteEntries > maxPal && maxPal) paletteEntries = maxPal;
const paletteBytes = paletteEntries * entrySize;
if (flag(o, 'palette') && paletteEntries) {
  for (let i = 0; i < Math.min(paletteEntries, 256); i++) {
    const at = paletteStart + i * entrySize;
    if (at + entrySize > b.length) break;
    palette.push(dibSize === 12
      ? { i, r: b[at + 2], g: b[at + 1], bl: b[at], a: 0 }
      : { i, bl: b[at], g: b[at + 1], r: b[at + 2], a: b[at + 3] });
  }
}

const rowStride = (((header.width * header.bitDepth + 31) >> 5) << 2);
const pixelRowBytes = header.bitDepth === 0 ? 0 : rowStride;
const computedPixels = pixelRowBytes * header.height;
const availablePixels = Math.max(0, b.length - pixelOffset);
const expectedFile = pixelOffset + computedPixels;

const known = [0, 1, 2, 3, 4, 5, 6, 11, 12, 13];
const checks = [
  { test: 'magic "BM"', ok: true },
  { test: 'DIB header size recognised', ok: dibSize in DIB_NAMES, detail: `${dibSize} bytes` },
  { test: 'declared file size matches actual', ok: declaredSize === b.length, detail: `declared=${declaredSize} actual=${b.length}` },
  { test: 'pixel offset inside file', ok: pixelOffset > 0 && pixelOffset <= b.length, detail: `offset=${pixelOffset}` },
  { test: 'pixel offset after headers', ok: pixelOffset >= 14 + dibSize, detail: `min=${14 + dibSize}` },
  { test: 'pixel array fully present', ok: availablePixels >= computedPixels, detail: `need=${computedPixels} have=${availablePixels}` },
  { test: 'compression known', ok: known.includes(header.compression), detail: COMPRESSION[header.compression] || `code ${header.compression}` },
  { test: 'bpp in {1,4,8,16,24,32}', ok: [1, 4, 8, 16, 24, 32].includes(header.bitDepth), detail: `${header.bitDepth} bpp` },
  { test: 'planes == 1', ok: header.planes === 1, detail: `${header.planes}` },
  { test: 'imageSize zero or == computed', ok: header.imageSize === 0 || header.imageSize === computedPixels, detail: `declared=${header.imageSize} computed=${computedPixels}` },
];

const issues = checks.filter((c) => !c.ok);
const pixelHex = [];
if (flag(o, 'pixels') && availablePixels > 0) {
  const n = Math.max(1, Math.min(256, num(get(o, 'n', 8), 8)));
  const bytesPerPixel = Math.max(1, Math.ceil(header.bitDepth / 8));
  const firstRowStart = header.topDown ? pixelOffset : pixelOffset + computedPixels - pixelRowBytes;
  for (let i = 0; i < n; i++) {
    const at = firstRowStart + i * bytesPerPixel;
    if (at + bytesPerPixel > b.length) break;
    pixelHex.push(b.slice(at, at + bytesPerPixel).toString('hex'));
  }
}

const report = {
  file: src,
  fileSize: b.length,
  declaredFileSize: declaredSize,
  dibSize,
  dibVariant: DIB_NAMES[dibSize] || `unknown(${dibSize})`,
  header,
  compressionName: COMPRESSION[header.compression] || `unknown(${header.compression})`,
  topDown: !!header.topDown,
  paletteEntries,
  paletteBytes,
  palette: palette.length ? palette : undefined,
  pixelOffset,
  headersToPixels: pixelOffset - 14 - dibSize,
  rowStrideBytes: rowStride,
  computedPixelBytes: computedPixels,
  availablePixelBytes: availablePixels,
  trailingBytes: Math.max(0, b.length - expectedFile),
  dimensions: { width: header.width, height: header.height, megapixels: Number(((header.width * header.height) / 1e6).toFixed(3)) },
  colors: header.bitDepth <= 8 ? 1 << header.bitDepth : header.bitDepth === 16 ? 65536 : null,
  checks,
  problems: issues.map((c) => `${c.test} — ${c.detail || 'FAILED'}`),
  ...(pixelHex.length ? { samplePixels: pixelHex } : {}),
};

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — ${report.dibVariant}, ${header.width}x${header.height}, ${header.bitDepth} bpp, ${report.compressionName}`);
  console.log(table([
    { field: 'file size', value: `${fmt(b.length)} bytes (declared ${fmt(declaredSize)})` },
    { field: 'DIB header', value: `${dibSize} bytes` },
    { field: 'dimensions', value: `${header.width} x ${header.height}${header.topDown ? ' (top-down)' : ''}` },
    { field: 'planes', value: String(header.planes) },
    { field: 'bit depth', value: `${header.bitDepth} bpp` },
    { field: 'compression', value: report.compressionName },
    { field: 'pixel data offset', value: `${pixelOffset} (0x${pixelOffset.toString(16)})` },
    { field: 'row stride', value: `${rowStride} bytes` },
    { field: 'computed pixels', value: `${fmt(computedPixels)} bytes` },
    { field: 'available pixels', value: `${fmt(availablePixels)} bytes` },
    { field: 'palette', value: paletteEntries ? `${paletteEntries} entries (${paletteBytes} bytes)` : 'none' },
    { field: 'resolution', value: header.xppm ? `${header.xppm} x ${header.yppm} px/m` : 'unspecified' },
    { field: 'trailing bytes', value: String(report.trailingBytes) },
  ], ['field', 'value']));
  console.log('\nCHECKS');
  console.log(table(checks.map((c) => ({ check: c.test, result: c.ok ? 'ok' : 'FAIL', detail: c.detail || '' })), ['check', 'result', 'detail']));
  if (issues.length) console.log(`\n${issues.length} problem(s) found — file may be truncated or malformed`);
  if (palette.length) {
    console.log('\nPALETTE (first 32)');
    console.log(palette.slice(0, 32).map((p) => `${String(p.i).padStart(3)}: rgb(${p.r},${p.g},${p.bl})`).join('\n'));
  }
  if (pixelHex.length) console.log('\nfirst pixels (bottom row unless top-down): ' + pixelHex.join(' '));
}
