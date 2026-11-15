// iniscan.js — INI/config parser and auditor: duplicate keys, quoting, whitespace, secrets.
// Copyright (c) 2026 0xnothings
// @tool iniscan
// @desc Parse INI/config files and audit duplicates, quoting inconsistencies, whitespace and secret-looking values
// @usage node tools/iniscan.js app.ini --json
// @tags data,config,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HELP = `iniscan — INI / config auditor

  node tools/iniscan.js <file.ini|config.cfg|--dir path|-> [options]

  --list            print the parsed keys as a table
  --section <name>  only report findings for this section
  --no-secrets      skip the secret-value heuristic
  --strict          exit 1 when any warning is found
  --lower           lowercase section and key names
  --json            machine-readable output
  -h, --help        this text

  Findings: duplicate sections, duplicate keys within a section, keys after a
  value with no section header (implicit global), mixed separators (= vs :),
  inconsistent quoting (some quoted, some not), trailing whitespace on values,
  BOM, CRLF/LF mix, inline comments stripped from values, empty values, secrets
  (keys matching password/token/api_key/secret with a plausible value), boolean
  spellings that disagree (true/yes/1 mixed in one file) and unparsable lines.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json', 'list', 'lower', 'no-secrets', 'strict']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const target = o._[0] || get(o, 'dir', null);
if (!target) die('need a file — node tools/iniscan.js app.ini');
const onlySection = get(o, 'section', null) ? String(get(o, 'section')) : null;
const lower = flag(o, 'lower');

const SECRET_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?key|salt|pin)/i;
const BOOLISH = { true: 'true', yes: 'true', on: 'true', '1': 'true', false: 'false', no: 'false', off: 'false', '0': 'false' };

