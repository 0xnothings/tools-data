// jsoninfer.js — infer a JSON Schema-ish schema from sample JSON data.
// Copyright (c) 2026 0xnothings
// @tool jsoninfer
// @desc Infer a JSON Schema (draft-style) from sample data, merging arrays of objects
// @usage node tools/jsoninfer.js api-dump.json --required
// @tags data,json,schema,cli
import { args, get, num, flag, die, readInput } from '../_lib.js';

const HELP = `jsoninfer — infer a JSON Schema from data

  node tools/jsoninfer.js <file|-> [options]

  --path <dotted>     infer from a sub-node instead of the root
  --merge <n>         sample at most n array elements when inferring (default all)
  --required          mark properties present in 100% of samples as required
  --examples          include sample values as "examples"
  --format <f>        schema (default) | types | summary
  --json              machine-readable envelope (schema + stats)
  -h, --help          this text

  Arrays of objects are merged: field sets are unioned and each field records
  how many elements contained it, so optional fields are visible.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a JSON file or pipe on stdin');
const raw = await readInput(src);
if (!raw.trim()) die('empty input');
let doc;
try { doc = JSON.parse(raw); } catch (e) { die(`invalid JSON: ${e.message}`); }

const pathOpt = get(o, 'path', null);
if (pathOpt) {
  for (const seg of String(pathOpt).split('.').filter(Boolean)) {
    const m = seg.match(/^(.*?)\[(\d+)\]$/);
    if (m) { doc = m[1] ? doc[m[1]] : doc; doc = Array.isArray(doc) ? doc[Number(m[2])] : undefined; }
    else doc = doc?.[seg];
  }
  if (doc === undefined) die(`path not found: ${pathOpt}`);
}

const mergeN = num(get(o, 'merge', 0), 0);
const wantRequired = flag(o, 'required');
const wantExamples = flag(o, 'examples');
const stats = { objects: 0, arrays: 0, scalars: 0, maxDepth: 0, optionalFields: 0 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const typeName = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

function mergeSchemas(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  const types = new Set([...(a.type ? (Array.isArray(a.type) ? a.type : [a.type]) : []), ...(b.type ? (Array.isArray(b.type) ? b.type : [b.type]) : [])]);
  out.type = types.size === 1 ? [...types][0] : [...types];
  if (a.properties || b.properties) {
    const props = {};
    const pa = a.properties || {}, pb = b.properties || {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) props[k] = mergeSchemas(pa[k], pb[k]);
    out.properties = props;
  }
  if (a.items || b.items) out.items = mergeSchemas(a.items, b.items);
  if (a.format === 'integer' && b.format === 'number') out.format = 'number';
  else if (a.format && b.format && a.format !== b.format) delete out.format;
  else if (b.format && !a.format) out.format = b.format;
  if (a.enum && b.enum) {
    const s = a.enum.filter((x) => b.enum.includes(x));
    if (s.length) out.enum = s; else delete out.enum;
  } else if (a.enum || b.enum) { /* union too large to be an enum */ delete out.enum; }
  return out;
}

function infer(node, depth) {
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  if (node === null) { stats.scalars++; return { type: 'null' }; }
  if (Array.isArray(node)) {
    stats.arrays++;
    const use = mergeN > 0 ? node.slice(0, mergeN) : node;
    let items = null;
    for (const el of use) { const s = infer(el, depth + 1); items = items ? mergeSchemas(items, s) : s; }
    const s = { type: 'array' };
    if (items) s.items = items;
    return s;
  }
  if (typeof node === 'object') {
    stats.objects++;
    const props = {};
    const present = {};
    const keys = Object.keys(node);
    for (const k of keys) {
      props[k] = infer(node[k], depth + 1);
      present[k] = true;
    }
    const s = { type: 'object', properties: props };
    if (keys.length === 0) delete s.properties;
    s.__present = present;
    s.__count = 1;
    return s;
  }
  const t = typeName(node);
  if (t === 'number') {
    stats.scalars++;
    return isNum(node) && Number.isInteger(node) ? { type: 'integer' } : { type: 'number' };
  }
  if (t === 'string') {
    stats.scalars++;
    const s = { type: 'string' };
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(node)) s.format = 'date-time';
    else if (/^\d{4}-\d{2}-\d{2}$/.test(node)) s.format = 'date';
    else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(node)) s.format = 'email';
    else if (/^https?:\/\//.test(node)) s.format = 'uri';
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node)) s.format = 'uuid';
    if (wantExamples) s.examples = [node.length > 80 ? node.slice(0, 77) + '...' : node];
    return s;
  }
  stats.scalars++;
  return { type: t };
}

const schema = infer(doc, 0);

function strip(s) {
  if (s === null || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(strip);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k.startsWith('__')) continue;
    out[k] = strip(v);
  }
  return out;
}

function annotateArrays(node, depth) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x) => annotateArrays(x, depth + 1)); return; }
  if (node.type === 'array' && node.items) {
    const items = node.items;
    if (items.type === 'object' && items.properties) {
      let optional = 0;
      for (const [k, v] of Object.entries(items.properties)) {
        if (v.__count === undefined) { v.__count = 0; v.__present = {}; }
        optional += 1;
      }
      if (wantRequired) {
        const req = Object.entries(items.properties).filter(([, v]) => v.__present && v.__present.__all).map(([k]) => k);
        if (req.length) items.required = req;
        stats.optionalFields += optional;
      }
    }
    annotateArrays(items, depth + 1);
  }
  if (node.properties) for (const v of Object.values(node.properties)) annotateArrays(v, depth + 1);
}

function markPresence(node, totalKeys) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (node.type === 'object' && node.properties && node.__count) {
    for (const [k, v] of Object.entries(node.properties)) {
      if (!v.__present) v.__present = {};
      v.__present.__all = v.__present.__all !== false;
    }
  }
}

// mergeSchemas drops __present merges; recompute presence over array items by scanning the source.
function presencePass(srcNode, schemaNode, depth) {
  if (!schemaNode || !srcNode) return;
  if (Array.isArray(srcNode) && schemaNode.type === 'array' && schemaNode.items) {
    const items = schemaNode.items;
    if (items.type === 'object' && items.properties) {
      const counts = {};
      for (const el of srcNode) {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          for (const k of Object.keys(el)) counts[k] = (counts[k] || 0) + 1;
        }
      }
      for (const [k, v] of Object.entries(items.properties)) {
        if (!v.__present) v.__present = {};
        v.__present.__all = (counts[k] || 0) === srcNode.length;
      }
      if (wantRequired) {
        const req = Object.entries(items.properties).filter(([, v]) => v.__present.__all).map(([k]) => k);
        if (req.length) items.required = req;
      }
      for (const el of srcNode.slice(0, 50)) presencePass(el, items, depth + 1);
    } else {
      for (const el of srcNode) presencePass(el, items, depth + 1);
    }
    return;
  }
  if (srcNode && typeof srcNode === 'object' && !Array.isArray(srcNode) && schemaNode.properties) {
    for (const [k, v] of Object.entries(schemaNode.properties)) {
      if (k in srcNode) presencePass(srcNode[k], v, depth + 1);
    }
  }
}

presencePass(doc, schema, 0);
annotateArrays(schema, 0);
const clean = strip(schema);

function typeList(node, prefix) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  const t = Array.isArray(node.type) ? node.type.join('|') : node.type;
  out.push(`${prefix || '$'}  ${t}${node.format ? ` (${node.format})` : ''}`);
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) out.push(...typeList(v, prefix ? `${prefix}.${k}` : k));
  if (node.items) out.push(...typeList(node.items, `${prefix || '$'}[]`));
  return out;
}

const fmtOpt = String(get(o, 'format', 'schema'));

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ source: src === '-' ? '<stdin>' : src, stats, schema: clean }, null, 2) + '\n');
} else if (fmtOpt === 'types') {
  process.stdout.write(typeList(clean, '').join('\n') + '\n');
} else if (fmtOpt === 'summary') {
  const top = clean.type === 'object' ? Object.keys(clean.properties || {}).length : clean.type === 'array' ? Object.keys(clean.items?.properties || {}).length : 0;
  process.stdout.write([
    `root type      ${Array.isArray(clean.type) ? clean.type.join('|') : clean.type}`,
    top ? `top fields     ${top}` : null,
    `objects        ${stats.objects}`,
    `arrays         ${stats.arrays}`,
    `scalars        ${stats.scalars}`,
    `max depth      ${stats.maxDepth}`,
  ].filter(Boolean).join('\n') + '\n');
} else {
  process.stdout.write(JSON.stringify(clean, null, 2) + '\n');
}
