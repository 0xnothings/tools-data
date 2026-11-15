#!/usr/bin/env node
// datecalc.js — date arithmetic CLI: add/subtract, diff, workdays, ISO week.
// Copyright (c) 2026 0xnothings
// @tool datecalc
// @desc Date arithmetic: shift dates, diff two dates, business-day math, ISO week
// @usage node tools/datecalc.js 2026-03-01 --add 45d --workdays
// @tags time,date,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `datecalc — date arithmetic

  node tools/datecalc.js <date> [options]            (single-date mode)
  node tools/datecalc.js <dateA> <dateB> [options]   (diff mode)

  --add <dur>        add a duration: 3d, 2w, 6h, 90m, 1y2mo3d, or a bare number of days
  --sub <dur>        subtract a duration
  --workdays         with --add/--sub: move in business days; with two dates: count them
  --business         force the business-day report in diff mode
  --holidays <file>  newline-separated ISO dates to treat as non-business days
  --weekend <spec>   weekend days, 0=Sun..6=Sat (default 0,6)
  --format <fmt>     iso (default) | epoch | epochms | date | long | rfc | compact | custom
  --template <str>   with --format custom: YYYY MM MMM DD ddd HH mm ss
  --tz <offset>      render in a UTC offset: +07:00, -05:00 or Z (default: local)
  --each <dur>       with two dates, list every step between them
  --json             machine-readable output
  -h, --help         this text

  Accepts ISO-8601, "YYYY-MM-DD", "DD/MM/YYYY", epoch seconds, epoch milliseconds,
  "now" and "today". Durations: y years, mo months, w weeks, d days, h hours,
  m minutes, s seconds, ms milliseconds. Months are calendar months, clamped to
  the last valid day (2026-01-31 + 1mo = 2026-02-28).`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const ISO_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ISO_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

function parseTz(spec) {
  if (!spec) return { offsetMinutes: -new Date().getTimezoneOffset(), label: 'local' };
  const s = String(spec).trim();
  if (/^(z|utc)$/i.test(s)) return { offsetMinutes: 0, label: 'Z' };
  const m = s.match(/^([+-])(\d{1,2}):?(\d{2})$/);
  if (!m) die(`bad --tz value: ${spec} (try +07:00, -05:00, Z)`);
  const sign = m[1] === '-' ? -1 : 1;
  return { offsetMinutes: sign * (Number(m[2]) * 60 + Number(m[3])), label: m[1] + pad(m[2]) + ':' + m[3] };
}

const tz = parseTz(get(o, 'tz', null));
const fmt = String(get(o, 'format', 'iso'));
const template = get(o, 'template', null);

function parseDate(input) {
  const s = String(input).trim();
  if (/^-?\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^-?\d{13}$/.test(s)) return new Date(Number(s));
  if (/^now$/i.test(s)) return new Date();
  if (/^today$/i.test(s)) {
    const n = new Date(Date.now() + tz.offsetMinutes * 60000);
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - tz.offsetMinutes * 60000);
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    const [, y, mo, d, hh, mi, ss, ms, zone] = iso;
    const off = zone ? parseTz(zone).offsetMinutes : tz.offsetMinutes;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh || 0), Number(mi || 0), Number(ss || 0), Number((ms || '0').padEnd(3, '0')));
    return new Date(utc - off * 60000);
  }
  const dmy = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (dmy) return new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  die(`cannot parse date: ${input}`);
}

function parseDuration(str) {
  const s = String(str).trim();
  const out = { y: 0, mo: 0, w: 0, d: 0, h: 0, m: 0, s: 0, ms: 0 };
  const re = /(\d+(?:\.\d+)?)\s*(ms|mo|y|w|d|h|m|s)\b/gi;
  let m, matched = 0;
  while ((m = re.exec(s))) { out[m[2].toLowerCase()] += parseFloat(m[1]); matched++; }
  if (!matched) {
    const compact = s.match(/^([+-]?)((?:\d+(?:ms|mo|[ywdhsm]))+)$/i);
    if (compact) {
      const parts = compact[2].match(/\d+(?:ms|mo|[ywdhsm])/gi) || [];
      for (const p of parts) {
        const mm = p.match(/(\d+)(ms|mo|[ywdhsm])/i);
        out[mm[2].toLowerCase()] += Number(mm[1]);
      }
      matched = parts.length;
    } else if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
      out.d = Math.abs(parseFloat(s));
      matched = 1;
    }
  }
  if (!matched) return null;
  if (s.startsWith('-')) for (const k of Object.keys(out)) out[k] = -out[k];
  return out;
}

function shift(date, dur, sign) {
  // Calendar arithmetic must happen in the display timezone, otherwise a local
  // midnight on the 1st of a month lands on the previous UTC day and month
  // clamping produces the wrong result.
  const l = new Date(date.getTime() + tz.offsetMinutes * 60000);
  const y = l.getUTCFullYear(), mo = l.getUTCMonth(), d = l.getUTCDate();
  if (dur.y || dur.mo) {
    const targetMonth = mo + dur.mo * sign;
    const targetYear = y + dur.y * sign;
    const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const clamped = Math.min(d, last);
    const base = Date.UTC(targetYear, targetMonth, clamped, l.getUTCHours(), l.getUTCMinutes(), l.getUTCSeconds(), l.getUTCMilliseconds());
    const ms2 = (dur.w * 7 + dur.d) * 86400000 + dur.h * 3600000 + dur.m * 60000 + dur.s * 1000 + dur.ms;
    return new Date(base - tz.offsetMinutes * 60000 + ms2 * sign);
  }
  const ms = (dur.w * 7 + dur.d) * 86400000 + dur.h * 3600000 + dur.m * 60000 + dur.s * 1000 + dur.ms;
  return new Date(date.getTime() + ms * sign);
}

const localOf = (d) => new Date(d.getTime() + tz.offsetMinutes * 60000);

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = d.getTime();
  d.setUTCMonth(0, 1);
  if (d.getUTCDay() !== 4) d.setUTCMonth(0, 1 + ((4 - d.getUTCDay()) + 7) % 7);
  return 1 + Math.round((firstThursday - d.getTime()) / 604800000);
}

const dayOfYear = (date) => Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);

function format(date, which, tpl) {
  const l = localOf(date);
  const suffix = tz.label === 'local' ? '' : tz.label === 'Z' ? 'Z' : tz.label;
  switch (which) {
    case 'epoch': return String(Math.floor(date.getTime() / 1000));
    case 'epochms': return String(date.getTime());
    case 'date': return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`;
    case 'compact': return `${l.getUTCFullYear()}${pad(l.getUTCMonth() + 1)}${pad(l.getUTCDate())}T${pad(l.getUTCHours())}${pad(l.getUTCMinutes())}${pad(l.getUTCSeconds())}${suffix}`;
    case 'long': return `${ISO_DAY[l.getUTCDay()]}, ${pad(l.getUTCDate())} ${ISO_MON[l.getUTCMonth()]} ${l.getUTCFullYear()} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}`;
    case 'rfc': return l.toUTCString();
    case 'custom': {
      const t = tpl || 'YYYY-MM-DD HH:mm:ss';
      return t.replace(/YYYY/g, String(l.getUTCFullYear())).replace(/MMM/g, ISO_MON[l.getUTCMonth()])
        .replace(/MM/g, pad(l.getUTCMonth() + 1)).replace(/DD/g, pad(l.getUTCDate()))
        .replace(/ddd/g, ISO_DAY[l.getUTCDay()]).replace(/HH/g, pad(l.getUTCHours()))
        .replace(/mm/g, pad(l.getUTCMinutes())).replace(/ss/g, pad(l.getUTCSeconds()));
    }
    default: {
      const base = `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}T${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}`;
      if (suffix) return base + suffix;
      const off = tz.offsetMinutes;
      return `${base}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
    }
  }
}

const weekend = (() => {
  const w = get(o, 'weekend', null);
  if (!w) return new Set([0, 6]);
  const s = new Set(String(w).split(',').map((x) => Number(x.trim())).filter(Number.isFinite));
  if (!s.size) die(`--weekend must be a comma list of 0..6 (got ${w})`);
  return s;
})();

let holidays = new Set();
if (get(o, 'holidays', null)) {
  try {
    holidays = new Set(readFileSync(String(get(o, 'holidays')), 'utf8').split(/\r?\n/).map((s) => s.trim().slice(0, 10)).filter(Boolean));
  } catch (e) { die(`cannot read holidays file: ${e.message}`); }
}

const keyOf = (d) => { const l = localOf(d); return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`; };
const isBusiness = (d) => !weekend.has(localOf(d).getUTCDay()) && !holidays.has(keyOf(d));

