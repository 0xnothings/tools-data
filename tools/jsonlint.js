#!/usr/bin/env node
// jsonlint.js — JSON auditor: duplicate keys, precision loss, BOM, comments, NaN, deep nesting.
// Copyright (c) 2026 0xnothings
// @tool jsonlint
// @desc Lint JSON for duplicate keys, big-integer precision loss, BOM, comments, NaN, trailing data and deep nesting
// @usage node tools/jsonlint.js data.json --json
// @tags data,json,lint,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `jsonlint — JSON structure auditor

  node tools/jsonlint.js <file.json|--dir path|-> [options]

  --strict          treat warnings as errors (exit 1)
  --max-depth <n>   warn when nesting exceeds n (default 32)
  --max-number <n>  warn on integers with more digits than n (default 15)
  --allow-comments  do not flag // and /* */ syntax
  --allow-bom       do not flag a UTF-8 BOM
  --sample <n>      example values per finding (default 3)
  --json            machine-readable output
  -h, --help        this text

  Checks: UTF-8/UTF-16 BOM, JSON.parse failure with a line/column, duplicate object
  keys (JSON.parse silently keeps the last), integers past Number.MAX_SAFE_INTEGER,
  NaN/Infinity literals, trailing data after the root value, single quotes, unquoted
  keys, trailing commas, // and /* */ comments, control characters in strings,
  invalid \\u escapes and nesting deeper than the threshold.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['allow-bom', 'allow-comments', 'json', 'strict']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a file — node tools/jsonlint.js data.json');
const maxDepth = num(get(o, 'max-depth', 32), 32);
const maxDigits = num(get(o, 'max-number', 15), 15);
const sampleN = num(get(o, 'sample', 3), 3);

function lineColOf(text, pos) {
  let line = 1, col = 1;
  for (let i = 0; i < pos && i < text.length; i++) { if (text[i] === '\n') { line++; col = 1; } else col++; }
  return { line, col };
}

