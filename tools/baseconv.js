// baseconv.js — base 2-36 conversion for integers with BigInt support.
// Copyright (c) 2026 0xnothings
// @tool baseconv
// @desc Convert integers between bases 2-36 with BigInt precision and bit utilities
// @usage node tools/baseconv.js "deadbeef" --from 16 --to 2
// @tags numbers,convert,cli
import { args, get, flag, die, table } from '../_lib.js';

const HELP = `baseconv — arbitrary-precision base conversion

  node tools/baseconv.js <value|file|-> [options]

  --from <b>        source base 2..36, or 'auto' (default: auto)
  --to <b>          target base 2..36, or a named format (default 10)
  --pad <n>         zero-pad the output to n digits
  --group <n>       insert spaces every n digits in the output
  --uppercase       uppercase the output digits
  --prefix          add 0b/0o/0x prefixes where they exist
  --all             print the value in every notable base
  --bits            bit layout: popcount, bit length, byte/word views
  --lines           convert every non-empty line of the input
  --json            machine-readable output
  -h, --help        this text

  Input may use common prefixes (0x, 0b, 0o), separators (_ ' , and spaces),
  named formats (bin/oct/dec/hex/base32/base36/base58/base64), and values with
  leading zeros. Everything runs on BigInt, so 128-bit and larger values are exact.

  Named target formats:
    bin, oct, dec, hex            plain positional output
    base58                        Bitcoin-style alphabet
    base64                        standard alphabet
    uuid                          hex padded/truncated to 32 digits, dashed
    mac                           hex grouped into a MAC address
    ipv6                          hex grouped into eight quads
    ipv4                          dotted decimal, spaced into octets`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function parseToBigInt(input, forcedBase) {
  let s = String(input).trim().replace(/[\s_',]/g, '');
  let base = forcedBase && forcedBase !== 'auto' ? Number(forcedBase) : null;
  if (s.startsWith('-')) { const v = parseToBigInt(s.slice(1), forcedBase); return v === null ? null : -v; }
  if (s.startsWith('+')) s = s.slice(1);
  if (base === null) {
    if (/^0[xX]/.test(s)) { base = 16; s = s.slice(2); }
    else if (/^0[bB]/.test(s)) { base = 2; s = s.slice(2); }
    else if (/^0[oO]/.test(s)) { base = 8; s = s.slice(2); }
    else base = 10;
  } else {
    s = s.replace(/^0[xX]/, '').replace(/^0[bB]/, '').replace(/^0[oO]/, '');
  }
  if (!s) return 0n;
  if (base < 2 || base > 36) return null;
  let v = 0n;
  const B = BigInt(base);
  for (const ch of s.toLowerCase()) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0 || d >= base) return null;
    v = v * B + BigInt(d);
  }
  return v;
}

function toBase(v, base, { upper = false, pad = 0, group = 0, prefix = false } = {}) {
  const neg = v < 0n;
  let n = neg ? -v : v;
  const B = BigInt(base);
  let out = '';
  if (n === 0n) out = '0';
  while (n > 0n) { out = ALPHABET[Number(n % B)] + out; n /= B; }
  if (upper) out = out.toUpperCase();
  if (pad > out.length) out = '0'.repeat(pad - out.length) + out;
  if (group > 0) out = out.replace(new RegExp(`(\\w)(?=(\\w{${group}})+$)`, 'g'), '$1 ');
  if (prefix) {
    if (base === 2) out = '0b' + out;
    else if (base === 8) out = '0o' + out;
    else if (base === 16) out = '0x' + out;
  }
  return (neg ? '-' : '') + out;
}

