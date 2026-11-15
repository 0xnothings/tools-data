#!/usr/bin/env node
// yamlpeek.js — minimal YAML reader (mappings, sequences, scalars, block scalars) producing JSON.
// Copyright (c) 2026 0xnothings
// @tool yamlpeek
// @desc Parse a practical YAML subset to JSON with line numbers in error messages
// @usage node tools/yamlpeek.js config.yaml --json
// @tags data,yaml,config,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `yamlpeek — YAML subset reader

  node tools/yamlpeek.js <file.yaml|file.yml|-> [options]

  --doc <n>        emit only document n (0-based, default all)
  --flatten        emit dotted paths instead of nested JSON
  --strict         error on constructs outside the supported subset
  --json           machine-readable output (the parsed document by default)
  -h, --help       this text

  Supported: block mappings and sequences, nested indentation, inline flow
  collections {a: 1} / [1, 2], quoted and single-quoted scalars, block scalars
  | and > with - and + chomping, multi-document --- / ... markers, anchors and
  aliases (&a / *a), merge keys (<<:), comments, and type inference
  (null/bool/int/float/date-like stay strings). Anchors are resolved before
  merging; unknown tags, complex keys (? :) and flow-scalar continuations are
  reported as unsupported.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['flatten', 'json', 'strict']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/yamlpeek.js config.yaml');
let text;
try { text = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

const strict = flag(o, 'strict');
const notes = [];

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q && line[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw, lineNo) {
  const s = raw.trim();
  if (s === '') return { value: null, empty: true };
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return { value: null };
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return { value: true };
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return { value: false };
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return { value: s, note: `integer ${s} exceeds the safe range, kept as a string` };
    return { value: n };
  }
  if (/^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(s)) return { value: Number(s) };
  if (/^(0x[0-9a-fA-F]+|0o[0-7]+)$/.test(s)) return { value: Number(s) };
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) { notes.push({ line: lineNo, kind: 'unterminated-string', text: s.slice(0, 40) }); return { value: s.slice(1) }; }
    const inner = s.slice(1, -1);
    return { value: inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) { notes.push({ line: lineNo, kind: 'unterminated-string', text: s.slice(0, 40) }); return { value: s.slice(1) }; }
    return { value: s.slice(1, -1).replace(/''/g, "'") };
  }
  if (s.startsWith('!')) { notes.push({ line: lineNo, kind: 'tag', text: s.split(/\s/)[0] }); return scalar(s.replace(/^!\S*\s*/, ''), lineNo); }
  if (s.startsWith('*')) return { value: { __alias: s.slice(1) } };
  return { value: s };
}

function findColon(s) {
  let q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === ':' && depth === 0 && (i + 1 >= s.length || /\s/.test(s[i + 1]))) return i;
  }
  return -1;
}

function parseFlow(s, lineNo) {
  const t = s.trim();
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) { notes.push({ line: lineNo, kind: 'unterminated-flow-map', text: t.slice(0, 40) }); return { partial: true, value: t }; }
    const inner = t.slice(1, -1).trim();
    if (!inner) return { value: {} };
    const obj = {};
    for (const part of splitTop(inner, ',')) {
      const ci = findColon(part);
      if (ci === -1) { notes.push({ line: lineNo, kind: 'flow-map-item-without-colon', text: part.trim().slice(0, 40) }); continue; }
      const k = unquote(part.slice(0, ci).trim());
      obj[k] = parseFlow(part.slice(ci + 1).trim(), lineNo).value ?? null;
    }
    return { value: obj };
  }
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) { notes.push({ line: lineNo, kind: 'unterminated-flow-seq', text: t.slice(0, 40) }); return { partial: true, value: t }; }
    const inner = t.slice(1, -1).trim();
    if (!inner) return { value: [] };
    return { value: splitTop(inner, ',').map((p) => parseFlow(p, lineNo).value ?? null) };
  }
  const sc = scalar(t, lineNo);
  return sc;
}

