// dupefind.js — content-hash duplicate finder with reclaimable-byte accounting.
// Copyright (c) 2026 0xnothings
// @tool dupefind
// @desc Find duplicate files by size-then-hash, report reclaimable bytes and clusters
// @usage node tools/dupefind.js ./photos --min-size 1kb
// @tags files,dedupe,disk,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readdirSync, statSync, createReadStream, lstatSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

const HELP = `dupefind — duplicate file finder

  node tools/dupefind.js <dir...> [options]

  --min-size <n>     ignore files smaller than n bytes (suffixes: kb, mb, gb)
  --max-size <n>     ignore files larger than n bytes
  --algo <a>         sha256 (default) | sha1 | md5
  --partial <n>      bytes to hash before full-read (default 4096, 0 = full only)
  --ext <list>       only these extensions (comma separated, no dots)
  --exclude <glob>   skip path substrings (repeatable)
  --delete <mode>    none | keep-first | keep-oldest  (default none; requires --yes)
  -y, --yes          confirm destructive action
  --empty            include zero-byte files as duplicate candidates
  --json             machine-readable output
  -h, --help         this text

  Two-stage hashing: group by size, then by a partial read, then by full content,
  so large trees with few real duplicates stay fast.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const roots = o._.slice();
if (!roots.length) die('need at least one directory — node tools/dupefind.js ./dir');

const parseSize = (v, def) => {
  if (v === undefined || v === null) return def;
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) return def;
  const n = parseFloat(m[1]);
  const u = (m[2] || 'b').toLowerCase();
  return Math.floor(n * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[u]);
};

const minSize = parseSize(get(o, 'min-size', null), 1);
const maxSize = parseSize(get(o, 'max-size', null), Infinity);
const algo = String(get(o, 'algo', 'sha256'));
if (!['sha256', 'sha1', 'md5'].includes(algo)) die('--algo must be sha256 | sha1 | md5');
const partialN = num(get(o, 'partial', 4096), 4096);
const extFilter = get(o, 'ext', null) ? String(get(o, 'ext')).split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()) : null;
const excludes = [];
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--exclude' && process.argv[i + 1]) excludes.push(process.argv[i + 1]);
const includeEmpty = flag(o, 'empty');
const deleteMode = String(get(o, 'delete', 'none'));

const files = [];
let skippedDirs = 0, errors = 0;

function walk(dir, depth) {
  if (depth > 64) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { errors++; return; }
  for (const ent of ents) {
    const full = join(dir, ent.name);
    if (excludes.some((x) => full.includes(x))) { skippedDirs++; continue; }
    let st;
    try { st = lstatSync(full); } catch { errors++; continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { walk(full, depth + 1); continue; }
    if (!st.isFile()) continue;
    if (st.size < minSize || st.size > maxSize) continue;
    if (st.size === 0 && !includeEmpty) continue;
    if (extFilter) {
      const e = extname(ent.name).replace(/^\./, '').toLowerCase();
      if (!extFilter.includes(e)) continue;
    }
    files.push({ path: full, size: st.size, mtime: st.mtimeMs });
  }
}
for (const r of roots) {
  try {
    const st = statSync(r);
    if (st.isDirectory()) walk(r, 0);
    else if (st.isFile()) files.push({ path: r, size: st.size, mtime: st.mtimeMs });
  } catch (e) { die(`cannot stat ${r}: ${e.message}`); }
}

function hashFile(path, bytes) {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    const s = createReadStream(path, bytes ? { start: 0, end: bytes - 1 } : undefined);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

const bySize = new Map();
for (const f of files) {
  if (!bySize.has(f.size)) bySize.set(f.size, []);
  bySize.get(f.size).push(f);
}
const sizeCandidates = [...bySize.entries()].filter(([, v]) => v.length > 1);
let partialHashes = 0, fullHashes = 0;

const byPartial = new Map();
for (const [size, group] of sizeCandidates) {
  if (partialN > 0 && size > partialN) {
    for (const f of group) {
      let h;
      try { h = await hashFile(f.path, partialN); partialHashes++; } catch { errors++; continue; }
      const k = `${size}:${h}`;
      if (!byPartial.has(k)) byPartial.set(k, []);
      byPartial.get(k).push(f);
    }
  } else {
    const k = `${size}:full`;
    if (!byPartial.has(k)) byPartial.set(k, []);
    byPartial.get(k).push(...group);
  }
}

const clusters = [];
for (const [, group] of byPartial) {
  if (group.length < 2) continue;
  const byFull = new Map();
  for (const f of group) {
    let h;
    try { h = await hashFile(f.path, 0); fullHashes++; } catch { errors++; continue; }
    if (!byFull.has(h)) byFull.set(h, []);
    byFull.get(h).push(f);
  }
  for (const [hash, hits] of byFull) {
    if (hits.length < 2) continue;
    hits.sort((a, b) => a.path.localeCompare(b.path));
    clusters.push({
      hash, size: hits[0].size, count: hits.length,
      reclaimable: hits[0].size * (hits.length - 1),
      files: hits.map((h) => ({ path: h.path, mtime: new Date(h.mtime).toISOString() })),
    });
  }
}

clusters.sort((a, b) => b.reclaimable - a.reclaimable);
const totalReclaim = clusters.reduce((s, c) => s + c.reclaimable, 0);
const totalFiles = clusters.reduce((s, c) => s + c.count, 0);
const wasted = totalFiles - clusters.length;

let deleted = [];
if (deleteMode !== 'none') {
  if (!flag(o, 'y') && !flag(o, 'yes')) die(`${deleteMode} deletes files — re-run with --yes to confirm`);
  const { unlinkSync } = await import('node:fs');
  for (const c of clusters) {
    const keep = deleteMode === 'keep-first'
      ? [...c.files].sort((a, b) => a.path.localeCompare(b.path))[0]
      : [...c.files].sort((a, b) => new Date(a.mtime) - new Date(b.mtime))[0];
    for (const f of c.files) {
      if (f.path === keep.path) continue;
      try { unlinkSync(f.path); deleted.push(f.path); } catch { errors++; }
    }
  }
}

const human = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    roots, scannedFiles: files.length, hashed: { partial: partialHashes, full: fullHashes },
    duplicateClusters: clusters.length, redundantFiles: wasted,
    reclaimableBytes: totalReclaim, reclaimable: human(totalReclaim),
    skippedDirs, errors, deleted,
    clusters: clusters.map((c) => ({ ...c, humanSize: human(c.size), humanReclaim: human(c.reclaimable) })),
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`roots       ${roots.join(', ')}`);
  out.push(`scanned     ${files.length} file(s)  (partial hashes ${partialHashes}, full ${fullHashes})`);
  out.push(`clusters    ${clusters.length} duplicate group(s), ${wasted} redundant copy(ies)`);
  out.push(`reclaimable ${human(totalReclaim)} (${totalReclaim.toLocaleString('en-US')} bytes)`);
  if (errors) out.push(`errors      ${errors} unreadable path(s)`);
  if (deleted.length) out.push(`deleted     ${deleted.length} file(s), freed ${human(deleted.length ? totalReclaim : 0)}`);
  out.push('');
  for (const c of clusters.slice(0, 40)) {
    out.push(`${human(c.size)} x${c.count}  saves ${human(c.reclaimable)}  [${c.hash.slice(0, 12)}]`);
    for (const f of c.files) out.push(`    ${f.path}`);
  }
  if (clusters.length > 40) out.push(`... ${clusters.length - 40} more cluster(s)`);
  if (!clusters.length) out.push('no duplicates found');
  process.stdout.write(out.join('\n') + '\n');
}
process.exit(clusters.length ? 0 : 0);
