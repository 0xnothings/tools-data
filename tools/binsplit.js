// binsplit.js — split a binary by size or pattern offset, with checksum-verified reassembly.
// Copyright (c) 2026 0xnothings
// @tool binsplit
// @desc Split a binary into size-bounded or pattern-anchored chunks and verify reassembly by checksum
// @usage node tools/binsplit.js dump.bin --chunk 1m --out ./parts --json
// @tags data,binary,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

const HELP = `binsplit — binary chunker

  node tools/binsplit.js <file> [options]

  --chunk <size>     split into fixed-size chunks (1m, 512k, 4096, 100000)
  --parts <n>        split into exactly n roughly equal chunks
  --at <off,off,..>  cut at explicit offsets
  --pattern <hex>    cut before every occurrence of this hex pattern
  --out <dir>        output directory (default: <name>.parts)
  --prefix <name>    chunk filename prefix (default: <basename>)
  --join <dir>       reassemble chunks from a directory instead of splitting
  --verify           after splitting, re-join in memory and compare SHA-256
  --json             machine-readable output
  -h, --help         this text

  Reassembly reads the chunk filenames' embedded index, so part order is
  recovered even if the directory listing is shuffled. --verify recomputes the
  source SHA-256 from the emitted parts and fails loudly on any mismatch.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'verify']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const sha = (b) => createHash('sha256').update(b).digest('hex');
const parseSize = (v) => {
  if (v === undefined || v === null || v === true) return null;
  const s = String(v).trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\d+(\.\d+)?[kmg]$/.test(s)) return Math.round(parseFloat(s) * { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[s.slice(-1)]);
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

const joinDir = get(o, 'join', null);
if (joinDir !== null) {
  const dir = String(joinDir);
  let names;
  try { names = readdirSync(dir); } catch (e) { die(`cannot read ${dir}: ${e.message}`); }
  const parts = [];
  for (const n of names) {
    const m = n.match(/^(.*)\.part(\d+)(?:of(\d+))?$/);
    if (m) parts.push({ index: parseInt(m[2], 10), path: join(dir, n), name: n });
  }
  if (!parts.length) die(`no *.partNNNN files in ${dir}`);
  parts.sort((a, b) => a.index - b.index);
  const out = parts[0].name.replace(/\.part\d+(of\d+)?$/, '');
  const buffers = parts.map((p) => readFileSync(p.path));
  const joined = Buffer.concat(buffers);
  const outPath = get(o, 'out', null) ? String(get(o, 'out')) : out;
  writeFileSync(outPath, joined);
  const report = {
    mode: 'join', dir, parts: parts.length, out: outPath, bytes: joined.length, sha256: sha(joined),
    missingIndexes: (() => {
      const missing = [];
      const max = parts[parts.length - 1].index;
      for (let i = 0; i <= max; i++) if (!parts.some((p) => p.index === i)) missing.push(i);
      return missing;
    })(),
    partSizes: parts.map((p, i) => ({ index: p.index, file: p.name, bytes: buffers[i].length })),
  };
  if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    console.log(`joined ${parts.length} part(s) from ${dir} -> ${outPath}`);
    console.log(`bytes=${fmt(joined.length)}  sha256=${report.sha256}`);
    if (report.missingIndexes.length) console.log(`WARNING: missing part indexes ${report.missingIndexes.join(', ')}`);
  }
  process.exit(0);
}

const src = o._[0];
if (!src) die('need a file — node tools/binsplit.js dump.bin --chunk 1m --out ./parts');

let buf;
try { buf = readFileSync(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
const base = basename(src);

const chunkSize = parseSize(get(o, 'chunk', null));
const partCount = num(get(o, 'parts', 0), 0);
const cutList = get(o, 'at', null) ? String(get(o, 'at')).split(',').map((s) => parseSize(s)).filter((n) => n !== null) : null;
const patternHex = get(o, 'pattern', null) ? String(get(o, 'pattern')).replace(/^0x/, '').replace(/\s+/g, '') : null;
if (patternHex && (patternHex.length % 2 || !/^[0-9a-f]+$/i.test(patternHex))) die('--pattern needs an even-length hex string');

const modes = [chunkSize !== null, partCount > 0, cutList !== null, patternHex !== null].filter(Boolean).length;
if (modes > 1) die('use exactly one of --chunk, --parts, --at, --pattern');
if (modes === 0) die('need a split mode: --chunk, --parts, --at or --pattern');

const cuts = [0];
if (chunkSize !== null) for (let p = chunkSize; p < buf.length; p += chunkSize) cuts.push(p);
else if (partCount > 0) {
  if (partCount < 1) die('--parts must be at least 1');
  const per = Math.ceil(buf.length / partCount);
  for (let i = 1; i < partCount; i++) cuts.push(Math.min(buf.length, i * per));
}
else if (cutList) for (const c of [...cutList].sort((a, b) => a - b)) if (c > 0 && c < buf.length) cuts.push(c);
else if (patternHex) {
  const pat = Buffer.from(patternHex, 'hex');
  let p = 0;
  while ((p = buf.indexOf(pat, p)) !== -1) { if (p > 0) cuts.push(p); p += pat.length; }
  if (cuts.length === 1) die(`pattern ${patternHex} not found — nothing to split`);
}
const bounds = [...new Set(cuts)].sort((a, b) => a - b);
bounds.push(buf.length);

const outDir = String(get(o, 'out', `${base}.parts`));
const prefix = String(get(o, 'prefix', base));
mkdirSync(outDir, { recursive: true });

const parts = [];
const total = bounds.length - 1;
for (let i = 0; i < total; i++) {
  const slice = buf.slice(bounds[i], bounds[i + 1]);
  if (!slice.length) continue;
  const partName = `${prefix}.part${String(i).padStart(4, '0')}of${String(total).padStart(4, '0')}`;
  const path = join(outDir, partName);
  writeFileSync(path, slice);
  parts.push({ index: i, file: partName, path, offset: bounds[i], bytes: slice.length, sha256: sha(slice), preview: slice.slice(0, 16).toString('hex') });
}

const report = {
  file: src, size: buf.length, mode: chunkSize !== null ? 'chunk' : partCount > 0 ? 'parts' : cutList ? 'at' : 'pattern',
  outDir, partCount: parts.length, sourceSha256: sha(buf),
  parts: parts.map(({ path, ...rest }) => rest),
};

if (flag(o, 'verify')) {
  const joined = Buffer.concat(parts.map((p) => readFileSync(p.path)));
  report.verify = {
    reassembledBytes: joined.length, expectedBytes: buf.length,
    sha256: sha(joined), sourceSha256: report.sourceSha256,
    ok: joined.length === buf.length && sha(joined) === report.sourceSha256,
    byteIdentical: joined.equals(buf),
  };
  if (!report.verify.ok) { if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n'); die(`reassembly verification FAILED (${report.verify.sha256} != ${report.sourceSha256})`); }
}

const verifyDir = get(o, 'verify-dir', null);
if (verifyDir) {
  const dir = String(verifyDir);
  const files = readdirSync(dir).filter((f) => f.includes('.part')).sort();
  const joined = Buffer.concat(files.map((f) => readFileSync(join(dir, f))));
  report.verifyDir = { dir, files: files.length, bytes: joined.length, sha256: sha(joined), ok: sha(joined) === report.sourceSha256 };
}

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — ${fmt(buf.length)} bytes -> ${parts.length} part(s) in ${outDir} (mode: ${report.mode})`);
  console.log(`source sha256: ${report.sourceSha256}`);
  console.log(table(parts.slice(0, 100).map((p) => ({
    index: p.index, file: p.file, offset: fmt(p.offset), bytes: fmt(p.bytes), sha: p.sha256.slice(0, 16), head: p.preview,
  })), ['index', 'file', 'offset', 'bytes', 'sha', 'head']));
  if (parts.length > 100) console.log(`... ${parts.length - 100} more part(s)`);
  if (report.verify) console.log(`\nverify: ${report.verify.ok ? 'OK' : 'FAILED'} — reassembled ${fmt(report.verify.reassembledBytes)} bytes, sha256 ${report.verify.sha256}`);
  if (report.verifyDir) console.log(`verify-dir ${report.verifyDir.dir}: ${report.verifyDir.ok ? 'OK' : 'MISMATCH'} (${report.verifyDir.files} file(s), ${fmt(report.verifyDir.bytes)} bytes)`);
}
