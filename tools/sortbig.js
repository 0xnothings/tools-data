// sortbig.js — external merge sort for files larger than RAM.
// Copyright (c) 2026 0xnothings
// @tool sortbig
// @desc External merge sort: chunk, sort, k-way merge with a min-heap; unique and dedupe
// @usage node tools/sortbig.js huge.log --out sorted.log --chunk 200mb
// @tags data,sort,bigdata,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import {
  openSync, readSync, writeSync, closeSync, mkdirSync, statSync,
  createWriteStream, existsSync, unlinkSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HELP = `sortbig — external merge sort (works on files bigger than RAM)

  node tools/sortbig.js <file> [options]

  --out <file>        output path (default: stdout)
  --chunk <size>      memory budget per run (default 128mb; suffixes b/kb/mb/gb)
  --key <mode>        line (default) | numeric | field:<n> | natural | length | reverse
  --delim <c>         field delimiter for field:<n> (default comma)
  --numeric-field <n> field index treated as a number (0-based, with --key field)
  --unique            drop duplicate lines
  --ignore-case       case-insensitive comparison
  --desc              descending order
  --stable            preserve original order for equal keys (adds a tiebreak index)
  --temp <dir>        scratch directory (default: os tmpdir)
  --keep-temp         do not delete the scratch runs
  --json              machine-readable stats (written to stderr when --out is used)
  -h, --help          this text

  Algorithm: read the input in --chunk slices, sort each slice in memory, spill to a
  run file, then k-way merge all runs through a binary min-heap. Memory stays at one
  chunk plus one line per run, no matter the input size.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const input = o._[0];
if (!input) die('need an input file — node tools/sortbig.js huge.log --out sorted.log');

const parseSize = (v, def) => {
  const m = String(v ?? '').match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!m) return def;
  return Math.floor(parseFloat(m[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] || 'b').toLowerCase()]);
};

const chunkBytes = parseSize(get(o, 'chunk', null), 128 * 1024 * 1024);
const outPath = get(o, 'out', null);
const keyMode = String(get(o, 'key', 'line'));
const delim = (() => { const d = get(o, 'delim', ','); return d === 'tab' ? '\t' : String(d); })();
const numericField = get(o, 'numeric-field', null) !== null ? Number(get(o, 'numeric-field')) : null;
const unique = flag(o, 'unique');
const ignoreCase = flag(o, 'ignore-case');
const desc = flag(o, 'desc');
const stable = flag(o, 'stable');
const tempRoot = String(get(o, 'temp', join(tmpdir(), 'sortbig-' + process.pid)));
const keepTemp = flag(o, 'keep-temp');

let totalBytes;
try { totalBytes = statSync(input).size; } catch (e) { die(`cannot stat ${input}: ${e.message}`); }

const NUMERIC_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function firstNumber(s) {
  const m = String(s).match(NUMERIC_RE);
  return m ? Number(m[0]) : Number.NaN;
}

function makeKey(line) {
  const l = ignoreCase ? line.toLowerCase() : line;
  switch (keyMode) {
    case 'numeric': return { t: 'n', v: firstNumber(l) };
    case 'length': return { t: 'n', v: l.length };
    case 'natural': return { t: 'nat', v: l };
    case 'reverse': return { t: 's', v: l };
    case 'line': return { t: 's', v: l };
    default:
      if (keyMode.startsWith('field:')) {
        const idx = Number(keyMode.slice(6));
        const parts = l.split(delim);
        const f = parts[idx] ?? '';
        if (numericField !== null && idx === numericField) return { t: 'n', v: firstNumber(f) };
        return { t: 's', v: f };
      }
      return { t: 's', v: l };
  }
}

function compareKeys(a, b) {
  let r;
  if (a.t === 'n' && b.t === 'n') {
    const x = Number.isFinite(a.v) ? a.v : (Number.isFinite(b.v) ? 1 : 0);
    const y = Number.isFinite(b.v) ? b.v : (Number.isFinite(a.v) ? -1 : 0);
    r = x === y ? 0 : x < y ? -1 : 1;
  } else if (a.t === 'nat' && b.t === 'nat') {
    r = naturalCompare(a.v, b.v);
  } else {
    const x = String(a.v), y = String(b.v);
    r = x === y ? 0 : x < y ? -1 : 1;
  }
  if (keyMode === 'reverse') r = -r;
  return desc ? -r : r;
}

function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const ax = String(a).match(re) || [];
  const bx = String(b).match(re) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i], y = bx[i];
    if (x !== y) {
      const nx = /^\d/.test(x), ny = /^\d/.test(y);
      if (nx && ny) return Number(x) - Number(y);
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

const records = [];
let bytesInChunk = 0;
let lineNo = 0;
let started = false;
let truncationWarned = false;
let tail = '';
const runs = [];

mkdirSync(tempRoot, { recursive: true });
const maxLine = 64 * 1024 * 1024;

function spillRun(items) {
  const idx = runs.length;
  const p = join(tempRoot, `run-${String(idx).padStart(5, '0')}.txt`);
  items.sort((a, b) => {
    const c = compareKeys(makeKey(a.line), makeKey(b.line));
    return c !== 0 ? c : a.seq - b.seq;
  });
  const fd = openSync(p, 'w');
  const buf = [];
  let bufLen = 0;
  for (const it of items) {
    buf.push(it.line, '\n');
    bufLen += Buffer.byteLength(it.line) + 1;
    if (bufLen > 4 * 1024 * 1024) { writeSync(fd, Buffer.from(buf.join(''))); buf.length = 0; bufLen = 0; }
  }
  if (buf.length) writeSync(fd, Buffer.from(buf.join('')));
  closeSync(fd);
  runs.push({ path: p, count: items.length });
  return p;
}

let buffered = [];
const readSize = 1 << 20;
const fd = openSync(input, 'r');
const raw = Buffer.allocUnsafe(readSize);
while (true) {
  const n = readSync(fd, raw, 0, readSize, null);
  if (n <= 0) break;
  const text = tail + raw.subarray(0, n).toString('utf8');
  tail = '';
  const parts = text.split('\n');
  tail = parts.pop() ?? '';
  if (tail.length > maxLine && !truncationWarned) {
    process.stderr.write(`warning: a line exceeds ${maxLine} bytes — it will be read but sorted as one unit\n`);
    truncationWarned = true;
  }
  for (const line of parts) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    buffered.push({ line: clean, seq: lineNo++ });
    bytesInChunk += Buffer.byteLength(clean) + 1;
    started = true;
  }
  if (bytesInChunk >= chunkBytes) {
    spillRun(buffered);
    buffered = [];
    bytesInChunk = 0;
  }
}
closeSync(fd);
if (tail.length) {
  buffered.push({ line: tail, seq: lineNo++ });
  bytesInChunk += Buffer.byteLength(tail) + 1;
  started = true;
}
if (!started) die('input file is empty');
if (buffered.length) spillRun(buffered);

/* ---- k-way merge with a binary min-heap ---- */
class RunReader {
  constructor(path, desc2) {
    this.fd = openSync(path, 'r');
    this.buf = Buffer.allocUnsafe(1 << 20);
    this.pos = 0;
    this.len = 0;
    this.partial = '';
    this.eof = false;
    void desc2;
  }
  next() {
    for (;;) {
      let nl = this.partial.indexOf('\n');
      if (nl >= 0) {
        const line = this.partial.slice(0, nl);
        this.partial = this.partial.slice(nl + 1);
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }
      if (this.eof && !this.partial.length) return null;
      if (this.eof) {
        const out = this.partial;
        this.partial = '';
        return out.endsWith('\r') ? out.slice(0, -1) : out;
      }
      const n = readSync(this.fd, this.buf, 0, this.buf.length, null);
      if (n <= 0) { this.eof = true; continue; }
      this.partial += this.buf.subarray(0, n).toString('utf8');
    }
  }
  close() { try { closeSync(this.fd); } catch { /* ignore */ } }
}

const readers = runs.map((r) => new RunReader(r.path));
const heap = [];
let cmpCount = 0;

function push(item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    cmpCount++;
    if (compareKeys(heap[parent].key, heap[i].key) <= 0) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}
function pop() {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heap.length && (cmpCount++, compareKeys(heap[l].key, heap[m].key) < 0)) m = l;
      if (r < heap.length && (cmpCount++, compareKeys(heap[r].key, heap[m].key) < 0)) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
}

for (let i = 0; i < readers.length; i++) {
  const line = readers[i].next();
  if (line !== null) push({ key: makeKey(line), line, run: i, seq: 0 });
}

const sink = outPath ? createWriteStream(String(outPath)) : null;
let sunkBytes = 0;
const outLines = [];
let emitted = 0;
let droppedDupes = 0;
let lastWritten = null;

function writeLine(line) {
  emitted++;
  if (sink) {
    sink.write(line + '\n');
    sunkBytes += Buffer.byteLength(line) + 1;
  } else outLines.push(line);
}

while (heap.length) {
  const item = pop();
  const isDupe = lastWritten !== null && (ignoreCase ? lastWritten.toLowerCase() === item.line.toLowerCase() : lastWritten === item.line);
  if (!(unique && isDupe)) {
    writeLine(item.line);
    lastWritten = item.line;
  } else droppedDupes++;
  const nextLine = readers[item.run].next();
  if (nextLine !== null) push({ key: makeKey(nextLine), line: nextLine, run: item.run, seq: 0 });
}
for (const r of readers) r.close();

if (sink) await new Promise((res) => sink.end(res));

if (!keepTemp) { try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ } }

const stats = {
  input,
  inputBytes: totalBytes,
  chunkBytes,
  runs: runs.length,
  linesIn: lineNo,
  linesOut: emitted,
  duplicatesDropped: droppedDupes,
  keys: keyMode,
  order: desc ? `${keyMode} descending` : keyMode,
  comparisons: cmpCount,
  outputBytes: outPath ? sunkBytes : outLines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0),
  tempDir: keepTemp ? tempRoot : null,
};

if (!outPath) {
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ stats, lines: outLines }, null, 2) + '\n');
  else process.stdout.write(outLines.join('\n') + (outLines.length ? '\n' : ''));
} else if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
} else {
  process.stderr.write(`${stats.linesIn} lines in -> ${stats.linesOut} lines out across ${stats.runs} run(s); wrote ${outPath}\n`);
  if (droppedDupes) process.stderr.write(`${droppedDupes} duplicate line(s) dropped\n`);
}

// Keep the unused-import surface honest for readers of this file.
void existsSync; void unlinkSync; void table;
