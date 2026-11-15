#!/usr/bin/env node
// hexdumpx.js — hexdump with width/grouping/offset-base control and reverse (hex-to-binary) mode.
// Copyright (c) 2026 0xnothings
// @tool hexdumpx
// @desc Configurable hexdump with grouping, offset base and reverse mode back into binary
// @usage node tools/hexdumpx.js firmware.bin --width 32 --base 0 --json
// @tags data,binary,hex,cli
import { args, get, num, flag, die, readInput, readStdin, fmt } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';

const HELP = `hexdumpx — hexdump / reverse hexdump

  node tools/hexdumpx.js <file|-> [options]
  node tools/hexdumpx.js --reverse <hexdump.txt> --out <file.bin>

  --width <n>     bytes per line (default 16)
  --group <n>     bytes per hex group (default 1, 0 = none)
  --offset <n>    first byte offset shown (default 0)
  --length <n>    stop after n bytes
  --seek <n>      skip n bytes before dumping
  --base <n>      offset numeral base: 16 | 10 | 8 (default 16)
  --no-ascii      omit the ASCII panel
  --upper         uppercase hex digits
  --reverse       parse a hexdump (or bare hex / 0x-prefixed hex) back to bytes
  --out <file>    write the result of --reverse to this file
  --json          machine-readable output
  -h, --help      this text

  The reverse mode accepts the exact format this tool prints, plus "0x.." C
  arrays and plain hex strings with optional whitespace, colons or commas. It
  writes binary to stdout (or --out) and reports a byte count + SHA-256.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'no-ascii', 'upper']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const width = Math.max(1, Math.min(256, num(get(o, 'width', 16), 16)));
const group = Math.max(0, Math.min(width, num(get(o, 'group', 1), 1)));
const offsetBase = num(get(o, 'base', 16), 16);
const noAscii = flag(o, 'no-ascii');
const upper = flag(o, 'upper');
const showOffset = num(get(o, 'offset', 0), 0);
const seek = num(get(o, 'seek', 0), 0);
const length = num(get(o, 'length', 0), 0);
const outFile = get(o, 'out', null);
const pad = (n, w) => n.toString(offsetBase).padStart(w, '0');
const hx = (buf) => (upper ? buf.toString('hex').toUpperCase() : buf.toString('hex'));

const reverseArg = get(o, 'reverse', null);
const isReverse = flag(o, 'reverse') || typeof reverseArg === 'string';
if (isReverse) {
  const src = typeof reverseArg === 'string' ? reverseArg : o._[0];
  const text = src && src !== '-' ? readFileSync(src, 'utf8') : await readStdin();
  const { createHash } = await import('node:crypto');
  const cleaned = [];
  let skipped = 0, skippedLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let body = line;
    const firstBar = body.indexOf('|');
    if (firstBar !== -1) body = body.slice(0, firstBar);              // drop the ASCII panel
    body = body.replace(/^\s*(0x)?[0-9a-fA-F]{1,16}\s*(?=[0-9a-fA-F]{2}[\s:,-]|$)/, ' '); // drop a leading offset column
    const stripped = body.replace(/(?:0x)?[0-9a-fA-F]{2}/g, '').replace(/[\s:,.\[\]{}-]/g, '');
    if (!/^(0x)?[0-9a-fA-F]{2}/.test(body.trim())) { if (body.trim()) { skipped++; skippedLines.push(line.trim().slice(0, 60)); } continue; }
    if (stripped.length) { skipped++; skippedLines.push(line.trim().slice(0, 60)); continue; }
    const toks = body.match(/(?:0x)?[0-9a-fA-F]{2}/g) || [];
    cleaned.push(...toks.map((t) => (t.startsWith('0x') ? t.slice(2) : t)));
  }
  const hex = cleaned.join('');
  if (!hex.length) die('no hex bytes found in input (lines must look like "00000000  48 65 6c 6c 6f  |Hello|")');
  if (hex.length % 2) die(`odd number of hex digits (${hex.length}) — cannot form whole bytes`);
  const buf = Buffer.from(hex, 'hex');
  const sha = createHash('sha256').update(buf).digest('hex');
  if (outFile) writeFileSync(String(outFile), buf);
  else process.stdout.write(buf);
  const meta = { mode: 'reverse', bytes: buf.length, hexDigits: hex.length, out: outFile ? String(outFile) : 'stdout', sha256: sha, skippedLines: skipped, skippedExamples: skippedLines.slice(0, 5) };
  if (flag(o, 'json')) process.stderr.write(JSON.stringify(meta, null, 2) + '\n');
  else process.stderr.write(`reverse: ${fmt(buf.length)} byte(s) -> ${meta.out}  sha256=${sha}${skipped ? `  (${skipped} non-hex line(s) skipped)` : ''}\n`);
  process.exit(0);
}

const src = o._[0];
if (!src) die('need a file — node tools/hexdumpx.js firmware.bin');
let buf;
try { buf = readFileSync(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
let view = buf;
if (seek > 0) view = view.slice(Math.min(seek, view.length));
if (length > 0) view = view.slice(0, length);

const rows = [];
for (let p = 0; p < view.length; p += width) {
  const chunk = view.slice(p, p + width);
  let hexStr;
  if (group <= 1) hexStr = hx(chunk).replace(/(.{2})/g, '$1 ').trimEnd();
  else {
    const groups = [];
    for (let q = 0; q < chunk.length; q += group) groups.push(hx(chunk.slice(q, q + group)));
    hexStr = groups.join(' ');
  }
  const ascii = [...chunk].map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join('');
  rows.push({ offset: showOffset + p, bytes: chunk.length, hex: hexStr, ascii, raw: chunk });
}

const offDigits = Math.max(4, (showOffset + view.length).toString(offsetBase).length);
const hexCols = group <= 1 ? width * 3 - 1 : Math.ceil(width / group) * (group * 2 + 1) - 1;

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    file: src, size: buf.length, dumped: view.length, seek, offsetBase, width, group,
    offsetPrefix: offsetBase === 16 ? '0x' : offsetBase === 8 ? '0o' : '',
    rows: rows.map((r) => ({ offset: r.offset, offsetHex: '0x' + r.offset.toString(16), bytes: r.bytes, hex: r.hex, ascii: r.ascii })),
  }, null, 2) + '\n');
} else {
  const lines = rows.map((r) => {
    const offStr = (offsetBase === 16 ? '' : '') + pad(r.offset, offDigits);
    return noAscii ? `${offStr}  ${r.hex}` : `${offStr}  ${r.hex.padEnd(hexCols)}  |${r.ascii}|`;
  });
  process.stdout.write(`${src}  ${fmt(buf.length)} bytes${seek ? `, seek ${seek}` : ''}${length ? `, len ${length}` : ''}, width ${width}, group ${group}, base ${offsetBase}\n`);
  process.stdout.write(lines.join('\n') + '\n');
  if (offsetBase === 16) process.stdout.write(`end: 0x${(showOffset + view.length).toString(16)}\n`);
}