function calendarUnits(a, b) {
  const sign = b >= a ? 1 : -1;
  const start = b >= a ? a : b, end = b >= a ? b : a;
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  let months = end.getUTCMonth() - start.getUTCMonth();
  let days = end.getUTCDate() - start.getUTCDate();
  let hours = end.getUTCHours() - start.getUTCHours();
  let minutes = end.getUTCMinutes() - start.getUTCMinutes();
  let seconds = end.getUTCSeconds() - start.getUTCSeconds();
  if (seconds < 0) { seconds += 60; minutes--; }
  if (minutes < 0) { minutes += 60; hours--; }
  if (hours < 0) { hours += 24; days--; }
  if (days < 0) { days += new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0)).getUTCDate(); months--; }
  if (months < 0) { months += 12; years--; }
  return { years: years * sign, months: months * sign, days: days * sign, hours: hours * sign, minutes: minutes * sign, seconds: seconds * sign };
}

function humanize(ms, negative) {
  let rem = ms;
  const parts = [];
  for (const [label, size] of [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]]) {
    if (rem >= size) { const n = Math.floor(rem / size); parts.push(`${n}${label}`); rem -= n * size; }
  }
  if (!parts.length) parts.push(`${rem}ms`);
  return (negative ? '-' : '') + parts.join(' ');
}

