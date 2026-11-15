// numberfmt.js — number formatting: separators, SI/IEC bytes, sig figs, engineering notation.
// Copyright (c) 2026 0xnothings
// @tool numberfmt
// @desc Format numbers as grouped, SI/IEC byte, significant-figure, scientific or engineering notation
// @usage node tools/numberfmt.js 1234567.891 --mode bytes --json
// @tags data,numbers,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `numberfmt — number formatter

  node tools/numberfmt.js <value|--> [options]

  --mode <m>         plain (default) | bytes | bytes-iec | sci | eng | percent | compact
  --group <s>        thousands separator (default ","), use "" to disable
  --decimal <s>      decimal mark (default ".")
  --precision <n>    decimals for plain/bytes (default 2), sig figs for --sig
  --sig              treat --precision as significant figures instead of decimals
  --min-int <n>      minimum integer digits (zero padding)
  --pad <n>          pad the whole formatted string to this width (right-aligned)
  --locale <name>    presets: en-US, de-DE, fr-FR, id-ID, hi-IN, ch-IN, sv-SE
  --table            format every number found on stdin/a file, as a table
  --json             machine-readable output
  -h, --help         this text

  Bytes modes use 1000-based (--mode bytes) or 1024-based (--mode bytes-iec)
  divisors and label them kB/MB/GB or KiB/MiB/GiB. sci/eng never round the
  mantissa past the requested significant figures. --locale hi-IN/ch-IN applies
  the Indian 2-2-3 grouping (12,34,56,789).`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'sig']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const LOCALES = {
  'en-us': { group: ',', decimal: '.' },
  'de-de': { group: '.', decimal: ',' },
  'fr-fr': { group: ' ', decimal: ',' },
  'sv-se': { group: ' ', decimal: ',' },
  'id-id': { group: '.', decimal: ',' },
  'it-it': { group: '.', decimal: ',' },
  'es-es': { group: '.', decimal: ',' },
  'hi-in': { group: ',', decimal: '.', indian: true },
  'ch-in': { group: ',', decimal: '.', indian: true },
  'eu': { group: ' ', decimal: ',' },
};
const localeName = get(o, 'locale', null) ? String(get(o, 'locale')).toLowerCase() : null;
const loc = localeName ? LOCALES[localeName] : null;
if (localeName && !loc) die(`unknown --locale "${localeName}" — try ${Object.keys(LOCALES).join(', ')}`);

const groupSep = get(o, 'group', null) !== null ? String(get(o, 'group')) : loc ? loc.group : ',';
const decimalSep = get(o, 'decimal', null) !== null ? String(get(o, 'decimal')) : loc ? loc.decimal : '.';
const indian = loc ? !!loc.indian : false;
const precision = num(get(o, 'precision', 2), 2);
const useSig = flag(o, 'sig');
const minInt = num(get(o, 'min-int', 1), 1);
const padWidth = num(get(o, 'pad', 0), 0);
const mode = String(get(o, 'mode', 'plain')).toLowerCase();
if (!['plain', 'bytes', 'bytes-iec', 'sci', 'eng', 'percent', 'compact'].includes(mode)) die(`unknown --mode "${mode}"`);

function groupInteger(digits, sep, indianStyle) {
  if (!sep) return digits;
  if (indianStyle) {
    if (digits.length <= 3) return digits;
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    return rest.replace(/\B(?=(\d\d)+(?!\d))/g, sep) + sep + last3;
  }
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function baseFormat(abs, decimals) {
  const fixed = abs.toFixed(decimals);
  const [ip, fpRaw] = fixed.split('.');
  const ipOut = groupInteger(ip.padStart(minInt, '0'), groupSep, indian);
  const fp = fpRaw === undefined ? '' : fpRaw;
  return fp ? ipOut + decimalSep + fp : ipOut;
}

const SI_STEPS = [[1e24, 'Y'], [1e21, 'Z'], [1e18, 'E'], [1e15, 'P'], [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, '']];
const IEC_STEPS = [[1024 ** 6, 'Ei'], [1024 ** 5, 'Pi'], [1024 ** 4, 'Ti'], [1024 ** 3, 'Gi'], [1024 ** 2, 'Mi'], [1024, 'Ki'], [1, '']];
const COMPACT = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'], [1, '']];

function bytesFormat(abs, iec) {
  const steps = iec ? IEC_STEPS : SI_STEPS;
  for (const [factor, suffix] of steps) {
    if (abs >= factor || factor === 1) {
      const v = abs / factor;
      const dec = v >= 100 ? 0 : v >= 10 ? 1 : precision;
      const out = baseFormat(v, dec);
      return `${out} ${suffix}${iec ? 'B' : 'B'}`;
    }
  }
  return `${baseFormat(abs, 0)} B`;
}

function sciFormat(abs, engMode) {
  if (abs === 0) return `0${engMode ? 'e+00' : 'e+00'}`;
  let exp = Math.floor(Math.log10(abs));
  let mantissa = abs / 10 ** exp;
  if (useSig) {
    mantissa = Number(mantissa.toPrecision(precision));
    if (mantissa >= 10) { mantissa /= 10; exp += 1; }
  } else {
    mantissa = Number(mantissa.toFixed(precision));
    if (mantissa >= 10) { mantissa /= 10; exp += 1; }
  }
  if (engMode) {
    const engExp = Math.floor(exp / 3) * 3;
    const shift = exp - engExp;
    const m = Number((mantissa * 10 ** shift).toFixed(precision));
    const sign = engExp >= 0 ? '+' : '-';
    return `${baseFormat(m, precision)}e${sign}${String(Math.abs(engExp)).padStart(2, '0')}`;
  }
  const sign = exp >= 0 ? '+' : '-';
  return `${baseFormat(mantissa, precision)}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`;
}

function compactFormat(abs) {
  for (const [factor, suffix] of COMPACT) {
    if (abs >= factor || factor === 1) {
      const v = abs / factor;
      const dec = v >= 100 ? 0 : v >= 10 ? 1 : precision;
      return baseFormat(v, dec) + suffix;
    }
  }
  return baseFormat(abs, 0);
}

function formatNumber(v) {
  const neg = v < 0 || Object.is(v, -0);
  const abs = Math.abs(v);
  let body;
  if (mode === 'bytes') body = bytesFormat(abs, false);
  else if (mode === 'bytes-iec') body = bytesFormat(abs, true);
  else if (mode === 'sci') body = sciFormat(abs, false);
  else if (mode === 'eng') body = sciFormat(abs, true);
  else if (mode === 'percent') body = baseFormat(abs, precision) + '%';
  else if (mode === 'compact') body = compactFormat(abs);
  else if (useSig) {
    const s = Number(abs.toPrecision(Math.max(1, precision)));
    body = baseFormat(s, Math.max(0, precision - String(Math.trunc(s)).length));
  } else body = baseFormat(abs, precision);
  const out = (neg ? '-' : '') + body;
  return padWidth > out.length ? ' '.repeat(padWidth - out.length) + out : out;
}

let inputs = [];
const tableArg = get(o, 'table', null);
const tableOn = flag(o, 'table') || typeof tableArg === 'string';
const src = tableOn ? (typeof tableArg === 'string' ? tableArg : o._[0]) : o._[0];
if (tableOn || (src && !Number.isFinite(Number(src)) && src !== '-')) {
  const path = src === '-' ? null : src;
  const text = path ? readFileSync(path, 'utf8') : await readInput(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const found = line.match(/-?\d[\d,_ ]*(?:\.\d+)?(?:[eE][-+]?\d+)?/g) || [];
    for (const f of found) {
      const cleaned = f.replace(/[,_ ]/g, '');
      const v = Number(cleaned);
      if (Number.isFinite(v) && cleaned !== '') inputs.push(v);
    }
  }
} else {
  const v = num(src, NaN);
  if (!Number.isFinite(v)) die(`first argument must be a number, got "${src ?? ''}"`);
  inputs.push(v);
}
if (!inputs.length) die('no numbers to format');

const rows = inputs.map((v) => ({
  raw: v,
  formatted: formatNumber(v),
  locale: Number(v).toLocaleString(localeName || 'en-US', { maximumFractionDigits: precision }),
  plain: groupInteger(Math.abs(Math.trunc(v)).toString(), ',', false) + (Number.isInteger(v) ? '' : '.' + String(Math.abs(v)).split('.')[1]),
  sci: sciFormat(Math.abs(v), false),
  eng: sciFormat(Math.abs(v), true),
  bytes_si: bytesFormat(Math.abs(v), false),
  bytes_iec: bytesFormat(Math.abs(v), true),
  hex: Number.isFinite(v) ? '0x' + Math.trunc(Math.abs(v)).toString(16) + (v < 0 ? ' (neg)' : '') : '-',
}));

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify(rows.length === 1 ? { ...rows[0], mode, precision, significantFigures: useSig, groupSeparator: groupSep, decimalSeparator: decimalSep, locale: localeName } : { count: rows.length, mode, rows }, null, 2) + '\n');
} else if (rows.length === 1) {
  const r = rows[0];
  console.log(table([
    { field: 'input', value: String(r.raw) },
    { field: 'formatted', value: r.formatted },
    { field: 'locale', value: r.locale },
    { field: 'scientific', value: r.sci },
    { field: 'engineering', value: r.eng },
    { field: 'bytes (SI)', value: r.bytes_si },
    { field: 'bytes (IEC)', value: r.bytes_iec },
    { field: 'hex', value: r.hex },
  ], ['field', 'value']));
} else {
  console.log(`${rows.length} number(s) formatted (mode ${mode}, precision ${precision}${useSig ? ' sig-figs' : ''})`);
  console.log(table(rows.map((r) => ({ input: String(r.raw), formatted: r.formatted, bytes_si: r.bytes_si, bytes_iec: r.bytes_iec, eng: r.eng })), ['input', 'formatted', 'bytes_si', 'bytes_iec', 'eng']));
}