function splitTop(s, delim) {
  const out = [];
  let cur = '', q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === delim && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (s) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

// ---- tokenize ----
const rawLines = text.split(/\r?\n/);
const docs = [];
let cur = [];
for (let i = 0; i === 0 || i < rawLines.length; i++) {
  const raw = rawLines[i] ?? '';
  const l = stripComment(raw).replace(/\s+$/, '');
  if (/^---\s*$/.test(l) || /^---\s+\S/.test(l)) { if (cur.some((x) => x.trim())) docs.push(cur); cur = []; if (/^---\s+\S/.test(l)) cur.push({ text: l.replace(/^---\s*/, ''), line: i + 1, indent: 0 }); continue; }
  if (/^\.\.\.\s*$/.test(l)) { if (cur.some((x) => x.trim())) { docs.push(cur); cur = []; } continue; }
  if (/^%YAML|^%TAG/.test(l)) { notes.push({ line: i + 1, kind: 'directive', text: l.trim() }); continue; }
  if (!l.trim()) { cur.push({ blank: true, line: i + 1, indent: 999 }); continue; }
  if (/^\t/.test(raw)) notes.push({ line: i + 1, kind: 'tab-indent', text: 'tabs are not valid YAML indentation' });
  const indent = raw.match(/^ */)[0].length;
  cur.push({ text: l.replace(/^ +/, ''), line: i + 1, indent });
}
if (cur.some((x) => x.text !== undefined && x.text.trim())) docs.push(cur);
if (!docs.length) docs.push([]);

function nextIndent(lines, from, parentIndent) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].blank) continue;
    if (lines[i].indent <= parentIndent) return null;
    return lines[i].indent;
  }
  return null;
}

function parseBlock(lines, startIdx, indent, anchors) {
  const first = lines[startIdx];
  const isSeq = first && first.text !== undefined && /^-\s|^-$/.test(first.text);
  const container = isSeq ? [] : {};
  let i = startIdx;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.blank) { i++; continue; }
    if (ln.indent < indent) break;
    if (ln.indent > indent) { notes.push({ line: ln.line, kind: 'unexpected-indent', text: ln.text.slice(0, 40) }); i++; continue; }
    if (isSeq) {
      const m = ln.text.match(/^-\s*(.*)$/);
      if (!m) break;
      const rest = m[1];
      if (rest === '') {
        const ci2 = nextIndent(lines, i + 1, indent);
        if (ci2 === null) { container.push(null); i++; continue; }
        const child = parseBlock(lines, i + 1, ci2, anchors);
        container.push(child.value);
        i = child.next;
        continue;
      }
      const ci = findColon(rest);
      if (ci > 0 && /^[^-]/.test(rest)) {
        // "- key: value" starts an inline mapping
        const obj = {};
        const k = unquote(rest.slice(0, ci));
        let v = rest.slice(ci + 1).trim();
        const anchorM = v.match(/^&(\S+)\s*(.*)$/);
        if (anchorM) { anchors.set(anchorM[1], null); v = anchorM[2]; }
        if (v === '') {
          const ci2 = nextIndent(lines, i + 1, indent);
          if (ci2 === null) { obj[k] = null; i++; }
          else { const child = parseBlock(lines, i + 1, ci2, anchors); obj[k] = child.value; i = child.next; }
        } else {
          const r = parseFlow(v, ln.line);
          obj[k] = r.value;
          i++;
        }
        // absorb further keys of the same inline mapping
        while (i < lines.length && !lines[i].blank && lines[i].indent > indent) {
          const sub = lines[i];
          const si = findColon(sub.text);
          if (si > 0) {
            const sk = unquote(sub.text.slice(0, si));
            const sv = sub.text.slice(si + 1).trim();
            if (sv === '') {
              const ci3 = nextIndent(lines, i + 1, sub.indent);
              if (ci3 === null) { obj[sk] = null; i++; }
              else { const ch = parseBlock(lines, i + 1, ci3, anchors); obj[sk] = ch.value; i = ch.next; }
            } else { obj[sk] = parseFlow(sv, sub.line).value; i++; }
          } else break;
        }
        container.push(obj);
        continue;
      }
      const r = parseFlow(rest, ln.line);
      container.push(r.value);
      i++;
      continue;
    }
    const ci = findColon(ln.text);
    if (ci === -1) {
      if (ln.text.trim()) notes.push({ line: ln.line, kind: 'unexpected-scalar', text: ln.text.slice(0, 40) });
      i++;
      continue;
    }
    const key = unquote(ln.text.slice(0, ci));
    let v = ln.text.slice(ci + 1).trim();
    let anchorName = null;
    const anchorM = v.match(/^&(\S+)\s*(.*)$/);
    if (anchorM) { anchorName = anchorM[1]; v = anchorM[2]; }
    if (v === '|' || v === '>' || /^[|>][-+]?\d?$/.test(v)) {
      const style = v[0];
      const chomp = /-/.test(v) ? 'strip' : /\+/.test(v) ? 'keep' : 'clip';
      const collected = [];
      let j = i + 1;
      let blockIndent = null, explicitIndent = num(/[|>]([-+]?)(\d)/.exec(v)?.[2], 0);
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.blank) { collected.push(''); j++; continue; }
        if (bl.indent <= indent) break;
        if (blockIndent === null) blockIndent = explicitIndent ? indent + explicitIndent : bl.indent;
        collected.push(' '.repeat(Math.max(0, bl.indent - blockIndent)) + bl.text);
        j++;
      }
      let joined = style === '|' ? collected.join('\n') : collected.join(' ').replace(/[ \t]+/g, ' ');
      if (style === '>') joined = joined.replace(/ +\n/g, '\n');
      if (chomp === 'strip') joined = joined.replace(/[\n ]+$/, '');
      else if (chomp === 'keep') joined = joined.replace(/\n*$/, '\n\n');
      else joined = joined.replace(/\n*$/, '\n');   // clip
      if (key === '<<') { /* not valid here */ }
      container[key] = joined;
      i = j;
      continue;
    }
    if (v === '') {
      const ci2 = nextIndent(lines, i + 1, indent);
      if (ci2 === null) { container[key] = null; if (anchorName) anchors.set(anchorName, null); i++; continue; }
      const child = parseBlock(lines, i + 1, ci2, anchors);
      container[key] = child.value;
      if (anchorName) anchors.set(anchorName, container[key]);
      i = child.next;
      continue;
    }
    const r = parseFlow(v, ln.line);
    let val = r.value;
    if (val && typeof val === 'object' && val.__alias) {
      if (!anchors.has(val.__alias)) notes.push({ line: ln.line, kind: 'unknown-anchor', text: val.__alias });
      val = anchors.get(val.__alias) ?? null;
    }
    if (anchorName) anchors.set(anchorName, val);
    if (key === '<<') {
      const merges = Array.isArray(val) ? val : [val];
      for (const m of merges) if (m && typeof m === 'object') for (const [mk, mv] of Object.entries(m)) if (!(mk in container)) container[mk] = mv;
      i++;
      continue;
    }
    container[key] = val;
    i++;
  }
  return { value: container, next: i };
}

