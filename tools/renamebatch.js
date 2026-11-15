// renamebatch.js — regex bulk rename with dry-run preview and undo script.
// Copyright (c) 2026 0xnothings
// @tool renamebatch
// @desc Regex bulk renamer with dry-run preview, collision detection and undo script
// @usage node tools/renamebatch.js ./shots --find 'IMG_(\\d+)' --replace 'photo-$1' --dry-run
// @tags files,rename,batch,cli
import { args, get, flag, die, table } from '../_lib.js';
import { readdirSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';

const HELP = `renamebatch — regex bulk rename

  node tools/renamebatch.js <dir> --find <regex> --replace <template> [options]

  --find <regex>      JavaScript regex applied to the file name (no delimiters)
  --replace <str>     replacement; supports $1..$9, $& and $<name>
  --flags <f>         regex flags (default 'g'; add 'i' for case-insensitive)
  --match <mode>      name (default) | stem (without extension) | path (full path)
  --ext <list>        only files with these extensions (comma separated)
  --recursive         walk subdirectories
  --number <start>    append a zero-padded running counter; use %n in --replace
  --pad <n>           counter width (default 3)
  --lower / --upper   case-fold the resulting name
  --slug              collapse spaces/punctuation into single dashes
  --dry-run           show the plan without touching anything (default action)
  --apply             actually rename
  --undo <file>       write a shell-agnostic undo list (node undo script)
  --json              machine-readable output
  -h, --help          this text

  Collisions are detected before anything moves: if two sources map to the same
  target, or a target already exists, the whole batch is refused.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const dir = o._[0];
if (!dir) die('need a directory — node tools/renamebatch.js ./dir --find <re> --replace <str>');
const find = get(o, 'find', null);
if (!find) die('--find <regex> is required');
const repl = String(get(o, 'replace', ''));
const flags = String(get(o, 'flags', 'g'));
const matchMode = String(get(o, 'match', 'name'));
const apply = flag(o, 'apply');

let re;
try { re = new RegExp(String(find), flags); } catch (e) { die(`bad --find regex: ${e.message}`); }

const extFilter = get(o, 'ext', null) ? String(get(o, 'ext')).split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()) : null;
const counterStart = get(o, 'number', null);
const pad = Number(get(o, 'pad', 3));

function slugify(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const targets = [];
function walk(d, depth) {
  if (depth > 32) return;
  let ents;
  try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const ent of ents) {
    const full = join(d, ent.name);
    if (ent.isDirectory()) { if (flag(o, 'recursive')) walk(full, depth + 1); continue; }
    if (!ent.isFile()) continue;
    if (extFilter) {
      const e = extname(ent.name).replace(/^\./, '').toLowerCase();
      if (!extFilter.includes(e)) continue;
    }
    targets.push(full);
  }
}
walk(dir, 0);
targets.sort();

const ext = (p) => extname(p);
const stem = (p) => basename(p, extname(p));

const plan = [];
let counter = counterStart !== null ? Number(counterStart) : 0;
for (const src of targets) {
  const subject = matchMode === 'stem' ? stem(src) : matchMode === 'path' ? src : basename(src);
  re.lastIndex = 0;
  if (!re.test(subject)) continue;
  re.lastIndex = 0;
  const replaced = subject.replace(re, counterStart !== null ? repl.replace(/%n/g, String(counter).padStart(pad, '0')) : repl);
  if (counterStart !== null) counter++;

  let newName;
  if (matchMode === 'stem') newName = replaced + ext(src);
  else if (matchMode === 'path') newName = replaced;
  else newName = replaced;

  if (flag(o, 'lower')) newName = newName.toLowerCase();
  if (flag(o, 'upper')) newName = newName.toUpperCase();
  if (flag(o, 'slug')) {
    const e = ext(newName);
    newName = slugify(basename(newName, e)) + (e ? e.toLowerCase() : '');
  }
  const dest = matchMode === 'path' ? newName : join(dirname(src), newName);
  if (dest === src) continue;
  plan.push({ from: src, to: dest });
}

const collisions = [];
const targetsSeen = new Map();
for (const p of plan) {
  const k = p.to.toLowerCase();
  if (targetsSeen.has(k)) collisions.push({ to: p.to, sources: [targetsSeen.get(k), p.from] });
  else targetsSeen.set(k, p.from);
}
for (const p of plan) {
  if (p.from === p.to) continue;
  try {
    const st = statSync(p.to);
    if (st) collisions.push({ to: p.to, reason: 'target already exists' });
  } catch { /* good — does not exist */ }
}

let applied = 0, failed = [];
if (apply) {
  if (collisions.length) die(`refusing to rename: ${collisions.length} collision(s) — see --dry-run output`);
  for (const p of plan) {
    try { renameSync(p.from, p.to); applied++; } catch (e) { failed.push({ from: p.from, error: e.message }); }
  }
}

let undoPath = null;
if (get(o, 'undo', null)) {
  undoPath = String(get(o, 'undo'));
  const lines = [
    '#!/usr/bin/env node',
    '// undo script generated by renamebatch — run with: node ' + basename(undoPath),
    "import { renameSync, existsSync } from 'node:fs';",
    'let ok = 0, skip = 0;',
    `const moves = ${JSON.stringify(plan.map((p) => [p.to, p.from]), null, 2)};`,
    'for (const [from, to] of moves) {',
    '  if (!existsSync(from)) { skip++; continue; }',
    "  try { renameSync(from, to); ok++; } catch (e) { console.error('failed', from, e.message); }",
    '}',
    'console.log(`reverted ${ok}, skipped ${skip}`);',
  ];
  writeFileSync(undoPath, lines.join('\n') + '\n', 'utf8');
}

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    dir, find: String(find), replace: repl, applied: apply ? applied : 0, mode: apply ? 'apply' : 'dry-run',
    planned: plan.length, collisions, failed, undoScript: undoPath,
    moves: plan,
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`${apply ? 'APPLIED' : 'DRY RUN'}  ${dir}`);
  out.push(`regex /${find}/${flags} -> ${JSON.stringify(repl)}  (match: ${matchMode})`);
  out.push(`${plan.length} file(s) would move`);
  out.push('');
  if (plan.length) {
    const rows = plan.slice(0, 200).map((p) => ({ from: basename(p.from), to: basename(p.to) }));
    out.push(table(rows, ['from', 'to']));
    if (plan.length > 200) out.push(`... ${plan.length - 200} more`);
  } else out.push('no file names matched');
  if (collisions.length) {
    out.push('', `COLLISIONS (${collisions.length}) — nothing will be renamed until resolved`);
    for (const c of collisions.slice(0, 20)) out.push(`  ${c.to}  <- ${(c.sources || []).join(' , ') || c.reason}`);
  }
  if (apply) out.push('', `applied ${applied}${failed.length ? `, ${failed.length} failed` : ''}`);
  else if (plan.length) out.push('', 're-run with --apply to perform the renames');
  if (undoPath) out.push(`undo script written to ${undoPath}`);
  process.stdout.write(out.join('\n') + '\n');
}
process.exit(collisions.length && apply ? 2 : 0);
