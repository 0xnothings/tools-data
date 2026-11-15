// entropyscan.js — per-block Shannon entropy scan to find encrypted or compressed payloads.
// Copyright (c) 2026 0xnothings
// @tool entropyscan
// @desc Per-block Shannon entropy map of a file to locate encrypted, compressed or embedded payloads
// @usage node tools/entropyscan.js firmware.bin --block 256 --json
// @tags data,binary,forensics,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `entropyscan — sliding-window entropy profiler

  node tools/entropyscan.js <file|--dir path> [options]

  --block <n>      window size in bytes (default 1024)
  --stride <n>     step between windows (default = block)
  --high <f>       high-entropy threshold in bits/byte (default 7.2)
  --low <f>        low-entropy (zero/padding) threshold (default 0.2)
  --min-run <n>    only report runs of at least n consecutive blocks (default 2)
  --map            print a compact ASCII entropy map
  --chart <n>      sparkline width in columns (default 96)
  --match <a,b,c>  byte-pattern counts to track per block (hex list)
  --json           machine-readable output
  -h, --help       this text

  Entropy near 8.0 bits/byte means the bytes are effectively random: encrypted
  blob, compressed stream, or a nested archive. Entropy near 0 means padding or
  a zero-filled region. Runs above the threshold are reported with their byte
  offsets, so you can slice them straight out with byterange.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'map']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a file — node tools/entropyscan.js firmware.bin');

const block = Math.max(16, num(get(o, 'block', 1024), 1024));
const stride = Math.max(1, num(get(o, 'stride', block), block));
const high = num(get(o, 'high', 7.2), 7.2);
const low = num(get(o, 'low', 0.2), 0.2);
const minRun = Math.max(1, num(get(o, 'min-run', 2), 2));
const chartW = Math.max(16, num(get(o, 'chart', 96), 96));
const patterns = (get(o, 'match', null) ? String(get(o, 'match')).split(',').map((s) => s.trim()) : []).filter(Boolean).map((h) => {
  const clean = h.replace(/^0x/, '').replace(/\s+/g, '');
  if (clean.length % 2) die(`--match "${h}" needs an even number of hex digits`);
  return { hex: clean.toLowerCase(), buf: Buffer.from(clean, 'hex') };
});

function entropy(buf) {
  if (!buf.length) return 0;
  const c = new Array(256).fill(0);
  for (const b of buf) c[b]++;
  let e = 0;
  for (const n of c) if (n) { const p = n / buf.length; e -= p * Math.log2(p); }
  return e;
}

function analyze(path) {
  const buf = readFileSync(path);
  const blocks = [];
  for (let p = 0; p + block <= buf.length; p += stride) {
    const chunk = buf.slice(p, p + block);
    const e = entropy(chunk);
    const rec = {
      offset: p, end: p + block, entropy: Number(e.toFixed(4)),
      zeros: 0, printable: 0, class: e >= high ? 'high' : e <= low ? 'flat' : 'mixed',
    };
    for (const b of chunk) { if (b === 0) rec.zeros++; if (b >= 0x20 && b < 0x7f) rec.printable++; }
    rec.zeroRatio = Number((rec.zeros / chunk.length).toFixed(4));
    rec.printableRatio = Number((rec.printable / chunk.length).toFixed(4));
    if (patterns.length) rec.patternHits = patterns.map((pt) => {
      let n = 0, q = 0;
      while ((q = chunk.indexOf(pt.buf, q)) !== -1) { n++; q += 1; }
      return { hex: pt.hex, count: n };
    });
    blocks.push(rec);
  }
  const tail = buf.length % stride;
  const runs = [];
  let cur = null;
  for (const b of blocks) {
    if (b.class === 'high') {
      if (cur) { cur.end = b.end; cur.blocks++; cur.sum += b.entropy; }
      else cur = { kind: 'high-entropy', start: b.offset, end: b.end, blocks: 1, sum: b.entropy };
    } else if (cur) { cur.entropyAvg = Number((cur.sum / cur.blocks).toFixed(3)); delete cur.sum; runs.push(cur); cur = null; }
  }
  if (cur) { cur.entropyAvg = Number((cur.sum / cur.blocks).toFixed(3)); delete cur.sum; runs.push(cur); }
  let flat = null;
  for (const b of blocks) {
    if (b.class === 'flat') {
      if (flat) { flat.end = b.end; flat.blocks++; }
      else flat = { start: b.offset, end: b.end, blocks: 1 };
    } else if (flat) { runs.push({ kind: 'flat/zero', ...flat }); flat = null; }
  }
  if (flat) runs.push({ kind: 'flat/zero', ...flat });
  runs.sort((a, b) => a.start - b.start);
  const filtered = runs.filter((r) => r.blocks >= minRun);
  const totalEntropy = entropy(buf);
  return { file: path, size: buf.length, block, stride, tailBytes: tail, wholeFileEntropy: Number(totalEntropy.toFixed(4)), blockCount: blocks.length, blocks, runs: filtered };
}

