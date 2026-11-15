// logtail.js — tail-like log reader with filtering, follow-simulation and JSON output.
// Copyright (c) 2026 0xnothings
// @tool logtail
// @desc Tail a log file with grep/level filters, follow simulation, JSON and histogram
// @usage node tools/logtail.js app.log --lines 100 --grep ERROR --json
// @tags logs,text,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { openSync, readSync, closeSync, statSync, watchFile, unwatchFile } from 'node:fs';

const HELP = `logtail — tail a log with filtering

  node tools/logtail.js <file> [options]

  -n, --lines <n>     how many matching lines to show (default 20, 0 = all)
  --grep <regex>      keep lines matching this regex (repeatable, OR)
  --exclude <regex>   drop lines matching this regex (repeatable)
  --level <list>      keep lines containing one of: error,warn,info,debug,trace
  --context <n>       show n lines of context around each match
  --follow            keep reading as the file grows (Ctrl-C to stop)
  --interval <ms>     poll interval for --follow (default 500)
  --json              parse each line as JSON when possible and emit records
  --histogram         bucket matching lines over time (needs a timestamp)
  --time-key <k>      JSON field or regex group used as the timestamp
  --stats             print counts per level instead of the lines
  --head              read from the start instead of the end
  -h, --help          this text

  Reads backwards from the end by seeking to a byte offset, so tailing a 10 GB
  log costs a few reads, not a full scan. --follow polls the file size and
  prints only the newly appended bytes.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const file = o._[0];
if (!file) die('need a log file — node tools/logtail.js app.log -n 50');

let size;
try { size = statSync(file).size; } catch (e) { die(`cannot stat ${file}: ${e.message}`); }

function collect(argv, key) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${key}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
}

const grepPatterns = collect(process.argv.slice(2), 'grep');
const excludePatterns = collect(process.argv.slice(2), 'exclude');
const onlyJSON = flag(o, 'json');
const wantLines = num(get(o, 'lines', get(o, 'n', 20)), 20);
const contextN = num(get(o, 'context', 0), 0);
const head = flag(o, 'head');
const follow = flag(o, 'follow');
const interval = num(get(o, 'interval', 500), 500);
const levelSpec = get(o, 'level', null);
const timeKey = get(o, 'time-key', null);

let greps, excludes;
try {
  greps = grepPatterns.map((p) => new RegExp(p, 'i'));
  excludes = excludePatterns.map((p) => new RegExp(p, 'i'));
} catch (e) { die(`bad --grep/--exclude regex: ${e.message}`); }

const LEVEL_RE = /\b(fatal|panic|error|err|warn(?:ing)?|info|notice|debug|trace)\b/i;

function keep(line) {
  if (!line.length) return false;
  if (greps.length && !greps.some((r) => r.test(line))) return false;
  if (excludes.some((r) => r.test(line))) return false;
  if (levelSpec) {
    const want = String(levelSpec).toLowerCase().split(',').map((s) => s.trim());
    const m = line.match(LEVEL_RE);
    if (!m) return false;
    const found = m[1].toLowerCase();
    const normalized = found.startsWith('err') ? 'error' : found.startsWith('warn') ? 'warn' : found;
    if (!want.includes(normalized) && !want.includes(found)) return false;
  }
  return true;
}

function levelOf(line) {
  const m = line.match(LEVEL_RE);
  if (!m) return 'other';
  const f = m[1].toLowerCase();
  return f.startsWith('err') ? 'error' : f.startsWith('warn') ? 'warn' : f;
}

const READ_BLOCK = 1 << 20;

function readRange(start, end) {
  const fd = openSync(file, 'r');
  let pos = start;
  const chunks = [];
  const buf = Buffer.allocUnsafe(READ_BLOCK);
  while (pos < end) {
    const want = Math.min(READ_BLOCK, end - pos);
    const n = readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    pos += n;
  }
  closeSync(fd);
  return Buffer.concat(chunks).toString('utf8');
}

/** Read the last `count` lines by walking backwards in blocks. */
function tailLines(count) {
  if (count <= 0) return readRange(0, size).split(/\r?\n/);
  const fd = openSync(file, 'r');
  const pieces = [];
  let pos = size;
  let newlines = 0;
  const buf = Buffer.allocUnsafe(READ_BLOCK);
  while (pos > 0 && newlines <= count) {
    const want = Math.min(READ_BLOCK, pos);
    pos -= want;
    const n = readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    const chunk = buf.subarray(0, n).toString('utf8');
    pieces.push(chunk);
    for (const ch of chunk) if (ch === '\n') newlines++;
  }
  closeSync(fd);
  const text = pieces.reverse().join('');
  const ls = text.split(/\r?\n/);
  // The first element may be a partial line if we stopped mid-file.
  if (pos > 0 && ls.length) ls.shift();
  if (ls.length && ls[ls.length - 1] === '') ls.pop();
  return ls;
}

const lines = head ? readRange(0, size).split(/\r?\n/) : tailLines(wantLines + contextN * 2 + 1);

const matched = [];
let scanned = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line === '' && i === lines.length - 1) continue;
  scanned++;
  if (keep(line)) matched.push({ idx: i, line, level: levelOf(line) });
}

const levelCounts = {};
for (const line of lines) {
  const l = levelOf(line);
  levelCounts[l] = (levelCounts[l] || 0) + 1;
}

function parseTimestamp(line) {
  if (timeKey) {
    try {
      const j = JSON.parse(line);
      let v = j;
      for (const seg of String(timeKey).split('.')) v = v?.[seg];
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    } catch { /* not JSON */ }
  }
  const iso = line.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/);
  if (iso) { const d = new Date(iso[1].replace(' ', 'T')); if (!Number.isNaN(d.getTime())) return d; }
  const syslog = line.match(/^([A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2})/);
  if (syslog) { const d = new Date(`${syslog[1]} ${new Date().getFullYear()}`); if (!Number.isNaN(d.getTime())) return d; }
  return null;
}

if (flag(o, 'histogram')) {
  const buckets = new Map();
  let undated = 0;
  for (const m of matched) {
    const d = parseTimestamp(m.line);
    if (!d) { undated++; continue; }
    const key = d.toISOString().slice(0, 16).replace('T', ' ');
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (flag(o, 'json')) {
    process.stdout.write(JSON.stringify({ file, matched: matched.length, undated, buckets: Object.fromEntries(sorted) }, null, 2) + '\n');
  } else {
    const out = [`${matched.length} matching line(s) across ${sorted.length} bucket(s)${undated ? `, ${undated} without a timestamp` : ''}`, ''];
    const max = Math.max(1, ...sorted.map(([, v]) => v));
    for (const [k, v] of sorted) out.push(`  ${k}  ${'#'.repeat(Math.max(1, Math.round((v / max) * 40)))} ${v}`);
    process.stdout.write(out.join('\n') + '\n');
  }
  process.exit(0);
}

if (flag(o, 'stats')) {
  const byLevel = Object.entries(levelCounts).sort((a, b) => b[1] - a[1]);
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ file, scanned, matched: matched.length, levels: Object.fromEntries(byLevel) }, null, 2) + '\n');
  else process.stdout.write(table(byLevel.map(([level, count]) => ({ level, count, percent: `${((count / (scanned || 1)) * 100).toFixed(2)}%` })), ['level', 'count', 'percent']) + '\n');
  process.exit(0);
}

const emitMatch = (m) => {
  if (onlyJSON) {
    let parsed;
    try { parsed = JSON.parse(m.line); } catch { parsed = { message: m.line }; }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) parsed.__level = parsed.__level ?? m.level;
    process.stdout.write(JSON.stringify(parsed) + '\n');
  } else {
    process.stdout.write(`${m.line}\n`);
  }
};

if (contextN > 0) {
  const shown = new Set();
  for (const m of matched) {
    for (let i = Math.max(0, m.idx - contextN); i <= Math.min(lines.length - 1, m.idx + contextN); i++) shown.add(i);
  }
  for (const i of [...shown].sort((a, b) => a - b)) process.stdout.write(`${lines[i]}\n`);
} else {
  for (const m of matched) emitMatch(m);
}

if (onlyJSON) {
  process.stderr.write(`${scanned} line(s) scanned, ${matched.length} emitted${Object.keys(levelCounts).length ? ` | levels: ${Object.entries(levelCounts).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}\n`);
}

if (follow) {
  let pos = size;
  let pending = '';
  process.stderr.write(`following ${file} (${interval}ms poll) — Ctrl-C to stop\n`);
  const stop = () => { unwatchFile(file); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  watchFile(file, { interval }, (curr) => {
    if (curr.size < pos) { process.stderr.write(`\n${file} was truncated — resetting to start\n`); pos = 0; }
    if (curr.size === pos) return;
    const text = pending + readRange(pos, curr.size);
    pos = curr.size;
    const parts = text.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (!keep(line)) continue;
      if (onlyJSON) {
        let parsed;
        try { parsed = JSON.parse(line); } catch { parsed = { message: line }; }
        process.stdout.write(JSON.stringify(parsed) + '\n');
      } else process.stdout.write(line + '\n');
    }
  });
}
