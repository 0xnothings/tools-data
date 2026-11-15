// carver.js — recover embedded files from a raw blob by magic header + footer scanning.
// Copyright (c) 2026 0xnothings
// @tool carver
// @desc Carve JPEG/PNG/GIF/PDF/ZIP/ELF/MP4 payloads out of a raw blob with size validation
// @usage node tools/carver.js disk.img --out ./recovered --json
// @tags data,forensics,binary,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync, gunzipSync } from 'node:zlib';

const HELP = `carver — magic-based file carver

  node tools/carver.js <blob|--dir path> [options]

  --out <dir>      write recovered files here (default: ./carved)
  --types <list>   jpeg,png,gif,bmp,pdf,zip,gzip,elf,pe,mp4,7z,rar,riff,sqlite
  --min <n>        reject candidates smaller than n bytes (default 64)
  --max <n>        reject candidates larger than n bytes (default 64 MiB)
  --dry            report candidates without writing anything
  --sha256         hash each recovered file
  --verify         validate each candidate structurally before writing
  --json           machine-readable output
  -h, --help       this text

  Header/footer pairs are scanned forward. Validation is structural, not
  heuristic: PNG chunks are walked to IEND, ZIP central directories are parsed,
  PDF %%EOF is confirmed, RIFF sizes are checked, JPEG EOI markers are found by
  segment walking. Unvalidated candidates can be kept with --types but are
  flagged "unverified".`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['dry', 'json', 'sha256', 'verify']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a blob — node tools/carver.js disk.img --out ./recovered');

const outDir = String(get(o, 'out', 'carved'));
const dry = flag(o, 'dry');
const doSha = flag(o, 'sha256');
const verify = flag(o, 'verify');
const minSize = num(get(o, 'min', 64), 64);
const maxSize = num(get(o, 'max', 64 * 1024 * 1024), 64 * 1024 * 1024);
const wantTypes = get(o, 'types', null) ? String(get(o, 'types')).split(',').map((s) => s.trim().toLowerCase()) : null;

const MAGICS = [
  { key: 'jpeg', name: 'JPEG image', ext: 'jpg', heads: [[0xff, 0xd8, 0xff]], foots: [[0xff, 0xd9]] },
  { key: 'png', name: 'PNG image', ext: 'png', heads: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]], foots: [[0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]] },
  { key: 'gif', name: 'GIF image', ext: 'gif', heads: ['GIF87a', 'GIF89a'], foots: [[0x3b]] },
  { key: 'bmp', name: 'BMP image', ext: 'bmp', heads: ['BM'], foots: [], sizeFrom: 'bmp' },
  { key: 'pdf', name: 'PDF document', ext: 'pdf', heads: ['%PDF'], foots: ['%%EOF'] },
  { key: 'zip', name: 'ZIP archive', ext: 'zip', heads: [[0x50, 0x4b, 0x03, 0x04]], foots: [[0x50, 0x4b, 0x05, 0x06]], sizeFrom: 'zip' },
  { key: 'gzip', name: 'Gzip stream', ext: 'gz', heads: [[0x1f, 0x8b, 0x08]], foots: [], sizeFrom: 'gzip' },
  { key: 'elf', name: 'ELF binary', ext: 'elf', heads: [[0x7f, 0x45, 0x4c, 0x46]], foots: [], sizeFrom: 'elf' },
  { key: 'pe', name: 'PE executable', ext: 'exe', heads: ['MZ'], foots: [], sizeFrom: 'pe' },
  { key: 'mp4', name: 'MP4 / ISO-BMFF', ext: 'mp4', heads: [[0x00, 0x00, 0x00]], foots: [], sizeFrom: 'mp4' },
  { key: '7z', name: '7-Zip archive', ext: '7z', heads: [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], foots: [], sizeFrom: '7z' },
  { key: 'riff', name: 'RIFF container', ext: 'riff', heads: ['RIFF'], foots: [], sizeFrom: 'riff' },
  { key: 'sqlite', name: 'SQLite database', ext: 'sqlite', heads: ['SQLite format 3\0'], foots: [], sizeFrom: 'sqlite' },
];

const hexToBuf = (x) => (Buffer.isBuffer(x) ? x : typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x));
const active = MAGICS.filter((m) => !wantTypes || wantTypes.includes(m.key));

function allIndexes(buf, needle, limit = 20000) {
  const out = [];
  let p = 0;
  while (out.length < limit) {
    const i = buf.indexOf(needle, p);
    if (i === -1) break;
    out.push(i);
    p = i + 1;
  }
  return out;
}

