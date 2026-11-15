// mp4box.js — ISO-BMFF / MP4 box tree parser: tracks, codecs, durations, handler types.
// Copyright (c) 2026 0xnothings
// @tool mp4box
// @desc Walk an MP4/ISO-BMFF box tree and report tracks, durations, codecs and handler types
// @usage node tools/mp4box.js clip.mp4 --json
// @tags data,video,binary,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `mp4box — MP4 / ISO-BMFF box tree parser

  node tools/mp4box.js <file.mp4|.m4a|.mov|.3gp> [options]

  --depth <n>      tree depth to print (default 6, 0 = unlimited)
  --tree           print the full box tree
  --tracks         track table only
  --find <type>    greps boxes by 4cc (e.g. --find mdhd)
  --extract <spec> extract a box payload: <4cc>[:<nth>]  -> writes <4cc>.bin
  --json           machine-readable output
  -h, --help       this text

  Parses size/type/largesize/uuid framing, container recursion, stsd sample
  entries (avc1/hev1/mp4a/Opus/ac-3/subtitle), mdhd timescale and duration,
  tkhd track ids, hdlr handler types and free/skip payload sizes.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'tracks', 'tree']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/mp4box.js clip.mp4');

const b = readFileSync(src);
const maxDepth = num(get(o, 'depth', 6), 6);

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'mfra', 'udta', 'ilst', 'sinf', 'schi', 'wave', 'tref', 'iprp', 'ipco', 'mdri', 'strk', 'strd', 'rinf', 'grpl', 'stsd']);
const FULLBOX = new Set(['mvhd', 'tkhd', 'mdhd', 'hdlr', 'vmhd', 'smhd', 'stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'elst', 'mehd', 'trex', 'mfhd', 'tfhd', 'trun', 'sidx', 'dref', 'url ', 'urn ']);

const boxes = [], problems = [], flat = [];

/** buf is the buffer of the PARENT payload; baseAbs is that payload's absolute file offset. */
function readBoxes(buf, start, end, depth, path, baseAbs) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('latin1');
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > end) { problems.push(`largesize box ${type} truncated at ${p}`); break; }
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) { problems.push(`box ${type} at ${p} has a size too large to address`); break; }
      size = Number(big); headerSize = 16;
    } else if (size === 0) { size = end - p; }
    if (type === 'uuid') headerSize += 16;
    if (size < headerSize || p + size > end) {
      problems.push(`box ${type} at ${baseAbs + p}: size ${size} overruns parent (parent end ${baseAbs + end})`);
      break;
    }
    const payload = buf.slice(p + headerSize, p + size);
    const absOffset = baseAbs + p;
    const absPayload = absOffset + headerSize;
    const box = { type, offset: absOffset, headerSize, size, payload, depth, path: path + '/' + type };
    boxes.push(box); flat.push(box);

    if (type === 'stsd') {
      const n = payload.length >= 8 ? payload.readUInt32BE(4) : 0;
      box.entryCount = n;
      box.children = [];
      let q = 8;
      for (let i = 0; i < n && q + 8 <= payload.length; i++) {
        const esize = payload.readUInt32BE(q);
        const etype = payload.slice(q + 4, q + 8).toString('latin1');
        if (esize < 8 || q + esize > payload.length) { problems.push(`stsd entry ${etype} bad size ${esize}`); break; }
        const edata = payload.slice(q + 8, q + esize);
        const entry = { type: etype, offset: absPayload + q, size: esize, depth: depth + 1, payload: edata, path: box.path + '/' + etype, codec: describeSampleEntry(etype, edata) };
        boxes.push(entry); flat.push(entry); box.children.push(entry);
        // sample entries carry their own child boxes (avcC, hvcC, esds, dOps, pasp, colr, btrt...)
        const kids = ['avcC', 'hvcC', 'vpcC', 'av1C', 'esds', 'dOps', 'dac3', 'dec3', 'pasp', 'colr', 'btrt', 'clap', 'ffCC', 'sinf', 'wave', 'alac', 'damr', 'dawp', 'dfLa'];
        const videoEntry = ['avc1', 'avc3', 'hev1', 'hvc1', 'av01', 'vp09', 'mp4v', 'encv', 'dvh1'].includes((etype || '').trim());
        const audioEntry = ['mp4a', 'ac-3', 'ec-3', 'Opus', 'alac', 'enca', 'samr', 'sawb'].includes((etype || '').trim());
        const kidStart = videoEntry ? 78 : audioEntry ? 28 : 8;
        if (edata.length > kidStart + 8) {
          let r = kidStart;
          while (r + 8 <= edata.length) {
            const csz = edata.readUInt32BE(r);
            const cty = edata.slice(r + 4, r + 8).toString('latin1');
            if (csz < 8 || r + csz > edata.length) break;
            if (kids.includes(cty)) {
              const cb = { type: cty, offset: entry.offset + 8 + r, size: csz, headerSize: 8, depth: depth + 2, payload: edata.slice(r + 8, r + csz), path: entry.path + '/' + cty, parentSampleEntry: entry };
              boxes.push(cb); flat.push(cb);
            }
            r += csz;
          }
        }
        q += esize;
      }
    } else if (type === 'meta') {
      readBoxes(payload, 4, payload.length, depth + 1, box.path, absPayload);
    } else if (CONTAINERS.has(type)) {
      readBoxes(payload, 0, payload.length, depth + 1, box.path, absPayload);
    }
    p += size;
  }
}

