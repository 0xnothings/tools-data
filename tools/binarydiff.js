// binarydiff.js — byte-level diff of two files: offset-anchored hunks, prefix/suffix trim, per-region entropy.
// Copyright (c) 2026 0xnothings
// @tool binarydiff
// @desc Byte-level diff of two binaries with offset-anchored hunks, resync and per-region entropy
// @usage node tools/binarydiff.js old.bin new.bin --json
// @tags data,binary,diff,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `binarydiff — byte-level binary comparison

  node tools/binarydiff.js <file-a> <file-b> [options]

  --context <n>     bytes of context around each hunk (default 16)
  --max-hunks <n>   stop after n hunks (default 200)
  --resync <n>      matches of this length close a hunk (default 12, min 4)
  --hex             hexdump every hunk side by side
  --entropy         per-hunk Shannon entropy for both files
  --window <n>      entropy window for the shifted-region report (default 512)
  --json            machine-readable output
  -h, --help        this text

  Algorithm: trim the identical prefix/suffix, then walk both buffers forward.
  On a mismatch, look ahead up to 4 KiB on either side for a run of --resync
  identical bytes and treat that as the resync point — so pure insertions and
  deletions collapse into one hunk with a signed shift instead of thousands of
  one-byte differences.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['entropy', 'hex', 'json']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }
const fa = o._[0], fb = o._[1];
if (!fa || !fb) die('need two files — node tools/binarydiff.js old.bin new.bin');

let A, B;
try { A = readFileSync(fa); } catch (e) { die(`cannot read ${fa}: ${e.message}`); }
try { B = readFileSync(fb); } catch (e) { die(`cannot read ${fb}: ${e.message}`); }

const ctx = Math.max(0, num(get(o, 'context', 16), 16));
const maxHunks = num(get(o, 'max-hunks', 200), 200);
const resync = Math.max(4, num(get(o, 'resync', 12), 12));
const windowN = Math.max(16, num(get(o, 'window', 512), 512));

function entropyOf(buf) {
  if (!buf.length) return 0;
  const counts = new Array(256).fill(0);
  for (const b of buf) counts[b]++;
  let e = 0;
  for (const c of counts) if (c) { const p = c / buf.length; e -= p * Math.log2(p); }
  return Number(e.toFixed(4));
}

const minLen = Math.min(A.length, B.length);
let prefix = 0;
while (prefix < minLen && A[prefix] === B[prefix]) prefix++;
let suffix = 0;
while (suffix < minLen - prefix && A[A.length - 1 - suffix] === B[B.length - 1 - suffix]) suffix++;

function findRun(a, b, ai, bi, need, lookAhead) {
  const limitA = Math.min(a.length, ai + lookAhead);
  for (let p = ai; p < limitA; p++) {
    if (a[p] !== b[bi]) continue;
    let n = 0;
    while (ai + (p - ai) + n < a.length && bi + n < b.length && a[p + n] === b[bi + n] && n < need) n++;
    if (n >= need) return { type: 'insert-into-b', atA: ai, atB: bi, matched: n };
  }
  const limitB = Math.min(b.length, bi + lookAhead);
  for (let q = bi; q < limitB; q++) {
    if (b[q] !== a[ai]) continue;
    let n = 0;
    while (bi + (q - bi) + n < b.length && ai + n < a.length && b[q + n] === a[ai + n] && n < need) n++;
    if (n >= need) return { type: 'delete-from-b', atA: ai, atB: bi, matched: n };
  }
  return null;
}

const aEnd = A.length - suffix, bEnd = B.length - suffix;
const hunks = [];
let ai = prefix, bi = prefix, truncated = false;
const LOOK = 4096;

while (ai < aEnd || bi < bEnd) {
  while (ai < aEnd && bi < bEnd && A[ai] === B[bi]) { ai++; bi++; }
  if (ai >= aEnd && bi >= bEnd) break;
  const startA = ai, startB = bi;
  let resynced = null;
  let sa = ai, sb = bi;
  while (sa < aEnd || sb < bEnd) {
    if (sa < aEnd && sb < bEnd && A[sa] === B[sb] && sa > ai && sb > bi) {
      let n = 0;
      while (sa + n < aEnd && sb + n < bEnd && A[sa + n] === B[sb + n] && n < resync) n++;
      if (n >= resync) { resynced = { sa, sb }; break; }
    }
    const r = findRun(A, B, sa, sb, resync, LOOK);
    if (r) { resynced = { sa: r.atA, sb: r.atB }; break; }
    if (sa < aEnd) sa++;
    if (sb < bEnd) sb++;
    if (sa - startA > LOOK && sb - startB > LOOK) break;
  }
  const endA = resynced ? resynced.sa : aEnd;
  const endB = resynced ? resynced.sb : bEnd;
  const ra = A.slice(startA, endA), rb = B.slice(startB, endB);
  hunks.push({
    aOffset: startA, bOffset: startB,
    aLength: ra.length, bLength: rb.length,
    shift: rb.length - ra.length,
    kind: ra.length === 0 ? 'insert' : rb.length === 0 ? 'delete' : ra.length === rb.length ? 'substitute' : 'replace',
    a: ra, b: rb,
  });
  ai = endA; bi = endB;
  if (hunks.length >= maxHunks * 4) { truncated = true; break; }
}

