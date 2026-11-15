// genimg.mjs — build tiny valid test images (PNG/GIF/BMP/JPEG+EXIF) for verification.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// PNG 320x200 truecolor
{
  const w = 320, h = 200;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) { raw[off + 1 + x * 3] = x % 256; raw[off + 2 + x * 3] = y % 256; raw[off + 3 + x * 3] = 128; }
  }
  writeFileSync('gen.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// GIF 200x100
{
  const b = Buffer.alloc(13 + 10 + 12);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(200, 6); b.writeUInt16LE(100, 8);
  b[10] = 0x00; b[11] = 0; b[12] = 0;
  b[13] = 0x2c;
  b.writeUInt16LE(0, 14); b.writeUInt16LE(0, 16); b.writeUInt16LE(200, 18); b.writeUInt16LE(100, 20); b[21] = 0;
  b[22] = 2; b[23] = 2; b[24] = 0x44; b[25] = 0x01;
  b[26] = 0x3b;
  writeFileSync('gen.gif', b.subarray(0, 27));
}
// BMP 128x64 24bpp
{
  const w = 128, h = 64, rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * h, 0x40);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(w, 4); dib.writeInt32LE(h, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14);
  const fileSize = 14 + 40 + pixels.length;
  const fh = Buffer.alloc(14);
  fh.write('BM', 0, 'latin1'); fh.writeUInt32LE(fileSize, 2); fh.writeUInt32LE(54, 10);
  writeFileSync('gen.bmp', Buffer.concat([fh, dib, pixels]));
}

