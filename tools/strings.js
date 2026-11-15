#!/usr/bin/env node
// strings.js — extract printable strings with encoding, offset, length and regex filters.
// Copyright (c) 2026 0xnothings
// @tool strings
// @desc Pull printable strings from binaries with ASCII/UTF-16 encodings, offsets, lengths and regex filters
// @usage node tools/strings.js sample.bin --min 5 --utf16 --json
// @tags data,binary,forensics,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `strings — printable string extractor

  node tools/strings.js <file|--dir path> [options]

  --min <n>        minimum string length (default 4)
  --enc <list>     encodings: ascii,utf16le,utf16be (default ascii)
  --utf16          shorthand for --enc ascii,utf16le
  --at <off>       start scanning at this offset
  --len <n>        scan only n bytes
  --regex <re>     keep only strings matching this JavaScript regex
  --grep <substr>  case-insensitive substring filter
  --unique         drop duplicate strings, report the hit count
  --sort <mode>    offset (default) | length | alpha
  --limit <n>      print at most n strings (default 500)
  --types          classify strings (url/path/ipv4/email/uuid/flag/base64/hex)
  --diff <file>    keep only strings NOT present in this file
  --json           machine-readable output
  -h, --help       this text

  Scans raw bytes; no assumption about the container. UTF-16 scans start at
  every byte offset, so unaligned UTF-16 inside a packed binary is recovered.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'types', 'unique', 'utf16']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a file — node tools/strings.js sample.bin');

const minLen = Math.max(1, num(get(o, 'min', 4), 4));
const encSpec = flag(o, 'utf16') ? 'ascii,utf16le' : String(get(o, 'enc', 'ascii'));
const encodings = encSpec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
for (const e of encodings) if (!['ascii', 'utf16le', 'utf16be'].includes(e)) die(`unknown encoding "${e}" — use ascii, utf16le or utf16be`);
const at = num(get(o, 'at', 0), 0);
const len = num(get(o, 'len', 0), 0);
const limit = num(get(o, 'limit', 500), 500);
const sortMode = String(get(o, 'sort', 'offset'));
const reSrc = get(o, 'regex', null);
let re = null;
if (reSrc !== null) { try { re = new RegExp(String(reSrc)); } catch (e) { die(`bad --regex: ${e.message}`); } }
const grep = get(o, 'grep', null) ? String(get(o, 'grep')).toLowerCase() : null;