function parseIni(text, path) {
  const findings = [];
  const add = (sev, code, detail) => findings.push({ severity: sev, code, ...detail });
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) { add('warning', 'bom', { message: 'file starts with a UTF-8 BOM' }); body = body.slice(1); }
  if (/\r\n/.test(body) && /(?<!\r)\n/.test(body)) add('warning', 'mixed-line-endings', { message: 'file mixes CRLF and LF line endings' });

  const lines = body.split(/\r?\n/);
  const sections = new Map();
  const sectionOrder = [];
  let current = null;
  let currentStart = 0;
  const seenSections = new Map();
  const separators = new Set();
  const quoting = new Set();
  const boolSpellings = new Map();
  const globalKeys = [];

  const ensure = (sectionName) => {
    if (!sections.has(sectionName)) { sections.set(sectionName, { name: sectionName, keys: [], index: sectionOrder.length }); sectionOrder.push(sectionName); }
    return sections.get(sectionName);
  };

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    if (!rawLine.trim()) return;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith(';') || trimmed.startsWith('#')) return;
    const sec = trimmed.match(/^\[([^\]]*)\]\s*(.*)$/);
    if (sec) {
      const sectionName = lower ? sec[1].trim().toLowerCase() : sec[1].trim();
      if (sec[2] && !/^[;#]/.test(sec[2])) add('warning', 'trailing-content-after-section', { line: lineNo, section: sectionName, message: `text after the section header: ${JSON.stringify(sec[2].slice(0, 40))}` });
      if (!sectionName) add('error', 'empty-section-name', { line: lineNo, message: 'section header with an empty name' });
      if (seenSections.has(sectionName)) add('warning', 'duplicate-section', { line: lineNo, section: sectionName, message: `section [${sectionName}] repeats (first at line ${seenSections.get(sectionName)})` });
      else seenSections.set(sectionName, lineNo);
      current = ensure(sectionName);
      currentStart = lineNo;
      return;
    }
    const m = rawLine.match(/^\s*([^=:]+?)\s*([=:])\s*(.*)$/);
    if (!m) { add('warning', 'unparsable-line', { line: lineNo, message: `no "key = value" structure: ${JSON.stringify(trimmed.slice(0, 50))}` }); return; }
    const keyRaw = m[1].trim();
    const key = lower ? keyRaw.toLowerCase() : keyRaw;
    separators.add(`"${m[2]}"`);
    let value = m[3];
    const hadTrailing = /\s+$/.test(value);
    const strippedInline = /[;#]/.test(value) && !/^["']/.test(value.trim());
    if (strippedInline) { const ci = value.search(/\s[;#]/); if (ci !== -1) value = value.slice(0, ci); }
    const trimmedValue = value.trim();
    if (hadTrailing && trimmedValue) add('info', 'trailing-whitespace', { line: lineNo, section: current?.name ?? '(global)', key, message: `value has trailing whitespace before the newline` });
    if (/^["']/.test(trimmedValue) || /["']$/.test(trimmedValue)) {
      const q = trimmedValue[0];
      quoting.add(q === '"' ? 'double' : 'single');
      if (trimmedValue.length < 2 || trimmedValue[trimmedValue.length - 1] !== q) add('error', 'unterminated-quote', { line: lineNo, section: current?.name ?? '(global)', key, message: `quote opened with ${q} but never closed` });
    } else quoting.add('none');
    if (!current) globalKeys.push({ key, line: lineNo });
    if (current) {
      if (current.keys.some((k) => k.key === key)) add('warning', 'duplicate-key', { line: lineNo, section: current.name, key, message: `key "${key}" repeats in [${current.name}] (first at line ${current.keys.find((k) => k.key === key).line})` });
      current.keys.push({ key, raw: keyRaw, value: trimmedValue, line: lineNo, separator: m[2], quoted: /^["']/.test(trimmedValue), empty: trimmedValue === '', inlineCommentStripped: strippedInline });
    }
    if (trimmedValue === '') add('info', 'empty-value', { line: lineNo, section: current?.name ?? '(global)', key, message: `key "${key}" has an empty value` });
    const low = trimmedValue.toLowerCase();
    if (BOOLISH[low] !== undefined) {
      const bucket = boolSpellings.get(BOOLISH[low]) || new Set();
      bucket.add(low);
      boolSpellings.set(BOOLISH[low], bucket);
    }
    if (!flag(o, 'no-secrets') && SECRET_KEY.test(keyRaw) && trimmedValue && !/^(false|true|none|null|0|1|changeme|placeholder|\*+|\$\{|<)/i.test(trimmedValue)) {
      add('warning', 'secret-value', {
        line: lineNo, section: current?.name ?? '(global)', key,
        message: `key looks secret-bearing and has a literal value (${trimmedValue.length} chars)`,
        valuePreview: trimmedValue.length > 4 ? trimmedValue.slice(0, 2) + '*'.repeat(Math.min(6, trimmedValue.length - 2)) : '****',
      });
    }
  });

  if (globalKeys.length) add('warning', 'global-keys', { line: globalKeys[0].line, message: `${globalKeys.length} key(s) appear before any [section] header: ${globalKeys.slice(0, 5).map((g) => g.key).join(', ')}` });
  if (separators.size > 1) add('info', 'mixed-separators', { message: `file mixes ${[...separators].join(' and ')} separators — parsers may disagree` });
  if (quoting.size > 1) add('info', 'inconsistent-quoting', { message: `values mix quoting styles: ${[...quoting].join(', ')}` });
  for (const [canon, spellings] of boolSpellings) if (spellings.size > 1) add('info', 'boolean-spelling', { message: `same boolean written ${[...spellings].join(' / ')} (${canon})` });

  const counts = findings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m; }, {});
  return {
    file: path, bytes: Buffer.byteLength(text, 'utf8'), lines: lines.length,
    sections: sectionOrder.map((n, i) => ({ name: n, index: i, keys: sections.get(n).keys.length, line: seenSections.get(n) || null })),
    sectionCount: sectionOrder.length,
    keyCount: [...sections.values()].reduce((a, s) => a + s.keys.length, 0),
    globalKeyCount: globalKeys.length,
    parsed: Object.fromEntries([...sections.values()].map((s) => [s.name, Object.fromEntries(s.keys.map((k, i) => {
      const dup = s.keys.slice(0, i).some((x) => x.key === k.key);
      return [dup ? `${k.key}#${i}` : k.key, k.value];
    }))])),
    findings, counts: { error: counts.error || 0, warning: counts.warning || 0, info: counts.info || 0 },
    sections_verbose: [...sections.values()].map((s) => ({ name: s.name, keys: s.keys.map((k) => ({ key: k.key, line: k.line, separator: k.separator, quoted: k.quoted, empty: k.empty, value: k.value.length > 80 ? k.value.slice(0, 77) + '...' : k.value })) })),
  };
}

const paths = [];
if (flag(o, 'dir') || (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) {
  const dir = get(o, 'dir', target);
  for (const ent of readdirSync(dir, { withFileTypes: true })) if (ent.isFile() && /\.(ini|cfg|conf|properties|env|cnf)$/i.test(ent.name)) paths.push(join(dir, ent.name));
  if (!paths.length) die(`no .ini/.cfg/.conf/.properties/.env files in ${dir}`);
} else paths.push(target);

const reports = [];
for (const p of paths) {
  let text;
  try { text = p === '-' ? await readInput(p) : readFileSync(p, 'utf8'); } catch (e) { die(`cannot read ${p}: ${e.message}`); }
  const r = parseIni(text, p);
  if (onlySection) r.findings = r.findings.filter((f) => f.section === onlySection);
  reports.push(r);
}

const anyWarn = reports.some((r) => r.counts.warning || r.counts.error);

if (flag(o, 'json')) process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : { files: reports.length, reports }, null, 2) + '\n');
else {
  for (const r of reports) {
    console.log(`${r.file} — ${r.sectionCount} section(s), ${r.keyCount} key(s), ${r.globalKeyCount} global key(s), ${r.lines} lines`);
    console.log(table(r.sections.map((s) => ({ '#': s.index, section: s.name, keys: s.keys, headerLine: s.line ?? '-' })), ['#', 'section', 'keys', 'headerLine']));
    if (flag(o, 'list')) {
      console.log('\nPARSED KEYS');
      for (const s of r.sections_verbose) {
        console.log(`\n[${s.name}]`);
        console.log(table(s.keys.map((k) => ({ key: k.key, line: k.line, sep: k.separator, quoted: k.quoted ? 'yes' : '', empty: k.empty ? 'yes' : '', value: k.value })), ['key', 'line', 'sep', 'quoted', 'empty', 'value']));
      }
    }
    if (r.findings.length) {
      console.log(`\nFINDINGS (${r.counts.error} error / ${r.counts.warning} warning / ${r.counts.info} info)`);
      console.log(table(r.findings.slice(0, 60).map((f) => ({
        severity: f.severity, code: f.code, line: f.line ?? '-', section: f.section ?? '', key: f.key ?? '', message: f.message.slice(0, 80),
      })), ['severity', 'code', 'line', 'section', 'key', 'message']));
      if (r.findings.length > 60) console.log(`... ${r.findings.length - 60} more`);
    } else console.log('\nno findings');
    console.log('');
  }
}
if (flag(o, 'strict') && anyWarn) process.exit(1);