const paths = [];
if (flag(o, 'dir') || (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) if (ent.isFile()) paths.push(join(dir, ent.name));
} else paths.push(target);

const results = paths.map((p) => analyze(p));
const spark = (v) => ' .:-=+*#%@'[Math.max(0, Math.min(9, Math.round((v / 8) * 9)))];
const bars = (blocks, w) => {
  const step = Math.max(1, Math.ceil(blocks.length / w));
  let out = '';
  for (let i = 0; i < blocks.length; i += step) {
    const avg = blocks.slice(i, i + step).reduce((a, b) => a + b.entropy, 0) / Math.min(step, blocks.length - i);
    out += spark(avg);
  }
  return out;
};

if (flag(o, 'json')) process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : { scanned: results.length, files: results.map((r) => ({ ...r, blocks: r.blocks.slice(0, 2000) })) }, null, 2) + '\n');
else {
  for (const r of results) {
    console.log(`${r.file} — ${fmt(r.size)} bytes, ${r.blockCount} blocks of ${r.block} B, whole-file entropy ${r.wholeFileEntropy} bits/byte`);
    console.log(`thresholds: high >= ${high}, flat <= ${low}, min run ${minRun} block(s)`);
    if (flag(o, 'map') || !flag(o, 'json')) {
      console.log('\nENTROPY MAP (low ' + spark(0) + ' -> high ' + spark(8) + ')');
      console.log('0x0' + ' ' + bars(r.blocks, chartW) + ` 0x${r.size.toString(16)}`);
    }
    if (r.runs.length) {
      console.log('\nRUNS');
      console.log(table(r.runs.map((x) => ({
        kind: x.kind, start: '0x' + x.start.toString(16), end: '0x' + x.end.toString(16),
        bytes: fmt(x.end - x.start), blocks: x.blocks, entropy: x.entropyAvg ?? '-',
      })), ['kind', 'start', 'end', 'bytes', 'blocks', 'entropy']));
    } else console.log('\nno runs at or above the report threshold');
    const top = [...r.blocks].sort((a, b) => b.entropy - a.entropy).slice(0, 5);
    console.log('\nHIGHEST-ENTROPY BLOCKS');
    console.log(table(top.map((b) => ({ offset: '0x' + b.offset.toString(16), entropy: b.entropy, zeros: b.zeroRatio, printable: b.printableRatio, class: b.class })), ['offset', 'entropy', 'zeros', 'printable', 'class']));
    if (patterns.length) {
      const hitBlocks = r.blocks.filter((b) => b.patternHits && b.patternHits.some((h) => h.count));
      console.log(`\nPATTERN HITS (${patterns.map((p) => p.hex).join(', ')}): ${hitBlocks.length} block(s)`);
      for (const b of hitBlocks.slice(0, 10)) console.log(`  0x${b.offset.toString(16)}  ` + b.patternHits.filter((h) => h.count).map((h) => `${h.hex}x${h.count}`).join(' '));
    }
  }
}
