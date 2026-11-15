#!/usr/bin/env node
// graphtext.js — ASCII charts from numeric series: sparkline, bar, histogram, boxplot.
// Copyright (c) 2026 0xnothings
// @tool graphtext
// @desc Render sparklines, bars, histograms, scatter and boxplots from numeric series with no dependencies
// @usage node tools/graphtext.js series.txt --chart bar --json
// @tags data,charts,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `graphtext — ASCII / Unicode charts

  node tools/graphtext.js <series.txt|csv|-> [options]

  --chart <kind>    spark (default) | bar | hist | hbar | box | scatter | heat
  --col <n>         which column to read in CSV-ish input (default: last numeric column)
  --width <n>       chart width in columns (default 72)
  --height <n>      chart height in rows (default 16, used by hist/scatter/heat)
  --bins <n>        histogram bin count (default 12)
  --precision <n>   decimals in labels (default 3)
  --label           label min/max/mean on the chart
  --charset <set>   blocks (default) | ascii | dots
  --no-axis         omit the axis labels on bar charts
  --json            machine-readable output
  -h, --help        this text

  Input: one number per line, comma/tab/space separated rows, a JSON array, or
  a JSON array of objects (use --col). Charts are pure text — no colour codes —
  so they survive copy-paste into tickets, commit messages and READMEs.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'no-axis']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need data — node tools/graphtext.js series.txt --chart bar');
let text;
try { text = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }

const CHARSETS = {
  blocks: { spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'], bar: '█', partial: '▏▎▍▌▋▊▉', box: '─│┌┐└┘├┤┬┴┼', dot: '•' },
  ascii: { spark: ['_', '.', ':', '-', '=', '+', '*', '#'], bar: '#', partial: '', box: '-|+++++++++', dot: '*' },
  dots: { spark: ['.', ':', '-', '=', '+', '*', '@', '#'], bar: '●', partial: '', box: '-|+++++++++', dot: '·' },
};
const cs = CHARSETS[String(get(o, 'charset', 'blocks')).toLowerCase()] || CHARSETS.blocks;

const width = Math.max(10, num(get(o, 'width', 72), 72));
const height = Math.max(3, num(get(o, 'height', 16), 16));
const bins = Math.max(2, num(get(o, 'bins', 12), 12));
const precision = Math.max(0, num(get(o, 'precision', 3), 3));
const chart = String(get(o, 'chart', 'spark')).toLowerCase();
if (!['spark', 'bar', 'hist', 'hbar', 'box', 'scatter', 'heat'].includes(chart)) die(`unknown --chart "${chart}"`);

let values = [];
let labels = null;
if (/^\s*\[/.test(text)) {
  const data = JSON.parse(text);
  const colArg = get(o, 'col', null);
  if (Array.isArray(data) && data.length && typeof data[0] === 'object' && data[0] !== null) {
    const keys = Object.keys(data[0]);
    const numericKeys = keys.filter((k) => data.some((r) => typeof r[k] === 'number'));
    const key = colArg !== null && !/^\d+$/.test(String(colArg)) ? String(colArg) : numericKeys[numericKeys.length - 1];
    if (!key) die(`no numeric field found in the JSON objects (fields: ${keys.join(', ')})`);
    values = data.map((r) => Number(r[key])).filter(Number.isFinite);
  } else values = data.map(Number).filter(Number.isFinite);
} else {
  const colArg = get(o, 'col', null);
  const colIdx = colArg !== null ? num(colArg, -1) : -1;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/[\s,;\t|]+/).filter((x) => x !== '');
    const nums = parts.map(Number);
    if (nums.every(Number.isFinite)) {
      if (colIdx >= 1 && colIdx <= nums.length) values.push(nums[colIdx - 1]);
      else values.push(nums[nums.length - 1]);
      if (colIdx === -1 && labels === null && parts.length > 1) labels = null;
    } else {
      const last = nums[nums.length - 1];
      if (Number.isFinite(last)) { values.push(last); if (!labels) labels = []; if (labels) labels.push(parts[0]); }
    }
  }
}

if (!values.length) die('no numeric values found');

