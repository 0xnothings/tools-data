// exifread.js — minimal JPEG EXIF/TIFF parser, no dependencies.
// Copyright (c) 2026 0xnothings
// @tool exifread
// @desc Parse JPEG EXIF: camera, exposure, orientation, timestamps, GPS coordinates
// @usage node tools/exifread.js photo.jpg --json
// @tags media,images,exif,metadata,cli
import { args, get, flag, die, table } from '../_lib.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const HELP = `exifread — read JPEG EXIF metadata

  node tools/exifread.js <file...> [options]

  --dir <path>        scan a directory for *.jpg/*.jpeg/*.tif
  --recursive         recurse into subdirectories
  --all               dump every tag, not just the curated set
  --strip             print a summary suitable for privacy auditing
  --json              machine-readable output
  -h, --help          this text

  Handles both byte orders, IFD0/ExifIFD/GPSIFD, all standard value types
  (BYTE..DOUBLE), and decodes GPS lat/lon/alt into decimal degrees.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const inputs = o._.slice();
const dirArg = get(o, 'dir', null);
if (!inputs.length && !dirArg) die('need a JPEG path, or --dir <path>');

const targets = [...inputs];
if (dirArg) {
  const walk = (d, depth) => {
    if (depth > 32) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) { if (flag(o, 'recursive')) walk(full, depth + 1); continue; }
      if (ent.isFile() && /\.(jpe?g|jpe|tiff?)$/i.test(ent.name)) targets.push(full);
    }
  };
  walk(String(dirArg), 0);
}

const TAG_NAMES = {
  0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0x0102: 'BitsPerSample', 0x0103: 'Compression',
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
  0x011a: 'XResolution', 0x011b: 'YResolution', 0x011c: 'PlanarConfig', 0x0128: 'ResolutionUnit',
  0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x013e: 'WhitePoint',
  0x0213: 'YCbCrPositioning', 0x8298: 'Copyright', 0x8769: 'ExifIFDPointer', 0x8825: 'GPSInfoIFDPointer',
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8827: 'ISO',
  0x8830: 'SensitivityType', 0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9101: 'ComponentsConfig',
  0x9102: 'CompressedBitsPerPixel', 0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue',
  0x9203: 'BrightnessValue', 0x9204: 'ExposureBias', 0x9205: 'MaxApertureValue',
  0x9206: 'SubjectDistance', 0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash',
  0x920a: 'FocalLength', 0x9214: 'SubjectArea', 0x927c: 'MakerNote', 0x9286: 'UserComment',
  0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized',
  0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension',
  0xa004: 'RelatedSoundFile', 0xa005: 'InteropIFDPointer', 0xa20e: 'FocalPlaneXResolution',
  0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit', 0xa217: 'SensingMethod',
  0xa300: 'FileSource', 0xa301: 'SceneType', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance',
  0xa404: 'DigitalZoomRatio', 0xa405: 'FocalLengthIn35mm', 0xa406: 'SceneCaptureType',
  0xa407: 'GainControl', 0xa408: 'Contrast', 0xa409: 'Saturation', 0xa40a: 'Sharpness',
  0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
  0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber',
  0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp',
  0x0008: 'GPSSatellites', 0x0009: 'GPSStatus', 0x000a: 'GPSMeasureMode', 0x000b: 'GPSDOP',
  0x000c: 'GPSSpeedRef', 0x000d: 'GPSSpeed', 0x001d: 'GPSDateStamp', 0x001f: 'GPSHPositioningError',
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readValue(buf, valOff, type, count, le) {
  const size = (TYPE_SIZE[type] || 1) * count;
  const base = size <= 4 ? valOff : valOff;
  if (base + size > buf.length) return null;
  const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  switch (type) {
    case 1: case 7: return [...buf.subarray(base, base + count)];
    case 2: {
      let s = buf.subarray(base, base + count).toString('latin1');
      return s.replace(/\0+$/, '');
    }
    case 3: { const out = []; for (let i = 0; i < count; i++) out.push(u16(base + i * 2)); return count === 1 ? out[0] : out; }
    case 4: { const out = []; for (let i = 0; i < count; i++) out.push(u32(base + i * 4)); return count === 1 ? out[0] : out; }
    case 5: {
      const out = [];
      for (let i = 0; i < count; i++) { const n = u32(base + i * 8), d = u32(base + i * 8 + 4); out.push(d ? n / d : 0); }
      return count === 1 ? out[0] : out;
    }
    case 6: { const out = []; for (let i = 0; i < count; i++) out.push(buf.readInt8(base + i)); return count === 1 ? out[0] : out; }
    case 8: { const out = []; for (let i = 0; i < count; i++) out.push(le ? buf.readInt16LE(base + i * 2) : buf.readInt16BE(base + i * 2)); return count === 1 ? out[0] : out; }
    case 9: { const out = []; for (let i = 0; i < count; i++) out.push(le ? buf.readInt32LE(base + i * 4) : buf.readInt32BE(base + i * 4)); return count === 1 ? out[0] : out; }
    case 10: {
      const out = [];
      for (let i = 0; i < count; i++) {
        const n = le ? buf.readInt32LE(base + i * 8) : buf.readInt32BE(base + i * 8);
        const d = le ? buf.readInt32LE(base + i * 8 + 4) : buf.readInt32BE(base + i * 8 + 4);
        out.push(d ? n / d : 0);
      }
      return count === 1 ? out[0] : out;
    }
    case 11: { const out = []; for (let i = 0; i < count; i++) out.push(buf.readFloatLE(base + i * 4)); return count === 1 ? out[0] : out; }
    case 12: { const out = []; for (let i = 0; i < count; i++) out.push(buf.readDoubleLE(base + i * 8)); return count === 1 ? out[0] : out; }
    default: return null;
  }
}

function parseTiff(buf, start, tiffBase) {
  const le = buf[start] === 0x49;
  if (!((buf[start] === 0x49 && buf[start + 1] === 0x49) || (buf[start] === 0x4d && buf[start + 1] === 0x4d))) return null;
  if (buf[start + 2] !== 0x2a && !(buf[start + 2] === 0x2a && buf[start + 3] === 0x00)) return null;
  const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  const tiffStart = start;

  const out = { byteOrder: le ? 'little' : 'big', ifds: {} };
  const seen = new Set();

  function readIFD(offset, label) {
    const abs = tiffStart + offset;
    if (abs < 0 || abs + 2 > buf.length || seen.has(label)) return null;
    seen.add(label);
    const count = u16(abs);
    const tags = {};
    let exifPtr = null, gpsPtr = null, interopPtr = null;
    for (let i = 0; i < count; i++) {
      const e = abs + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const valOff = type === 3 && n === 1 ? e + 8 : type === 4 && n === 1 ? e + 8 : type === 1 && n <= 4 ? e + 8 : e + 8;
      const actual = (TYPE_SIZE[type] || 1) * n <= 4 ? e + 8 : tiffStart + u32(e + 8);
      void valOff;
      let value = readValue(buf, actual, type, n, le);
      if (tag === 0x8769 && typeof value === 'number') exifPtr = value;
      if (tag === 0x8825 && typeof value === 'number') gpsPtr = value;
      if (tag === 0xa005 && typeof value === 'number') interopPtr = value;
      if (tag === 0x927c) value = `(${n} bytes of MakerNote)`;
      const name = TAG_NAMES[tag] || `Tag_0x${tag.toString(16).padStart(4, '0')}`;
      tags[name] = value;
    }
    out.ifds[label] = tags;
    if (exifPtr !== null) readIFD(exifPtr, 'exif');
    if (gpsPtr !== null) readIFD(gpsPtr, 'gps');
    if (interopPtr !== null) readIFD(interopPtr, 'interop');
    return tags;
  }

  const firstIfd = u32(tiffStart + 4);
  readIFD(firstIfd, 'ifd0');
  void tiffBase;
  return out;
}

function findExif(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p < buf.length - 3) {
      if (buf[p] !== 0xff) { p++; continue; }
      const marker = buf[p + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const len = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.subarray(p + 4, p + 10).toString('latin1') === 'Exif\0\0') {
        return parseTiff(buf, p + 10, p + 10);
      }
      p += 2 + len;
    }
    return null;
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return parseTiff(buf, 0, 0);
  return null;
}

function dmsToDeg(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const dec = dms[0] + dms[1] / 60 + dms[2] / 3600;
  const sign = ref === 'S' || ref === 'W' ? -1 : 1;
  return Number((dec * sign).toFixed(6));
}

const ORIENTATION_TEXT = {
  1: 'normal', 2: 'mirrored', 3: 'rotated 180', 4: 'mirrored + 180',
  5: 'mirrored + 90cw', 6: 'rotated 90cw', 7: 'mirrored + 90ccw', 8: 'rotated 90ccw',
};

const results = [];
for (const t of targets) {
  let buf;
  try { buf = readFileSync(t); } catch (e) { results.push({ file: t, error: e.message }); continue; }
  const exif = findExif(buf);
  if (!exif) { results.push({ file: t, hasExif: false }); continue; }
  const i0 = exif.ifds.ifd0 || {};
  const ex = exif.ifds.exif || {};
  const gps = exif.ifds.gps || {};
  const lat = gps.GPSLatitude ? dmsToDeg(gps.GPSLatitude, gps.GPSLatitudeRef) : null;
  const lon = gps.GPSLongitude ? dmsToDeg(gps.GPSLongitude, gps.GPSLongitudeRef) : null;
  const summary = {
    file: t,
    hasExif: true,
    byteOrder: exif.byteOrder,
    camera: { make: i0.Make ?? null, model: i0.Model ?? null, software: i0.Software ?? null, lens: ex.LensModel ?? null },
    dimensions: { width: ex.PixelXDimension ?? i0.ImageWidth ?? null, height: ex.PixelYDimension ?? i0.ImageHeight ?? null },
    orientation: i0.Orientation !== undefined ? { value: i0.Orientation, meaning: ORIENTATION_TEXT[i0.Orientation] || 'unknown' } : null,
    taken: {
      original: ex.DateTimeOriginal ?? i0.DateTime ?? null,
      digitized: ex.DateTimeDigitized ?? null,
      offset: ex.OffsetTime ?? null,
      subsec: ex.SubSecTimeOriginal ?? null,
    },
    exposure: {
      exposureTime: ex.ExposureTime !== undefined ? (ex.ExposureTime < 1 ? `1/${Math.round(1 / ex.ExposureTime)}` : `${ex.ExposureTime}s`) : null,
      fNumber: ex.FNumber ?? null,
      iso: ex.ISO ?? null,
      focalLength: ex.FocalLength ?? null,
      focal35: ex.FocalLengthIn35mm ?? null,
    },
    gps: lattitudePresent(gps) ? {
      latitude: lat, longitude: lon,
      altitude: gps.GPSAltitude ?? null,
      altitudeRef: gps.GPSAltitudeRef === 1 ? 'below sea level' : gps.GPSAltitude !== undefined ? 'above sea level' : null,
      timestamp: gps.GPSTimeStamp ?? null,
      datestamp: gps.GPSDateStamp ?? null,
      mapUrl: lat !== null && lon !== null ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}` : null,
    } : null,
    serials: { body: ex.BodySerialNumber ?? null, lens: ex.LensSerialNumber ?? null, owner: ex.CameraOwnerName ?? null },
    raw: flag(o, 'all') ? exif.ifds : undefined,
  };
  results.push(summary);
}

function lattitudePresent(gps) { return gps && (gps.GPSLatitude !== undefined || gps.GPSLongitude !== undefined); }

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n');
} else {
  const out = [];
  for (const r of results) {
    out.push(`== ${basename(r.file)}`);
    if (r.error) { out.push(`   error: ${r.error}`); continue; }
    if (!r.hasExif) { out.push('   no EXIF block'); continue; }
    const show = (label, v) => { if (v !== null && v !== undefined && v !== '') out.push(`   ${label.padEnd(14)} ${typeof v === 'object' ? JSON.stringify(v) : v}`); };
    show('make', r.camera.make);
    show('model', r.camera.model);
    show('lens', r.camera.lens);
    show('software', r.camera.software);
    show('dimensions', r.dimensions.width ? `${r.dimensions.width}x${r.dimensions.height}` : null);
    show('orientation', r.orientation ? `${r.orientation.meaning} (${r.orientation.value})` : null);
    show('taken', r.taken.original);
    show('exposure', r.exposure.exposureTime);
    show('aperture', r.exposure.fNumber ? `f/${r.exposure.fNumber}` : null);
    show('iso', r.exposure.iso);
    show('focal', r.exposure.focalLength ? `${r.exposure.focalLength}mm` : null);
    if (r.gps) {
      show('gps', `${r.gps.latitude}, ${r.gps.longitude}`);
      show('altitude', r.gps.altitude);
      show('gps time', r.gps.datestamp ? `${r.gps.datestamp} ${JSON.stringify(r.gps.timestamp)}` : null);
      show('map', r.gps.mapUrl);
    }
    if (r.serials.body) show('serial', r.serials.body);
    if (r.raw) {
      for (const [ifd, tags] of Object.entries(r.raw)) {
        out.push(`   -- ${ifd} --`);
        for (const [k, v] of Object.entries(tags)) out.push(`   ${k.padEnd(24)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    }
    out.push('');
  }
  const withGps = results.filter((r) => r.gps).length;
  out.push(`${results.length} file(s), ${results.filter((r) => r.hasExif).length} with EXIF, ${withGps} with GPS coordinates`);
  process.stdout.write(out.join('\n') + '\n');
}
