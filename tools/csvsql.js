// csvsql.js — run a SQL subset over a CSV file with a hand-written tokenizer and parser.
// Copyright (c) 2026 0xnothings
// @tool csvsql
// @desc Query a CSV file with a SQL subset: SELECT cols WHERE cond ORDER BY LIMIT
// @usage node tools/csvsql.js data.csv "SELECT name, age WHERE age > 30 ORDER BY age DESC LIMIT 5"
// @tags data,csv,sql,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const HELP = `csvsql — SQL subset over CSV

  node tools/csvsql.js <file|-> "<query>" [options]

  --json          array of row objects
  --csv           emit CSV instead of an aligned table
  --delim <c>     input delimiter (default: sniffed)
  --case          case-sensitive string comparison (default: insensitive)

  Grammar:
    SELECT * | col, col, ...
    FROM <table>                       (table name is cosmetic)
    [WHERE expr]
    [ORDER BY col [ASC|DESC] [, ...]]
    [LIMIT n]

  expr:  < > <= >= = == != <>   LIKE (with % and _)   IN (a, b, ...)
         AND OR NOT (...)        numbers versus strings auto-coerced,
         column names bare or "quoted".

  Examples:
    node tools/csvsql.js users.csv "SELECT name, city WHERE age >= 18 AND city LIKE 'New%'"
    node tools/csvsql.js users.csv "SELECT * ORDER BY signup DESC LIMIT 10" --json`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const file = o._[0];
const query = o._.slice(1).join(' ');
if (!file) die('usage: node tools/csvsql.js <file> "<query>"  (try --help)');
if (!query.trim()) die('missing query — pass a SELECT statement as the second argument');

function parseCSV(text, delim) {
  const rows = [];
  let row = [], cur = '', quoted = false, sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
      continue;
    }
    if (c === '"') { quoted = true; sawAny = true; continue; }
    if (c === delim) { row.push(cur); cur = ''; sawAny = true; continue; }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; sawAny = false; continue; }
    if (c === '\r') continue;
    cur += c; sawAny = true;
  }
  if (sawAny || cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function sniffDelim(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  let best = ',', bestN = -1;
  for (const c of [',', '\t', ';', '|']) {
    let n = 0, q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === c && !q) n++; }
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

const KEYWORDS = new Set(['select', 'from', 'where', 'order', 'by', 'limit', 'asc', 'desc',
  'and', 'or', 'not', 'like', 'in', 'is', 'null', 'offset']);

function tokenize(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === "'") {
      let s = ''; i++;
      while (i < sql.length) {
        if (sql[i] === "'") { if (sql[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
        s += sql[i++];
      }
      out.push({ t: 'str', v: s }); continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let s = ''; i++;
      while (i < sql.length && sql[i] !== close) s += sql[i++];
      i++;
      out.push({ t: 'ident', v: s }); continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let s = '';
      while (i < sql.length && /[0-9.eE+-]/.test(sql[i])) {
        if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(sql[i - 1] || '')) break;
        s += sql[i++];
      }
      const n = Number(s);
      out.push(Number.isFinite(n) ? { t: 'num', v: n } : { t: 'ident', v: s });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < sql.length && /[A-Za-z0-9_$.]/.test(sql[i])) s += sql[i++];
      const low = s.toLowerCase();
      out.push(KEYWORDS.has(low) ? { t: 'kw', v: low } : { t: 'ident', v: s });
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (two === '!=' || two === '<>' || two === '<=' || two === '>=' || two === '==') {
      out.push({ t: 'op', v: two === '==' ? '=' : two }); i += 2; continue;
    }
    if ('=<>(),*'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  return out;
}

function parser(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const isKw = (v) => !!peek() && peek().t === 'kw' && peek().v === v;
  const isOp = (v) => !!peek() && peek().t === 'op' && peek().v === v;
  const expectKw = (v) => { if (!isKw(v)) throw new Error(`expected ${v.toUpperCase()} near ${describe(peek())}`); p++; };
  const expectOp = (v) => { if (!isOp(v)) throw new Error(`expected '${v}' near ${describe(peek())}`); p++; };
  const describe = (t) => (t ? `${t.t} '${t.v}'` : 'end of query');

  const q = { columns: null, table: '', where: null, order: [], limit: null };

  expectKw('select');
  if (isOp('*')) { p++; q.columns = null; }
  else {
    q.columns = [];
    for (;;) {
      const t = next();
      if (!t) throw new Error('expected column name after SELECT');
      q.columns.push(t.v);
      if (isOp(',')) { p++; continue; }
      break;
    }
  }
  if (isKw('from')) { p++; const t = next(); if (!t) throw new Error('expected table name after FROM'); q.table = String(t.v); }

  if (isKw('where')) { p++; q.where = parseOr(); }

  if (isKw('order')) {
    p++; expectKw('by');
    for (;;) {
      const t = next();
      if (!t) throw new Error('expected column after ORDER BY');
      let dir = 'asc';
      if (isKw('asc')) { p++; } else if (isKw('desc')) { dir = 'desc'; p++; }
      q.order.push({ col: String(t.v), dir });
      if (isOp(',')) { p++; continue; }
      break;
    }
  }
  if (isKw('limit')) {
    p++;
    const t = next();
    if (!t || t.t !== 'num') throw new Error('expected a number after LIMIT');
    q.limit = t.v;
  }

  function parseOr() {
    let left = parseAnd();
    while (isKw('or')) { p++; left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isKw('and')) { p++; left = { type: 'and', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (isKw('not')) { p++; return { type: 'not', expr: parseNot() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    if (isOp('(')) { p++; const e = parseOr(); expectOp(')'); return e; }
    const col = next();
    if (!col) throw new Error('unexpected end of WHERE clause');
    const colName = String(col.v);
    if (isKw('is')) {
      p++;
      let neg = false;
      if (isKw('not')) { p++; neg = true; }
      expectKw('null');
      return { type: 'null', col: colName, neg };
    }
    if (isKw('in')) {
      p++;
      expectOp('(');
      const list = [];
      for (;;) {
        const t = next();
        if (!t) throw new Error('unterminated IN list');
        list.push(t.v);
        if (isOp(',')) { p++; continue; }
        break;
      }
      expectOp(')');
      let neg = false;
      return { type: 'in', col: colName, list, neg };
    }
    if (isKw('like')) {
      p++;
      const pat = next();
      if (!pat) throw new Error('expected pattern after LIKE');
      return { type: 'like', col: colName, pattern: String(pat.v) };
    }
    if (isKw('not')) {
      p++;
      if (isKw('like')) {
        p++;
        const pat = next();
        return { type: 'notlike', col: colName, pattern: String(pat.v) };
      }
      if (isKw('in')) {
        p++;
        expectOp('(');
        const list = [];
        for (;;) { const t = next(); if (!t) throw new Error('unterminated IN list'); list.push(t.v); if (isOp(',')) { p++; continue; } break; }
        expectOp(')');
        return { type: 'in', col: colName, list, neg: true };
      }
      throw new Error('expected LIKE or IN after NOT');
    }
    if (peek() && peek().t === 'op') {
      const opTok = next();
      const rhs = next();
      if (!rhs) throw new Error(`expected a value after '${opTok.v}'`);
      return { type: 'cmp', col: colName, op: opTok.v, value: rhs.v };
    }
    throw new Error(`expected a comparison operator after column '${colName}'`);
  }

  if (p < tokens.length) throw new Error(`unexpected token ${describe(peek())}`);
  return q;
}

const asNum = (v) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

function compare(a, b, caseSensitive) {
  const na = asNum(a), nb = asNum(b);
  if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = String(a ?? ''), sb = String(b ?? '');
  const x = caseSensitive ? sa : sa.toLowerCase();
  const y = caseSensitive ? sb : sb.toLowerCase();
  return x === y ? 0 : x < y ? -1 : 1;
}

function likeToRe(pattern) {
  let re = '^';
  for (const ch of String(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$', 'i');
}

function evalExpr(expr, row, cs) {
  switch (expr.type) {
    case 'and': return evalExpr(expr.left, row, cs) && evalExpr(expr.right, row, cs);
    case 'or': return evalExpr(expr.left, row, cs) || evalExpr(expr.right, row, cs);
    case 'not': return !evalExpr(expr.expr, row, cs);
    case 'null': {
      const v = row[expr.col];
      const isnull = v === undefined || v === null || String(v).trim() === '';
      return expr.neg ? !isnull : isnull;
    }
    case 'in': {
      const hit = expr.list.some((v) => compare(row[expr.col], v, cs) === 0);
      return expr.neg ? !hit : hit;
    }
    case 'like': return likeToRe(expr.pattern).test(String(row[expr.col] ?? ''));
    case 'notlike': return !likeToRe(expr.pattern).test(String(row[expr.col] ?? ''));
    case 'cmp': {
      const c = compare(row[expr.col], expr.value, cs);
      switch (expr.op) {
        case '=': return c === 0;
        case '!=': case '<>': return c !== 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '>=': return c >= 0;
        default: return false;
      }
    }
    default: return false;
  }
}

function toCSV(rows, cols) {
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

const raw = await readInput(file);
if (!raw.trim()) die('empty input');
const dOpt = get(o, 'delim', null);
const delim = dOpt ? (dOpt === '\\t' ? '\t' : dOpt) : sniffDelim(raw);
const grid = parseCSV(raw, delim);
const header = grid[0].map((h, i) => h.trim() || `col${i + 1}`);
const data = grid.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));

let q;
try { q = parser(tokenize(query)); } catch (e) { die(`parse error: ${e.message}`); }

const cs = flag(o, 'case');
for (const c of q.columns || []) {
  if (!header.includes(c)) die(`unknown column '${c}' — available: ${header.join(', ')}`);
}
const selCols = q.columns && !q.columns.includes('*') ? q.columns.filter((c) => header.includes(c)) : header;

let rows = q.where ? data.filter((r) => evalExpr(q.where, r, cs)) : data.slice();
for (const { col, dir } of [...q.order].reverse()) {
  rows = rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const c = compare(a.r[col], b.r[col], cs);
    return (c !== 0 ? c : a.i - b.i) * (dir === 'desc' ? -1 : 1);
  }).map((x) => x.r);
}
const total = rows.length;
if (q.limit !== null) rows = rows.slice(0, q.limit);
const out = rows.map((r) => Object.fromEntries(selCols.map((c) => [c, r[c] ?? ''])));

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({ query, columns: selCols, matched: total, returned: out.length, rows: out }, null, 2) + '\n');
} else if (flag(o, 'csv')) {
  process.stdout.write(toCSV(out, selCols) + '\n');
} else {
  process.stdout.write(table(out, selCols) + '\n');
  process.stdout.write(`\n${out.length} row(s) shown, ${total} matched\n`);
}
