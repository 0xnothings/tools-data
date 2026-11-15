// tomlpeek.js — TOML subset reader (tables, arrays, inline tables, dates, quotes) producing JSON.
// Copyright (c) 2026 0xnothings
// @tool tomlpeek
// @desc Parse TOML tables, arrays, inline tables and datetime literals to JSON with error positions
// @usage node tools/tomlpeek.js Cargo.toml --json
// @tags data,toml,config,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `tomlpeek — TOML subset reader

  node tools/tomlpeek.js <file.toml|--dir path|-> [options]

  --flat            emit dotted keys instead of nested tables
  --types           also print a per-key type table
  --no-dates        keep date/time literals as strings instead of ISO markers
  --strict          exit 1 on any warning (redefinition, out-of-order table, …)
  --json            machine-readable output (the parsed document by default)
  -h, --help        this text

  Supported: [table], [[array.of.tables]], dotted keys (a.b.c = 1), basic and
  literal strings with escapes, multi-line ''' and """ strings, integers with _
  and 0x/0o/0b prefixes, floats (inf/nan), booleans, arrays (nested, trailing
  comma), inline tables, offset date-time, local date-time, local date, local
  time, and comments outside strings. Errors carry the line and column.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['flat', 'json', 'no-dates', 'strict', 'types']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a file — node tools/tomlpeek.js Cargo.toml');
const keepDates = !flag(o, 'no-dates');
const warnings = [];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?)?$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

function fail(line, col, message) {
  die(`${message}\n  at line ${line}, column ${col}`);
}

function unescapeBasic(s, line) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\b/g, '\b').replace(/\\f/g, '\f')
    .replace(/\\(?!["\\bfnrtuU])/g, (m) => { warnings.push({ line, code: 'invalid-escape', message: `unknown escape ${m}` }); return m[1]; });
}

class Reader {
  constructor(text) { this.t = text; this.i = 0; this.line = 1; this.col = 1; }
  get eof() { return this.i >= this.t.length; }
  peek(k = 0) { return this.t[this.i + k]; }
  bump() { const c = this.t[this.i++]; if (c === '\n') { this.line++; this.col = 1; } else this.col++; return c; }
  error(msg) { fail(this.line, this.col, msg); }
  skipWs() { while (!this.eof && (this.peek() === ' ' || this.peek() === '\t')) this.bump(); }
  skipWsAndNewlines() { while (!this.eof && /[ \t\r\n]/.test(this.peek())) this.bump(); }
  skipComment() { if (this.peek() === '#') { while (!this.eof && this.peek() !== '\n') this.bump(); } }

  readKey() {
    this.skipWs();
    const parts = [];
    for (;;) {
      this.skipWs();
      const c = this.peek();
      if (c === '"' || c === "'") {
        const s = this.readString();
        parts.push(s.value);
      } else {
        let raw = '';
        while (!this.eof && /[A-Za-z0-9_\-]/.test(this.peek())) raw += this.bump();
        if (!raw) this.error('expected a key');
        parts.push(raw);
      }
      this.skipWs();
      if (this.peek() === '.') { this.bump(); continue; }
      break;
    }
    return parts;
  }

  readString() {
    const quote = this.bump();
    const triple = this.peek() === quote && this.peek(1) === quote;
    if (triple) { this.bump(); this.bump(); }
    let out = '';
    const isLiteral = quote === "'";
    for (;;) {
      if (this.eof) this.error('unterminated string');
      if (triple) {
        if (this.peek() === quote && this.peek(1) === quote && this.peek(2) === quote) { this.bump(); this.bump(); this.bump(); break; }
        if (this.peek() === '\\' && !isLiteral) {
          this.bump();
          const esc = this.bump();
          if (esc === '\n') { this.skipWsAndNewlines(); continue; }
          out += unescapeBasic('\\' + esc, this.line);
          continue;
        }
        out += this.bump();
      } else {
        const c = this.peek();
        if (c === '\n') this.error('unterminated string on one line (use triple quotes for multi-line)');
        if (c === quote) { this.bump(); break; }
        if (c === '\\' && !isLiteral) {
          this.bump();
          const esc = this.bump();
          out += unescapeBasic('\\' + esc, this.line);
          continue;
        }
        out += this.bump();
      }
    }
    return { value: out, kind: isLiteral ? 'literal-string' : 'string' };
  }

  readValue() {
    this.skipWs();
    if (this.eof) this.error('expected a value');
    const c = this.peek();
    if (c === '"' || c === "'") return { value: this.readString().value, kind: 'string' };
    if (c === '[') return this.readArray();
    if (c === '{') return this.readInlineTable();
    // bare token
    let raw = '';
    while (!this.eof && !/[,\]\}\n#]/.test(this.peek())) { raw += this.bump(); }
    raw = raw.trim();
    if (!raw) this.error('empty value');
    if (raw === 'true') return { value: true, kind: 'bool' };
    if (raw === 'false') return { value: false, kind: 'bool' };
    if (raw === 'inf' || raw === '+inf') return { value: Infinity, kind: 'float', note: 'inf' };
    if (raw === '-inf') return { value: -Infinity, kind: 'float', note: '-inf' };
    if (raw === 'nan' || raw === '+nan' || raw === '-nan') return { value: null, kind: 'float', note: 'nan (emitted as null)' };
    if (DATE_RE.test(raw) || TIME_RE.test(raw)) {
      const m = raw.match(DATE_RE);
      if (m) {
        const hasTime = m[4] !== undefined;
        const hasOffset = m[8] !== undefined || m[9] !== undefined;
        const kind = hasTime ? (hasOffset ? 'offset-datetime' : 'local-datetime') : 'local-date';
        if (keepDates) {
          const iso = `${m[1]}-${m[2]}-${m[3]}` + (hasTime ? `T${m[4]}:${m[5]}:${m[6]}${m[7] ? '.' + m[7] : ''}${m[8] ? 'Z' : m[9] ? `${m[9]}${m[10]}:${m[11]}` : ''}` : '');
          return { value: iso, kind, parsed: Date.parse(iso) || null };
        }
        return { value: raw, kind };
      }
      return { value: raw, kind: 'local-time' };
    }
    let numStr = raw.replace(/_/g, '');
    if (/^[+-]?0x[0-9a-fA-F]+$/.test(numStr)) return { value: Number(numStr), kind: 'int', base: 16 };
    if (/^[+-]?0o[0-7]+$/.test(numStr)) return { value: Number(numStr.replace(/0o/, '0o')), kind: 'int', base: 8, note: `0o prefix` };
    if (/^[+-]?0b[01]+$/.test(numStr)) return { value: Number(numStr), kind: 'int', base: 2 };
    if (/^[+-]?\d+$/.test(numStr)) {
      const n = Number(numStr);
      if (!Number.isSafeInteger(n)) { warnings.push({ line: this.line, code: 'unsafe-integer', message: `${numStr} exceeds Number.MAX_SAFE_INTEGER, precision lost` }); }
      return { value: n, kind: 'int' };
    }
    if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(numStr)) return { value: Number(numStr), kind: 'float' };
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return { value: raw, kind: 'datetime-ish' };
    warnings.push({ line: this.line, code: 'unparsed-value', message: `could not classify ${JSON.stringify(raw.slice(0, 40))}, kept as a string` });
    return { value: raw, kind: 'bare-string' };
  }

  readArray() {
    this.bump(); // [
    const out = [];
    for (;;) {
      this.skipWsAndNewlines();
      this.skipComment();
      this.skipWsAndNewlines();
      if (this.eof) this.error('unterminated array');
      if (this.peek() === ']') { this.bump(); break; }
      const v = this.readValue();
      out.push(v.value);
      this.skipWsAndNewlines();
      this.skipComment();
      this.skipWsAndNewlines();
      if (this.peek() === ',') { this.bump(); continue; }
      if (this.peek() === ']') { this.bump(); break; }
      this.error(`expected "," or "]" in array, found ${JSON.stringify(this.peek())}`);
    }
    return { value: out, kind: 'array' };
  }

  readInlineTable() {
    this.bump(); // {
    const obj = {};
    for (;;) {
      this.skipWs();
      if (this.eof) this.error('unterminated inline table');
      if (this.peek() === '}') { this.bump(); break; }
      if (this.peek() === '\n') this.error('inline tables may not span lines');
      const path = this.readKey();
      this.skipWs();
      if (this.peek() !== '=') this.error('expected "=" in inline table');
      this.bump();
      const v = this.readValue();
      setPath(obj, path, v.value, this.line, warnings);
      this.skipWs();
      if (this.peek() === ',') { this.bump(); continue; }
      if (this.peek() === '}') { this.bump(); break; }
      this.error(`expected "," or "}" in inline table, found ${JSON.stringify(this.peek())}`);
    }
    return { value: obj, kind: 'inline-table' };
  }
}

function setPath(root, path, value, line, warns) {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!(k in node)) node[k] = {};
    if (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k])) {
      warns.push({ line, code: 'key-conflict', message: `key "${k}" was already a scalar/array, replaced by a table` });
      node[k] = {};
    }
    node = node[k];
  }
  const last = path[path.length - 1];
  if (node[last] !== undefined) warns.push({ line, code: 'duplicate-key', message: `key "${path.join('.')}" redefined (TOML forbids this)` });
  node[last] = value;
}

function parseToml(text, path) {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) { warnings.push({ line: 1, code: 'bom', message: 'file starts with a UTF-8 BOM' }); body = body.slice(1); }
  const r = new Reader(body);
  const root = {};
  const definedTables = new Set();
  const arrayTables = new Set();
  let currentPath = [];
  let currentIsArrayTable = false;

  while (!r.eof) {
    r.skipWsAndNewlines();
    r.skipComment();
    r.skipWsAndNewlines();
    if (r.eof) break;
    if (r.peek() === '[') {
      r.bump();
      const isArray = r.peek() === '[';
      if (isArray) r.bump();
      const keyPath = r.readKey();
      r.skipWs();
      if (r.peek() !== ']') r.error('expected "]" to close the table header');
      r.bump();
      if (isArray) {
        if (r.peek() !== ']') r.error('expected "]]" to close the array-of-tables header');
        r.bump();
      }
      r.skipWs();
      r.skipComment();
      if (!r.eof && r.peek() !== '\n') r.error(`unexpected content after the table header: ${JSON.stringify(r.peek())}`);
      const dotted = keyPath.join('.');
      currentPath = keyPath;
      currentIsArrayTable = isArray;
      let node = root;
      for (let i = 0; i < keyPath.length; i++) {
        const k = keyPath[i];
        const isLast = i === keyPath.length - 1;
        if (isLast && isArray) {
          if (!Array.isArray(node[k])) {
            if (node[k] !== undefined) warnings.push({ line: r.line, code: 'table-kind-conflict', message: `[[${dotted}]] replaces a non-array value` });
            node[k] = [];
          }
          const tbl = {};
          node[k].push(tbl);
          node = tbl;
          arrayTables.add(dotted);
        } else {
          if (!(k in node)) node[k] = {};
          if (typeof node[k] !== 'object' || node[k] === null || Array.isArray(node[k])) {
            warnings.push({ line: r.line, code: 'table-kind-conflict', message: `[${dotted}] conflicts with an existing non-table value at "${k}"` });
            node[k] = {};
          }
          node = node[k];
        }
      }
      if (!isArray) {
        if (definedTables.has(dotted)) warnings.push({ line: r.line, code: 'duplicate-table', message: `table [${dotted}] defined twice` });
        definedTables.add(dotted);
      }
      continue;
    }
    const keyPath = r.readKey();
    r.skipWs();
    if (r.peek() !== '=') r.error('expected "=" after the key');
    r.bump();
    const v = r.readValue();
    let node = root;
    for (const k of currentPath) {
      if (!(k in node)) node[k] = {};
      if (Array.isArray(node[k])) { node = node[k][node[k].length - 1]; continue; }
      node = node[k];
    }
    setPath(node, keyPath, v.value, r.line, warnings);
    r.skipWs();
    r.skipComment();
    if (!r.eof && r.peek() !== '\n') r.error(`unexpected content after the value: ${JSON.stringify(r.peek())}`);
  }
  return { root, definedTables, arrayTables };
}

function flatten(v, prefix, out) {
  if (Array.isArray(v)) { if (!v.length && prefix) out[prefix] = []; v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out)); }
  else if (v && typeof v === 'object') { const ks = Object.keys(v); if (!ks.length && prefix) out[prefix] = {}; ks.forEach((k) => flatten(v[k], prefix ? `${prefix}.${k}` : k, out)); }
  else out[prefix || '(root)'] = v;
  return out;
}

const paths = [];
if (flag(o, 'dir') || (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) if (ent.isFile() && /\.toml$/i.test(ent.name)) paths.push(join(dir, ent.name));
  if (!paths.length) die(`no .toml files in ${dir}`);
} else paths.push(target);

const reports = [];
for (const p of paths) {
  let text;
  try { text = p === '-' ? await readInput(p) : readFileSync(p, 'utf8'); } catch (e) { die(`cannot read ${p}: ${e.message}`); }
  const before = warnings.length;
  const { root, definedTables, arrayTables } = parseToml(text, p);
  const local = warnings.splice(before);
  const flat = flatten(root, '', {});
  const types = {};
  for (const [k, v] of Object.entries(flat)) types[k] = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  reports.push({
    file: p, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length,
    tables: [...definedTables], arrayTables: [...arrayTables],
    keyCount: Object.keys(flat).length, warnings: local,
    flat, types, document: flag(o, 'flat') ? flat : root,
  });
}

const warnCount = reports.reduce((a, r) => a + r.warnings.length, 0);

if (flag(o, 'json')) {
  const payload = reports.length > 1
    ? { files: reports.map((r) => ({ file: r.file, tables: r.tables, arrayTables: r.arrayTables, keyCount: r.keyCount, warnings: r.warnings, document: r.document })) }
    : reports[0].document;
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  for (const r of reports) {
    console.log(`${r.file} — ${r.tables.length} table(s) + ${r.arrayTables.length} array-of-table(s), ${r.keyCount} leaf key(s), ${r.warnings.length} warning(s)`);
    if (r.tables.length || r.arrayTables.length) console.log(`tables: ${[...r.tables, ...r.arrayTables.map((a) => a + '[[ ]]')].join(', ')}`);
    if (r.warnings.length) {
      console.log(table(r.warnings.slice(0, 40).map((w) => ({ line: w.line, code: w.code, message: w.message })), ['line', 'code', 'message']));
    }
    if (flag(o, 'types')) {
      console.log('\nTYPES');
      console.log(table(Object.entries(r.types).slice(0, 200).map(([k, v]) => ({
        key: k, type: v,
        preview: JSON.stringify(r.flat[k]).slice(0, 50),
      })), ['key', 'type', 'preview']));
    }
    console.log('');
    process.stdout.write(JSON.stringify(r.document, null, 2) + '\n');
  }
}
if (flag(o, 'strict') && warnCount) process.exit(1);
