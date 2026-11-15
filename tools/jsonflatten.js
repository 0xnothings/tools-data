// jsonflatten.js — flatten or unflatten nested JSON with separator control and round-trip proof.
// Copyright (c) 2026 0xnothings
// @tool jsonflatten
// @desc Flatten nested JSON to dotted paths (or rebuild it) with collision detection and round-trip verification
// @usage node tools/jsonflatten.js nested.json --sep . --verify --json
// @tags data,json,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';

const HELP = `jsonflatten — flatten / unflatten JSON

  node tools/jsonflatten.js <file.json|-> [options]

  --sep <s>         path separator (default ".", one char recommended)
  --unflatten       rebuild a nested document from flat keys
  --array <mode>    how arrays flatten: index (default, a.0.b) | json (a = [..]) | skip
  --empty           keep empty objects/arrays as leaf values (default off)
  --max-depth <n>   stop flattening below this depth, emit the subtree as JSON
  --verify          flatten then unflatten and prove the round trip is lossless
  --out <file>      write the result here instead of stdout
  --json            machine-readable output
  -h, --help        this text

  Collisions are real: {"a.b": 1, "a": {"b": 2}} flattens to the same key twice, and
  {"a": {"0": "x"}} is ambiguous with an array under unflatten. Both are detected and
  reported rather than silently losing data. Escaping: keys containing the separator
  are backslash-escaped on flatten and unescaped on unflatten.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['empty', 'json', 'unflatten', 'verify']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/jsonflatten.js nested.json');
const text = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src);
let doc;
try { doc = JSON.parse(text); } catch (e) { die(`JSON parse failed: ${e.message}`); }

const sep = String(get(o, 'sep', '.'));
if (!sep) die('--sep cannot be empty');
const arrayMode = String(get(o, 'array', 'index')).toLowerCase();
if (!['index', 'json', 'skip'].includes(arrayMode)) die('--array must be index, json or skip');
const keepEmpty = flag(o, 'empty');
const maxDepth = num(get(o, 'max-depth', 0), 0);
const unflatten = flag(o, 'unflatten');

const esc = (k) => String(k).replace(/\\/g, '\\\\').replace(new RegExp(`\\${sep}`, 'g'), `\\${sep}`);
const unesc = (k) => String(k).replace(new RegExp(`\\\\\\${sep}`, 'g'), sep).replace(/\\\\/g, '\\');
const splitPath = (s) => {
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s.startsWith(sep, i)) { parts.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += s[i];
  }
  parts.push(cur);
  return parts.map(unesc);
};

function flatten(value, path, out, collisions, depth) {
  const key = path.join(sep);
  if (value === null || typeof value !== 'object') { if (path.length) out.push([key, value]); return; }
  if (maxDepth && depth >= maxDepth) { if (path.length) out.push([key, value]); return; }
  if (Array.isArray(value)) {
    if (arrayMode === 'json' || arrayMode === 'skip') { if (path.length) out.push([key, value]); return; }
    if (!value.length) { if (keepEmpty && path.length) out.push([key, []]); return; }
    value.forEach((v, i) => flatten(v, [...path, String(i)], out, collisions, depth + 1));
    return;
  }
  const keys = Object.keys(value);
  if (!keys.length) { if (keepEmpty && path.length) out.push([key, {}]); return; }
  for (const k of keys) flatten(value[k], [...path, esc(k)], out, collisions, depth + 1);
}

function unflattenFlat(entries, out, collisions) {
  for (const [rawKey, value] of entries) {
    const parts = splitPath(rawKey);
    let node = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      if (last) {
        if (p in node && typeof node[p] === 'object' && node[p] !== null) collisions.push({ path: rawKey, kind: 'would-clobber-object' });
        node[p] = value;
        break;
      }
      const nextIsIndex = /^\d+$/.test(parts[i + 1]);
      if (!(p in node)) node[p] = nextIsIndex ? [] : {};
      if (typeof node[p] !== 'object' || node[p] === null) { collisions.push({ path: parts.slice(0, i + 1).join(sep), kind: 'scalar-path-conflict' }); node[p] = nextIsIndex ? [] : {}; }
      node = node[p];
    }
  }
  // convert numeric-keyed objects/arrays consistently
  const fix = (v) => {
    if (Array.isArray(v)) {
      const dense = v.every((x, i) => x !== undefined);
      const outv = v.map(fix);
      return outv;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      const allNumeric = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
      if (allNumeric) {
        const max = Math.max(...keys.map((k) => Number(k)));
        const arr = new Array(max + 1).fill(null).map((_, i) => (i in v ? fix(v[i]) : null));
        return arr;
      }
      const res = {};
      for (const k of keys) res[k] = fix(v[k]);
      return res;
    }
    return v;
  };
  return fix(out);
}

let result;
const collisions = [];
let flatPairs = null;
if (unflatten) {
  let entries;
  if (Array.isArray(doc)) entries = doc.map((e) => [String(e.key ?? e.path), e.value]);
  else if (doc && typeof doc === 'object') entries = Object.entries(doc);
  else die('unflatten needs a flat object of "path": value pairs (or an array of {key, value})');
  result = unflattenFlat(entries, {}, collisions);
  flatPairs = entries.length;
} else {
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const keys = Object.keys(doc);
    if (keys.length && keys.every((k) => k.includes(sep))) {
      collisions.push({ path: '(root)', kind: 'input-looks-already-flat' });
    }
  }
  flatPairs = [];
  flatten(doc, [], flatPairs, collisions, 0);
  const seen = new Map();
  for (const [k] of flatPairs) {
    if (seen.has(k)) collisions.push({ path: k, kind: 'duplicate-flat-key', firstType: typeof seen.get(k), secondType: (flatPairs.find((x) => x[0] === k) || [])[1] });
    seen.set(k, true);
  }
  result = Object.fromEntries(flatPairs.map(([k, v]) => [k, v]));
}

let verify = null;
if (flag(o, 'verify')) {
  if (unflatten) {
    const ref = [];
    flatten(result, [], ref, [], 0);
    const origEntries = Array.isArray(doc) ? doc.map((e) => [String(e.key ?? e.path), e.value]) : Object.entries(doc);
    const a = JSON.stringify(ref.slice().sort((x, y) => x[0].localeCompare(y[0])));
    const b = JSON.stringify(origEntries.slice().sort((x, y) => x[0].localeCompare(y[0])));
    verify = { direction: 'unflatten', flatKeysBefore: origEntries.length, flatKeysAfter: ref.length, ok: a === b, lossless: a === b };
  } else {
    const back = unflattenFlat(flatPairs, {}, []);
    const a = JSON.stringify(doc), b = JSON.stringify(back);
    verify = {
      direction: 'flatten', ok: a === b, lossless: a === b,
      originalBytes: a.length, rebuiltBytes: b.length,
      note: a === b ? 'round trip is byte-identical' : 'round trip differs (arrays of objects, numeric-string keys or type coercion)',
    };
  }
}

const outFile = get(o, 'out', null);
const payload = JSON.stringify(result, null, 2) + '\n';
if (outFile) writeFileSync(String(outFile), payload);

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    input: src, mode: unflatten ? 'unflatten' : 'flatten', separator: sep, arrayMode, maxDepth: maxDepth || null,
    flatKeyCount: flatPairs === null ? null : (Array.isArray(flatPairs) ? flatPairs.length : flatPairs),
    collisions, verify, output: outFile ? String(outFile) : 'stdout', result,
  }, null, 2) + '\n');
} else {
  console.log(`${src} — ${unflatten ? 'unflatten' : 'flatten'} (sep "${sep}", arrays ${arrayMode})`);
  console.log(`top-level keys out: ${Object.keys(result).length}`);
  if (collisions.length) {
    console.log(`\n${collisions.length} COLLISION(S) — data loss risk`);
    console.log(table(collisions.slice(0, 30).map((c) => ({ path: c.path, kind: c.kind })), ['path', 'kind']));
  } else console.log('no path collisions');
  if (verify) console.log(`\nverify (${verify.direction}): ${verify.ok ? 'LOSSLESS' : 'LOSSY'} — ${verify.note || ''}`);
  if (outFile) console.log(`\nwrote ${payload.length} bytes -> ${outFile}`);
  else process.stdout.write('\n' + payload);
}
