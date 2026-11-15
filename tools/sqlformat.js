#!/usr/bin/env node
// sqlformat.js — SQL beautifier with keyword casing, indent control and a literal-aware splitter.
// Copyright (c) 2026 0xnothings
// @tool sqlformat
// @desc Format/beautify SQL and split multi-statement scripts without breaking string literals or comments
// @usage node tools/sqlformat.js dump.sql --upper --indent 2 --split --json
// @tags data,sql,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync } from 'node:fs';

const HELP = `sqlformat — SQL formatter and statement splitter

  node tools/sqlformat.js <file.sql|-> [options]

  --upper            uppercase keywords (default)
  --lower            lowercase keywords
  --keep-case        leave keyword casing untouched
  --indent <n>       spaces per indent level (default 2)
  --split            emit one statement per record instead of formatting
  --list             with --split, list statement types and line ranges
  --wrap <n>         wrap long clauses at this column (default 100)
  --out <file>       write formatted SQL here
  --json             machine-readable output
  -h, --help         this text

  The tokenizer understands 'single quoted', "double quoted", \`backticked\`,
  [bracketed] and $$dollar quoted$$ literals, -- and # line comments, /* block
  comments */ (nestable, like PostgreSQL), and PostgreSQL ::casts and $1
  placeholders — none of which are ever rewritten. Statements are split on
  semicolons that occur outside a literal, a comment or a BEGIN ... END body.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'keep-case', 'list', 'lower', 'split']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/sqlformat.js dump.sql');
let text;
try { text = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
if (!text.trim()) die('input is empty');

const indentUnit = ' '.repeat(Math.max(1, num(get(o, 'indent', 2), 2)));
const caseMode = flag(o, 'lower') ? 'lower' : flag(o, 'keep-case') ? 'keep' : 'upper';
const wrapCol = num(get(o, 'wrap', 100), 100);

const KEYWORDS = new Set(`SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX VIEW DROP ALTER ADD COLUMN PRIMARY KEY FOREIGN REFERENCES NOT NULL DEFAULT UNIQUE CHECK CONSTRAINT JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL EXCEPT INTERSECT AS AND OR IN EXISTS BETWEEN LIKE ILIKE IS CASE WHEN THEN ELSE END BEGIN COMMIT ROLLBACK TRANSACTION DISTINCT COUNT SUM AVG MIN MAX COALESCE CAST RETURNING WITH RECURSIVE GRANT REVOKE TRUNCATE EXPLAIN ANALYZE VACUUM COPY PRIMARY KEY SERIAL BIGINT INTEGER SMALLINT TEXT VARCHAR CHAR BOOLEAN DATE TIMESTAMP TIMESTAMPTZ NUMERIC DECIMAL REAL FLOAT DOUBLE PRECISION JSON JSONB UUID BYTEA ARRAY ASC DESC NULLS FIRST LAST OVER PARTITION WINDOW FILTER ANY SOME TRUE FALSE CASCADE RESTRICT IF TEMPORARY TEMP SCHEMA DATABASE FUNCTION PROCEDURE TRIGGER LANGUAGE RETURNS DECLARE CURSOR LOOP WHILE FOR EXCEPTION ELSEIF PLPGSQL EXECUTE USING UNLOGGED CONCURRENTLY SIMULTANEOUSLY`.split(/\s+/));

const CLAUSE_BREAK = new Set(['select', 'from', 'where', 'insert into', 'values', 'update', 'set', 'delete', 'group by', 'order by', 'having', 'limit', 'offset', 'returning', 'with', 'union', 'union all', 'left join', 'right join', 'inner join', 'full join', 'cross join', 'join', 'on', 'and', 'or', ';', 'when', 'else', 'end', 'then', 'begin', 'commit']);

function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const n = sql.length;
  let line = 1;
  while (i < n) {
    const c = sql[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { const s = i; while (i < n && sql[i] !== '\n') i++; tokens.push({ t: 'comment', v: sql.slice(s, i), line }); continue; }
    if (c === '#') { const s = i; while (i < n && sql[i] !== '\n') i++; tokens.push({ t: 'comment', v: sql.slice(s, i), line }); continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const s = i; let depth = 1; i += 2;
      while (i < n && depth > 0) { if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else { if (sql[i] === '\n') line++; i++; } }
      tokens.push({ t: 'comment', v: sql.slice(s, i), line });
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; const s = i; i++;
      while (i < n) { if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } i++; break; } if (sql[i] === '\\' && q === "'") { i += 2; continue; } if (sql[i] === '\n') line++; i++; }
      tokens.push({ t: 'literal', v: sql.slice(s, i), line });
      continue;
    }
    if (c === '[') { const s = i; i++; while (i < n && sql[i] !== ']') i++; i++; tokens.push({ t: 'literal', v: sql.slice(s, i), line }); continue; }
    if (c === '$') {
      const tag = sql.slice(i).match(/^\$(\w*)\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const s = i;
        i = end === -1 ? n : end + tag[0].length;
        tokens.push({ t: 'literal', v: sql.slice(s, i), line });
        continue;
      }
      const ph = sql.slice(i).match(/^\$\d+/);
      if (ph) { i += ph[0].length; tokens.push({ t: 'word', v: ph[0], line }); continue; }
    }
    if (/[A-Za-z_]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ t: 'word', v: sql.slice(s, i), line });
      continue;
    }
    if (/\d/.test(c)) {
      const s = i;
      while (i < n && /[0-9a-fA-FxX.']/.test(sql[i])) { if (sql[i] === "'") break; i++; }
      tokens.push({ t: 'number', v: sql.slice(s, i), line });
      continue;
    }
    if (c === ':' && sql[i + 1] === ':') { i += 2; tokens.push({ t: 'op', v: '::', line }); continue; }
    const two = sql.slice(i, i + 2);
    if (['<=', '>=', '<>', '!=', '||'].includes(two)) { i += 2; tokens.push({ t: 'op', v: two, line }); continue; }
    i++;
    tokens.push({ t: 'punct', v: c, line });
  }
  return tokens;
}

function splitStatements(tokens) {
  const out = [];
  let cur = [], depth = 0, blockDepth = 0;
  const openers = new Set(['begin']);
  const closers = new Set(['end']);
  for (const tk of tokens) {
    if (tk.t === 'punct' && tk.v === '(') depth++;
    if (tk.t === 'punct' && tk.v === ')') depth = Math.max(0, depth - 1);
    if (tk.t === 'word') {
      const w = tk.v.toLowerCase();
      if (openers.has(w)) blockDepth++;
      if (closers.has(w)) blockDepth = Math.max(0, blockDepth - 1);
    }
    if (tk.t === 'punct' && tk.v === ';' && depth === 0 && blockDepth === 0) { cur.push(tk); out.push(cur); cur = []; continue; }
    cur.push(tk);
  }
  if (cur.length) out.push(cur);
  return out;
}

const tokens = tokenize(text);
const statements = splitStatements(tokens).map((toks) => {
  const firstWord = toks.find((t) => t.t === 'word');
  const verb = firstWord ? firstWord.v.toLowerCase() : '(unknown)';
  const verb2 = toks.filter((t) => t.t === 'word').slice(0, 3).map((t) => t.v.toLowerCase()).join(' ');
  return {
    verb,
    verbPhrase: verb + (verb === 'create' && verb2.includes('table') ? ' table' : verb === 'create' && verb2.includes('index') ? ' index' : ''),
    line: toks[0] ? toks[0].line : null,
    endLine: toks[toks.length - 1] ? toks[toks.length - 1].line : null,
    tokens: toks,
    text: toks.map((t) => t.v).join(' ')
      .replace(/\s+([,;)\].])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s*\.\s*/g, '.')
      .replace(/\s+/g, ' ')
      .trim(),
  };
});

function formatStatement(toks) {
  const out = [];
  let line = '';
  let depth = 0;
  const push = (s) => { line += s; };
  const newline = (indentDelta = 0) => {
    if (line.trim()) out.push(indentUnit.repeat(Math.max(0, depth + indentDelta)) + line.trim());
    line = '';
  };
  const kw = (v) => (caseMode === 'upper' ? v.toUpperCase() : caseMode === 'lower' ? v.toLowerCase() : v);
  const isKeyword = (t) => t.t === 'word' && KEYWORDS.has(t.v.toUpperCase());

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (t.t === 'comment') { newline(); out.push(indentUnit.repeat(depth) + t.v.trim()); continue; }
    if (t.t === 'word') {
      const w = t.v.toUpperCase();
      const wl = t.v.toLowerCase();
      const multi = next && next.t === 'word' ? `${wl} ${next.v.toLowerCase()}` : wl;
      const startsClause = CLAUSE_BREAK.has(wl) || CLAUSE_BREAK.has(multi);
      if (startsClause && i > 0 && line.trim()) newline();
      push((line.trim() ? ' ' : '') + (KEYWORDS.has(w) ? kw(t.v) : t.v));
      if (next && next.t === 'word' && CLAUSE_BREAK.has(multi)) continue;
      if (wl === 'select' && next && next.t !== 'punct') continue;
      continue;
    }
    if (t.t === 'literal') { push((line.trim() ? ' ' : '') + t.v); continue; }
    if (t.t === 'number') { push((line.trim() ? ' ' : '') + t.v); continue; }
    if (t.t === 'op') { push(` ${t.v} `); continue; }
    if (t.t === 'punct') {
      if (t.v === '(') {
        const before = line.trimEnd();
        if (before.length > wrapCol || /^(SELECT|WHERE|AND|OR)$/i.test(before.split(/\s+/).pop() || '')) { push('('); newline(); depth++; continue; }
        push((line.trim() ? ' ' : '') + '(');
        depth++;
        continue;
      }
      if (t.v === ')') { depth = Math.max(0, depth - 1); push(')'); continue; }
      if (t.v === ',') {
        push(',');
        newline();
        continue;
      }
      if (t.v === ';') { push(';'); newline(); continue; }
      if (t.v === '.') { push('.'); continue; }
      push(` ${t.v} `);
      continue;
    }
  }
  if (line.trim()) out.push(indentUnit.repeat(Math.max(0, depth)) + line.trim());
  if (flag(o, 'split')) return out.join('\n');
  return out.join('\n');
}

const counts = {};
for (const s of statements) counts[s.verb] = (counts[s.verb] || 0) + 1;

const report = {
  file: src, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length,
  statements: statements.length, statementTypes: counts,
  tokenCounts: tokens.reduce((m, t) => { m[t.t] = (m[t.t] || 0) + 1; return m; }, {}),
  keywordCase: caseMode, indent: indentUnit.length,
};

if (flag(o, 'split')) {
  report.split = statements.map((s, i) => ({ index: i, verb: s.verb, firstLine: s.line, lastLine: s.endLine, chars: s.text.length, sql: s.text + (s.text.trim().endsWith(';') ? '' : ';') }));
} else {
  // formatStatement takes a TOKEN ARRAY. The statement objects in `statements`
  // wrap that array in `.tokens`, so passing the object made it iterate
  // {verb, verbPhrase, line, ...} as if they were tokens — every property was
  // undefined, the formatter emitted nothing, and the tool still reported
  // "FORMATTED SQL". Pass the tokens.
  report.formatted = statements.map((s) => formatStatement(s.tokens)).join('\n\n');
}

const outFile = get(o, 'out', null);
if (outFile) writeFileSync(String(outFile), (flag(o, 'split') ? report.split.map((s) => s.sql).join('\n') : report.formatted) + '\n');

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — ${statements.length} statement(s), ${fmt(Buffer.byteLength(text, 'utf8'))} bytes, ${report.lines} lines`);
  console.log(table(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ statement: k, count: v })), ['statement', 'count']));
  if (flag(o, 'list') || flag(o, 'split')) {
    console.log('\nSTATEMENTS');
    console.log(table(statements.map((s, i) => ({
      '#': i, verb: s.verb, lines: `${s.line ?? '-'}-${s.endLine ?? '-'}`, chars: fmt(s.text.length),
      preview: s.text.slice(0, 70).replace(/\s+/g, ' '),
    })), ['#', 'verb', 'lines', 'chars', 'preview']));
  }
  if (!flag(o, 'split')) {
    console.log('\nFORMATTED SQL');
    process.stdout.write(report.formatted + '\n');
  }
  if (outFile) console.log(`\nwrote -> ${outFile}`);
}