const results = [];
for (const docLines of docs) {
  const anchors = new Map();
  if (!docLines.length) { results.push({ value: null, anchorsUsed: 0 }); continue; }
  const { value } = parseBlock(docLines, 0, docLines[0].indent, anchors);
  results.push({ value, anchorsUsed: anchors.size });
}

const docIdx = num(get(o, 'doc', -1), -1);
const selected = docIdx >= 0 ? [results[docIdx]].filter(Boolean) : results;
if (docIdx >= 0 && !results[docIdx]) die(`--doc ${docIdx} out of range (${results.length} document(s))`);

const flatten = (v, prefix, out) => {
  if (Array.isArray(v)) v.forEach((x, i) => flatten(x, prefix ? `${prefix}.${i}` : String(i), out));
  else if (v && typeof v === 'object') { const ks = Object.keys(v); if (!ks.length && prefix) out[prefix] = {}; ks.forEach((k) => flatten(v[k], prefix ? `${prefix}.${k}` : k, out)); }
  else out[prefix || '(root)'] = v;
  return out;
};

const outDocs = selected.map((d) => (flag(o, 'flatten') ? flatten(d.value, '', {}) : d.value));

const report = {
  file: src, documents: results.length, emitted: outDocs.length, lines: rawLines.length,
  strict, notes, anchorsPerDocument: results.map((r) => r.anchorsUsed),
  document: outDocs.length === 1 ? outDocs[0] : undefined,
  documentsOut: outDocs.length > 1 ? outDocs : undefined,
};

if (flag(o, 'json')) process.stdout.write(JSON.stringify(flag(o, 'flatten') || outDocs.length > 1 ? { ...report, documentsOut: outDocs, document: undefined } : outDocs[0], null, 2) + '\n');
else {
  console.log(`${src} — ${results.length} YAML document(s), ${rawLines.length} lines${flag(o, 'flatten') ? ', flattened' : ''}`);
  if (notes.length) {
    console.log(`\n${notes.length} NOTE(S)`);
    console.log(table(notes.slice(0, 40).map((n) => ({ line: n.line, kind: n.kind, text: (n.text || '').slice(0, 60) })), ['line', 'kind', 'text']));
  } else console.log('no unsupported constructs encountered');
  console.log('');
  process.stdout.write(JSON.stringify(outDocs.length === 1 ? outDocs[0] : outDocs, null, 2) + '\n');
}
if (strict && notes.some((n) => n.kind !== 'tag')) process.exit(1);