function lintText(text, path) {
  const findings = [];
  const add = (sev, code, message, detail) => findings.push({ severity: sev, code, message, ...detail });
  let body = text;

  if (body.charCodeAt(0) === 0xfeff) {
    if (!flag(o, 'allow-bom')) add('warning', 'bom-utf8', 'file starts with a UTF-8 BOM (0xEF 0xBB 0xBF) — many parsers reject it, strip it', { offset: 0 });
    body = body.slice(1);
  }
  if (text.charCodeAt(0) === 0xfffe || (text.length > 1 && text.charCodeAt(0) === 0xfeff && text.charCodeAt(1) === 0xfeff)) add('error', 'bom-utf16', 'UTF-16 BOM detected — the file is not UTF-8 JSON', {});

  let parsed = null, parseError = null;
  try { parsed = JSON.parse(body); } catch (e) {
    parseError = e;
    const m = String(e.message).match(/position (\d+)/);
    let line = null, col = null;
    if (m) { const lc = lineColOf(body, Number(m[1])); line = lc.line; col = lc.col; }
    const lineM = String(e.message).match(/at line (\d+) column (\d+)/);
    if (lineM) { line = Number(lineM[1]); col = Number(lineM[2]); }
    add('error', 'parse-error', e.message, { line, col });
  }

  // comment syntax
  if (!flag(o, 'allow-comments')) {
    const lc = /(^|[\s,:\[{])\/\/[^\n]*/g;
    let m, n = 0;
    while ((m = lc.exec(body)) !== null && n < sampleN) {
      const l = lineColOf(body, m.index);
      add('warning', 'comment', `// comment at line ${l.line} — not valid JSON`, { line: l.line, col: l.col, sample: m[0].trim().slice(0, 60) });
      n++;
    }
    const bc = /\/\*[\s\S]*?\*\//g;
    let bm, bn = 0;
    while ((bm = bc.exec(body)) !== null && bn < sampleN) {
      const l = lineColOf(body, bm.index);
      add('warning', 'comment', `/* */ comment at line ${l.line} — not valid JSON`, { line: l.line, col: l.col, sample: bm[0].slice(0, 60) });
      bn++;
    }
  }

  // NaN / Infinity
  const bad = /\b(NaN|-?Infinity|undefined)\b/g;
  let nm, nn = 0;
  while ((nm = bad.exec(body)) !== null && nn < sampleN) {
    const l = lineColOf(body, nm.index);
    add('error', 'non-json-literal', `${nm[1]} is not a JSON value (line ${l.line})`, { line: l.line, col: l.col, sample: nm[1] });
    nn++;
  }

  // single quotes / unquoted keys
  if (parseError) {
    const sq = /:\s*'[^'\n]*'/g;
    let sm, sn = 0;
    while ((sm = sq.exec(body)) !== null && sn < sampleN) {
      const l = lineColOf(body, sm.index);
      add('warning', 'single-quotes', `single-quoted string at line ${l.line}`, { line: l.line, col: l.col, sample: sm[0].slice(0, 40) });
      sn++;
    }
    const uk = /[{,]\s*([A-Za-z_$][\w$]*)\s*:/g;
    let um, un = 0;
    while ((um = uk.exec(body)) !== null && un < sampleN) {
      const l = lineColOf(body, um.index);
      add('warning', 'unquoted-key', `unquoted object key "${um[1]}" at line ${l.line}`, { line: l.line, col: l.col, sample: um[1] });
      un++;
    }
    const tc = /,\s*[}\]]/g;
    let tm, tn = 0;
    while ((tm = tc.exec(body)) !== null && tn < sampleN) {
      const l = lineColOf(body, tm.index);
      add('warning', 'trailing-comma', `trailing comma at line ${l.line}`, { line: l.line, col: l.col });
      tn++;
    }
  }

  // big integers: digits outside strings
  const stripped = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const bigNum = /(?<![\w.])-?\d{16,}(?:\.\d+)?/g;
  let gm, gn = 0;
  while ((gm = bigNum.exec(stripped)) !== null && gn < sampleN) {
    const digits = gm[0].replace(/[-.]/g, '').length;
    if (digits < maxDigits + 1) continue;
    const l = lineColOf(body, gm.index);
    const asNum = Number(gm[0]);
    const lossy = BigInt(gm[0].replace(/\.\d+$/, '')) > BigInt(Number.MAX_SAFE_INTEGER);
    add(lossy ? 'warning' : 'info', 'big-integer',
      `integer ${gm[0]} at line ${l.line}${lossy ? ` loses precision (parses as ${asNum})` : ' exceeds the digit threshold'}`,
      { line: l.line, col: l.col, sample: gm[0], parsedAs: asNum, lossy });
    gn++;
  }

  // control characters inside strings
  const ctrl = /"[^"\n]*[\u0000-\u0008\u000b\u000c\u000e-\u001f][^"\n]*"/g;
  let cm, cn = 0;
  while ((cm = ctrl.exec(body)) !== null && cn < sampleN) {
    const l = lineColOf(body, cm.index);
    add('error', 'raw-control-char', `unescaped control character in a string at line ${l.line}`, { line: l.line, col: l.col });
    cn++;
  }

  // invalid \u escapes
  const badEsc = /\\u(?![0-9a-fA-F]{4})/g;
  let em, en = 0;
  while ((em = badEsc.exec(body)) !== null && en < sampleN) {
    const l = lineColOf(body, em.index);
    add('error', 'bad-unicode-escape', `malformed \\u escape at line ${l.line}`, { line: l.line, col: l.col });
    en++;
  }

  // duplicate keys via a tokenizer (JSON.parse cannot see them)
  const dups = [];
  const stack = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    if (c === '"') {
      let j = i + 1, str = '';
      while (j < n) {
        if (body[j] === '\\') { str += body[j] + (body[j + 1] || ''); j += 2; continue; }
        if (body[j] === '"') break;
        str += body[j]; j++;
      }
      const keyEnd = j;
      let k = keyEnd + 1;
      while (k < n && /\s/.test(body[k])) k++;
      if (body[k] === ':' && stack.length && stack[stack.length - 1].type === 'object') {
        const frame = stack[stack.length - 1];
        const key = str.replace(/\\"/g, '"');
        if (frame.keys.has(key)) dups.push({ key, path: frame.path, line: lineColOf(body, i).line, firstLine: frame.keys.get(key) });
        else frame.keys.set(key, lineColOf(body, i).line);
      }
      i = keyEnd + 1;
      continue;
    }
    if (c === '{') { stack.push({ type: 'object', keys: new Map(), path: stack.length ? stack[stack.length - 1].path + '/{obj}' : '' }); }
    else if (c === '[') { stack.push({ type: 'array', keys: new Map(), path: stack.length ? stack[stack.length - 1].path + '[]' : '' }); }
    else if (c === '}' || c === ']') { stack.pop(); }
    i++;
  }
  for (const d of dups.slice(0, sampleN)) add('error', 'duplicate-key', `duplicate key "${d.key}" (lines ${d.firstLine} and ${d.line}) — JSON.parse keeps only the last value`, { line: d.line, sample: d.key });

  function depthCheck(v, depth, path) {
    if (maxDepth && depth > maxDepth) {
      if (!findings.some((f) => f.code === 'deep-nesting')) add('warning', 'deep-nesting', `nesting exceeds ${maxDepth} levels (first seen at ${path})`, { line: null, sample: path.slice(0, 60) });
      return;
    }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) depthCheck(x, depth + 1, `${path}/${k}`);
  }

  let depth = 0, stats = {};
  if (parsed !== null) {
    depthCheck(parsed, 1, '');
    const measure = (v) => {
      if (v === null) return 1;
      if (Array.isArray(v)) return 1 + (v.length ? Math.max(...v.map(measure)) : 0);
      if (typeof v === 'object') { const ks = Object.keys(v); return 1 + (ks.length ? Math.max(...ks.map((k) => measure(v[k]))) : 0); }
      return 1;
    };
    depth = measure(parsed);
    const count = (v, acc) => {
      if (Array.isArray(v)) { acc.arrays++; acc.values += v.length; v.forEach((x) => count(x, acc)); }
      else if (v && typeof v === 'object') { const ks = Object.keys(v); acc.objects++; acc.keys += ks.length; ks.forEach((k) => count(v[k], acc)); }
      else { acc.scalars++; acc.types[typeof v] = (acc.types[typeof v] || 0) + 1; }
      return acc;
    };
    stats = count(parsed, { objects: 0, arrays: 0, keys: 0, scalars: 0, values: 0, types: {} });
  }

  // trailing data
  if (parsed !== null) {
    const trimmed = body.replace(/\s+$/, '');
    const lastClose = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'), trimmed.lastIndexOf('"'));
    const tail = trimmed.slice(lastClose + 1).trim();
    if (tail && !/^[\s;]*$/.test(tail)) add('warning', 'trailing-data', `non-whitespace data after the root value: ${JSON.stringify(tail.slice(0, 40))}`, { sample: tail.slice(0, 60) });
  }

  const counts = findings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m; }, {});
  return {
    file: path, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length,
    valid: parsed !== null, rootType: parsed === null ? null : Array.isArray(parsed) ? 'array' : typeof parsed,
    maxDepthObserved: depth, structure: stats, findings, counts: { error: counts.error || 0, warning: counts.warning || 0, info: counts.info || 0 },
  };
}

