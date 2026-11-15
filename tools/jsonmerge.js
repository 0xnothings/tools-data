#!/usr/bin/env node
// jsonmerge.js — deep merge JSON documents with a conflict policy and a conflict report.
// Copyright (c) 2026 0xnothings
// @tool jsonmerge
// @desc Deep merge multiple JSON files with last-wins/keep-first/error policies and a full conflict report
// @usage node tools/jsonmerge.js base.json override.json --policy last --json
// @tags data,json,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `jsonmerge — deep JSON merge

  node tools/jsonmerge.js <a.json> <b.json> [...] [options]

  --policy <p>      last (default) | first | error | array-append | array-union
  --arrays <mode>   append | union | replace (overrides the array behaviour)
  --depth <n>       give up merging below this depth and take the whole subtree (default 32)
  --out <file>      write the merged document (default stdout)
  --report          print the conflict report (default in text mode)
  --no-meta         emit only the merged document in --json mode
  --json            machine-readable output
  -h, --help        this text

  Objects merge key by key. Arrays merge per --arrays. Scalars go to --policy.
  Identity for array-union is structural (a canonical JSON serialisation), so
  {"a":1,"b":2} and {"b":2,"a":1} count as the same element. Every decision
  that overwrote or discarded data is recorded with its JSON pointer path.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'no-meta', 'report']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const files = o._.filter((x) => x && x !== '-');
if (!files.length) die('need at least two files — node tools/jsonmerge.js base.json override.json');
const stdinMode = o._.includes('-') || !files.length;

const policy = String(get(o, 'policy', 'last')).toLowerCase();
if (!['last', 'first', 'error', 'array-append', 'array-union'].includes(policy)) die(`unknown --policy "${policy}"`);
let arrayMode = get(o, 'arrays', null) ? String(get(o, 'arrays')).toLowerCase() : (policy.startsWith('array-') ? policy.slice(6) : 'replace');
if (!['append', 'union', 'replace', 'merge'].includes(arrayMode)) die(`unknown --arrays "${arrayMode}"`);
const maxDepth = num(get(o, 'depth', 32), 32);

const canon = (v) => JSON.stringify(v, Object.keys(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).sort());
const conflicts = [];
const stats = { merges: 0, overwrites: 0, additions: 0, arrayAppends: 0, arrayUnions: 0, arrayReplaces: 0, depthCut: 0 };

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function merge(a, b, path, depth) {
  const ta = typeOf(a), tb = typeOf(b);
  if (depth > maxDepth) { stats.depthCut++; conflicts.push({ path, kind: 'depth-cut', took: policy === 'first' ? 'a' : 'b', aType: ta, bType: tb }); return policy === 'first' ? a : b; }
  if (ta === 'object' && tb === 'object') {
    const out = { ...a };
    for (const k of Object.keys(b)) {
      const p = `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!(k in a)) { out[k] = b[k]; stats.additions++; continue; }
      out[k] = merge(a[k], b[k], p, depth + 1);
    }
    stats.merges++;
    return out;
  }
  if (ta === 'array' && tb === 'array') {
    if (arrayMode === 'replace') { stats.arrayReplaces++; conflicts.push({ path, kind: 'array-replace', aLength: a.length, bLength: b.length, took: 'b' }); return b.slice(); }
    if (arrayMode === 'append') { stats.arrayAppends++; return a.concat(b); }
    if (arrayMode === 'merge') return merge(a, b, path, depth + 1);
    const seen = new Set(a.map(canon));
    const out = a.slice();
    let added = 0;
    for (const el of b) { const c = canon(el); if (!seen.has(c)) { seen.add(c); out.push(el); added++; } }
    stats.arrayUnions++;
    conflicts.push({ path, kind: 'array-union', aLength: a.length, bLength: b.length, added, kept: a.length });
    return out;
  }
  if (ta !== tb) {
    if (policy === 'error') die(`type conflict at ${path}: ${ta} vs ${tb}`);
    const took = policy === 'first' ? 'a' : 'b';
    stats.overwrites++;
    conflicts.push({ path, kind: 'type-conflict', aType: ta, bType: tb, took });
    return took === 'a' ? a : b;
  }
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) return a;
  if (policy === 'error') die(`value conflict at ${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  const took = policy === 'first' ? 'a' : 'b';
  stats.overwrites++;
  conflicts.push({ path, kind: 'scalar-conflict', aValue: a, bValue: b, aType: ta, took });
  return took === 'a' ? a : b;
}

const docs = [];
const sources = [];
for (const f of files) {
  try {
    const raw = readFileSync(f, 'utf8');
    docs.push(JSON.parse(raw));
    sources.push({ file: f, bytes: raw.length, rootType: Array.isArray(JSON.parse(raw)) ? 'array' : typeof JSON.parse(raw) });
  } catch (e) {
    die(`cannot parse ${f}: ${e.message}`);
  }
}
if (stdinMode && !files.length) die('need JSON file paths (stdin merge is not supported)');

let merged = docs[0];
for (let i = 1; i < docs.length; i++) merged = merge(merged, docs[i], '', 0);

const outFile = get(o, 'out', null);
if (outFile) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(String(outFile), JSON.stringify(merged, null, 2) + '\n');
}

const byKind = conflicts.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {});

if (flag(o, 'json')) {
  const payload = flag(o, 'no-meta')
    ? merged
    : { files, policy, arrayMode, stats, conflictCount: conflicts.length, conflictsByKind: byKind, conflicts: conflicts.slice(0, 500), output: outFile ? String(outFile) : 'stdout', merged };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  console.log(`merged ${docs.length} document(s): ${files.join(', ')}`);
  console.log(`policy=${policy} arrays=${arrayMode}`);
  console.log(table([
    { field: 'objects merged', value: stats.merges },
    { field: 'keys added', value: stats.additions },
    { field: 'values overwritten', value: stats.overwrites },
    { field: 'arrays appended', value: stats.arrayAppends },
    { field: 'arrays unioned', value: stats.arrayUnions },
    { field: 'arrays replaced', value: stats.arrayReplaces },
    { field: 'depth cut-offs', value: stats.depthCut },
    { field: 'conflicts logged', value: conflicts.length },
  ], ['field', 'value']));
  if (flag(o, 'report') || !outFile) {
    if (conflicts.length) {
      console.log('\nCONFLICTS');
      console.log(table(conflicts.slice(0, 60).map((c) => ({
        path: c.path || '(root)', kind: c.kind, took: c.took ?? '',
        aSide: c.aValue !== undefined ? JSON.stringify(c.aValue).slice(0, 30) : c.aType ?? '',
        bSide: c.bValue !== undefined ? JSON.stringify(c.bValue).slice(0, 30) : c.bType ?? '',
      })), ['path', 'kind', 'took', 'aSide', 'bSide']));
      if (conflicts.length > 60) console.log(`... ${conflicts.length - 60} more conflict(s)`);
    } else console.log('\nno conflicts — clean merge');
  }
  if (outFile) console.log(`\nwrote merged document -> ${outFile}`);
  else process.stdout.write('\n' + JSON.stringify(merged, null, 2) + '\n');
}
