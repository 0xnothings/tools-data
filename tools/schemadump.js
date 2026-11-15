// schemadump.js — extract a schema from a SQL dump: CREATE TABLE into tables, columns, keys, indexes.
// Copyright (c) 2026 0xnothings
// @tool schemadump
// @desc Parse CREATE TABLE/INDEX statements out of a SQL dump into a structured schema with keys and columns
// @usage node tools/schemadump.js dump.sql --json
// @tags data,sql,schema,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';

const HELP = `schemadump — SQL dump schema extractor

  node tools/schemadump.js <dump.sql|-> [options]

  --table <name>    only this table
  --sql             emit reconstructed CREATE TABLE statements
  --markdown        emit a markdown schema document
  --dot             emit a Graphviz ER diagram (tables + foreign keys)
  --out <file>      write the chosen rendering here
  --json            machine-readable output
  -h, --help        this text

  Handles MySQL/MariaDB, PostgreSQL and SQLite dumps: column definitions with
  types, lengths, precision, nullability, defaults and auto-increment; PRIMARY
  KEY / UNIQUE / FOREIGN KEY constraints declared inline or as table-level
  clauses; CREATE INDEX and CREATE UNIQUE INDEX; ALTER TABLE ... ADD CONSTRAINT;
  INSERT count per table (to show row volume without reading the data); and
  ENGINE/CHARSET/COLLATE table options.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['dot', 'json', 'markdown', 'sql']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need a file — node tools/schemadump.js dump.sql');
let text;
try { text = src !== '-' ? readFileSync(src, 'utf8') : await readInput(src); } catch (e) { die(`cannot read ${src}: ${e.message}`); }
if (!text.trim()) die('input is empty');

const onlyTable = get(o, 'table', null) ? String(get(o, 'table')).replace(/[`"\[\]]/g, '') : null;
const notes = [];

function stripLiterals(sql) {
  // replace string literals and comments with spaces so paren matching is safe
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += ' ';
      i++;
      while (i < n) { if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } i++; break; } if (sql[i] === '\\' && q === "'") { i += 2; continue; } i++; }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

const clean = stripLiterals(text);

const TABLE_OPTS = ['ENGINE', 'DEFAULT CHARSET', 'CHARSET', 'COLLATE', 'AUTO_INCREMENT', 'ROW_FORMAT', 'COMMENT', 'TABLESPACE', 'WITHOUT ROWID', 'STRICT'];