const paths = [];
if (flag(o, 'dir') || (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) if (ent.isFile() && /\.json$/i.test(ent.name)) paths.push(join(dir, ent.name));
  if (!paths.length) die(`no .json files in ${dir}`);
} else paths.push(target);

const reports = [];
for (const p of paths) {
  let text;
  try { text = p === '-' ? await readInput(p) : readFileSync(p, 'utf8'); } catch (e) { die(`cannot read ${p}: ${e.message}`); }
  reports.push(lintText(text, p));
}

const anyError = reports.some((r) => r.counts.error > 0 || (flag(o, 'strict') && r.counts.warning > 0));

if (flag(o, 'json')) process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : { files: reports.length, reports }, null, 2) + '\n');
else {
  for (const r of reports) {
    console.log(`${r.file} — ${r.valid ? 'valid JSON' : 'INVALID'} (${fmt(r.bytes)} bytes, ${r.lines} lines, root ${r.rootType || '?'}, depth ${r.maxDepthObserved})`);
    if (r.structure.objects !== undefined) console.log(`structure: ${r.structure.objects} objects, ${r.structure.arrays} arrays, ${r.structure.keys} keys, ${r.structure.scalars} scalars`);
    if (!r.findings.length) { console.log('no findings — clean\n'); continue; }
    console.log(table(r.findings.map((f) => ({
      severity: f.severity, code: f.code, line: f.line ?? '-', col: f.col ?? '', message: f.message.slice(0, 90), sample: f.sample === undefined ? '' : String(f.sample).slice(0, 40),
    })), ['severity', 'code', 'line', 'col', 'message', 'sample']));
    console.log(`\n${r.counts.error} error(s), ${r.counts.warning} warning(s), ${r.counts.info} info\n`);
  }
}
if (anyError) process.exit(flag(o, 'strict') ? 1 : reports.some((r) => r.counts.error > 0) ? 1 : 0);