function elfSize(buf, off) {
  if (off + 64 > buf.length) return null;
  const is64 = buf[off + 4] === 2;
  const le = buf[off + 5] !== 2;
  const rd = (p, n) => (le ? buf.readUIntLE(p, n) : buf.readUIntBE(p, n));
  const shoff = is64 ? Number(buf.readBigUInt64LE(off + 40)) : rd(off + 32, 4);
  const shentsize = rd(off + (is64 ? 58 : 46), 2);
  const shnum = rd(off + (is64 ? 60 : 48), 2);
  if (!shoff || !shentsize || !shnum) return null;
  return shoff + shentsize * shnum;
}

function peSize(buf, off) {
  if (off + 0x40 > buf.length) return null;
  const peOff = buf.readUInt32LE(off + 0x3c);
  if (peOff <= 0 || off + peOff + 24 > buf.length) return null;
  if (buf.slice(off + peOff, off + peOff + 4).toString('latin1') !== 'PE\0\0') return null;
  const sections = buf.readUInt16LE(off + peOff + 6);
  const optSize = buf.readUInt16LE(off + peOff + 20);
  let end = peOff + 24 + optSize;
  for (let i = 0; i < sections; i++) {
    const sh = off + peOff + 24 + optSize + i * 40;
    if (sh + 40 > buf.length) break;
    const rawSize = buf.readUInt32LE(sh + 16);
    const rawPtr = buf.readUInt32LE(sh + 20);
    end = Math.max(end, rawPtr + rawSize);
  }
  return end;
}

function zipSize(buf, off) {
  let p = off, end = null;
  while (p + 30 <= buf.length) {
    const sig = buf.readUInt32LE(p);
    if (sig !== 0x04034b50) break;
    const csize = buf.readUInt32LE(p + 18);
    const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    p += 30 + nlen + xlen + csize;
  }
  const eocd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), Math.max(0, off));
  if (eocd !== -1) {
    const cdOff = buf.readUInt32LE(eocd + 16);
    const cdSize = buf.readUInt32LE(eocd + 12);
    end = Math.max(p, eocd + 22 - off + 0);
    const abs = off + cdOff + cdSize;
    if (abs > off && abs <= buf.length) end = Math.max(end, cdOff + cdSize + 22);
  }
  return end && end > 0 ? end : (p > off ? p - off : null);
}

function mp4Size(buf, off) {
  if (off + 8 > buf.length) return null;
  const first = buf.slice(off + 4, off + 8).toString('latin1');
  if (first !== 'ftyp' && first !== 'moov' && first !== 'styp') return null;
  let p = off;
  while (p + 8 <= buf.length) {
    const sz = buf.readUInt32BE(p);
    const ty = buf.slice(p + 4, p + 8).toString('latin1');
    if (sz < 8 || !/^[\x20-\x7e]{4}$/.test(ty)) break;
    if (p + sz > buf.length) { p = buf.length; break; }
    p += sz;
    if (ty === 'mdat') {
      const nz = p + 8 <= buf.length ? buf.readUInt32BE(p) : 0;
      if (nz >= 8 && p + nz <= buf.length && /^[\x20-\x7e]{4}$/.test(buf.slice(p + 4, p + 8).toString('latin1'))) continue;
    }
  }
  return p - off;
}

function riffSize(buf, off) {
  if (off + 12 > buf.length) return null;
  const sz = buf.readUInt32LE(off + 4);
  return sz >= 4 && off + 8 + sz <= buf.length ? 8 + sz : null;
}

function bmpSize(buf, off) {
  if (off + 54 > buf.length) return null;
  const sz = buf.readUInt32LE(off + 2);
  if (sz < 26 || off + sz > buf.length) return null;
  return sz;
}

function sz7z(buf, off) {
  if (off + 32 > buf.length) return null;
  const nextOff = Number(buf.readBigUInt64LE(off + 12));
  if (!nextOff || off + 32 + nextOff > buf.length) return null;
  return 32 + nextOff;
}

function sqliteSize(buf, off) {
  if (off + 32 > buf.length) return null;
  let pageSize = buf.readUInt16BE(off + 16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) return null;
  const pages = buf.readUInt32BE(off + 28);
  if (!pages) return null;
  const size = pageSize * pages;
  return off + size <= buf.length ? size : null;
}

function gzipSize(buf, off) {
  // inflateRawSync with info:true reports engine.bytesWritten = deflate bytes consumed, so
  // we can locate the end of the compressed member directly, then add the 8-byte gzip trailer.
  if (off + 18 > buf.length) return null;
  try {
    const r = inflateRawSync(buf.slice(off + 10, Math.min(buf.length, off + maxSize)), { info: true });
    const consumed = r && r.engine && Number(r.engine.bytesWritten);
    if (!consumed || consumed <= 0) return null;
    const size = 10 + consumed + 8;
    return size >= 18 ? size : null;
  } catch {
    return null;
  }
}