function toNamed(v, name) {
  const n = name.toLowerCase();
  if (/^\d+$/.test(n)) return toBase(v, Number(n), { upper: flag(o, 'uppercase'), pad: Number(get(o, 'pad', 0)) || 0, group: Number(get(o, 'group', 0)) || 0, prefix: flag(o, 'prefix') });
  const baseMatch = n.match(/^base(\d+)$/);
  if (baseMatch && Number(baseMatch[1]) >= 2 && Number(baseMatch[1]) <= 36) {
    return toBase(v, Number(baseMatch[1]), { upper: flag(o, 'uppercase'), pad: Number(get(o, 'pad', 0)) || 0, group: Number(get(o, 'group', 0)) || 0, prefix: flag(o, 'prefix') });
  }
  if (n === 'bin' || n === 'binary') return toBase(v, 2, { pad: Number(get(o, 'pad', 0)) || 0, group: Number(get(o, 'group', 0)) || 0, prefix: flag(o, 'prefix') });
  if (n === 'oct' || n === 'octal') return toBase(v, 8, { prefix: flag(o, 'prefix') });
  if (n === 'dec' || n === 'decimal') return toBase(v, 10, {});
  if (n === 'hex' || n === 'hexadecimal') return toBase(v, 16, { upper: flag(o, 'uppercase'), pad: Number(get(o, 'pad', 0)) || 0, group: Number(get(o, 'group', 0)) || 0, prefix: flag(o, 'prefix') });
  if (n === 'base58') {
    if (v < 0n) die('base58 is unsigned only');
    let x = v, out = '';
    if (x === 0n) out = '1';
    while (x > 0n) { out = BASE58[Number(x % 58n)] + out; x /= 58n; }
    return out;
  }
  if (n === 'base64') {
    if (v < 0n) die('base64 is unsigned only');
    let hex = toBase(v, 16, {});
    if (hex.length % 2) hex = '0' + hex;
    const bytes = Buffer.from(hex, 'hex');
    return bytes.toString('base64');
  }
  if (n === 'uuid' || n === 'guid') {
    const hex = toBase(v, 16, { pad: 32 }).slice(-32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (n === 'mac') {
    const hex = toBase(v, 16, { pad: 12 }).slice(-12).match(/.{2}/g);
    return hex.join(':');
  }
  if (n === 'ipv6') {
    const hex = toBase(v, 16, { pad: 32 }).slice(-32).match(/.{4}/g);
    return hex.join(':');
  }
  if (n === 'ipv4') {
    const parts = [];
    for (let shift = 24n; shift >= 0n; shift -= 8n) parts.push(String((v >> shift) & 0xffn));
    return parts.join('.');
  }
  return null;
}

function bitInfo(v) {
  const neg = v < 0n;
  const n = neg ? -v : v;
  const bin = toBase(n, 2, {});
  let pop = 0;
  for (const c of bin) if (c === '1') pop++;
  const bytesNeeded = Math.max(1, Math.ceil(bin.length / 8));
  const byteView = [];
  for (let i = bytesNeeded - 1; i >= 0; i--) byteView.push(toBase((n >> BigInt(i * 8)) & 0xffn, 16, { pad: 2 }));
  const trailingZeros = n === 0n ? 0 : bin.length - bin.replace(/0+$/, '').length;
  return {
    bitLength: bin.length,
    byteLength: bytesNeeded,
    popcount: pop,
    isPowerOfTwo: n > 0n && (n & (n - 1n)) === 0n,
    log2Floor: bin.length - 1,
    trailingZeros: n === 0n ? null : trailingZeros,
    hexBytes: byteView.join(' '),
    binary: bin.replace(/(.{4})(?=.)/g, '$1 '),
  };
}

const inputs = [];
const first = o._[0];
if (!first && process.stdin.isTTY) die('need a value — node tools/baseconv.js ff --from 16 --to 10');
if (first && (first === '-' || flag(o, 'lines'))) {
  const { readFileSync } = await import('node:fs');
  const { readStdin } = await import('../_lib.js');
  const text = first === '-' ? await readStdin() : readFileSync(first, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) inputs.push(t);
  }
} else {
  inputs.push(...o._);
}
if (!inputs.length) die('no values to convert');

const fromBase = get(o, 'from', 'auto');
const toSpec = String(get(o, 'to', '10'));
const pad = Number(get(o, 'pad', 0)) || 0;
const group = Number(get(o, 'group', 0)) || 0;
const upper = flag(o, 'uppercase');
const prefix = flag(o, 'prefix');

const results = [];
for (const input of inputs) {
  const v = parseToBigInt(input, fromBase);
  if (v === null) {
    results.push({ input, error: `not a valid base-${fromBase === 'auto' ? 'detected' : fromBase} number` });
    continue;
  }
  const named = toNamed(v, toSpec);
  if (named === null && !/^\d+$/.test(toSpec)) {
    results.push({ input, error: `unknown --to format: ${toSpec}` });
    continue;
  }
  const primary = named !== null ? named : toBase(v, Number(toSpec), { upper, pad, group, prefix });
  const rec = {
    input,
    value: v.toString(),
    valueString: String(v),
    hex: toBase(v, 16, {}),
    decimal: toBase(v, 10, {}),
    binary: toBase(v, 2, {}),
    octal: toBase(v, 8, {}),
    result: primary,
    target: toSpec,
    toBase36: toBase(v, 36, {}),
    negative: v < 0n,
  };
  if (flag(o, 'bits')) rec.bits = bitInfo(v);
  if (flag(o, 'all')) {
    rec.all = {};
    for (const b of [2, 8, 10, 16, 32, 36]) rec.all[`base${b}`] = toBase(v, b, {});
    rec.all.base58 = toNamed(v, 'base58');
    rec.all.base64 = toNamed(v, 'base64');
    rec.all.hexBytes = bitInfo(v).hexBytes;
  }
  results.push(rec);
}

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify(results.length === 1 ? results[0] : results, (k, val) => (typeof val === 'bigint' ? String(val) : val), 2) + '\n');
  process.exit(results.some((r) => r.error) ? 2 : 0);
}

if (results.length === 1 && !results[0].error) {
  const r = results[0];
  const out = [];
  out.push(`input      ${r.input}`);
  out.push(`decimal    ${r.decimal}`);
  out.push(`result     ${r.result}   (--to ${r.target})`);
  out.push('');
  out.push(table([
    { base: '2', value: r.binary },
    { base: '8', value: r.octal },
    { base: '10', value: r.decimal },
    { base: '16', value: r.hex },
    { base: '36', value: r.toBase36 },
  ], ['base', 'value']));
  if (r.bits) {
    out.push('', 'BITS');
    out.push(table([{
      bitLength: r.bits.bitLength, bytes: r.bits.byteLength, popcount: r.bits.popcount,
      powerOfTwo: r.bits.isPowerOfTwo, log2: r.bits.log2Floor, trailingZeros: r.bits.trailingZeros ?? '',
    }]));
    out.push(`  ${r.bits.binary}`);
    out.push(`  ${r.bits.hexBytes}`);
  }
  if (r.all) {
    out.push('', 'ALL BASES');
    out.push(table(Object.entries(r.all).map(([k, v]) => ({ format: k, value: String(v) })), ['format', 'value']));
  }
  process.stdout.write(out.join('\n') + '\n');
} else {
  const out = results.map((r) => (r.error ? `${r.input}  ERROR: ${r.error}` : `${r.input.padEnd(24)} ${r.result}`));
  process.stdout.write(out.join('\n') + '\n');
  if (results.some((r) => r.error)) process.exit(2);
}
