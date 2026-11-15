#!/usr/bin/env node
// hashdir.js — hash every file in a tree and emit a verifiable manifest.
// Copyright (c) 2026 0xnothings
// @tool hashdir
// @desc Hash a directory tree into a manifest and verify it later, detecting drift
// @usage node tools/hashdir.js ./src --algo sha256 --out manifest.json
// @tags files,hashing,integrity,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readdirSync, statSync, createReadStream, readFileSync, writeFileSync, lstatSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep, basename } from 'node:path';

const HELP = `hashdir — directory hashing and manifest verification

  node tools/hashdir.js <dir> [options]                 (create or verify)
  node tools/hashdir.js <dir> --verify <manifest>       (verify against a manifest)

  --algo <a>         sha256 (default) | sha1 | md5 | sha512
  --out <file>       write the manifest here (default: stdout)
  --verify <file>    verify the tree against a previously written manifest
  --format <f>       json (default) | tsv | sha256sum (checksum-tool compatible)
  --exclude <glob>   skip path substrings (repeatable)
  --ext <list>       only hash these extensions
  --min-size <n>     skip files smaller than n bytes
  --follow           follow symbolic links (default: hash link targets as text)
  --quiet            suppress per-file progress on stderr
  --json             machine-readable output
  -h, --help         this text

  The manifest records the algorithm, the file size and the digest, so verification
  reports modified, missing and newly added files with sizes. Paths are stored
  relative to the scanned root with forward slashes for portability.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const root = o._[0];
if (!root) die('need a directory — node tools/hashdir.js ./src --out manifest.json');

const algo = String(get(o, 'algo', 'sha256')).toLowerCase();
if (!['sha256', 'sha1', 'md5', 'sha512'].includes(algo)) die('--algo must be sha256 | sha1 | md5 | sha512');
const outFile = get(o, 'out', null);
const verifyFile = get(o, 'verify', null);
const format = String(get(o, 'format', 'json'));
const excludes = [];
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--exclude' && process.argv[i + 1]) excludes.push(process.argv[i + 1]);
const extFilter = get(o, 'ext', null) ? String(get(o, 'ext')).split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()) : null;
const minSize = num(get(o, 'min-size', 0), 0);
const follow = flag(o, 'follow');

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    const s = createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function walk(dir, depth, acc) {
  if (depth > 48) return acc;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of ents) {
    const full = join(dir, ent.name);
    if (excludes.some((x) => full.includes(x))) continue;
    let st;
    try { st = lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink() && !follow) {
      acc.push({ path: full, size: 0, symlink: true, target: (() => { try { return readlinkSync(full); } catch { return ''; } })() });
      continue;
    }
    if (ent.isDirectory() || (follow && statSync(full).isDirectory())) { walk(full, depth + 1, acc); continue; }
    if (!ent.isFile() && !follow) continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size < minSize) continue;
    if (extFilter) {
      const e = ent.name.includes('.') ? ent.name.split('.').pop().toLowerCase() : '';
      if (!extFilter.includes(e)) continue;
    }
    acc.push({ path: full, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
  }
  return acc;
}

const files = walk(root, 0, []).sort((a, b) => a.path.localeCompare(b.path));
const rel = (p) => relative(root, p).split(sep).join('/');

if (verifyFile) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(String(verifyFile), 'utf8')); } catch (e) {
    // Accept a sha256sum-style or tsv manifest as a fallback.
    try {
      const lines = readFileSync(String(verifyFile), 'utf8').split(/\r?\n/).filter(Boolean);
      const entries = [];
      for (const line of lines) {
        const m = line.match(/^([0-9a-f]{32,128})[\s*]+(.+)$/);
        if (m) entries.push({ digest: m[1], path: m[2], size: null });
      }
      if (!entries.length) die(`cannot parse manifest ${verifyFile}: ${e.message}`);
      manifest = { algorithm: algo, files: entries };
    } catch (e2) { die(`cannot read manifest ${verifyFile}: ${e2.message}`); }
  }

  const recorded = new Map((manifest.files || []).map((f) => [f.path, f]));
  const present = new Set();
  const modified = [], missing = [], sizeChanged = [];
  let verified = 0;

  for (const f of files) {
    const key = rel(f.path);
    present.add(key);
    const rec = recorded.get(key);
    if (!rec) continue;
    let digest;
    try { digest = await hashFile(f.path); } catch (e) { missing.push({ path: key, error: e.message }); continue; }
    if (rec.size !== null && rec.size !== undefined && rec.size !== f.size) {
      sizeChanged.push({ path: key, recordedSize: rec.size, actualSize: f.size, digest, recordedDigest: rec.digest });
      continue;
    }
    if (digest !== rec.digest) modified.push({ path: key, recordedDigest: rec.digest, actualDigest: digest, size: f.size });
    else verified++;
    if (!flag(o, 'quiet')) process.stderr.write(`\r${verified + modified.length + sizeChanged.length}/${files.length} checked`);
  }
  if (!flag(o, 'quiet')) process.stderr.write('\n');

  const added = files.map((f) => rel(f.path)).filter((k) => !recorded.has(k));
  const gone = (manifest.files || []).map((f) => f.path).filter((k) => !present.has(k) && !missing.some((m) => m.path === k));

  const clean = !modified.length && !missing.length && !sizeChanged.length && !added.length && !gone.length;
  const result = {
    verify: verifyFile,
    algorithm: manifest.algorithm || algo,
    root,
    recordedEntries: (manifest.files || []).length,
    scannedFiles: files.length,
    verified, modified, sizeChanged, missing, added, removed: gone,
    clean,
  };

  if (flag(o, 'json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    const out = [];
    out.push(`verify     ${verifyFile}  (${result.algorithm})`);
    out.push(`root       ${root}`);
    out.push(`${verified} verified, ${modified.length + sizeChanged.length} modified, ${missing.length} unreadable, ${added.length} added, ${gone.length} removed`);
    out.push('');
    if (modified.length) { out.push(`MODIFIED (${modified.length})`); for (const m of modified.slice(0, 50)) out.push(`  M ${m.path}  ${m.recordedDigest.slice(0, 12)} -> ${m.actualDigest.slice(0, 12)}`); }
    if (sizeChanged.length) { out.push(`SIZE CHANGED (${sizeChanged.length})`); for (const m of sizeChanged.slice(0, 50)) out.push(`  S ${m.path}  ${m.recordedSize} -> ${m.actualSize}`); }
    if (missing.length) { out.push(`UNREADABLE (${missing.length})`); for (const m of missing.slice(0, 50)) out.push(`  ! ${m.path}  ${m.error}`); }
    if (added.length) { out.push(`ADDED (${added.length})`); for (const a of added.slice(0, 50)) out.push(`  + ${a}`); }
    if (gone.length) { out.push(`REMOVED (${gone.length})`); for (const g of gone.slice(0, 50)) out.push(`  - ${g}`); }
    if (clean) out.push('tree matches the manifest exactly');
    process.stdout.write(out.join('\n') + '\n');
  }
  process.exit(clean ? 0 : 2);
}

/* ---- create a manifest ---- */
const entries = [];
let totalBytes = 0;
let done = 0;
for (const f of files) {
  let digest;
  try { digest = await hashFile(f.path); } catch (e) {
    entries.push({ path: rel(f.path), error: e.message });
    continue;
  }
  const r = { path: rel(f.path), size: f.size, digest, mtime: f.mtime };
  if (f.symlink) { r.symlink = true; r.target = f.target; }
  entries.push(r);
  totalBytes += f.size;
  done++;
  if (!flag(o, 'quiet') && outFile) process.stderr.write(`\r${done}/${files.length} hashed`);
}
if (!flag(o, 'quiet') && outFile) process.stderr.write('\n');

const manifest = {
  generated: new Date().toISOString(),
  root: root.replace(/\\/g, '/'),
  algorithm: algo,
  fileCount: entries.filter((e) => !e.error).length,
  totalBytes,
  errors: entries.filter((e) => e.error).length,
  files: entries,
};

let rendered;
if (format === 'json') rendered = JSON.stringify(manifest, null, 2) + '\n';
else if (format === 'tsv') rendered = ['path\tsize\tdigest', ...entries.filter((e) => !e.error).map((e) => `${e.path}\t${e.size}\t${e.digest}`)].join('\n') + '\n';
else if (format === 'sha256sum') rendered = entries.filter((e) => !e.error).map((e) => `${e.digest}  ${e.path}`).join('\n') + '\n';
else die(`--format must be json | tsv | sha256sum (got ${format})`);

if (outFile) {
  writeFileSync(String(outFile), rendered, 'utf8');
  const summary = { manifest: String(outFile), algorithm: algo, files: manifest.fileCount, bytes: totalBytes, errors: manifest.errors, format };
  if (flag(o, 'json')) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  else process.stdout.write(`wrote ${outFile}: ${manifest.fileCount} file(s), ${totalBytes.toLocaleString('en-US')} bytes, ${algo}${manifest.errors ? `, ${manifest.errors} error(s)` : ''}\n`);
} else {
  if (flag(o, 'json')) process.stdout.write(rendered);
  else process.stdout.write(rendered);
}
void basename; void table;