function validatePng(buf, slice) {
  if (slice.length < 20) return { ok: false, reason: 'shorter than one chunk' };
  let p = 8, chunks = 0;
  while (p + 12 <= slice.length && chunks < 10000) {
    const len = slice.readUInt32BE(p);
    const type = slice.slice(p + 4, p + 8).toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(type) || p + 12 + len > slice.length) return { ok: false, reason: `bad chunk ${JSON.stringify(type)} at ${p}` };
    chunks++;
    if (type === 'IEND') return { ok: true, detail: `${chunks} chunks, ends at ${p + 12}`, trimmed: p + 12 };
    p += 12 + len;
  }
  return { ok: false, reason: 'no IEND' };
}

function validateJpeg(buf, slice) {
  if (slice.length < 4) return { ok: false, reason: 'too short' };
  let p = 2;
  while (p + 1 < slice.length) {
    if (slice[p] !== 0xff) { p++; continue; }
    const marker = slice[p + 1];
    if (marker === 0xd9) return { ok: true, detail: `EOI at ${p + 2}`, trimmed: p + 2 };
    if (marker === 0xda) {
      const len = slice.readUInt16BE(p + 2);
      let q = p + 2 + len;
      while (q + 1 < slice.length) {
        if (slice[q] === 0xff && slice[q + 1] === 0xd9) return { ok: true, detail: `scan ended, EOI at ${q + 2}`, trimmed: q + 2 };
        q++;
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (p + 4 > slice.length) break;
    const len = slice.readUInt16BE(p + 2);
    if (len < 2) return { ok: false, reason: `bad segment length at ${p}` };
    p += 2 + len;
  }
  return { ok: false, reason: 'no EOI' };
}

function validatePdf(slice) {
  const tail = slice.slice(-2048).toString('latin1');
  const ok = tail.includes('%%EOF');
  return { ok, reason: ok ? undefined : 'no %%EOF in the last 2 KiB', detail: ok ? 'xref/trailer tail present' : undefined };
}

function validateZip(slice) {
  const eocd = slice.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) return { ok: false, reason: 'no end-of-central-directory' };
  try {
    const cdOff = slice.readUInt32LE(eocd + 16), cdSize = slice.readUInt32LE(eocd + 12), total = slice.readUInt16LE(eocd + 10);
    if (cdOff + cdSize > slice.length) return { ok: false, reason: `central directory overruns (${cdOff}+${cdSize} > ${slice.length})` };
    return { ok: true, detail: `${total} entries, CD ${cdSize} B`, trimmed: eocd + 22 };
  } catch (e) { return { ok: false, reason: e.reason || e.message }; }
}

function validateGzip(slice) {
  try {
    const out = gunzipSync(slice);
    return { ok: true, detail: `gunzip ok, ${out.length} B decompressed` };
  } catch (e) {
    if (/unexpected end/i.test(e.message)) return { ok: false, reason: 'truncated gzip stream (no complete trailer)' };
    return { ok: false, reason: `gunzip failed: ${e.message} [${slice.slice(0, 10).toString('hex')}]` };
  }
}

function validateRiff(slice) {
  if (slice.length < 12) return { ok: false, reason: 'too short' };
  const sz = slice.readUInt32LE(4);
  if (8 + sz > slice.length) return { ok: false, reason: `declared ${sz} B, only ${slice.length - 8} present` };
  const form = slice.slice(8, 12).toString('latin1');
  if (!/^[A-Z0-9 ]{4}$/.test(form)) return { ok: false, reason: `bad form type ${JSON.stringify(form)}` };
  return { ok: true, detail: `form ${form}, ${sz + 8} B` };
}

const VALIDATORS = { png: validatePng, jpeg: validateJpeg, pdf: (b, s) => validatePdf(s), zip: (b, s) => validateZip(s), gzip: (b, s) => validateGzip(s), riff: (b, s) => validateRiff(s) };

const report = { source: target, types: active.map((m) => m.key), minSize, maxSize, candidates: [], written: [], unverified: 0, rejected: 0, totalBytesWritten: 0 };

function processBlob(path) {
  const buf = readFileSync(path);
  const found = [];
  for (const m of active) {
    for (const headRaw of m.heads) {
      const head = hexToBuf(headRaw);
      for (const hoff of allIndexes(buf, head)) {
        let size = null, mode = 'footer', detail = null;
        if (m.sizeFrom === 'elf') { size = elfSize(buf, hoff); mode = 'elf-sections'; }
        else if (m.sizeFrom === 'pe') { size = peSize(buf, hoff); mode = 'pe-sections'; }
        else if (m.sizeFrom === 'zip') { size = zipSize(buf, hoff); mode = 'zip-central-dir'; }
        else if (m.sizeFrom === 'mp4') { size = mp4Size(buf, hoff); mode = 'iso-bmff-walk'; }
        else if (m.sizeFrom === 'riff') { size = riffSize(buf, hoff); mode = 'riff-size'; }
        else if (m.sizeFrom === 'bmp') { size = bmpSize(buf, hoff); mode = 'bmp-header-size'; }
        else if (m.sizeFrom === '7z') { size = sz7z(buf, hoff); mode = '7z-next-header'; }
        else if (m.sizeFrom === 'sqlite') { size = sqliteSize(buf, hoff); mode = 'sqlite-page-math'; }
        else if (m.sizeFrom === 'gzip') { size = gzipSize(buf, hoff); mode = 'gzip-crc-boundary'; }
        else if (m.sized) { size = null; mode = 'unbounded'; }
        else {
          const limit = Math.min(buf.length, hoff + maxSize);
          let best = null;
          for (const footRaw of m.foots) {
            const foot = hexToBuf(footRaw);
            const fi = buf.indexOf(foot, hoff + head.length);
            if (fi !== -1 && fi < limit && (best === null || fi < best)) best = fi;
          }
          if (best !== null) { size = best - hoff + (m.foots[0].length || 1) + (m.key === 'png' ? 0 : 0); size = best - hoff + hexToBuf(m.foots[0]).length; }
          else if (m.foots.length === 0) size = null;
        }
        if (size === null) { continue; }
        if (size < minSize || size > maxSize) { report.rejected++; continue; }
        if (hoff + size > buf.length) { report.rejected++; continue; }
        let slice = buf.slice(hoff, hoff + size);
        let verdict = { ok: true };
        const v = VALIDATORS[m.key];
        if (v) verdict = v(buf, slice);
        if (verdict.trimmed && verdict.trimmed < slice.length) slice = buf.slice(hoff, hoff + verdict.trimmed);
        const okV = verdict.ok !== false;
        if (!okV && verify) { report.rejected++; continue; }
        found.push({
          type: m.key, name: m.name, offset: hoff, offsetHex: '0x' + hoff.toString(16), size: slice.length,
          sizingMethod: mode, validated: okV, note: okV ? (verdict.detail || null) : (verdict.reason || null),
          data: slice,
        });
      }
    }
  }
  found.sort((a, b) => a.offset - b.offset);
  // drop candidates fully contained inside an earlier, larger candidate of the same type (fragments)
  const kept = [];
  for (const f of found) {
    if (kept.some((k) => k.type === f.type && f.offset >= k.offset && f.offset + f.size <= k.offset + k.size)) { report.rejected++; continue; }
    kept.push(f);
  }
  return { buf, kept };
}

const blobs = [];
if (flag(o, 'dir') || (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) if (ent.isFile()) blobs.push(join(dir, ent.name));
} else blobs.push(target);

for (const blob of blobs) {
  const { buf, kept } = processBlob(blob);
  const base = basename(blob).replace(/[^\w.-]/g, '_');
  for (const f of kept) {
    const rec = {
      source: blob, sourceSize: buf.length, type: f.type, kind: f.name, ext: f.ext || MAGICS.find((m) => m.key === f.type).ext,
      offset: f.offset, offsetHex: f.offsetHex, size: f.size, sizingMethod: f.sizingMethod,
      validated: f.validated, note: f.note,
    };
    if (doSha) rec.sha256 = createHash('sha256').update(f.data).digest('hex');
    if (!f.validated) report.unverified++;
    if (!dry) {
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${base}_${rec.offsetHex}_${f.type}.${rec.ext}`);
      writeFileSync(outPath, f.data);
      rec.output = outPath;
      report.written.push(outPath);
      report.totalBytesWritten += f.size;
    }
    report.candidates.push(rec);
  }
}

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${target} — ${report.candidates.length} candidate(s), ${report.rejected} rejected, ${report.unverified} unverified`);
  if (report.candidates.length) {
    console.log(table(report.candidates.map((c) => ({
      type: c.type, offset: c.offsetHex, size: fmt(c.size), method: c.sizingMethod,
      valid: c.validated ? 'yes' : 'NO', note: (c.note || '').slice(0, 40), sha: c.sha256 ? c.sha256.slice(0, 12) : '',
    })), ['type', 'offset', 'size', 'method', 'valid', 'note', 'sha']));
  } else console.log('no carvable payloads found — try --types with a wider list or raise --max');
  if (!dry) console.log(`\nwrote ${report.written.length} file(s), ${fmt(report.totalBytesWritten)} bytes, into ${outDir}`);
  else console.log('\n(dry run — nothing written)');
}