function describeSampleEntry(etype, d) {
  const info = { fourcc: etype };
  try {
    if (d.length >= 8) { info.dataReferenceIndex = d.readUInt16BE(6); }
    if (['avc1', 'avc3', 'hev1', 'hvc1', 'av01', 'vp09', 'mp4v', 'encv', 'dvh1'].includes((etype || '').trim()) && d.length >= 28) {
      info.width = d.readUInt16BE(24);
      info.height = d.readUInt16BE(26);
      info.compressor = d.slice(42, 74).toString('latin1').replace(/\0+/g, '').trim() || null;
      info.horizontalResolution = d.readUInt32BE(28) / 65536;
      info.frameCount = d.length >= 42 ? d.readUInt16BE(40) : null;
      info.depth = d.length >= 76 ? d.readUInt16BE(74) : null;
      info.childBoxes = (() => {
        const out = [];
        let q = 78;
        while (q + 8 <= d.length) {
          const sz = d.readUInt32BE(q);
          if (sz < 8 || q + sz > d.length) break;
          out.push(d.slice(q + 4, q + 8).toString('latin1'));
          q += sz;
        }
        return out;
      })();
      const codecBoxAt = d.indexOf(Buffer.from('avcC', 'ascii'));
      const hvcCAt = d.indexOf(Buffer.from('hvcC', 'ascii'));
      if (etype && etype.trim() === 'avc1' && codecBoxAt > 0) {
        const cfg = d.slice(codecBoxAt + 4);
        if (cfg.length >= 4) {
          const profile = cfg[1], compat = cfg[2], level = cfg[3];
          info.codecString = `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
          info.avcProfile = profile; info.avcLevel = level / 10;
        }
      } else if (hvcCAt > 0) {
        const cfg = d.slice(hvcCAt + 4);
        if (cfg.length >= 13) info.codecString = `hvc1.${cfg[1].toString(16)}.L${cfg[12]}`;
      }
    } else if (['mp4a', 'ac-3', 'ec-3', 'Opus', 'alac', 'enca'].includes(etype && etype.trim()) && d.length >= 28) {
      info.channels = d.readUInt16BE(16);
      info.sampleSize = d.readUInt16BE(18);
      info.sampleRate = d.readUInt32BE(24) >>> 16;
      const esdsAt = d.indexOf(Buffer.from('esds', 'ascii'));
      const dOpsAt = d.indexOf(Buffer.from('dOps', 'ascii'));
      if (esdsAt > 0 && d.length >= esdsAt + 30) {
        const objectType = d[esdsAt + 8 + 4 + 1];
        const oti = { 0x40: 'aac-lc/object-40', 0x66: 'aac-lc', 0x67: 'aac-lc', 0x69: 'aac-lc', 0x6b: 'aac-he(6b)', 0x5b: 'aac-he-v2', 0xdd: 'xHE-AAC', 0x6c: 'mp3' }[objectType];
        info.objectTypeIndication = oti || `0x${(objectType || 0).toString(16)}`;
        info.codecString = (etype && etype.trim() === 'mp4a' ? `mp4a.40.${objectType ?? 2}` : etype);
      } else if (dOpsAt > 0) { info.codecString = 'opus'; info.preSkip = d.readUInt16BE(dOpsAt + 4); }
    } else if (['tx3g', 'wvtt', 'stpp', 'text', 'sbtt'].includes(etype && etype.trim())) {
      info.textSampleEntry = true;
      if (etype && etype.trim() === 'stpp') info.namespace = d.slice(8).toString('utf8').split('\0')[0];
    }
  } catch (e) { info.parseError = e.message; }
  return info;
}

function parseDetail(box) {
  const p = box.payload;
  try {
    if (box.type === 'ftyp' && p.length >= 8) {
      const brands = [];
      for (let i = 8; i + 4 <= p.length; i += 4) brands.push(p.slice(i, i + 4).toString('latin1'));
      return { majorBrand: p.slice(0, 4).toString('latin1'), minorVersion: p.readUInt32BE(4), compatibleBrands: brands };
    }
    if (box.type === 'mvhd') {
      const v = p[0];
      if (v === 1 && p.length >= 40) {
        const ts = p.readUInt32BE(20), dur = Number(p.readBigUInt64BE(24));
        return { version: 1, timescale: ts, duration: dur, durationSeconds: ts ? dur / ts : null, nextTrackId: p.readUInt32BE(36) };
      }
      const ts = p.readUInt32BE(12), dur = p.readUInt32BE(16);
      return { version: 0, timescale: ts, duration: dur, durationSeconds: ts ? Number((dur / ts).toFixed(4)) : null, nextTrackId: p.length >= 100 ? p.readUInt32BE(96) : null };
    }
    if (box.type === 'tkhd' && p.length >= (p[0] === 1 ? 96 : 84)) {
      const v = p[0];
      const trackId = p.readUInt32BE(v === 1 ? 20 : 12);
      const dur = v === 1 ? Number(p.readBigUInt64BE(28)) : p.readUInt32BE(20);
      const flags = p.readUInt32BE(0) & 0xffffff;
      const wAt = p.length - 8, hAt = p.length - 4;
      return {
        version: v, trackId, duration: dur, flags: '0x' + flags.toString(16),
        enabled: !!(flags & 1), inMovie: !!(flags & 2), inPreview: !!(flags & 4),
        width: Math.round((p.readUInt32BE(wAt) / 65536) * 100) / 100,
        height: Math.round((p.readUInt32BE(hAt) / 65536) * 100) / 100,
      };
    }
    if (box.type === 'mdhd') {
      const v = p[0];
      if (v === 1 && p.length >= 32) {
        const ts = p.readUInt32BE(20), dur = Number(p.readBigUInt64BE(24));
        return { version: 1, timescale: ts, duration: dur, durationSeconds: Number((dur / ts).toFixed(4)), language: decodeLang(p.length >= 34 ? p.readUInt16BE(32) : 0) };
      }
      const ts = p.readUInt32BE(12), dur = p.readUInt32BE(16);
      return { version: 0, timescale: ts, duration: dur, durationSeconds: ts ? Number((dur / ts).toFixed(4)) : null, language: decodeLang(p.length >= 22 ? p.readUInt16BE(20) : 0), creationTime: p.readUInt32BE(4), modificationTime: p.readUInt32BE(8) };
    }
    if (box.type === 'hdlr') return { handlerType: p.slice(8, 12).toString('latin1'), name: p.slice(24).toString('utf8').replace(/\0+$/, '') };
    if (box.type === 'stsz') return { sampleSize: p.readUInt32BE(4), sampleCount: p.readUInt32BE(8) };
    if (box.type === 'stco') return { entryCount: p.readUInt32BE(4) };
    if (box.type === 'stts') return { entryCount: p.readUInt32BE(4) };
    if (box.type === 'stsc') return { entryCount: p.readUInt32BE(4) };
    if (box.type === 'elst') return { entryCount: p.readUInt32BE(4) };
    if (box.type === 'mfhd') return { sequenceNumber: p.readUInt32BE(4) };
    if (box.type === 'free' || box.type === 'skip') return { fillerBytes: p.length };
    if (box.type === 'mdat') return { mediaBytes: p.length };
  } catch (e) { return { parseError: e.message }; }
  return null;
}

function decodeLang(v) {
  if (!v) return null;
  const c = (n) => String.fromCharCode((n & 0x1f) + 0x60);
  const s = c(v >> 10) + c(v >> 5) + c(v);
  return /^[a-z]{3}$/.test(s) ? s : null;
}

readBoxes(b, 0, b.length, 0, '', 0);

const details = new Map();
for (const box of flat) {
  const d = box.codec || parseDetail(box);
  if (d) details.set(box, d);
}

const tracks = [];
const tk = flat.filter((x) => x.type === 'trak');
for (const t of tk) {
  const kids = flat.filter((x) => x.depth > t.depth && x.offset >= t.offset && x.offset < t.offset + t.size);
  const tkhd = kids.find((x) => x.type === 'tkhd'), mdhd = kids.find((x) => x.type === 'mdhd'), hdlr = kids.find((x) => x.type === 'hdlr'), stsd = kids.find((x) => x.type === 'stsd');
  const th = tkhd ? details.get(tkhd) : null, mh = mdhd ? details.get(mdhd) : null, hh = hdlr ? details.get(hdlr) : null;
  const entries = stsd && stsd.children ? stsd.children.map((e) => e.codec) : [];
  tracks.push({
    trackId: th?.trackId ?? null,
    handler: hh?.handlerType ?? null,
    handlerName: hh?.name ?? null,
    codec: entries.map((e) => e.codecString || e.fourcc).join(', ') || null,
    timescale: mh?.timescale ?? null,
    durationTicks: mh?.duration ?? null,
    durationSeconds: mh?.durationSeconds ?? null,
    language: mh?.language ?? null,
    width: th?.width ?? entries[0]?.width ?? null,
    height: th?.height ?? entries[0]?.height ?? null,
    sampleCount: kids.find((x) => x.type === 'stsz') ? details.get(kids.find((x) => x.type === 'stsz')).sampleCount : null,
    sampleEntries: entries,
  });
}

const findType = get(o, 'find', null);
const extractSpec = get(o, 'extract', null);
const report = {
  file: src, fileSize: b.length,
  boxCount: flat.length,
  brands: (() => { const f = flat.find((x) => x.type === 'ftyp'); return f ? details.get(f) : null; })(),
  topLevel: boxes.filter((x) => x.depth === 0).map((x) => ({ type: x.type, size: x.size, offset: x.offset })),
  movie: (() => { const m = flat.find((x) => x.type === 'mvhd'); return m ? details.get(m) : null; })(),
  tracks,
  problems,
};

if (extractSpec) {
  const [want, nth] = String(extractSpec).split(':');
  const hits = flat.filter((x) => x.type === want);
  const pick = hits[(num(nth, 0) || 0)];
  if (!pick) die(`no box of type "${want}"${nth ? ` #${nth}` : ''}`);
  const { writeFileSync } = await import('node:fs');
  const outName = `${want.trim() || 'box'}.bin`;
  writeFileSync(outName, pick.payload);
  report.extracted = { box: want, index: num(nth, 0) || 0, bytes: pick.payload.length, out: outName };
}

if (flag(o, 'json')) {
  const dump = (list) => list.map((x) => ({ type: x.type, size: x.size, offset: x.offset, depth: x.depth, headerSize: x.headerSize, detail: details.get(x) || null, ...(x.children ? { children: dump(x.children) } : {}) }));
  report.tree = flag(o, 'tree') || true ? dump(boxes.filter((x) => x.depth <= (maxDepth || 99) && x.depth === 0 || (x.depth > 0))) : undefined;
  if (findType) report.found = flat.filter((x) => x.type === String(findType)).map((x) => ({ type: x.type, offset: x.offset, size: x.size, depth: x.depth, detail: details.get(x) || null }));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`${src} — ${fmt(b.length)} bytes, ${flat.length} boxes`);
  if (report.brands) console.log(`brand ${report.brands.majorBrand} v${report.brands.minorVersion}  compatible: ${report.brands.compatibleBrands.join(' ')}`);
  if (report.movie) console.log(`movie: timescale ${report.movie.timescale}, duration ${report.movie.duration} ticks = ${report.movie.durationSeconds?.toFixed(3)} s`);
  if (tracks.length) {
    console.log('\nTRACKS');
    console.log(table(tracks.map((t) => ({
      id: t.trackId, handler: t.handler, codec: t.codec || '-',
      dims: t.width ? `${Math.round(t.width)}x${Math.round(t.height)}` : '-',
      timescale: t.timescale, seconds: t.durationSeconds, samples: t.sampleCount ?? '-', lang: t.language || '-',
    })), ['id', 'handler', 'codec', 'dims', 'timescale', 'seconds', 'samples', 'lang']));
  }
  if (flag(o, 'tree') || !flag(o, 'tracks')) {
    console.log('\nBOX TREE');
    const shown = flag(o, 'tree') ? flat : flat.filter((x) => CONTAINERS.has(x.type) || ['ftyp', 'mvhd', 'tkhd', 'mdhd', 'hdlr', 'stsd', 'mdat', 'free', 'moof'].includes(x.type));
    for (const x of shown) {
      if (maxDepth && x.depth > maxDepth) continue;
      const d = details.get(x);
      const extra = d ? `  ${JSON.stringify(d).slice(0, 120)}` : '';
      console.log(`${'  '.repeat(x.depth)}${x.type} (${x.size} B @ ${x.offset})${extra}`);
    }
  }
  if (findType) {
    const hits = flat.filter((x) => x.type === String(findType));
    console.log(`\nFIND "${findType}": ${hits.length} match(es)`);
    for (const h of hits) console.log(`  @${h.offset} size=${h.size} ${JSON.stringify(details.get(h) || {})}`);
  }
  if (report.extracted) console.log(`\nextracted ${report.extracted.box} #${report.extracted.index} (${report.extracted.bytes} bytes) -> ${report.extracted.out}`);
  if (problems.length) { console.log('\nPROBLEMS'); problems.slice(0, 20).forEach((p) => console.log('  ' + p)); }
}