// JPEG with EXIF (camera, date, GPS) — 800x600, minimal SOF0
function exifBlock() {
  // TIFF little-endian
  const entries = [];
  const gpsValues = {};
  const ifd0 = [];
  const exifIfd = [];
  const gpsIfd = [];

  const SHORT = 3, LONG = 4, ASCII = 2, RATIONAL = 5, UNDEFINED = 7;

  // Build with a simple layout: header 8 bytes, then IFD0, then data area.
  const enc = {
    ascii: (s) => {
      const b = Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);
      if (b.length <= 4) {
        const pad = Buffer.alloc(4); b.copy(pad);
        return { type: ASCII, count: b.length, inlineBuf: pad };
      }
      return { type: ASCII, count: b.length, data: b };
    },
    short: (n) => ({ type: SHORT, count: 1, inline: n }),
    long: (n) => ({ type: LONG, count: 1, inline: n }),
    rational: (n, d) => ({ type: RATIONAL, count: 1, data: (() => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); b.writeUInt32LE(d, 4); return b; })() }),
    rationals: (pairs) => ({ type: RATIONAL, count: pairs.length, data: (() => { const b = Buffer.alloc(8 * pairs.length); pairs.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4); }); return b; })() }),
    undefined: (buf) => ({ type: UNDEFINED, count: buf.length, data: buf }),
  };

  ifd0.push([0x010f, enc.ascii('0xnothings Cameras')]);
  ifd0.push([0x0110, enc.ascii('X1000 Mark II')]);
  ifd0.push([0x0112, enc.short(6)]);
  ifd0.push([0x011a, enc.rational(72, 1)]);
  ifd0.push([0x011b, enc.rational(72, 1)]);
  ifd0.push([0x0128, enc.short(2)]);
  ifd0.push([0x0131, enc.ascii('firmware 1.2.3')]);
  ifd0.push([0x0132, enc.ascii('2024:06:14 09:32:11')]);
  exifIfd.push([0x829a, enc.rational(1, 250)]);
  exifIfd.push([0x829d, enc.rational(28, 10)]);
  exifIfd.push([0x8827, enc.short(200)]);
  exifIfd.push([0x9003, enc.ascii('2024:06:14 09:32:11')]);
  exifIfd.push([0x920a, enc.rational(35, 1)]);
  exifIfd.push([0xa002, enc.long(800)]);
  exifIfd.push([0xa003, enc.long(600)]);
  exifIfd.push([0xa434, enc.ascii('XF 35mm F1.4')]);
  exifIfd.push([0xa431, enc.ascii('SN-0042-ABCD')]);
  gpsIfd.push([0x0001, enc.ascii('N')]);
  gpsIfd.push([0x0002, enc.rationals([[40, 1], [44, 1], [5412, 100]])]);
  gpsIfd.push([0x0003, enc.ascii('W')]);
  gpsIfd.push([0x0004, enc.rationals([[73, 1], [59, 1], [810, 100]])]);
  gpsIfd.push([0x0005, enc.short(0)]);
  gpsIfd.push([0x0006, enc.rational(1250, 100)]);
  gpsIfd.push([0x0007, enc.rationals([[9, 1], [32, 1], [11, 1]])]);
  gpsIfd.push([0x001d, enc.ascii('2024:06:14')]);
  void gpsValues; void entries;

  const exifPtrTag = 0x8769, gpsPtrTag = 0x8825;
  const ifdSize = (n) => 2 + n * 12 + 4;
    const offIfd0 = 8;
    const n0 = ifd0.length + 2;
    const offIfd0End = offIfd0 + ifdSize(n0);
    const offExif = offIfd0End;
    const offExifEnd = offExif + ifdSize(exifIfd.length);
    const offGps = offExifEnd;
    const offGpsEnd = offGps + ifdSize(gpsIfd.length);
    let dataOff = offGpsEnd;
    void dataOff;

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1'); header.writeUInt16LE(42, 2); header.writeUInt32LE(offIfd0, 4);

  const dataChunks = [];
  const writeIfd = (entriesArr) => {
    const b = Buffer.alloc(ifdSize(entriesArr.length));
    b.writeUInt16LE(entriesArr.length, 0);
    entriesArr.forEach(([tag, e], i) => {
      const at = 2 + i * 12;
      b.writeUInt16LE(tag, at);
      b.writeUInt16LE(e.type, at + 2);
      b.writeUInt32LE(e.count, at + 4);
      if (e.inline !== undefined) {
        if (e.type === SHORT) b.writeUInt16LE(e.inline, at + 8);
        else b.writeUInt32LE(e.inline, at + 8);
      } else if (e.inlineBuf) {
        e.inlineBuf.copy(b, at + 8);
      } else {
        b.writeUInt32LE(dataOff, at + 8);
        dataChunks.push(e.data);
        dataOff += e.data.length;
        if (dataOff % 2) { dataChunks.push(Buffer.from([0])); dataOff++; }
      }
    });
    return b;
  };

  const ifd0Entries = [...ifd0, [exifPtrTag, { type: LONG, count: 1, inline: offExif }], [gpsPtrTag, { type: LONG, count: 1, inline: offGps }]];
  // offsets must be computed with the pointer entries sorted by tag; rebuild order
  ifd0Entries.sort((a, b) => a[0] - b[0]);
  const ifd0Buf = writeIfd(ifd0Entries);
  ifd0Buf.writeUInt32LE(0, ifd0Buf.length - 4);
  const exifBuf = writeIfd([...exifIfd].sort((a, b) => a[0] - b[0]));
  exifBuf.writeUInt32LE(0, exifBuf.length - 4);
  const gpsBuf = writeIfd([...gpsIfd].sort((a, b) => a[0] - b[0]));
  gpsBuf.writeUInt32LE(0, gpsBuf.length - 4);

  return Buffer.concat([header, ifd0Buf, exifBuf, gpsBuf, ...dataChunks]);
}

{
  const w = 800, h = 600;
  const exif = exifBlock();
  const app1Len = exif.length + 8;
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(app1Len); return b; })(),
    Buffer.from('Exif\0\0', 'latin1'), exif,
  ]);
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 3);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(sof.length - 2, 2);
  sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 1; sof[10] = 1; sof[11] = 0x11; sof[12] = 0;
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  writeFileSync('gen.jpg', Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, sos, Buffer.alloc(200, 0x11), Buffer.from([0xff, 0xd9])]));
}
console.log('generated gen.png gen.gif gen.bmp gen.jpg');