const CLASSIFIERS = [
  ['url', /^(https?|ftp|ssh|ws|wss|file):\/\/\S+$/i],
  ['email', /^[\w.+-]+@[\w-]+\.[\w.-]+$/],
  ['ipv4', /^(\d{1,3}\.){3}\d{1,3}$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['windows-path', /^[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+$/],
  ['unix-path', /^\/(?:[\w.@-]+\/)+[\w.@-]*$/],
  ['shell-flag', /^--?[A-Za-z][\w-]+$/],
  ['base64', /^[A-Za-z0-9+/]{20,}={0,2}$/],
  ['hex-blob', /^(?:[0-9a-fA-F]{2}){16,}$/],
  ['version', /^v?\d+\.\d+(\.\d+)?([-.+][\w.]+)?$/],
  ['dotted-name', /^(?:[A-Za-z_][\w$]*\.)+[A-Za-z_][\w$]*$/],
  ['flag-brace', /^[\w-]*\{[^{}]{4,}\}$/],
  ['sentence', /^[A-Z][a-z]+(?: [\w'",.-]+)*[.!?]?$/],
];
const classify = (s) => (CLASSIFIERS.find(([, rx]) => rx.test(s)) || ['other'])[0];
const printable = (b) => (b >= 0x20 && b < 0x7f) || b === 0x09;

function scanAscii(buf, base) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const ok = i < buf.length && printable(buf[i]);
    if (ok && start === -1) start = i;
    if (!ok && start !== -1) {
      if (i - start >= minLen) out.push({ offset: base + start, text: buf.slice(start, i).toString('latin1'), enc: 'ascii', bytes: i - start });
      start = -1;
    }
  }
  return out;
}

function scanUtf16(buf, base, le) {
  const out = [];
  const n = buf.length;
  for (let i = 0; i + 1 < n; i++) {
    let j = i;
    const chars = [];
    while (j + 1 < n) {
      const code = le ? buf[j] | (buf[j + 1] << 8) : (buf[j] << 8) | buf[j + 1];
      if (code >= 0x20 && code < 0x7f) { chars.push(String.fromCharCode(code)); j += 2; } else break;
    }
    if (chars.length >= minLen) { out.push({ offset: base + i, text: chars.join(''), enc: le ? 'utf16le' : 'utf16be', bytes: chars.length * 2 }); i = j - 1; }
  }
  return out;
}

function scanBuffer(buf, base) {
  let out = [];
  if (encodings.includes('ascii')) out = out.concat(scanAscii(buf, base));
  if (encodings.includes('utf16le')) out = out.concat(scanUtf16(buf, base, true));
  if (encodings.includes('utf16be')) out = out.concat(scanUtf16(buf, base, false));
  return out;
}

function readAndScan(path) {
  const all = readFileSync(path);
  const view = len > 0 ? all.slice(at, at + len) : all.slice(at);
  return { size: all.length, hits: scanBuffer(view, at) };
}

let diffSet = null;
const diffFile = get(o, 'diff', null);
if (diffFile !== null) diffSet = new Set(readAndScan(String(diffFile)).hits.map((h) => h.text));

const paths = [];
if (flag(o, 'dir') || (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) if (ent.isFile()) paths.push(join(dir, ent.name));
} else paths.push(target);

const reports = [];
for (const p of paths) {
  const { size, hits } = readAndScan(p);
  let v = hits;
  if (grep) v = v.filter((h) => h.text.toLowerCase().includes(grep));
  if (re) v = v.filter((h) => re.test(h.text));
  if (diffSet) v = v.filter((h) => !diffSet.has(h.text));
  const totalBeforeLimit = v.length;
  let deduped = false;
  if (flag(o, 'unique')) {
    const seen = new Map();
    for (const h of v) { if (seen.has(h.text)) seen.get(h.text).count++; else seen.set(h.text, { ...h, count: 1 }); }
    v = [...seen.values()];
    deduped = true;
  }
  if (sortMode === 'length') v.sort((a, b) => b.bytes - a.bytes);
  else if (sortMode === 'alpha') v.sort((a, b) => a.text.localeCompare(b.text));
  else v.sort((a, b) => a.offset - b.offset);
  if (flag(o, 'types')) for (const h of v) h.type = classify(h.text.trim());
  const counts = {};
  for (const h of v) counts[h.enc] = (counts[h.enc] || 0) + 1;
  reports.push({
    file: p, size, scannedFrom: at, scannedBytes: len || size - at,
    encodings, minLength: minLen, count: v.length, totalBeforeLimit, matchedAfterFilters: totalBeforeLimit,
    byEncoding: counts, uniqueApplied: deduped,
    avgLength: v.length ? Number((v.reduce((a, h) => a + h.text.length, 0) / v.length).toFixed(2)) : 0,
    strings: v.slice(0, limit).map((h) => ({
      offset: h.offset, offsetHex: '0x' + h.offset.toString(16), encoding: h.enc, bytes: h.bytes, length: h.text.length, text: h.text,
      ...(h.type ? { type: h.type } : {}), ...(h.count ? { count: h.count } : {}),
    })),
  });
}

if (flag(o, 'json')) process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : { scanned: reports.length, files: reports.map((r) => ({ file: r.file, count: r.count, strings: r.strings })) }, null, 2) + '\n');
else {
  for (const r of reports) {
    console.log(`${r.file} — ${fmt(r.size)} bytes, ${fmt(r.count)} string(s) (min ${r.minLength}, ${r.encodings.join('+')})${r.uniqueApplied ? ', deduplicated' : ''}`);
    if (!r.count) { console.log('no strings matched'); continue; }
    const showType = r.strings.some((s) => s.type);
    const showCount = r.strings.some((s) => s.count);
    const cols = ['offset', 'enc', 'len', ...(showCount ? ['n'] : []), ...(showType ? ['type'] : []), 'text'];
    console.log(table(r.strings.map((s) => ({
      offset: s.offsetHex, enc: s.encoding, len: s.length, n: s.count ?? '',
      type: s.type || '', text: s.text.length > 100 ? s.text.slice(0, 97) + '...' : s.text,
    })), cols));
    if (r.count > r.strings.length) console.log(`... ${r.count - r.strings.length} more string(s) (raise --limit)`);
    if (showType) {
      const byType = {};
      for (const s of r.strings) byType[s.type] = (byType[s.type] || 0) + 1;
      console.log('types: ' + Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
    }
  }
}
