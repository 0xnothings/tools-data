// byterange.js — read, extract, splice or patch byte ranges with hash verification.
// Copyright (c) 2026 0xnothings
// @tool byterange
// @desc Extract, replace or XOR/patch byte ranges in a file, with offsets, hex and SHA-256 verification
// @usage node tools/byterange.js firmware.bin --at 0x100 --len 64 --json
// @tags data,binary,patch,cli
import { args, get, num, flag, die, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HELP = `byterange — byte range reader / patcher

  node tools/byterange.js <file> [options]

  --at <off>        start offset (default 0) — accepts 0x.., decimal, or 1m/4k suffix
  --len <n>         length in bytes (default: to end of file)
  --end <off>       alternative to --len
  --out <file>      write the selected range to a file
  --dump            hexdump the range (default in text mode)
  --replace <data>  replace the range with <data>: "@file" reads a file,
                    "hex:0a1b" / "a1b2c3" hex literal, else raw text
  --xor <key>       XOR the range with a key: hex literal (hex:6f) or text
  --sigma <file>    apply a "sigma patch": JSON list of {offset,hex} or a
                    "offset:hexbytes" per-line patch file, verified then written
  --write <file>    target for --replace/--xor/--sigma (default: in-place, with .bak)
  --no-backup       do not keep a .bak copy on in-place writes
  --verify <hex>    refuse the write unless the selected range equals <hex>
  --json            machine-readable output
  -h, --help        this text

  Every mutation is verified: the tool writes to <file>.tmp, re-reads it, and
  confirms the sha256 of the patched region plus total size before swapping in
  the original (a .bak is kept unless --no-backup).`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['dump', 'json', 'no-backup']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/byterange.js firmware.bin --at 0x100 --len 64');

const parseOff = (v, def) => {
  if (v === undefined || v === null || v === true) return def;
  const s = String(v).trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\d+[kmg]$/.test(s)) return parseInt(s, 10) * { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[s.slice(-1)];
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
};

const at = parseOff(get(o, 'at', 0), 0);
let buf;
try { buf = readFileSync(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
let len = get(o, 'len', null) === null ? null : parseOff(get(o, 'len'), null);
if (len === null && get(o, 'end', null) !== null) len = parseOff(get(o, 'end'), buf.length) - at;
if (len === null) len = buf.length - at;
if (at < 0 || at > buf.length) die(`--at ${at} is outside the file (0..${buf.length})`);
len = Math.min(len, buf.length - at);
const range = buf.slice(at, at + len);

const parseData = (v) => {
  const s = String(v);
  if (s.startsWith('@')) return readFileSync(s.slice(1));
  if (s.startsWith('hex:')) {
    const h = s.slice(4).replace(/\s+/g, '');
    if (h.length % 2) die('hex: literal has an odd number of digits');
    return Buffer.from(h, 'hex');
  }
  if (/^(0x)?[0-9a-fA-F]{4,}$/.test(s) && s.replace(/^0x/, '').length % 2 === 0 && /[a-fA-F]/.test(s)) return Buffer.from(s.replace(/^0x/, ''), 'hex');
  return Buffer.from(s, 'utf8');
};

const sha = (b) => createHash('sha256').update(b).digest('hex');
const hexdump = (b, start = 0, max = 1024) => {
  const out = [];
  const slice = b.slice(0, max);
  for (let p = 0; p < slice.length; p += 16) {
    const c = slice.slice(p, p + 16);
    out.push(`${(start + p).toString(16).padStart(8, '0')}  ${c.toString('hex').replace(/(.{2})/g, '$1 ').trimEnd().padEnd(47)}  |${[...c].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('')}|`);
  }
  if (b.length > max) out.push(`... ${b.length - max} more byte(s) omitted`);
  return out.join('\n');
};

const report = {
  file: src, fileSize: buf.length, at, length: len,
  end: at + len,
  hex: range.toString('hex'),
  ascii: [...range].map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join(''),
  sha256: sha(range),
  nonzero: [...range].filter((x) => x !== 0).length,
};
const hdr = range.slice(0, 16);
report.bytes = [...hdr].map((x) => x.toString(16).padStart(2, '0')).join(' ');

const verify = get(o, 'verify', null);
if (verify) {
  const want = String(verify).replace(/^hex:/, '').replace(/\s+/g, '').toLowerCase();
  report.verify = { expected: want, actual: range.toString('hex').toLowerCase(), ok: want === range.toString('hex').toLowerCase() };
  if (!report.verify.ok) { if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n'); die(`verify FAILED at ${at}: expected ${want.slice(0, 64)}..., got ${report.hex.slice(0, 64)}...`); }
}

const outFile = get(o, 'out', null);
if (outFile) { writeFileSync(String(outFile), range); report.written = { path: String(outFile), bytes: range.length }; }

let mutated = null;
const replaceWith = get(o, 'replace', null);
const xorKey = get(o, 'xor', null);
const sigmaFile = get(o, 'sigma', null);

if (replaceWith !== null || xorKey !== null || sigmaFile !== null) {
  const out = Buffer.from(buf);
  if (replaceWith !== null) {
    const data = parseData(replaceWith);
    if (data.length > len) die(`replacement (${data.length} B) is longer than the range (${len} B) — widen --len`);
    data.copy(out, at);
    if (data.length < len) out.fill(0, at + data.length, at + len);
    mutated = { op: 'replace', wrote: data.length, zeroFilled: len - data.length };
  }
  if (xorKey !== null) {
    const key = parseData(String(xorKey).startsWith('hex:') ? xorKey : String(xorKey));
    if (!key.length) die('empty xor key');
    for (let i = 0; i < len; i++) out[at + i] = out[at + i] ^ key[i % key.length];
    mutated = { op: 'xor', keyHex: key.toString('hex'), keyLength: key.length, bytes: len };
  }
  if (sigmaFile !== null) {
    const txt = readFileSync(String(sigmaFile), 'utf8');
    const patches = [];
    if (txt.trim().startsWith('[')) {
      for (const rec of JSON.parse(txt)) {
        const off = parseOff(rec.offset !== undefined ? rec.offset : rec.at, NaN);
        if (!Number.isFinite(off)) die(`sigma record without a usable offset: ${JSON.stringify(rec)}`);
        const data = parseData(rec.hex ? 'hex:' + rec.hex : rec.data);
        patches.push({ off, data });
      }
    } else {
      for (const line of txt.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#') || s.startsWith(';') || s.startsWith('//')) continue;
        const m = s.match(/^(0x[0-9a-fA-F]+|\d+)\s*[:=]\s*((?:[0-9a-fA-F]{2}[\s:]*)+)$/);
        if (!m) die(`unparsable sigma line: ${s}`);
        patches.push({ off: parseOff(m[1], 0), data: Buffer.from(m[2].replace(/[\s:]/g, ''), 'hex') });
      }
    }
    let applied = 0;
    const appliedList = [];
    for (const p of patches) {
      if (p.off + p.data.length > out.length) die(`sigma patch at ${p.off} (${p.data.length} B) overruns the file (${out.length} B)`);
      const before = out.slice(p.off, p.off + p.data.length);
      p.data.copy(out, p.off);
      appliedList.push({ offset: p.off, bytes: p.data.length, before: before.toString('hex'), after: p.data.toString('hex') });
      applied++;
    }
    mutated = { op: 'sigma', patches: applied, appliedList };
  }

  const target = get(o, 'write', null) ? String(get(o, 'write')) : src;
  const inPlace = target === src;
  if (inPlace && !flag(o, 'no-backup')) writeFileSync(src + '.bak', buf);
  const tmp = target + '.tmp';
  writeFileSync(tmp, out);
  const back = readFileSync(tmp);
  const ok = back.length === out.length && sha(back) === sha(out);
  if (!ok) { die(`verification FAILED for ${tmp} — original left untouched`); }
  if (inPlace) {
    writeFileSync(target, back);
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmp); } catch { /* tmp already gone */ }
  } else {
    const { renameSync } = await import('node:fs');
    renameSync(tmp, target);
  }
  mutated.result = {
    path: target,
    sizeBefore: buf.length, sizeAfter: back.length,
    sha256Before: sha(buf), sha256After: sha(back),
    backup: inPlace && !flag(o, 'no-backup') ? src + '.bak' : null,
    patchRegionHex: back.slice(at, at + len).toString('hex'),
  };
  report.mutation = mutated;
}

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — ${fmt(buf.length)} bytes, range [${at}, ${at + len}) = ${fmt(len)} byte(s)`);
  console.log(table([
    { field: 'offset', value: `${at} (0x${at.toString(16)})` },
    { field: 'end', value: `${at + len} (0x${(at + len).toString(16)})` },
    { field: 'length', value: fmt(len) },
    { field: 'nonzero bytes', value: `${report.nonzero} / ${len}` },
    { field: 'sha256(range)', value: report.sha256 },
    { field: 'first bytes', value: report.bytes },
  ], ['field', 'value']));
  if (flag(o, 'dump') || !outFile) console.log('\n' + hexdump(range, at));
  if (report.verify) console.log(`\nverify: ${report.verify.ok ? 'OK' : 'FAILED'} (${report.verify.actual.slice(0, 64)})`);
  if (report.written) console.log(`wrote ${fmt(report.written.bytes)} byte(s) -> ${report.written.path}`);
  if (report.mutation) {
    const m = report.mutation;
    console.log(`\nMUTATION: ${m.op}${m.patches !== undefined ? ` (${m.patches} patch(es))` : ''}`);
    console.log(table(Object.entries(m.result).filter(([, v]) => v !== null).map(([k, v]) => ({ field: k, value: String(v) })), ['field', 'value']));
    if (m.appliedList) console.log(table(m.appliedList.map((p) => ({ offset: '0x' + p.offset.toString(16), bytes: p.bytes, before: p.before.slice(0, 32), after: p.after.slice(0, 32) })), ['offset', 'bytes', 'before', 'after']));
  }
}
