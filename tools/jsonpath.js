// jsonpath.js — query and mutate JSON with a JSONPath subset.
// Copyright (c) 2026 0xnothings
// @tool jsonpath
// @desc Query JSON with a JSONPath subset ($ .key [n] [*] ..key) and set values in place
// @usage node tools/jsonpath.js data.json '$.items[*].name' --json
// @tags data,json,query,cli
import { args, get, flag, die, readInput } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `jsonpath — JSONPath subset query and mutation

  node tools/jsonpath.js <file|-> '<path>' [options]

  --set <value>     set every matched node to <value> (parses JSON, else string)
  --del             delete every matched node (array elements removed in reverse)
  --count           print only the number of matches
  --flat            print one match per line as compact JSON
  --json            machine-readable output
  -w, --write       write the mutated document back to <file> (with --set/--del)
  -h, --help        this text

  Path grammar:
    $                 root
    .key  ['key']     member access ("key with spaces" too)
    [0] [0,2] [-1]    array index (negative = from end)
    [*]               every array element
    .*                every object member
    ..key             recursive descent
    .a.b[1].c         chaining

  Examples:
    node tools/jsonpath.js pkg.json '$.dependencies.*'
    node tools/jsonpath.js cfg.json '$.services[*].port' --json
    node tools/jsonpath.js cfg.json '$.debug' --set true -w`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
const pathExpr = o._[1];
if (!src) die('need a JSON file — node tools/jsonpath.js data.json \'$.a.b\'');
if (!pathExpr) die('need a path expression — try $. or $.key or $..key');

const raw = await readInput(src);
if (!raw.trim()) die('empty input');
let doc;
try { doc = JSON.parse(raw); } catch (e) { die(`invalid JSON: ${e.message}`); }

