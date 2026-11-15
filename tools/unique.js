#!/usr/bin/env node
// unique.js — fuzzy line dedupe with Levenshtein clustering.
// Copyright (c) 2026 0xnothings
// @tool unique
// @desc Deduplicate lines with Levenshtein/normalized similarity, report clusters
// @usage node tools/unique.js emails.txt --threshold 2 --keep shortest
// @tags text,dedupe,fuzzy,cli
import { args, get, num, flag, die, readInput } from '../_lib.js';

const HELP = `unique — fuzzy line deduplication

  node tools/unique.js <file|-> [options]

  --threshold <n>     max edit distance to treat as the same (default 0 = exact)
  --similarity <f>    or use a normalized ratio 0..1 (overrides --threshold)
  --keep <mode>       first (default) | last | shortest | longest | most-frequent
  --normalize <list>  case,trim,ws,unicode,punct,digits  (default trim)
  --stream            do not cluster, just drop lines within threshold of a kept line
  --report            print clusters and counts, keep nothing hidden
  --cluster-max <n>   cap comparisons per line for huge inputs (default 20000)
  --json              machine-readable output
  -h, --help          this text

  Uses a banded Levenshtein with an early-exit when the length difference already
  exceeds the threshold, so it stays usable on tens of thousands of lines.
  Cluster representatives are chosen by --keep.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a file or pipe lines on stdin');

const raw = await readInput(src);
const all = raw.split(/\r?\n/);

const normOpts = new Set(String(get(o, 'normalize', 'trim')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
function normalize(line) {
  let s = line;
  if (normOpts.has('case')) s = s.toLowerCase();
  if (normOpts.has('ws')) s = s.replace(/\s+/g, ' ');
  if (normOpts.has('unicode')) s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  if (normOpts.has('punct')) s = s.replace(/[^\w\s]/g, '');
  if (normOpts.has('digits')) s = s.replace(/\d/g, '#');
  if (normOpts.has('trim') || normOpts.size === 0) s = s.trim();
  return s;
}

function levenshtein(a, b, max) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = new Int32Array(lb + 1);
  let cur = new Int32Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

function similarity(a, b, max) {
  const d = levenshtein(a, b, Math.max(max, 64));
  const longest = Math.max(a.length, b.length) || 1;
  return 1 - d / longest;
}

const rawThreshold = num(get(o, 'threshold', 0), 0);
const simOpt = get(o, 'similarity', null);
const simThreshold = simOpt !== null ? Math.max(0, Math.min(1, num(simOpt, 0.8))) : null;
const clusterMax = num(get(o, 'cluster-max', 20000), 20000);

const withIndex = all.map((line, i) => ({ text: line, idx: i, norm: normalize(line) })).filter((l) => l.text !== '');
const emptyCount = all.length - withIndex.length;

const clusters = [];
let streamKept = 0, streamDropped = 0;

function sim(a, b) {
  if (simThreshold !== null) return similarity(a, b, Math.ceil((1 - simThreshold) * Math.max(a.length, b.length) + 1));
  return levenshtein(a, b, rawThreshold) <= rawThreshold;
}

if (flag(o, 'stream')) {
  const kept = [];
  for (const item of withIndex) {
    let hit = false;
    const limit = Math.min(kept.length, clusterMax);
    for (let i = kept.length - 1; i >= Math.max(0, kept.length - limit); i--) {
      if (sim(item.norm, kept[i].norm)) { hit = true; break; }
    }
    if (hit) streamDropped++;
    else { kept.push(item); streamKept++; }
  }
  const out = kept.map((k) => k.text).join('\n');
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ mode: 'stream', input: withIndex.length, kept: streamKept, dropped: streamDropped, lines: kept.map((k) => k.text) }, null, 2) + '\n');
  else process.stdout.write(out + (out ? '\n' : ''));
  process.exit(0);
}

const index = new Map();
for (const item of withIndex) {
  if (!index.has(item.norm)) index.set(item.norm, []);
  index.get(item.norm).push(item);
}

const byLength = [...index.keys()].sort((a, b) => a.length - b.length);
const assigned = new Set();
for (const key of byLength) {
  if (assigned.has(key)) continue;
  const members = [...index.get(key)];
  assigned.add(key);
  for (let j = 0; j < byLength.length; j++) {
    const other = byLength[j];
    if (assigned.has(other)) continue;
    if (Math.abs(other.length - key.length) > (simThreshold !== null ? Math.max(4, key.length * (1 - simThreshold) + 1) : rawThreshold)) continue;
    if (sim(key, other)) {
      members.push(...index.get(other));
      assigned.add(other);
    }
  }
  members.sort((a, b) => a.idx - b.idx);
  clusters.push({
    representative: members[0].text,
    normalized: key,
    count: members.length,
    variants: members.map((m) => m.text),
    lineNumbers: members.map((m) => m.idx + 1),
  });
}

const keepMode = String(get(o, 'keep', 'first'));
const pick = (c) => {
  switch (keepMode) {
    case 'last': return c.variants[c.variants.length - 1];
    case 'shortest': return c.variants.reduce((a, b) => (b.length < a.length ? b : a));
    case 'longest': return c.variants.reduce((a, b) => (b.length > a.length ? b : a));
    case 'most-frequent': return c.variants.reduce((a, b) => (b.length >= a.length ? b : a));
    default: return c.representative;
  }
};

const output = clusters.map(pick);
const dupClusters = clusters.filter((c) => c.count > 1);
const removedCount = withIndex.length - clusters.length;

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    input: withIndex.length, emptyLines: emptyCount,
    clusters: clusters.length, duplicateClusters: dupClusters.length,
    removed: removedCount, keep: keepMode,
    threshold: simThreshold !== null ? { similarity: simThreshold } : { editDistance: rawThreshold },
    groups: dupClusters.map((c) => ({ representative: pick(c), count: c.count, variants: c.variants, lines: c.lineNumbers })),
    lines: output,
  }, null, 2) + '\n');
} else if (flag(o, 'report')) {
  const out = [];
  out.push(`${clusters.length} kept, ${removedCount} removed (${dupClusters.length} fold groups) from ${withIndex.length} non-empty lines`);
  out.push(`matching: ${simThreshold !== null ? `similarity >= ${simThreshold}` : `edit distance <= ${rawThreshold}`}, keep=${keepMode}`);
  out.push('');
  for (const c of dupClusters) {
    out.push(`x${c.count}  keep: ${pick(c)}   (lines ${c.lineNumbers.join(', ')})`);
    for (const v of c.variants) out.push(`      | ${v}`);
  }
  if (!dupClusters.length) out.push('no near-duplicates found');
  process.stdout.write(out.join('\n') + '\n');
} else {
  process.stdout.write(output.join('\n') + (output.length ? '\n' : ''));
}
