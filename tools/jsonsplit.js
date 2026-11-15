#!/usr/bin/env node
// jsonsplit.js — split a large JSON array into N shards by count or size, with an index manifest.
// Copyright (c) 2026 0xnothings
// @tool jsonsplit
// @desc Split a JSON array into count- or size-bounded shards plus a verifiable index manifest
// @usage node tools/jsonsplit.js big.json --parts 8 --out ./shards --json
// @tags data,json,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';

const HELP = `jsonsplit — JSON array sharder

  node tools/jsonsplit.js <array.json|-> [options]

  --parts <n>       split into exactly n shards
  --per <n>         max elements per shard
  --max-bytes <n>   max serialised bytes per shard (1m, 512k, 2000000)
  --out <dir>       output directory (default: <name>.shards)
  --prefix <name>   shard filename prefix (default: <basename>)
  --wrap <key>      wrap each shard as {"<key>": [...]} instead of a bare array
  --pretty          indent shard JSON (default: compact, 2-space with --pretty)
  --manifest        write manifest.json into the output dir (default on)
  --no-manifest     skip the manifest
  --field <name>    shard by consecutive runs of this top-level field value
  --json            machine-readable output
  -h, --help        this text

  Reads the whole array first (streaming a JSON array without a parser is a lie),
  then partitions it. The manifest records every shard's element range, byte size
  and SHA-256, so a downstream job can verify it consumed the complete set.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'no-manifest', 'pretty']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/jsonsplit.js big.json --parts 8 --out ./shards');
const text = await readInput(src);
if (!text.trim()) die('input is empty');

let data;
try { data = JSON.parse(text); } catch (e) { die(`JSON parse failed: ${e.message}`); }
if (!Array.isArray(data)) {
  const arrKey = ['items', 'rows', 'records', 'data', 'results'].find((k) => Array.isArray(data?.[k]));
  if (!arrKey) die(`top-level value is ${Array.isArray(data) ? 'an array' : typeof data} — expected an array (or an object with an items/rows/records/data array)`);
  data = data[arrKey];
}
if (!data.length) die('array is empty — nothing to shard');

const parseBytes = (v) => {
  if (v === undefined || v === null || v === true) return null;
  const s = String(v).trim().toLowerCase();
  if (/^\d+(\.\d+)?[kmg]$/.test(s)) return Math.round(parseFloat(s) * { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[s.slice(-1)]);
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

const parts = num(get(o, 'parts', 0), 0);
const per = num(get(o, 'per', 0), 0);
const maxBytes = parseBytes(get(o, 'max-bytes', null));
const field = get(o, 'field', null) ? String(get(o, 'field')) : null;
const pretty = flag(o, 'pretty');
const wrapKey = get(o, 'wrap', null) ? String(get(o, 'wrap')) : null;

const modes = [parts > 0, per > 0, maxBytes !== null, field !== null].filter(Boolean).length;
if (modes > 1) die('use exactly one of --parts, --per, --max-bytes, --field');
if (modes === 0) die('need a shard mode: --parts, --per, --max-bytes or --field');

const shards = [];
if (field) {
  for (const el of data) {
    const key = el && typeof el === 'object' ? JSON.stringify(el[field]) : null;
    const last = shards[shards.length - 1];
    if (last && last.groupKey === key) last.elements.push(el);
    else shards.push({ groupKey: key, groupValue: el && typeof el === 'object' ? el[field] : null, elements: [el] });
  }
} else if (maxBytes !== null) {
  let cur = [], curBytes = 2;
  const overhead = (e) => JSON.stringify(e).length + 1;
  for (const el of data) {
    const size = overhead(el);
    if (cur.length && curBytes + size > maxBytes) { shards.push({ elements: cur }); cur = []; curBytes = 2; }
    cur.push(el);
    curBytes += size;
  }
  if (cur.length) shards.push({ elements: cur });
} else {
  const size = per > 0 ? per : Math.ceil(data.length / parts);
  for (let i = 0; i < data.length; i += size) shards.push({ elements: data.slice(i, i + size) });
}

const outDir = String(get(o, 'out', `${basename(src, extname(src))}.shards`));
const prefix = String(get(o, 'prefix', basename(src, extname(src))));
mkdirSync(outDir, { recursive: true });

const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = { source: src, sourceBytes: Buffer.byteLength(text, 'utf8'), sourceElements: data.length, sourceSha256: sha(Buffer.from(text, 'utf8')), mode: field ? 'field' : maxBytes !== null ? 'max-bytes' : per > 0 ? 'per' : 'parts', shards: [] };

let totalElements = 0;
shards.forEach((s, i) => {
  const body = wrapKey ? { [wrapKey]: s.elements } : s.elements;
  const serialised = JSON.stringify(body, null, pretty ? 2 : 0) + '\n';
  const shardName = `${prefix}.part${String(i).padStart(4, '0')}.json`;
  const path = join(outDir, shardName);
  writeFileSync(path, serialised);
  const rec = {
    index: i, file: shardName, path, elements: s.elements.length,
    from: totalElements, to: totalElements + s.elements.length - 1,
    bytes: Buffer.byteLength(serialised, 'utf8'),
    sha256: sha(Buffer.from(serialised, 'utf8')),
    ...(field ? { groupField: field, groupValue: s.groupValue ?? null } : {}),
  };
  totalElements += s.elements.length;
  manifest.shards.push(rec);
});

manifest.totalElements = totalElements;
manifest.complete = totalElements === data.length;
manifest.shardCount = manifest.shards.length;
manifest.bytesWritten = manifest.shards.reduce((a, s) => a + s.bytes, 0);

const wantManifest = !flag(o, 'no-manifest');
if (wantManifest) writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (flag(o, 'json')) process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
else {
  console.log(`${src} — ${fmt(data.length)} element(s) -> ${manifest.shardCount} shard(s) in ${outDir} (mode: ${manifest.mode})`);
  console.log(`source sha256: ${manifest.sourceSha256}`);
  console.log(table(manifest.shards.slice(0, 80).map((s) => ({
    index: s.index, file: s.file, elements: s.elements, range: `${s.from}..${s.to}`, bytes: fmt(s.bytes), sha: s.sha256.slice(0, 16),
    ...(s.groupField ? { group: String(s.groupValue) } : {}),
  })), ['index', 'file', 'elements', 'range', 'bytes', 'sha', ...(field ? ['group'] : [])]));
  if (manifest.shards.length > 80) console.log(`... ${manifest.shards.length - 80} more shard(s)`);
  console.log(`\ntotal ${fmt(totalElements)} element(s)${manifest.complete ? ' — every source element accounted for' : ' — MISMATCH against source count'}`);
  if (wantManifest) console.log(`manifest written: ${join(outDir, 'manifest.json')}`);
}