function tokenizePath(p) {
  const out = [];
  let i = 0;
  if (p[i] === '$') i++;
  while (i < p.length) {
    const c = p[i];
    if (c === '.') {
      if (p[i + 1] === '.') {
        i += 2;
        let k = '';
        while (i < p.length && /[A-Za-z0-9_$\-]/.test(p[i])) k += p[i++];
        out.push({ t: 'descend', key: k || null });
        continue;
      }
      i++;
      if (p[i] === '*') { out.push({ t: 'wild' }); i++; continue; }
      let k = '';
      while (i < p.length && !'.['.includes(p[i])) k += p[i++];
      if (!k) throw new Error('empty key after "."');
      out.push({ t: 'key', key: k });
      continue;
    }
    if (c === '[') {
      i++;
      if (p[i] === '*') { out.push({ t: 'wild' }); i++; if (p[i] === ']') i++; continue; }
      if (p[i] === "'" || p[i] === '"') {
        const q = p[i++];
        let k = '';
        while (i < p.length && p[i] !== q) k += p[i++];
        i++;
        if (p[i] === ']') i++;
        out.push({ t: 'key', key: k });
        continue;
      }
      let inner = '';
      while (i < p.length && p[i] !== ']') inner += p[i++];
      i++;
      for (const part of inner.split(',')) {
        const t = part.trim();
        if (t === '*') out.push({ t: 'wild' });
        else if (/^-?\d+$/.test(t)) out.push({ t: 'index', i: Number(t) });
        else if (t) out.push({ t: 'key', key: t.replace(/^['"]|['"]$/g, '') });
      }
      continue;
    }
    if (c === '*') { out.push({ t: 'wild' }); i++; continue; }
    let k = '';
    while (i < p.length && !'.['.includes(p[i])) k += p[i++];
    if (k) out.push({ t: 'key', key: k });
  }
  return out;
}

function descendAll(node, key, out, seen) {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) descendAll(v, key, out, seen);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (key === null) { out.push({ value: v, parent: node, key: k }); }
    else if (k === key && key !== null) { out.push({ value: v, parent: node, key: k }); }
    descendAll(v, key, out, seen);
  }
}

const toks = tokenizePath(pathExpr);
const matches = [];
function apply(nodes, ti) {
  if (ti >= toks.length) { matches.push(...nodes); return; }
  const tok = toks[ti];
  const next = [];
  for (const n of nodes) {
    const v = n.value;
    if (tok.t === 'key') {
      if (v && typeof v === 'object' && !Array.isArray(v) && tok.key in v) next.push({ value: v[tok.key], parent: v, key: tok.key });
    } else if (tok.t === 'index') {
      if (Array.isArray(v)) {
        const idx = tok.i < 0 ? v.length + tok.i : tok.i;
        if (idx >= 0 && idx < v.length) next.push({ value: v[idx], parent: v, key: idx });
      }
    } else if (tok.t === 'wild') {
      if (Array.isArray(v)) v.forEach((x, i) => next.push({ value: x, parent: v, key: i }));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) next.push({ value: x, parent: v, key: k });
    } else if (tok.t === 'descend') {
      const found = [];
      if (tok.key === null) {
        (function rec(x) {
          if (x === null || typeof x !== 'object') return;
          if (Array.isArray(x)) { x.forEach((y, i) => { found.push({ value: y, parent: x, key: i }); rec(y); }); return; }
          for (const [k, y] of Object.entries(x)) { found.push({ value: y, parent: x, key: k }); rec(y); }
        })(v);
      } else {
        descendAll(v, tok.key, found, new Set());
      }
      next.push(...found);
    }
  }
  apply(next, ti + 1);
}
apply([{ value: doc, parent: null, key: null }], 0);

const setRaw = get(o, 'set', undefined);
const doSet = setRaw !== undefined;
const doDel = flag(o, 'del');
if (doSet && doDel) die('--set and --del are mutually exclusive');

let mutation = null;
if (doSet || doDel) {
  if (!matches.length) die('no matches — nothing to mutate');
  if (doSet) {
    let val;
    try { val = JSON.parse(String(setRaw)); } catch { val = String(setRaw); }
    for (const m of matches) {
      if (m.parent === null) doc = val;
      else m.parent[m.key] = val;
    }
    mutation = { op: 'set', value: val, count: matches.length };
  } else {
    const byParent = new Map();
    for (const m of matches) {
      if (m.parent === null) { die('refusing to delete the document root'); }
      if (!byParent.has(m.parent)) byParent.set(m.parent, []);
      byParent.get(m.parent).push(m.key);
    }
    let removed = 0;
    for (const [parent, keys] of byParent) {
      if (Array.isArray(parent)) {
        for (const k of [...keys].sort((a, b) => b - a)) { parent.splice(k, 1); removed++; }
      } else {
        for (const k of keys) { delete parent[k]; removed++; }
      }
    }
    mutation = { op: 'delete', count: removed };
  }

  if (flag(o, 'w') || flag(o, 'write')) {
    if (!src || src === '-') die('cannot --write when reading from stdin');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(src, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }
}

const values = matches.map((m) => m.value);

if (flag(o, 'count')) {
  process.stdout.write(matches.length + '\n');
} else if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    path: pathExpr,
    matches: matches.length,
    mutation,
    written: (flag(o, 'w') || flag(o, 'write')) && mutation ? src : null,
    values: values.length === 1 ? values[0] : values,
  }, null, 2) + '\n');
} else if (flag(o, 'flat')) {
  for (const v of values) process.stdout.write((typeof v === 'object' ? JSON.stringify(v) : String(v)) + '\n');
} else {
  if (values.length === 0) process.stdout.write('no matches\n');
  else if (values.length === 1) process.stdout.write(JSON.stringify(values[0], null, 2) + '\n');
  else {
    values.forEach((v, i) => process.stdout.write(`[${i}] ${JSON.stringify(v)}\n`));
    process.stdout.write(`\n${values.length} matches\n`);
  }
  if (mutation) process.stdout.write(`\n${mutation.op}: ${mutation.count} node(s)${(flag(o, 'w') || flag(o, 'write')) ? ` written to ${src}` : ''}\n`);
}

if (values.length === 0 && !mutation) process.exit(3);
