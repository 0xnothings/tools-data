// unittbl.js — convert and tabulate byte sizes, durations and numeric units.
// Copyright (c) 2026 0xnothings
// @tool unittbl
// @desc Convert between byte units, time durations, rates and number scales in a table
// @usage node tools/unittbl.js 1500mb --to gb --scale --json
// @tags units,convert,cli
import { args, get, num, flag, die, table } from '../_lib.js';

const HELP = `unittbl — unit conversion and scale tables

  node tools/unittbl.js <value> [unit] [options]

  --to <unit>        convert to one unit (prints the single result)
  --kind <type>      bytes (default) | time | rate | number | temp
  --scale            print the full scale ladder (bytes/time/number)
  --from <unit>      explicit source unit when the value has no suffix
  --decimal          use decimal (SI) byte units, 1000-based, instead of 1024
  --bits             for bytes: report the value in bits as well
  --rate <per>       for --kind rate: append /s, /m, /h, /d to the output
  --frames <fps>     for --kind time: also show frames at this fps
  --json             machine-readable output
  -h, --help         this text

  Values may carry their unit: "1.5gb", "90min", "2.5h", "10 Kbps". Recognised byte
  units are b, kb, mb, gb, tb, pb (KiB/MiB... are always 1024-based), time units are
  ns, us, ms, s, min, h, d, w, and number units are k, m, b, t (long scale) plus sci.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const rawValue = o._[0];
if (rawValue === undefined) die('need a value — try: node tools/unittbl.js 1.5gb --scale');

const kind = String(get(o, 'kind', 'bytes')).toLowerCase();
const decimal = flag(o, 'decimal');

const BYTE_UNITS = decimal
  ? { b: 1, byte: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, t: 1e12, tb: 1e12, p: 1e15, pb: 1e15 }
  : { b: 1, byte: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4, p: 1024 ** 5, pb: 1024 ** 5 };

// Explicit KiB-family suffixes are always binary, even in --decimal mode.
const BINARY_ONLY = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5, kibibyte: 1024, byte: 1 };

const TIME_UNITS = {
  ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
  mo: 2629800000, month: 2629800000, y: 31557600000, yr: 31557600000, year: 31557600000,
};

const NUM_SCALES = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, t: 1e12, trillion: 1e12, q: 1e15, quadrillion: 1e15 };

const TEMP_UNITS = { c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };

function splitValue(input, units) {
  const s = String(input).trim();
  const m = s.match(/^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([a-zA-Zµ]*)$/);
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  return { n: Number(m[1]), unit };
}

function fmtUnit(n, unit) {
  return `${Number(n.toFixed(6))} ${unit}`;
}

if (kind === 'bytes') {
  const parsed = splitValue(rawValue, BYTE_UNITS);
  if (!parsed) die(`cannot parse value: ${rawValue}`);
  const explicit = get(o, 'from', null);
  const unit = explicit ? String(explicit).toLowerCase() : parsed.unit || 'b';
  const factor = BINARY_ONLY[unit] !== undefined ? BINARY_ONLY[unit] : BYTE_UNITS[unit];
  if (factor === undefined) die(`unknown byte unit '${unit}' — try b, kb, mb, gb, tb, pb, kib, mib, gib`);
  const bytes = parsed.n * factor;

  const units = decimal
    ? [['B', 1], ['KB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12], ['PB', 1e15]]
    : [['B', 1], ['KiB', 1024], ['MiB', 1024 ** 2], ['GiB', 1024 ** 3], ['TiB', 1024 ** 4], ['PiB', 1024 ** 5]];

  const to = get(o, 'to', null);
  if (to) {
    const key = String(to).toLowerCase().replace(/^ki?b$/, 'kib');
    const f = BINARY_ONLY[key] !== undefined && (BYTE_UNITS[key] === undefined || BINARY_ONLY[key] !== BYTE_UNITS[key])
      ? BINARY_ONLY[key]
      : BYTE_UNITS[key];
    if (f === undefined) die(`unknown target unit '${to}'`);
    const v = bytes / f;
    if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, unit, bytes, to: String(to), value: Number(v.toFixed(10)), human: fmtUnit(v, to) }, null, 2) + '\n');
    else process.stdout.write(fmtUnit(v, to) + '\n');
    process.exit(0);
  }

  const rows = units.map(([label, size]) => ({
    unit: label, value: Number((bytes / size).toFixed(6)),
    exact: label === 'B' ? String(bytes) : undefined,
  }));

  if (flag(o, 'json')) {
    process.stdout.write(JSON.stringify({
      input: rawValue, kind, sourceUnit: unit, bytes,
      bits: flag(o, 'bits') ? bytes * 8 : undefined,
      base: decimal ? 1000 : 1024,
      conversions: rows,
    }, null, 2) + '\n');
    process.exit(0);
  }

  const out = [];
  out.push(`input      ${rawValue}  (${unit} -> ${Number(bytes).toLocaleString('en-US')} bytes, base ${decimal ? 1000 : 1024})`);
  if (flag(o, 'bits')) out.push(`bits       ${(bytes * 8).toLocaleString('en-US')} b  (${(bytes * 8 / 1e6).toFixed(3)} Mbit)`);
  out.push('');
  out.push(table(rows.filter((r) => r.value >= 1e-6 || r.unit === 'B'), ['unit', 'value']));
  if (flag(o, 'scale')) {
    out.push('', 'LADDER');
    for (const [label, size] of units) out.push(`  1 ${label.padEnd(4)} = ${size.toLocaleString('en-US')} bytes  = ${(size / units[units.length - 1][1]).toExponential(3)} PiB`);
  }
  process.stdout.write(out.join('\n') + '\n');
} else if (kind === 'time') {
  const parsed = splitValue(rawValue, TIME_UNITS);
  if (!parsed) die(`cannot parse value: ${rawValue}`);
  const explicit = get(o, 'from', null);
  const unit = (explicit ? String(explicit) : parsed.unit || 's').toLowerCase();
  const factor = TIME_UNITS[unit];
  if (factor === undefined) die(`unknown time unit '${unit}' — try ns, us, ms, s, min, h, d, w, mo, y`);
  const ms = parsed.n * factor;

  const ladder = [['ms', 1], ['s', 1000], ['min', 60000], ['h', 3600000], ['d', 86400000], ['w', 604800000], ['mo', 2629800000], ['y', 31557600000]];
  const to = get(o, 'to', null);
  if (to) {
    const f = TIME_UNITS[String(to).toLowerCase()];
    if (f === undefined) die(`unknown target unit '${to}'`);
    const v = ms / f;
    if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, unit, ms, to: String(to), value: Number(v.toFixed(10)) }, null, 2) + '\n');
    else process.stdout.write(fmtUnit(v, to) + '\n');
    process.exit(0);
  }

  const breakdown = () => {
    let rem = Math.abs(ms);
    const parts = [];
    for (const [label, size] of [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000], ['ms', 1]]) {
      if (rem >= size) { const n = Math.floor(rem / size); parts.push(`${n}${label}`); rem -= n * size; }
    }
    return (ms < 0 ? '-' : '') + (parts.join(' ') || '0ms');
  };

  const fps = get(o, 'frames', null);
  const rate = get(o, 'rate', null);
  const rows = ladder.map(([label, size]) => ({ unit: label, value: Number((ms / size).toFixed(6)) }));

  if (flag(o, 'json')) {
    process.stdout.write(JSON.stringify({
      input: rawValue, kind, sourceUnit: unit, milliseconds: ms,
      human: breakdown(),
      frames: fps ? { fps: Number(fps), count: Number(((ms / 1000) * Number(fps)).toFixed(3)) } : undefined,
      per: rate ? { period: String(rate), value: Number((1000 / TIME_UNITS[String(rate).toLowerCase().replace(/^per/, '')] * 1000).toFixed(6)) } : undefined,
      conversions: rows,
    }, null, 2) + '\n');
    process.exit(0);
  }

  const out = [];
  out.push(`input      ${rawValue}  (${unit} -> ${ms.toLocaleString('en-US')} ms)`);
  out.push(`human      ${breakdown()}`);
  if (fps) out.push(`frames     ${((ms / 1000) * Number(fps)).toFixed(2)} frames at ${fps} fps`);
  out.push('');
  out.push(table(rows, ['unit', 'value']));
  process.stdout.write(out.join('\n') + '\n');
} else if (kind === 'number') {
  const parsed = splitValue(rawValue, NUM_SCALES);
  if (!parsed) die(`cannot parse value: ${rawValue}`);
  const explicit = get(o, 'from', null);
  const unit = (explicit ? String(explicit) : parsed.unit || '').toLowerCase();
  const factor = unit ? NUM_SCALES[unit] : 1;
  if (factor === undefined) die(`unknown number unit '${unit}' — try k, m, b, t, q`);
  const value = parsed.n * factor;

  const scales = [['raw', 1], ['K', 1e3], ['M', 1e6], ['B', 1e9], ['T', 1e12], ['Q', 1e15]];
  const to = get(o, 'to', null);
  if (to) {
    const f = NUM_SCALES[String(to).toLowerCase()] ?? (Number.isFinite(Number(to)) ? Number(to) : undefined);
    if (f === undefined) die(`unknown target: ${to}`);
    if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, value, to: String(to), result: value / f }, null, 2) + '\n');
    else process.stdout.write(String(value / f) + '\n');
    process.exit(0);
  }
  const rows = scales.map(([label, size]) => ({ scale: label, value: value / size }));
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, value, units: unit || 'raw', scales: rows }, null, 2) + '\n');
  else {
    const out = [`input      ${rawValue}  (${unit || 'raw'} -> ${value.toLocaleString('en-US')})`, ''];
    out.push(table(rows.map((r) => ({ scale: r.scale, value: Number(r.value.toPrecision(10)) })), ['scale', 'value']));
    process.stdout.write(out.join('\n') + '\n');
  }
} else if (kind === 'rate') {
  const m = String(rawValue).match(/(\d+(?:\.\d+)?)/);
  if (!m) die(`cannot parse a number from: ${rawValue}`);
  const n = Number(m[1]);
  const suffix = String(get(o, 'per', 's')).toLowerCase().replace(/^per/, '') || 's';
  const periods = [['s', 1], ['m', 60], ['h', 3600], ['d', 86400], ['w', 604800]];
  const endUnit = get(o, 'to', null);
  if (endUnit) {
    const unit = String(endUnit).toLowerCase();
    if (BYTE_UNITS[unit] !== undefined) {
      const per = TIME_UNITS[suffix];
      if (per === undefined) die(`unknown rate period '${suffix}'`);
      const perSec = n / (per / 1000);
      const bytesPerSec = perSec * BYTE_UNITS[unit] * 8;
      if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, unit: endUnit, perSecond: bytesPerSec, human: fmtUnit(bytesPerSec / BYTE_UNITS[unit], endUnit) + '/s' }, null, 2) + '\n');
      else process.stdout.write(fmtUnit(bytesPerSec / BYTE_UNITS[unit], endUnit) + '/s\n');
      process.exit(0);
    }
    die(`--to for rate needs a byte unit (kb, mb, gb)`);
  }
  const rows = periods.map(([p, secs]) => ({ per: '/' + p, value: Number((n / (TIME_UNITS[suffix] / 1000) * secs).toFixed(6)) }));
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, baseUnit: suffix, rates: rows }, null, 2) + '\n');
  else {
    const out = [`input      ${n} per ${suffix}`, ''];
    out.push(table(rows, ['per', 'value']));
    process.stdout.write(out.join('\n') + '\n');
  }
} else if (kind === 'temp') {
  const parsed = splitValue(rawValue, TEMP_UNITS);
  if (!parsed) die(`cannot parse value: ${rawValue}`);
  const unit = (String(get(o, 'from', parsed.unit || 'c'))).toLowerCase();
  const u = TEMP_UNITS[unit];
  if (!u) die(`unknown temperature unit '${unit}' — c, f or k`);
  const v = parsed.n;
  const c = u === 'c' ? v : u === 'f' ? (v - 32) * 5 / 9 : v - 273.15;
  const f = c * 9 / 5 + 32;
  const k = c + 273.15;
  const to = get(o, 'to', null);
  if (to) {
    const t = TEMP_UNITS[String(to).toLowerCase()];
    if (!t) die(`unknown target unit '${to}'`);
    const out2 = t === 'c' ? c : t === 'f' ? f : k;
    if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, from: u, to: t, value: Number(out2.toFixed(6)) }, null, 2) + '\n');
    else process.stdout.write(`${Number(out2.toFixed(4))} ${to}\n`);
    process.exit(0);
  }
  const rows = [
    { unit: 'C', value: Number(c.toFixed(4)) },
    { unit: 'F', value: Number(f.toFixed(4)) },
    { unit: 'K', value: Number(k.toFixed(4)) },
  ];
  if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: rawValue, kind, celsius: c, fahrenheit: f, kelvin: k }, null, 2) + '\n');
  else process.stdout.write(table(rows, ['unit', 'value']) + '\n');
} else {
  die(`--kind must be bytes | time | number | rate | temp (got ${kind})`);
}
