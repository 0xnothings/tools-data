// jsondiff.js — structural diff of two JSON documents with paths and types.
// Copyright (c) 2026 0xnothings
// @tool jsondiff
// @desc Structural JSON diff with JSON-pointer paths, type changes and array diffing
// @usage node tools/jsondiff.js a.json b.json --json
// @tags data,json,diff,cli
import { args, get, flag, die } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `jsondiff — structural JSON diff

  node tools/jsondiff.js <a.json> <b.json> [options]

  --limit <n>       max changes to print (default 100, 0 = all)
  --ignore <path>   repeatable; skip a path prefix (JSON pointer, e.g. /meta/time)
  --array-mode <m>  index (compare by position) | key:<field>  (default index)
  --values          include full before/after values (default: truncated)
  --json            machine-readable output
  -h, --help        this text

  Exit codes: 0 = equal, 2 = differences, 1 = error.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const aPath = o._[0], bPath = o._[1];
if (!aPath || !bPath) die('need two files — node tools/jsondiff.js a.json b.json');

function load(p) {
  let text;
  try { text = readFileSync(p, 'utf8'); } catch (e) { die(`cannot read ${p}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { die(`invalid JSON in ${p}: ${e.message}`); }
}

const A = load(aPath);
const B = load(bPath);
const limit = Number(get(o, 'limit', 100));
const showValues = flag(o, 'values');
const arrayMode = String(get(o, 'array-mode', 'index'));
const arrayKey = arrayMode.startsWith('key:') ? arrayMode.slice(4) : null;
const ignores = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--ignore' && process.argv[i + 1]) ignores.push(process.argv[i + 1]);
}

const changes = [];
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function trunc(v) {
  if (showValues) return v;
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 57) + '...' : v;
  if (v && typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : JSON.parse(s);
  }
  return v;
}

function walk(a, b, path, depth) {
  if (depth > 200) return;
  if (ignores.some((ig) => path === ig || path.startsWith(ig + '/'))) return;
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) {
    changes.push({ path: path || '/', kind: 'type-changed', from: trunc(a), to: trunc(b), fromType: ta, toType: tb });
    return;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = `${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!(k in a)) changes.push({ path: p, kind: 'added', to: trunc(b[k]), toType: typeOf(b[k]) });
      else if (!(k in b)) changes.push({ path: p, kind: 'removed', from: trunc(a[k]), fromType: typeOf(a[k]) });
      else walk(a[k], b[k], p, depth + 1);
    }
    return;
  }
  if (ta === 'array') {
    if (arrayKey) {
      const keyed = (arr) => {
        const m = new Map();
        for (const item of arr) {
          const k = item && typeof item === 'object' ? String(item[arrayKey]) : String(item);
          m.set(k, item);
        }
        return m;
      };
      const ma = keyed(a), mb = keyed(b);
      const keys = new Set([...ma.keys(), ...mb.keys()]);
      for (const k of keys) {
        const p = `${path}[${arrayKey}=${k}]`;
        if (!ma.has(k)) changes.push({ path: p, kind: 'added', to: trunc(mb.get(k)), toType: typeOf(mb.get(k)) });
        else if (!mb.has(k)) changes.push({ path: p, kind: 'removed', from: trunc(ma.get(k)), fromType: typeOf(ma.get(k)) });
        else walk(ma.get(k), mb.get(k), p, depth + 1);
      }
      return;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}/${i}`;
      if (i >= a.length) changes.push({ path: p, kind: 'added', to: trunc(b[i]), toType: typeOf(b[i]) });
      else if (i >= b.length) changes.push({ path: p, kind: 'removed', from: trunc(a[i]), fromType: typeOf(a[i]) });
      else walk(a[i], b[i], p, depth + 1);
    }
    return;
  }
  if (a !== b) changes.push({ path: path || '/', kind: 'changed', from: trunc(a), to: trunc(b), fromType: ta, toType: tb });
}

walk(A, B, '', 0);

const counts = changes.reduce((acc, c) => (acc[c.kind] = (acc[c.kind] || 0) + 1, acc), {});
const shown = limit > 0 ? changes.slice(0, limit) : changes;

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ a: aPath, b: bPath, equal: changes.length === 0, counts, total: changes.length, changes: shown }, null, 2) + '\n');
} else {
  for (const c of shown) {
    const tag = c.kind === 'added' ? '+' : c.kind === 'removed' ? '-' : c.kind === 'type-changed' ? 'T' : '~';
    let line = `${tag} ${c.path}`;
    if (c.kind === 'changed') line += `  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`;
    else if (c.kind === 'type-changed') line += `  (${c.fromType} -> ${c.toType})`;
    else if (c.kind === 'added') line += `  ${JSON.stringify(c.to)}`;
    else line += `  ${JSON.stringify(c.from)}`;
    process.stdout.write(line + '\n');
  }
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  process.stdout.write(`\n${changes.length === 0 ? 'documents are equal' : `${changes.length} change(s): ${parts.join(', ')}`}\n`);
  if (limit > 0 && changes.length > limit) process.stdout.write(`(showing first ${limit} — use --limit 0 for all)\n`);
}

process.exit(changes.length === 0 ? 0 : 2);