let changedA = 0, changedB = 0;
for (const h of hunks) { changedA += h.aLength; changedB += h.bLength; }

const blockEntropy = (buf) => {
  const out = [];
  for (let p = 0; p < buf.length; p += windowN) {
    const chunk = buf.slice(p, p + windowN);
    out.push({ offset: p, bytes: chunk.length, entropy: entropyOf(chunk) });
  }
  return out;
};

const report = {
  a: { path: fa, size: A.length, entropy: entropyOf(A) },
  b: { path: fb, size: B.length, entropy: entropyOf(B) },
  identical: A.equals(B),
  commonPrefixBytes: prefix,
  commonSuffixBytes: suffix,
  changedBytesA: changedA,
  changedBytesB: changedB,
  changeRatio: Number(((changedA + changedB) / Math.max(1, A.length + B.length)).toFixed(6)),
  hunkCount: hunks.length,
  truncated,
  hunkSummary: hunks.reduce((m, h) => { m[h.kind] = (m[h.kind] || 0) + 1; return m; }, {}),
};

if (flag(o, 'hex')) report.hunks = hunks.slice(0, maxHunks).map((h) => ({
  kind: h.kind, aOffset: h.aOffset, bOffset: h.bOffset, shift: h.shift,
  aLength: h.aLength, bLength: h.bLength,
  aHex: h.a.slice(0, 4096).toString('hex'), bHex: h.b.slice(0, 4096).toString('hex'),
}));
else report.hunks = hunks.slice(0, maxHunks).map((h) => ({
  kind: h.kind, aOffset: h.aOffset, bOffset: h.bOffset, aLength: h.aLength, bLength: h.bLength, shift: h.shift,
  aPreview: h.a.slice(0, 32).toString('hex'), bPreview: h.b.slice(0, 32).toString('hex'),
}));

if (flag(o, 'entropy')) {
  report.entropyBlocksA = blockEntropy(A);
  report.entropyBlocksB = blockEntropy(B);
  report.hunkEntropy = hunks.slice(0, maxHunks).map((h) => ({ aOffset: h.aOffset, bOffset: h.bOffset, aEntropy: entropyOf(h.a), bEntropy: entropyOf(h.b) }));
}

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${fa} (${fmt(A.length)} B, H=${report.a.entropy})  vs  ${fb} (${fmt(B.length)} B, H=${report.b.entropy})`);
  console.log(report.identical ? 'files are IDENTICAL' : `${hunks.length} hunk(s), ${fmt(changedA)} B changed in A, ${fmt(changedB)} B in B (${(report.changeRatio * 100).toFixed(3)}% of total bytes)`);
  console.log(`common prefix ${fmt(prefix)} B, common suffix ${fmt(suffix)} B`);
  if (!report.identical) {
    console.log('\n' + table(hunks.slice(0, maxHunks).map((h) => ({
      kind: h.kind, 'A off': h.aOffset, 'B off': h.bOffset, 'A len': h.aLength, 'B len': h.bLength, shift: (h.shift > 0 ? '+' : '') + h.shift,
    })), ['kind', 'A off', 'B off', 'A len', 'B len', 'shift']));
    if (hunks.length > maxHunks) console.log(`... ${hunks.length - maxHunks} more hunk(s)`);
    if (flag(o, 'hex')) {
      console.log('\nHUNKS (hex, context-trimmed)');
      for (const h of hunks.slice(0, 20)) {
        const lo = Math.max(0, h.aOffset - ctx), hi = Math.min(A.length, h.aOffset + h.aLength + ctx);
        const loB = Math.max(0, h.bOffset - ctx), hiB = Math.min(B.length, h.bOffset + h.bLength + ctx);
        console.log(`\n@@ A 0x${lo.toString(16)}..0x${hi.toString(16)}  B 0x${loB.toString(16)}..0x${hiB.toString(16)}  (${h.kind}, shift ${h.shift})`);
        console.log('- ' + A.slice(lo, hi).toString('hex').replace(/(.{32})/g, '$1\n- ').trimEnd());
        console.log('+ ' + B.slice(loB, hiB).toString('hex').replace(/(.{32})/g, '$1\n+ ').trimEnd());
      }
    }
  }
  if (flag(o, 'entropy')) {
    console.log(`\nENTROPY BLOCKS (window ${windowN}) — showing blocks over 7.0 bits/byte`);
    const hiA = report.entropyBlocksA.filter((x) => x.entropy > 7), hiB = report.entropyBlocksB.filter((x) => x.entropy > 7);
    console.log(`A: ${hiA.length}/${report.entropyBlocksA.length} high-entropy blocks | B: ${hiB.length}/${report.entropyBlocksB.length}`);
    if (hiA.length) console.log('A: ' + hiA.slice(0, 12).map((x) => `0x${x.offset.toString(16)}(${x.entropy})`).join(' '));
    if (hiB.length) console.log('B: ' + hiB.slice(0, 12).map((x) => `0x${x.offset.toString(16)}(${x.entropy})`).join(' '));
  }
}
