// jsongrid.js — flatten a nested JSON array into a table, auto-discovering columns.
// Copyright (c) 2026 0xnothings
// @tool jsongrid
// @desc Flatten a nested JSON array/object into an aligned table with discovered columns
// @usage node tools/jsongrid.js data.json --depth 3 --json
// @tags data,json,table,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const HELP = `jsongrid — flatten nested JSON into a table

  node tools/jsongrid.js <file|-> [options]

  --path <jsonpath>   start from a sub-node (dotted, e.g. data.items)
  --depth <n>         max flatten depth (default 6, 0 = no flatten)
  --arrays <mode>     json | join | length | first   (default json)
  --raw               do not auto-unwrap a { data: [...] } style envelope
  --max-cols <n>      cap discovered columns (default 200)
  --csv               emit CSV instead of an aligned table
  --json              machine-readable output
  -h, --help          this text

  Nested objects become dotted columns (user.address.city). Arrays are
  rendered per --arrays: json (compact string), join (comma-joined scalars),
  length (count) or first (first element only).`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a JSON file or pipe on stdin');

const raw = await readInput(src);
if (!raw.trim()) die('empty input');
let parsed;
try { parsed = JSON.parse(raw); } catch (e) { die(`invalid JSON: ${e.message}`); }

const startPath = get(o, 'path', null);
if (startPath) {
  for (const seg of String(startPath).split('.').filter(Boolean)) {
    if (parsed == null) break;
    const m = seg.match(/^(.*?)\[(\d+)\]$/);
    if (m) {
      parsed = m[1] ? parsed[m[1]] : parsed;
      parsed = Array.isArray(parsed) ? parsed[Number(m[2])] : undefined;
    } else parsed = parsed[seg];
  }
  if (parsed === undefined) die(`path not found: ${startPath}`);
}

const depth = num(get(o, 'depth', 6), 6);
const arrMode = String(get(o, 'arrays', 'json'));
const maxCols = num(get(o, 'max-cols', 200), 200);

function flatten(node, prefix, out, level) {
  if (node === null || typeof node !== 'object') {
    out[prefix || 'value'] = node;
    return out;
  }
  if (Array.isArray(node)) {
    if (arrMode === 'length') { out[prefix || 'value'] = node.length; return out; }
    if (arrMode === 'join') { out[prefix || 'value'] = node.map((x) => (x === null || typeof x === 'object' ? JSON.stringify(x) : String(x))).join(','); return out; }
    if (arrMode === 'first') {
      if (!node.length) { out[prefix || 'value'] = null; return out; }
      return level >= depth || depth === 0
        ? (out[prefix || 'value'] = JSON.stringify(node[0]), out)
        : flatten(node[0], prefix, out, level + 1);
    }
    out[prefix || 'value'] = JSON.stringify(node);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const isObj = v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isObj && (depth === 0 || level >= depth)) out[key] = JSON.stringify(v);
    else if (Array.isArray(v)) flatten(v, key, out, level + 1);
    else if (isObj) flatten(v, key, out, level + 1);
    else out[key] = v;
  }
  return out;
}

let root = parsed;
if (!flag(o, 'raw')) {
  for (let hop = 0; hop < 3 && root && !Array.isArray(root) && typeof root === 'object'; hop++) {
    const preferred = ['data', 'items', 'results', 'records', 'rows', 'list'];
    let key = preferred.find((k) => Array.isArray(root[k]));
    if (!key) key = Object.keys(root).find((k) => Array.isArray(root[k]) && root[k].length && typeof root[k][0] === 'object');
    if (!key) {
      const arrays = Object.keys(root).filter((k) => Array.isArray(root[k]));
      if (arrays.length === 1) key = arrays[0];
    }
    if (key) { root = root[key]; break; }
    // Single-key wrapper object, e.g. { data: { items: [...] } }
    const keys = Object.keys(root);
    if (keys.length === 1 && root[keys[0]] && typeof root[keys[0]] === 'object') { root = root[keys[0]]; continue; }
    break;
  }
}

const records = Array.isArray(root) ? root : [root];
const flat = records.map((r) => flatten(r, '', {}, 0));
const colSet = new Set();
for (const row of flat) for (const k of Object.keys(row)) colSet.add(k);
const columns = [...colSet].slice(0, maxCols);

const cell = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};
const grid = flat.map((row) => Object.fromEntries(columns.map((c) => [c, cell(row[c])])));

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ rows: grid.length, columns, data: grid }, null, 2) + '\n');
} else if (flag(o, 'csv')) {
  const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const body = [columns.map(esc).join(','), ...grid.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
  process.stdout.write(body + '\n');
} else {
  const rows = grid.slice(0, 200);
  process.stdout.write(table(rows, columns) + '\n');
  process.stdout.write(`\n${grid.length} row(s), ${columns.length} column(s)`);
  if (grid.length > 200) process.stdout.write(' — display truncated to 200 rows (use --csv or --json)');
  process.stdout.write('\n');
}