function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const tables = new Map();
const indexes = [];
let insertCounts = new Map();
const insertRe = /INSERT\s+(?:IGNORE\s+)?INTO\s+[`"[]?([\w$.]+)[`"\]]?/gi;
let im;
while ((im = insertRe.exec(clean)) !== null) insertCounts.set(im[1].split('.').pop(), (insertCounts.get(im[1].split('.').pop()) || 0) + 1);

const createRe = /CREATE\s+(?:TEMPORARY\s+|UNLOGGED\s+|GLOBAL\s+TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[]?[\w$.]+[`"\]]?)\s*\(/gi;
let m;
while ((m = createRe.exec(clean)) !== null) {
  const rawName = m[1].replace(/[`"\[\]]/g, '');
  const tblName = rawName.split('.').pop();
  const schema = rawName.includes('.') ? rawName.split('.').slice(0, -1).join('.') : null;
  const openAt = m.index + m[0].length - 1;
  let depth = 0, i = openAt, body = '';
  for (; i < clean.length; i++) {
    const c = clean[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
    if (depth >= 1) body += c;
  }
  body = body.slice(1);
  const closeAt = i;
  const tail = clean.slice(closeAt + 1, closeAt + 400);
  const opts = {};
  for (const opt of TABLE_OPTS) {
    const rx = new RegExp(`${opt}\\s*[=\\s]\\s*([\\w.'"\\-]+)`, 'i');
    const om = tail.match(rx);
    if (om) opts[opt] = om[1].replace(/['"]/g, '');
  }
  const defs = splitTopLevel(body);
  const columns = [];
  const primaryKey = [];
  const uniques = [];
  const foreignKeys = [];
  const checks = [];
  for (const def of defs) {
    const d = def.trim();
    if (!d) continue;
    const upper = d.toUpperCase();
    // strip a leading CONSTRAINT <name> clause so the real clause keyword becomes visible
    let clause = d;
    const namedMatch = clause.match(/^CONSTRAINT\s+[`"[]?([\w$]+)[`"\]]?\s+([\s\S]*)$/i);
    if (namedMatch) clause = namedMatch[2];
    const upperC = clause.toUpperCase();
    if (/^PRIMARY\s+KEY/i.test(upperC)) {
      const cols = (clause.match(/\(([^)]*)\)/) || [, ''])[1];
      primaryKey.push(...cols.split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')).filter(Boolean));
      continue;
    }
    if (/^UNIQUE/i.test(upperC)) {
      const cols = (clause.match(/\(([^)]*)\)/) || [, ''])[1];
      uniques.push({ name: namedMatch ? namedMatch[1] : null, columns: cols.split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')).filter(Boolean) });
      continue;
    }
    if (/^(FOREIGN\s+KEY|KEY|INDEX)\b/i.test(upperC)) {
      const cols = (clause.match(/\(([^)]*)\)/) || [, ''])[1];
      const ref = clause.match(/REFERENCES\s+([`"[]?[\w$.]+[`"\]]?)\s*\(([^)]*)\)/i);
      const entry = {
        name: namedMatch ? namedMatch[1] : (clause.match(/^(?:FOREIGN\s+KEY\s+|KEY\s+|INDEX\s+)?[`"[]?([\w$]+)[`"\]]?/i) || [, null])[1],
        columns: cols.split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')).filter(Boolean),
      };
      if (ref) {
        entry.references = { table: ref[1].replace(/[`"\[\]]/g, '').split('.').pop(), columns: ref[2].split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')) };
        const onDelete = clause.match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT)/i);
        if (onDelete) entry.onDelete = onDelete[1].replace(/\s+/g, ' ').toUpperCase();
        entry.source = 'table-definition';
        foreignKeys.push(entry);
      } else indexes.push({ table: tblName, name: entry.name, columns: entry.columns, unique: false, source: 'table-definition' });
      continue;
    }
    if (/^CHECK/i.test(upperC)) { checks.push(clause.slice(0, 120)); continue; }
    if (/^(FULLTEXT|SPATIAL)\b/i.test(upperC)) { continue; }

    const cm = clause.match(/^([`"[]?[\w$]+[`"\]]?)\s+([\s\S]+)$/);
    if (!cm) { notes.push({ kind: 'unparsed-column', table: tblName, text: d.slice(0, 60) }); continue; }
    const colName = cm[1].replace(/[`"\[\]]/g, '');
    const after = cm[2];
    // the type is everything up to the first constraint keyword
    const CONSTRAINT_KW = /\b(NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|UNIQUE(?!\s*\()|AUTO_INCREMENT|AUTOINCREMENT|REFERENCES|CHECK|COLLATE|COMMENT|GENERATED|ON\s+UPDATE|CHARACTER\s+SET|CONSTRAINT)\b/i;
    const kwAt = after.search(CONSTRAINT_KW);
    const typeRaw = (kwAt === -1 ? after : after.slice(0, kwAt)).trim();
    const rest = kwAt === -1 ? '' : after.slice(kwAt);
    const lenM = typeRaw.match(/\(([^)]*)\)/);
    const baseType = typeRaw.replace(/\s*\([^)]*\)/, '').trim();
    const col = {
      name: colName,
      type: baseType,
      rawType: typeRaw,
      length: lenM ? lenM[1] : null,
      nullable: !/NOT\s+NULL/i.test(rest),
      default: (rest.match(/DEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i) || [, null])[1],
      autoIncrement: /AUTO_INCREMENT|AUTOINCREMENT|SERIAL|GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i.test(typeRaw + ' ' + rest),
      unsigned: /UNSIGNED/i.test(typeRaw + rest),
      primaryKey: /PRIMARY\s+KEY/i.test(rest),
      unique: /UNIQUE/i.test(rest),
      inlineReferences: (() => {
        const r = rest.match(/REFERENCES\s+([`"[]?[\w$.]+[`"\]]?)\s*\(([^)]*)\)/i);
        return r ? { table: r[1].replace(/[`"\[\]]/g, '').split('.').pop(), columns: r[2].split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')) } : null;
      })(),
      comment: (rest.match(/COMMENT\s+('[^']*'|"[^"]*")/i) || [, null])[1],
      check: (rest.match(/CHECK\s*\(([^)]*)\)/i) || [, null])[1],
      collate: (rest.match(/COLLATE\s+(\S+)/i) || [, null])[1],
    };
    if (col.primaryKey) primaryKey.push(col.name);
    if (col.unique) uniques.push({ name: null, columns: [col.name] });
    if (col.inlineReferences) foreignKeys.push({ name: null, columns: [col.name], references: col.inlineReferences, source: 'inline' });
    columns.push(col);
  }
  tables.set(tblName, { name: tblName, schema, columns, primaryKey, uniques, foreignKeys, checks, options: opts, insertStatements: insertCounts.get(tblName) || 0, line: clean.slice(0, m.index).split('\n').length });
}

const idxRe = /CREATE\s+(UNIQUE\s+)?INDEX\s+([`"[]?[\w$]+[`"\]]?)\s+ON\s+([`"[]?[\w$.]+[`"\]]?)\s*\(([^)]*)\)/gi;
let xm;
while ((xm = idxRe.exec(clean)) !== null) {
  indexes.push({
    table: xm[3].replace(/[`"\[\]]/g, '').split('.').pop(),
    name: xm[2].replace(/[`"\[\]]/g, ''),
    columns: xm[4].split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '').replace(/\s+(ASC|DESC)$/i, '')).filter(Boolean),
    unique: !!xm[1],
    source: 'create-index',
  });
}

const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?([`"[]?[\w$.]+[`"\]]?)\s+ADD\s+(?:CONSTRAINT\s+([`"[]?[\w$]+[`"\]]?)\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s+REFERENCES\s+([`"[]?[\w$.]+[`"\]]?)\s*\(([^)]*)\)([^;]*)/gi;
let am;
while ((am = alterRe.exec(clean)) !== null) {
  const tbl = am[1].replace(/[`"\[\]]/g, '').split('.').pop();
  const fk = {
    name: am[2] ? am[2].replace(/[`"\[\]]/g, '') : null,
    columns: am[3].split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')),
    references: { table: am[4].replace(/[`"\[\]]/g, '').split('.').pop(), columns: am[5].split(',').map((c) => c.trim().replace(/[`"\[\]]/g, '')) },
    onDelete: (am[6].match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION)/i) || [, null])[1],
    source: 'alter-table',
  };
  if (tables.has(tbl)) tables.get(tbl).foreignKeys.push(fk);
  else notes.push({ kind: 'alter-for-unknown-table', table: tbl });
}

for (const idx of indexes) {
  const t = tables.get(idx.table);
  if (t) t.indexes = t.indexes || [];
  if (t) t.indexes.push(idx);
}

let list = [...tables.values()].map((t) => ({ ...t, indexes: t.indexes || [] }));
if (onlyTable) { list = list.filter((t) => t.name === onlyTable); if (!list.length) die(`no table named "${onlyTable}" in the dump`); }

const typeHistogram = {};
for (const t of list) for (const c of t.columns) typeHistogram[c.type.toUpperCase()] = (typeHistogram[c.type.toUpperCase()] || 0) + 1;

const report = {
  file: src, bytes: Buffer.byteLength(text, 'utf8'), dialect: /AUTO_INCREMENT|ENGINE=/.test(text) ? 'mysql/mariadb' : /SERIAL|::|plpgsql/i.test(text) ? 'postgresql' : /AUTOINCREMENT/.test(text) ? 'sqlite' : 'unknown',
  tableCount: list.length, tables: list, indexCount: indexes.length,
  foreignKeyCount: list.reduce((a, t) => a + t.foreignKeys.length, 0),
  columnCount: list.reduce((a, t) => a + t.columns.length, 0),
  typeHistogram, notes,
  insertCounts: Object.fromEntries(insertCounts),
};

const renderSql = () => list.map((t) => {
  const lines = t.columns.map((c) => {
    let s = `  \`${c.name}\` ${c.rawType}`;
    if (!c.nullable) s += ' NOT NULL';
    if (c.default !== null) s += ` DEFAULT ${c.default}`;
    if (c.autoIncrement) s += ' AUTO_INCREMENT';
    if (c.comment) s += ` COMMENT ${c.comment}`;
    return s;
  });
  if (t.primaryKey.length) lines.push(`  PRIMARY KEY (${t.primaryKey.map((c) => `\`${c}\``).join(', ')})`);
  for (const u of t.uniques) lines.push(`  UNIQUE${u.name ? ' ' + u.name : ''} (${u.columns.map((c) => `\`${c}\``).join(', ')})`);
  for (const f of t.foreignKeys) lines.push(`  FOREIGN KEY (${f.columns.map((c) => `\`${c}\``).join(', ')}) REFERENCES \`${f.references.table}\` (${f.references.columns.join(', ')})${f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}`);
  for (const k of t.indexes) lines.push(`  KEY ${k.name ? '`' + k.name + '` ' : ''}(${k.columns.map((c) => `\`${c}\``).join(', ')})${k.unique ? ' /* unique */' : ''}`);
  return `CREATE TABLE \`${t.name}\` (\n${lines.join(',\n')}\n)${Object.keys(t.options).length ? ' ' + Object.entries(t.options).map(([k, v]) => `${k}=${v}`).join(' ') : ''};`;
}).join('\n\n');

const renderMarkdown = () => {
  const out = ['# Schema', '', `${list.length} table(s), ${report.columnCount} column(s), ${report.foreignKeyCount} foreign key(s).`, ''];
  for (const t of list) {
    out.push(`## ${t.name}${t.schema ? ` (schema ${t.schema})` : ''}`, '');
    if (t.insertStatements) out.push(`~${t.insertStatements} INSERT statement(s) in this dump.`, '');
    out.push('| Column | Type | Null | Default | Keys |', '|---|---|---|---|---|');
    for (const c of t.columns) {
      const keys = [c.primaryKey || t.primaryKey.includes(c.name) ? 'PK' : null, c.unique ? 'UQ' : null, t.foreignKeys.some((f) => f.columns.includes(c.name)) ? 'FK' : null, c.autoIncrement ? 'AI' : null].filter(Boolean).join(' ');
      out.push(`| ${c.name} | ${c.rawType} | ${c.nullable ? 'yes' : 'no'} | ${c.default ?? ''} | ${keys} |`);
    }
    if (t.foreignKeys.length) {
      out.push('', 'Foreign keys:', '');
      for (const f of t.foreignKeys) out.push(`- (${f.columns.join(', ')}) -> ${f.references.table}(${f.references.columns.join(', ')})${f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}`);
    }
    if (t.indexes.length) {
      out.push('', 'Indexes:', '');
      for (const k of t.indexes) out.push(`- ${k.name || '(unnamed)'} (${k.columns.join(', ')})${k.unique ? ' UNIQUE' : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
};

const renderDot = () => {
  const lines = ['digraph schema {', '  rankdir=LR;', '  node [shape=record, fontname="monospace"];'];
  const ids = new Map();
  list.forEach((t, i) => {
    ids.set(t.name, `t${i}`);
    const cells = t.columns.map((c) => `${c.name} : ${c.rawType}${c.primaryKey || t.primaryKey.includes(c.name) ? ' (PK)' : ''}`).join('|').replace(/[<>{}|"]/g, '');
    lines.push(`  t${i} [label="{${t.name}|${cells}}"];`);
  });
  for (const t of list) {
    for (const f of t.foreignKeys) {
      const a = ids.get(t.name), b = ids.get(f.references.table);
      if (a && b) lines.push(`  ${a} -> ${b} [label="${f.columns.join(',')}"];`);
    }
  }
  lines.push('}');
  return lines.join('\n');
};

const outFile = get(o, 'out', null);
const renderKind = flag(o, 'sql') ? 'sql' : flag(o, 'markdown') ? 'markdown' : flag(o, 'dot') ? 'dot' : null;
if (outFile && renderKind) writeFileSync(String(outFile), (renderKind === 'sql' ? renderSql() : renderKind === 'markdown' ? renderMarkdown() : renderDot()) + '\n');

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — dialect ${report.dialect}, ${list.length} table(s), ${report.columnCount} column(s), ${report.foreignKeyCount} FK(s), ${indexes.length} index statement(s)`);
  console.log('\n' + table(list.map((t) => ({
    table: t.name, columns: t.columns.length, pk: t.primaryKey.join(',') || '-',
    fks: t.foreignKeys.length, indexes: t.indexes.length, inserts: t.insertStatements, line: t.line,
  })), ['table', 'columns', 'pk', 'fks', 'indexes', 'inserts', 'line']));
  console.log('\nTYPE HISTOGRAM');
  console.log(table(Object.entries(typeHistogram).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ type: k, columns: v })), ['type', 'columns']));
  if (report.foreignKeyCount) {
    console.log('\nFOREIGN KEYS');
    const rows = [];
    for (const t of list) for (const f of t.foreignKeys) rows.push({ from: `${t.name}(${f.columns.join(',')})`, to: `${f.references.table}(${f.references.columns.join(',')})`, onDelete: f.onDelete || '', source: f.source || 'table-definition' });
    console.log(table(rows, ['from', 'to', 'onDelete', 'source']));
  }
  if (renderKind) {
    console.log(`\n${renderKind.toUpperCase()} RENDER`);
    process.stdout.write((renderKind === 'sql' ? renderSql() : renderKind === 'markdown' ? renderMarkdown() : renderDot()) + '\n');
  }
  if (notes.length) console.log(`\n${notes.length} note(s): ${notes.slice(0, 6).map((n) => n.kind).join(', ')}`);
  if (outFile && renderKind) console.log(`\nwrote ${renderKind} -> ${outFile}`);
}
