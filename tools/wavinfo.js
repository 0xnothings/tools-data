// wavinfo.js — WAV/RIFF chunk parser: format, rate, channels, duration, metadata inventory.
// Copyright (c) 2026 0xnothings
// @tool wavinfo
// @desc Parse WAV/RIFF chunk inventory: audio format, rate, channels, bit depth, duration, metadata
// @usage node tools/wavinfo.js track.wav --json
// @tags data,audio,binary,cli
import { args, get, flag, die, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `wavinfo — WAV / RIFF chunk parser

  node tools/wavinfo.js <file.wav> [options]

  --chunks        verbose chunk inventory (default in text mode)
  --meta          print LIST/INFO, bext, cue and smpl metadata values
  --verify        walk every chunk, flag size overruns and odd-byte padding issues
  --json          machine-readable output
  -h, --help      this text

  Reads the RIFF container by hand: fmt (PCM / IEEE float / A-law / mu-law /
  WAVE_FORMAT_EXTENSIBLE), data, fact, LIST-INFO, bext, cue, smpl, plus unknown
  chunks. Duration is derived from the actual data bytes and the block alignment,
  not from a header claim.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'meta']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/wavinfo.js track.wav');

const b = readFileSync(src);
if (b.length < 12 || b.slice(0, 4).toString('ascii') !== 'RIFF') die(`not a RIFF file (magic ${b.slice(0, 4).toString('hex')})`);
const riffSize = b.readUInt32LE(4);
const form = b.slice(8, 12).toString('ascii');
if (form !== 'WAVE' && form !== 'WEBP' && form !== 'AVI ') die(`RIFF form type is "${form}" — this tool needs WAVE`);
if (form !== 'WAVE') die(`RIFF form "${form}" is not a WAVE container`);

const FORMATS = {
  0x0001: 'PCM (integer)', 0x0003: 'IEEE float', 0x0006: 'A-law', 0x0007: 'mu-law',
  0x0002: 'MS ADPCM', 0x0011: 'IMA ADPCM', 0x0031: 'GSM 6.10', 0x0050: 'MPEG', 0x0055: 'MP3',
  0xfffe: 'WAVE_FORMAT_EXTENSIBLE', 0x0161: 'WMA v1', 0x0162: 'WMA v2', 0x0163: 'WMA Pro',
};
const GUID_PCM = '00000001-0000-0010-8000-00aa00389b71';

const chunks = [];
let pos = 12, problems = [];
while (pos + 8 <= b.length) {
  const id = b.slice(pos, pos + 4).toString('ascii');
  const size = b.readUInt32LE(pos + 4);
  const dataStart = pos + 8;
  const avail = b.length - dataStart;
  const data = b.slice(dataStart, Math.min(b.length, dataStart + size));
  chunks.push({ id, size, offset: pos, dataStart, available: avail, truncated: avail < size, data });
  pos = dataStart + size + (size % 2);
  if (size === 0 && id === '\0\0\0\0') break;
}
for (const c of chunks) if (c.truncated) problems.push(`chunk ${JSON.stringify(c.id)} at ${c.offset}: declared ${c.size}, only ${c.available} available`);

const fmtChunk = chunks.find((c) => c.id === 'fmt ');
const dataChunk = chunks.find((c) => c.id === 'data');
let fmtInfo = null;
if (!fmtChunk) problems.push('no "fmt " chunk found');
else {
  const d = fmtChunk.data;
  const tag = d.readUInt16LE(0);
  const channels = d.readUInt16LE(2);
  const sampleRate = d.readUInt32LE(4);
  const byteRate = d.readUInt32LE(8);
  const blockAlign = d.readUInt16LE(12);
  const bits = d.readUInt16LE(14);
  fmtInfo = { tag, format: FORMATS[tag] || `unknown(0x${tag.toString(16)})`, channels, sampleRate, byteRate, blockAlign, bitsPerSample: bits, extraBytes: d.length > 16 ? d.readUInt16LE(16) : 0 };
  if (tag === 0xfffe && d.length >= 40) {
    fmtInfo.validBitsPerSample = d.readUInt16LE(18);
    const mask = d.readUInt32LE(20);
    fmtInfo.channelMask = '0x' + mask.toString(16);
    const guid = Buffer.from(d.slice(24, 40));
    guid.writeUInt32LE(guid.readUInt32LE(0), 0);
    const hexG = [...guid].map((x) => x.toString(16).padStart(2, '0')).join('');
    const g = `${hexG.slice(0, 8)}-${hexG.slice(8, 12)}-${hexG.slice(12, 16)}-${hexG.slice(16, 20)}-${hexG.slice(20)}`;
    fmtInfo.subFormatGUID = g;
    fmtInfo.subFormat = g === GUID_PCM ? 'PCM (integer)' : 'non-PCM';
    fmtInfo.effectiveFormat = fmtInfo.subFormat;
    fmtInfo.speakerMask = mask === 0 ? 'unspecified' : [...Array(32).keys()].filter((i) => mask & (1 << i)).map((i) => ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC'][i] || `ch${i}`).join(',');
  } else {
    fmtInfo.effectiveFormat = fmtInfo.format;
  }
  if (byteRate !== sampleRate * blockAlign) problems.push(`byteRate ${byteRate} != sampleRate*blockAlign ${sampleRate * blockAlign}`);
  if (blockAlign !== channels * Math.ceil(bits / 8)) problems.push(`blockAlign ${blockAlign} != channels*bytesPerSample ${channels * Math.ceil(bits / 8)}`);
}

let frames = null, duration = null;
if (dataChunk && fmtInfo && fmtInfo.blockAlign > 0) {
  const dataBytes = Math.min(dataChunk.size, dataChunk.available);
  frames = Math.floor(dataBytes / fmtInfo.blockAlign);
  duration = frames / fmtInfo.sampleRate;
}
const factChunk = chunks.find((c) => c.id === 'fact' && c.data.length >= 4);

function infoPairs(id) {
  const c = chunks.find((x) => x.id === id);
  if (!c) return null;
  const out = [];
  let p = 0;
  if (id === 'LIST') {
    if (c.data.slice(0, 4).toString('ascii') !== 'INFO') return null;
    p = 4;
  }
  while (p + 8 <= c.data.length) {
    const k = c.data.slice(p, p + 4).toString('ascii');
    const n = c.data.readUInt32LE(p + 4);
    const v = c.data.slice(p + 8, p + 8 + n);
    out.push({ key: k, value: v.toString('utf8').replace(/\0+$/, ''), bytes: n });
    p += 8 + n + (n % 2);
  }
  return out.length ? out : null;
}

const meta = {
  listInfo: infoPairs('LIST'),
  bext: (() => {
    const c = chunks.find((x) => x.id === 'bext');
    if (!c || c.data.length < 256) return null;
    const d = c.data;
    return {
      description: d.slice(0, 256).toString('ascii').replace(/\0+$/, ''),
      originator: d.slice(256, 288).toString('ascii').replace(/\0+$/, ''),
      originatorReference: d.slice(288, 320).toString('ascii').replace(/\0+$/, ''),
      originationDate: d.slice(320, 330).toString('ascii').replace(/\0+$/, ''),
      originationTime: d.slice(330, 338).toString('ascii').replace(/\0+$/, ''),
      timeReferenceLow: d.length >= 346 ? d.readUInt32LE(338) : null,
      version: d.length >= 348 ? d.readUInt16LE(346) : null,
    };
  })(),
  cuePoints: (() => {
    const c = chunks.find((x) => x.id === 'cue ' && x.data.length >= 4);
    if (!c) return null;
    const n = c.data.readUInt32LE(0);
    const pts = [];
    for (let i = 0; i < Math.min(n, 64); i++) {
      const at = 4 + i * 24;
      if (at + 24 > c.data.length) break;
      pts.push({ id: c.data.readUInt32LE(at), position: c.data.readUInt32LE(at + 4), label: c.data.slice(at + 20, at + 24).toString('ascii') });
    }
    return { count: n, points: pts };
  })(),
  smpl: (() => {
    const c = chunks.find((x) => x.id === 'smpl' && x.data.length >= 36);
    if (!c) return null;
    return { manufacturer: c.data.readUInt32LE(0), product: c.data.readUInt32LE(4), samplePeriodNs: c.data.readUInt32LE(8), midiUnityNote: c.data.readUInt32LE(12), midiPitchFraction: c.data.readUInt32LE(16), loops: c.data.readUInt32LE(28) };
  })(),
  ixml: (() => { const c = chunks.find((x) => x.id === 'iXML'); return c ? c.data.toString('utf8').replace(/\0+$/, '') : null; })(),
};

const report = {
  file: src, fileSize: b.length, riffDeclaredSize: riffSize, form,
  riffSizeOk: riffSize + 8 === b.length,
  chunkCount: chunks.length,
  chunks: chunks.map((c) => ({ id: c.id.trim() || '(pad)', idHex: Buffer.from(c.id, 'ascii').toString('hex'), size: c.size, offset: c.offset, truncated: c.truncated, padded: c.size % 2 === 1 })),
  audio: fmtInfo,
  dataBytes: dataChunk ? Math.min(dataChunk.size, dataChunk.available) : 0,
  frames,
  durationSeconds: duration === null ? null : Number(duration.toFixed(6)),
  durationClock: duration === null ? null : `${Math.floor(duration / 60)}:${(duration % 60).toFixed(3).padStart(6, '0')}`,
  samplesFact: factChunk ? factChunk.data.readUInt32LE(0) : null,
  uncompressedBytes: fmtInfo ? fmtInfo.sampleRate * fmtInfo.channels * (fmtInfo.bitsPerSample / 8) * (duration || 0) : null,
  meta, problems,
};

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — RIFF/WAVE, ${fmt(b.length)} bytes, ${chunks.length} chunk(s)`);
  const a = fmtInfo || {};
  console.log(table([
    { field: 'format', value: a.effectiveFormat || '?' },
    { field: 'format tag', value: a.tag !== undefined ? `0x${a.tag.toString(16).padStart(4, '0')}` : '?' },
    { field: 'channels', value: a.channels ?? '?' },
    { field: 'sample rate', value: a.sampleRate ? `${fmt(a.sampleRate)} Hz` : '?' },
    { field: 'bit depth', value: a.bitsPerSample ? `${a.bitsPerSample} bit` : '?' },
    { field: 'byte rate', value: a.byteRate ? `${fmt(a.byteRate)} B/s` : '?' },
    { field: 'block align', value: a.blockAlign ?? '?' },
    { field: 'frames', value: frames === null ? '?' : fmt(frames) },
    { field: 'data bytes', value: fmt(report.dataBytes) },
    { field: 'duration', value: duration === null ? '?' : `${duration.toFixed(3)} s (${report.durationClock})` },
    { field: 'fact samples', value: report.samplesFact ?? '-' },
  ], ['field', 'value']));
  console.log('\nCHUNKS');
  console.log(table(chunks.map((c) => ({
    id: c.id.replace(/\0/g, '.'), size: fmt(c.size), offset: c.offset,
    pad: c.size % 2 ? 'yes' : '', status: c.truncated ? `TRUNCATED (${c.available} avail)` : 'ok',
  })), ['id', 'size', 'offset', 'pad', 'status']));
  if (flag(o, 'meta') || true) {
    if (meta.listInfo) { console.log('\nLIST/INFO'); console.log(table(meta.listInfo, ['key', 'value', 'bytes'])); }
    if (meta.bext) { console.log('\nBROADCAST AUDIO EXTENSION'); console.log(table(Object.entries(meta.bext).map(([k, v]) => ({ field: k, value: String(v) })), ['field', 'value'])); }
    if (meta.cuePoints) { console.log(`\nCUE POINTS (${meta.cuePoints.count})`); console.log(table(meta.cuePoints.points, ['id', 'position', 'label'])); }
    if (meta.smpl) console.log('\nSAMPLER: ' + JSON.stringify(meta.smpl));
    if (meta.ixml) console.log('\niXML: ' + meta.ixml.slice(0, 200));
  }
  if (problems.length) { console.log('\nPROBLEMS'); problems.forEach((p) => console.log('  ' + p)); }
}