function diffReport(a, b) {
  const ms = b - a, abs = Math.abs(ms);
  return {
    ms, seconds: Math.round(ms / 1000), minutes: Number((ms / 60000).toFixed(3)),
    hours: Number((ms / 3600000).toFixed(3)), days: Number((ms / 86400000).toFixed(3)),
    weeks: Number((ms / 604800000).toFixed(3)), months: Number((ms / 2629800000).toFixed(3)),
    years: Number((ms / 31557600000).toFixed(3)),
    human: humanize(abs, ms < 0),
    calendar: calendarUnits(a, b),
  };
}

function businessReport(a, b) {
  const early = a <= b ? a : b, late = a <= b ? b : a;
  let business = 0, weekendDays = 0, holidayDays = 0, total = 0;
  const cursor = new Date(Date.UTC(localOf(early).getUTCFullYear(), localOf(early).getUTCMonth(), localOf(early).getUTCDate()));
  const end = Date.UTC(localOf(late).getUTCFullYear(), localOf(late).getUTCMonth(), localOf(late).getUTCDate());
  while (cursor.getTime() <= end) {
    total++;
    if (weekend.has(cursor.getUTCDay())) weekendDays++;
    else if (holidays.has(keyOf(cursor))) holidayDays++;
    else business++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { calendarDays: total, businessDays: business, weekendDays, holidayDays, holidaysDeclared: holidays.size, weekendSpec: [...weekend].join(',') };
}

const list = o._.slice();
if (!list.length) die('need at least one date — try: node tools/datecalc.js today --add 30d');

const dateA = parseDate(list[0]);
const dateB = list[1] ? parseDate(list[1]) : null;

/* ---- compute the shifted date for single-date mode ---- */
let work = null, workDaysMoved = 0;
if (!dateB) {
  work = new Date(dateA.getTime());
  const addD = get(o, 'add', null), subD = get(o, 'sub', null);
  for (const [raw, sign] of [[addD, 1], [subD, -1]]) {
    if (raw === null) continue;
    const dur = parseDuration(raw);
    if (!dur) die(`bad duration: ${raw}`);
    const businessDays = Math.round(Math.abs(dur.d) + Math.abs(dur.w) * 7) * sign;
    const wantBusiness = flag(o, 'workdays');
    if (wantBusiness && businessDays !== 0) {
      let remaining = Math.abs(businessDays);
      const step = businessDays >= 0 ? 1 : -1;
      while (remaining > 0) {
        work.setUTCDate(work.getUTCDate() + step);
        workDaysMoved++;
        if (isBusiness(work)) remaining--;
      }
      const rest = { ...dur, d: 0, w: 0 };
      if (rest.h || rest.m || rest.s || rest.ms || rest.y || rest.mo) work = shift(work, rest, sign);
    } else {
      work = shift(work, dur, sign);
    }
  }
}

const each = get(o, 'each', null);
const steps = [];
if (dateB && each) {
  const dur = parseDuration(each);
  if (!dur) die(`bad --each duration: ${each}`);
  const dir = dateB >= dateA ? 1 : -1;
  let cur = new Date(dateA.getTime());
  let guard = 0;
  while ((dir > 0 ? cur <= dateB : cur >= dateB) && guard++ < 20000) {
    steps.push({ step: guard, value: format(cur, fmt, template), weekday: ISO_DAY[localOf(cur).getUTCDay()], business: isBusiness(cur) ? 'yes' : 'no' });
    cur = shift(cur, dur, dir);
  }
}

if (flag(o, 'json')) {
  const report = { input: list, timezone: tz.label, format: fmt };
  if (dateB) {
    report.a = { raw: list[0], iso: dateA.toISOString(), formatted: format(dateA, fmt, template) };
    report.b = { raw: list[1], iso: dateB.toISOString(), formatted: format(dateB, fmt, template) };
    report.diff = diffReport(dateA, dateB);
    if (flag(o, 'business') || flag(o, 'workdays')) report.business = businessReport(dateA, dateB);
    if (each) report.steps = steps;
  } else {
    const l = localOf(work);
    report.parsed = { raw: list[0], iso: dateA.toISOString(), formatted: format(dateA, fmt, template) };
    report.result = {
      iso: work.toISOString(),
      formatted: format(work, fmt, template),
      epoch: Math.floor(work.getTime() / 1000),
      weekday: ISO_DAY[l.getUTCDay()],
      isoWeek: isoWeek(l),
      dayOfYear: dayOfYear(l),
      quarter: Math.floor(l.getUTCMonth() / 3) + 1,
      isBusinessDay: isBusiness(work),
      calendarDaysMoved: workDaysMoved || undefined,
    };
    report.shift = diffReport(dateA, work);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

const out = [];
if (dateB) {
  const d = diffReport(dateA, dateB);
  out.push(`A  ${list[0]}  ->  ${format(dateA, 'long', template)}`);
  out.push(`B  ${list[1]}  ->  ${format(dateB, 'long', template)}`);
  out.push('');
  const cal = d.calendar;
  out.push(`difference     ${d.human} (${d.ms >= 0 ? 'B is after A' : 'B is before A'})`);
  out.push(`calendar       ${cal.years}y ${cal.months}mo ${cal.days}d ${cal.hours}h ${cal.minutes}m ${cal.seconds}s`);
  out.push('');
  out.push(table([{
    seconds: d.seconds, minutes: d.minutes, hours: d.hours, days: d.days,
    weeks: d.weeks, months: d.months, years: d.years, ms: d.ms,
  }], ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'ms']));
  if (flag(o, 'business') || flag(o, 'workdays')) {
    out.push('', 'BUSINESS DAYS');
    out.push(table([businessReport(dateA, dateB)]));
  }
  if (each) {
    out.push('', `EVERY ${String(each).toUpperCase()} — ${steps.length} step(s)`);
    out.push(table(steps.slice(0, 200), ['step', 'value', 'weekday', 'business']));
    if (steps.length > 200) out.push(`... ${steps.length - 200} more`);
  }
} else {
  const l = localOf(work);
  out.push(`parsed         ${list[0]}  ->  ${format(dateA, 'long', template)}`);
  out.push(`result         ${format(work, 'long', template)}`);
  out.push(`iso            ${work.toISOString()}`);
  out.push('');
  out.push(table([{
    weekday: ISO_DAY[l.getUTCDay()],
    isoWeek: `W${pad(isoWeek(l))}`,
    dayOfYear: dayOfYear(l),
    quarter: `Q${Math.floor(l.getUTCMonth() / 3) + 1}`,
    epoch: Math.floor(work.getTime() / 1000),
    business: isBusiness(work) ? 'yes' : 'no',
  }], ['weekday', 'isoWeek', 'dayOfYear', 'quarter', 'epoch', 'business']));
  const shiftInfo = diffReport(dateA, work);
  out.push('', `shifted by     ${shiftInfo.human} (${workDaysMoved ? `${workDaysMoved} calendar day(s) walked for ${Math.round(Math.abs((parseDuration(get(o, 'add', null)) || parseDuration(get(o, 'sub', null)) || { d: 0 }).d))} business day(s)` : 'exact duration arithmetic'})`);
}
out.push('', `timezone ${tz.label}${holidays.size ? `, ${holidays.size} holiday(s) loaded` : ''}, weekend days {${[...weekend].join(',')}}`);
process.stdout.write(out.join('\n') + '\n');
void num;
