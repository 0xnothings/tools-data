// jsonlines.js — NDJSON <-> JSON array conversion with filtering and sampling.
// Copyright (c) 2026 0xnothings
// @tool jsonlines
// @desc Convert between NDJSON and JSON arrays, filter with predicates, sample rows
// @usage node tools/jsonlines.js events.ndjson --to array --grep error
// @tags data,json,ndjson,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const HELP = `jsonlines — NDJSON tooling

  node tools/jsonlines.js <file|-> [options]

  --to <fmt>        lines | array | csv    (default: lines, i.e. pass-through normalize)
  --where <k=v>     repeatable; keep records where field equals value (dotted paths ok)
  --field <path>    repeatable; only require these fields to exist
  --grep <regex>    keep records whose raw line or stringified value matches
  --sample <n>      reservoir-sample n records (single pass, O(n) memory)
  --head <n>        first n records
  --pretty          pretty-print JSON (array + lines)
  --keys <col,..>   column order for --to csv (default: discovered)
  --json            wrap output in a machine-readable envelope
  -h, --help        this text

  Input may be either NDJSON, a single JSON array, or an array on one line;
  the format is auto-detected. Output --to lines emits one JSON per line.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a .ndjson/.json file or pipe on stdin');

const raw = await readInput(src);
if (!raw.trim()) die('empty input');

function collectMulti(argv, key) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${key}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  }
  return out;
}
const wheres = collectMulti(process.argv.slice(2), 'where');
const fields = collectMulti(process.argv.slice(2), 'field');
const grepRaw = get(o, 'grep', null);
const grepRe = grepRaw ? (() => { try { return new RegExp(String(grepRaw), 'i'); } catch (e) { die(`bad --grep regex: ${e.message}`); } })() : null;

function parseInput(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return { mode: 'array', records: arr };
    } catch { /* fall through to line mode */ }
  }
  const records = [];
  let bad = 0;
  const ls = text.split(/\r?\n/);
  for (const line of ls) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('[')) {
      try { const a = JSON.parse(t); if (Array.isArray(a)) { records.push(...a); continue; } } catch { /* line mode */ }
    }
    try { records.push(JSON.parse(t)); } catch { bad++; }
  }
  return { mode: 'lines', records, badLines: bad };
}

const picked = parseInput(raw);
const dig = (obj, path) => path.split('.').reduce((acc, k) => (acc === null || acc === undefined ? undefined : acc[k]), obj);

let records = picked.records;
const totalIn = records.length;

if (wheres.length) {
  const parsed = wheres.map((w) => {
    const eq = w.indexOf('=');
    if (eq < 0) die(`--where expects key=value (got ${w})`);
    return { path: w.slice(0, eq), value: w.slice(eq + 1) };
  });
  records = records.filter((r) => parsed.every((p) => {
    const v = dig(r, p.path);
    return String(v) === p.value || (v === undefined && p.value === '');
  }));
}
if (fields.length) records = records.filter((r) => fields.every((f) => dig(r, f) !== undefined));
if (grepRe) records = records.filter((r) => grepRe.test(typeof r === 'string' ? r : JSON.stringify(r)) && !(typeof r === 'object' && r !== null && !grepRe.test(JSON.stringify(r))));

const headN = get(o, 'head', null);
if (headN !== null) {
  const parsedHead = num(headN, 10);
  records = records.slice(0, parsedHead);
}

const sampleN = get(o, 'sample', null);
let sampleNote = null;
if (sampleN !== null) {
  const n = num(sampleN, 10);
  const res = []; let seen = 0;
  const rng = (() => { let s = 0x9e3779b9; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e9) / 1e9; }; })();
  for (const r of records) {
    seen++;
    if (res.length < n) res.push(r);
    else {
      const j = Math.floor(rng() * seen);
      if (j < n) res[j] = r;
    }
  }
  records = res;
  sampleNote = `reservoir sample ${res.length} of ${seen}`;
}

const to = String(get(o, 'to', 'lines'));
const pretty = flag(o, 'pretty');

if (to === 'csv') {
  const colSet = new Set();
  const forced = get(o, 'keys', null);
  if (forced) String(forced).split(',').map((s) => s.trim()).filter(Boolean).forEach((c) => colSet.add(c));
  else for (const r of records) if (r && typeof r === 'object' && !Array.isArray(r)) for (const k of Object.keys(r)) colSet.add(k);
  const cols = [...colSet];
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.map(esc).join(','), ...records.map((r) => cols.map((c) => esc(dig(r, c))).join(','))].join('\n');
  process.stdout.write(body + '\n');
} else if (to === 'array') {
  process.stdout.write(JSON.stringify(records, null, pretty ? 2 : 0) + '\n');
} else if (to === 'lines') {
  for (const r of records) process.stdout.write(JSON.stringify(r, null, pretty ? 2 : 0) + '\n');
} else die(`--to must be lines|array|csv (got ${to})`);

if (flag(o, 'json')) {
  process.stderr.write(JSON.stringify({
    inputMode: picked.mode, read: totalIn, emitted: records.length,
    skippedBadLines: picked.badLines || 0, filters: { where: wheres, field: fields, grep: grepRaw }, sample: sampleNote,
  }, null, 2) + '\n');
} else if (!flag(o, 'quiet')) {
  process.stderr.write(`${picked.mode} in: ${totalIn} record(s), filters -> ${records.length} emitted${sampleNote ? ` (${sampleNote})` : ''}\n`);
}