const n = values.length;
const min = Math.min(...values);
const max = Math.max(...values);
const sum = values.reduce((a, b) => a + b, 0);
const mean = sum / n;
const sorted = [...values].sort((a, b) => a - b);
const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
const stdev = Math.sqrt(variance);
const pct = (vals, p) => { const idx = Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p))); return vals[idx]; };
const q1 = pct(sorted, 0.25), q3 = pct(sorted, 0.75);
const iqr = q3 - q1;
const outliers = values.filter((v) => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
const fx = (v) => Number(v).toFixed(precision);
const norm = (v) => (max === min ? 0.5 : (v - min) / (max - min));

const lines = [];
if (chart === 'spark') {
  const step = Math.max(1, Math.ceil(n / width));
  let sparkLine = '';
  const used = [];
  for (let i = 0; i < n; i += step) {
    const chunk = values.slice(i, i + step);
    const avg = chunk.reduce((a, b) => a + b, 0) / chunk.length;
    used.push(avg);
    sparkLine += cs.spark[Math.min(cs.spark.length - 1, Math.round(norm(avg) * (cs.spark.length - 1)))];
  }
  lines.push(sparkLine);
  lines.push(`${sparkLine.length} cols for ${n} value(s), ${step} value(s)/col`);
} else if (chart === 'bar' || chart === 'hbar') {
  const step = Math.max(1, Math.ceil(n / (chart === 'hbar' ? height : width)));
  const cols = [];
  for (let i = 0; i < n; i += step) {
    const chunk = values.slice(i, i + step);
      const avg = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      const lb = labels && labels[Math.min(labels.length - 1, i)] !== undefined ? labels[Math.min(labels.length - 1, i)] : `${i}`;
      cols.push({ label: lb, value: avg, range: chunk.length > 1 ? `${i}..${i + chunk.length - 1}` : `${i}` });
  }
  if (chart === 'hbar') {
    const lblW = Math.max(...cols.map((c) => c.label.length), 3);
    for (const c of cols) {
      const w = Math.max(1, Math.round(norm(c.value) * (width - lblW - 12)));
      lines.push(`${c.label.padEnd(lblW)} ${cs.bar.repeat(w)} ${fx(c.value)}`);
    }
    lines.push('', `range ${fx(min)} .. ${fx(max)}, mean ${fx(mean)}`);
  } else {
    const rows = Math.min(height, 24);
    const grid = Array.from({ length: rows }, () => new Array(cols.length).fill(' '));
    cols.forEach((c, i) => {
      const h = Math.max(1, Math.round(norm(c.value) * (rows - 1)) + 1);
      for (let r = rows - h; r < rows; r++) grid[r][i] = cs.bar;
    });
    const maxLabelW = fx(max).length;
    for (let r = 0; r < rows; r++) {
      const val = max - (max - min) * (r / (rows - 1));
      const label = flag(o, 'no-axis') ? '' : String(fx(val)).padStart(maxLabelW) + ' |';
      lines.push(label + grid[r].map((ch) => (ch === ' ' ? ' ' : cs.bar)).join(''));
    }
    if (!flag(o, 'no-axis')) lines.push(' '.repeat(maxLabelW + 1) + ' +' + '-'.repeat(cols.length));
    lines.push('', `${cols.length} bucket(s), ${step} value(s)/bucket`);
  }
} else if (chart === 'hist') {
  const lo = min, hi = max;
  const span = hi - lo || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++;
  const cmax = Math.max(...counts);
  const rows = Math.min(height, bins * 2);
  const grid = Array.from({ length: rows }, () => new Array(bins).fill(' '));
  counts.forEach((c, b) => {
    const h = Math.max(c > 0 ? 1 : 0, Math.round((c / cmax) * rows));
    for (let r = rows - h; r < rows; r++) grid[r][b] = cs.bar;
  });
  const maxLbl = fmt(cmax).length;
  for (let r = 0; r < rows; r++) {
    const val = Math.round(cmax * (1 - r / rows));
    lines.push(String(val).padStart(maxLbl) + ' |' + grid[r].join(''));
  }
  lines.push(' '.repeat(maxLbl) + ' +' + '-'.repeat(bins));
  const edgeLine = [];
  counts.forEach((c, b) => edgeLine.push(fx(lo + span * (b / bins)).padStart(Math.max(4, Math.floor(width / bins)))));
  lines.push('  ' + edgeLine.join(' '));
  lines.push('', `bin width ${fx(span / bins)}, max count ${fmt(cmax)}`);
} else if (chart === 'box') {
  const barW = Math.max(10, Math.min(width, 72));
  const scale = (v) => Math.max(0, Math.min(barW - 1, Math.round(norm(v) * (barW - 1))));
  const row = new Array(barW).fill(' ');
  const q1p = scale(q1), medp = scale(median), q3p = scale(q3), minp = scale(min), maxp = scale(max), meanp = scale(mean);
  for (let x = q1p; x <= q3p; x++) row[x] = '=';
  row[medp] = '|';
  for (let x = minp; x < q1p; x++) row[x] = '-';
  for (let x = q3p + 1; x <= maxp; x++) row[x] = '-';
  row[meanp] = row[meanp] === '=' || row[meanp] === '-' ? '+' : '+';
  lines.push(row.join(''));
  lines.push(`min ${fx(min).padEnd(12)} q1 ${fx(q1).padEnd(12)} median ${fx(median).padEnd(12)} q3 ${fx(q3).padEnd(12)} max ${fx(max)}`);
  lines.push(`n=${n}  mean ${fx(mean)}  stdev ${fx(stdev)}  iqr ${fx(iqr)}  outliers ${outliers.length}`);
} else if (chart === 'scatter') {
  const grid = Array.from({ length: height }, () => new Array(Math.min(width, n)).fill(' '));
  const w = Math.min(width, n);
  const step = Math.max(1, Math.ceil(n / w));
  const pts = [];
  for (let i = 0; i < n; i += step) {
    const chunk = values.slice(i, i + step);
    pts.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }
  pts.forEach((v, i) => {
    const x = Math.min(w - 1, i);
    const y = Math.max(0, Math.min(height - 1, height - 1 - Math.round(norm(v) * (height - 1))));
    grid[y][x] = cs.dot;
  });
  const maxLbl = fx(max).length;
  grid.forEach((r, ri) => {
    const val = max - (max - min) * (ri / (height - 1));
    lines.push(String(fx(val)).padStart(maxLbl) + ' |' + r.join(''));
  });
  lines.push(' '.repeat(maxLbl) + ' +' + '-'.repeat(pts.length));
} else {
  const gw = Math.min(width, 64);
  const step = Math.max(1, Math.ceil(n / gw));
  const pts = [];
  for (let i = 0; i < n; i += step) {
    const chunk = values.slice(i, i + step);
    pts.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }
  const grid = Array.from({ length: height }, () => new Array(pts.length).fill(' '));
  pts.forEach((v, i) => {
    const x = Math.min(pts.length - 1, i);
    const y = Math.max(0, Math.min(height - 1, height - 1 - Math.round(norm(v) * (height - 1))));
    for (let yy = Math.min(y, height - 1); yy <= 0 + y; yy++) grid[yy][x] = cs.bar;
  });
  const maxLbl = fx(max).length;
  grid.forEach((r, ri) => {
    const val = max - (max - min) * (ri / (height - 1));
    lines.push(String(fx(val)).padStart(maxLbl) + ' |' + r.join(''));
  });
  lines.push(' '.repeat(maxLbl) + ' +' + '-'.repeat(pts.length));
}

const stats = {
  count: n, min, max, sum: Number(sum.toFixed(6)), mean: Number(mean.toFixed(6)),
  median, stdev: Number(stdev.toFixed(6)), variance: Number(variance.toFixed(6)),
  q1, q3, iqr, outlierCount: outliers.length, outliers: outliers.slice(0, 20),
  minIndex: values.indexOf(min), maxIndex: values.indexOf(max),
};

if (flag(o, 'json')) process.stdout.write(JSON.stringify({ input: src, chart, width, height, bins, stats, chartText: lines.join('\n') }, null, 2) + '\n');
else {
  console.log(`${src} — ${chart} chart, ${fmt(n)} value(s)`);
  console.log(table([
    { field: 'count', value: fmt(n) },
    { field: 'min', value: `${fx(min)} (index ${values.indexOf(min)})` },
    { field: 'max', value: `${fx(max)} (index ${values.indexOf(max)})` },
    { field: 'mean', value: fx(mean) },
    { field: 'median', value: fx(median) },
    { field: 'stdev', value: fx(stdev) },
    { field: 'q1 / q3', value: `${fx(q1)} / ${fx(q3)}` },
    { field: 'iqr', value: fx(iqr) },
    { field: 'outliers (1.5xIQR)', value: `${outliers.length}${outliers.length ? ': ' + outliers.slice(0, 6).map(fx).join(', ') : ''}` },
  ], ['field', 'value']));
  console.log('');
  process.stdout.write(lines.join('\n') + '\n');
}
