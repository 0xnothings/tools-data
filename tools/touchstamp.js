#!/usr/bin/env node
// touchstamp.js — bulk adjust file mtimes from a CSV manifest.
// Copyright (c) 2026 0xnothings
// @tool touchstamp
// @desc Apply mtime/atime to many files from a CSV manifest, with dry-run and skew
// @usage node tools/touchstamp.js manifest.csv --root ./photos --dry-run
// @tags files,metadata,csv,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { statSync, utimesSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const HELP = `touchstamp — bulk set file timestamps from a manifest

  node tools/touchstamp.js <manifest.csv> [options]

  --root <dir>        resolve relative paths against this directory (default .)
  --path-col <name>   manifest column holding the path (default: path|file|name)
  --time-col <name>   manifest column holding the timestamp (default: mtime|date|time)
  --op <mode>         set (default) | add | sub
  --skew <dur>        shift applied with add/sub, e.g. 6h, -90m, 2d, 500ms
  --atime <mode>      match (default) | keep | now
  --recursive         if no manifest is given, walk --root and shift every file
  --dry-run           show what would change (default action)
  --apply             perform the change
  --json              machine-readable output
  -h, --help          this text

  Timestamps accept ISO-8601, "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS" (local),
  epoch seconds, or epoch milliseconds. --op add/sub shift existing mtimes
  instead of reading the manifest column, which is how you fix a camera clock.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const manifest = o._[0];
const root = String(get(o, 'root', '.'));
const apply = flag(o, 'apply');
const op = String(get(o, 'op', 'set'));

function parseWhen(v) {
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]));
  return null;
}

function parseSkew(v) {
  if (!v) return 0;
  const m = String(v).match(/^([+-]?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
  if (!m) die(`bad --skew value: ${v} (try 6h, -90m, 2d, 500ms)`);
  const n = parseFloat(m[1]);
  const u = (m[2] || 's').toLowerCase();
  return Math.round(n * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[u]);
}

const skewMs = parseSkew(get(o, 'skew', null));
if ((op === 'add' || op === 'sub') && !skewMs) die('--op add/sub requires --skew <duration>');

function parseCSV(text, delim) {
  const rows = [];
  let row = [], cur = '', quoted = false, sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; sawAny = true; continue; }
    if (c === delim) { row.push(cur); cur = ''; sawAny = true; continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; sawAny = false; continue; }
    if (c === '\r') continue;
    cur += c; sawAny = true;
  }
  if (sawAny || cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function sniffDelim(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  let best = ',', bestN = -1;
  for (const c of [',', '\t', ';', '|']) {
    let n = 0, q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === c && !q) n++; }
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

const ops = [];
if (manifest) {
  const text = (await readInput(manifest)).replace(/^\uFEFF/, '');
  if (!text.trim()) die('manifest is empty');
  const delim = sniffDelim(text);
  const grid = parseCSV(text, delim);
  const header = grid[0].map((h) => h.trim().toLowerCase());
  const findCol = (want, defaults) => {
    if (want) return header.indexOf(String(want).toLowerCase());
    for (const d of defaults) { const i = header.indexOf(d); if (i >= 0) return i; }
    return -1;
  };
  let pathIdx = findCol(get(o, 'path-col', null), ['path', 'file', 'name', 'filename']);
  let timeIdx = findCol(get(o, 'time-col', null), ['mtime', 'date', 'time', 'timestamp', 'modified']);
  if (pathIdx < 0) pathIdx = 0;
  if (timeIdx < 0) timeIdx = header.findIndex((h, i) => i !== pathIdx && /date|time|mtime|stamp/.test(h));
  if (timeIdx < 0) timeIdx = header.length > 1 ? 1 : -1;

  for (const row of grid.slice(1)) {
    const p = (row[pathIdx] ?? '').trim();
    if (!p) continue;
    ops.push({ raw: p, timeRaw: timeIdx >= 0 ? (row[timeIdx] ?? '').trim() : '' });
  }
} else if (flag(o, 'recursive')) {
  const walk = (d, depth) => {
    if (depth > 32) return;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) ops.push({ raw: full, timeRaw: '' });
    }
  };
  walk(root, 0);
} else {
  die('need a manifest CSV, or --recursive to shift a whole tree');
}

const results = [];
let changed = 0, unchanged = 0, missing = 0;
const atimeMode = String(get(o, 'atime', 'match'));

for (const it of ops) {
  const full = isAbsolute(it.raw) ? it.raw : join(root, it.raw);
  let st;
  try { st = statSync(full); } catch { missing++; results.push({ file: it.raw, status: 'missing' }); continue; }
  const before = st.mtimeMs;
  let after;
  if (op === 'add') after = before + skewMs;
  else if (op === 'sub') after = before - skewMs;
  else {
    const d = parseWhen(it.timeRaw);
    if (!d) { results.push({ file: it.raw, status: 'bad-timestamp', value: it.timeRaw }); continue; }
    after = d.getTime();
  }
  const atime = atimeMode === 'now' ? Date.now() : atimeMode === 'keep' ? st.atimeMs : after;
  const status = Math.abs(after - before) < 1000 ? 'same' : 'change';
  if (status === 'same') unchanged++; else changed++;
  if (apply && status === 'change') {
    try { utimesSync(full, new Date(atime), new Date(after)); } catch (e) { results.push({ file: it.raw, status: 'error', error: e.message }); continue; }
  }
  results.push({
    file: it.raw,
    status: apply && status === 'change' ? 'applied' : status,
    from: new Date(before).toISOString(),
    to: new Date(after).toISOString(),
    deltaHours: Number(((after - before) / 3600000).toFixed(3)),
  });
}

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    manifest: manifest || null, root, op, skewMs, applied: apply,
    total: ops.length, changed, unchanged, missing, results,
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`${apply ? 'APPLIED' : 'DRY RUN'}  ${manifest || root}  (${ops.length} target(s), op=${op}${skewMs ? ` skew=${skewMs}ms` : ''})`);
  out.push(`changed ${changed}  unchanged ${unchanged}  missing ${missing}`);
  out.push('');
  const rows = results.slice(0, 60).map((r) => ({
    file: r.file.length > 44 ? '...' + r.file.slice(-41) : r.file,
    status: r.status,
    from: r.from ? r.from.replace('T', ' ').slice(0, 19) : '',
    to: r.to ? r.to.replace('T', ' ').slice(0, 19) : '',
    delta: r.deltaHours === undefined ? '' : `${r.deltaHours}h`,
  }));
  out.push(table(rows, ['file', 'status', 'from', 'to', 'delta']));
  if (results.length > 60) out.push(`... ${results.length - 60} more`);
  if (!apply && changed) out.push('', 're-run with --apply to write the timestamps');
  process.stdout.write(out.join('\n') + '\n');
}
