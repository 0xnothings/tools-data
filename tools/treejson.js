#!/usr/bin/env node
// treejson.js — directory tree as JSON with sizes and per-extension totals.
// Copyright (c) 2026 0xnothings
// @tool treejson
// @desc Emit a directory tree as JSON with file sizes, per-extension and per-dir totals
// @usage node tools/treejson.js ./src --depth 3 --json
// @tags files,tree,json,cli
import { args, get, num, flag, die, table } from '../_lib.js';
import { readdirSync, lstatSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const HELP = `treejson — directory tree as JSON

  node tools/treejson.js <dir> [options]

  --depth <n>         max recursion depth (default 6, 0 = unlimited)
  --min-size <n>      skip files smaller than n bytes
  --ext <list>        only include these extensions
  --exclude <glob>    skip path substrings (repeatable)
  --dirs-only         omit files from the tree
  --no-files          same as --dirs-only
  --sort <mode>       name (default) | size | count
  --top <n>           show top n dirs/extensions in the text summary (default 15)
  --text              render an ASCII tree instead of JSON
  --json              machine-readable output (default when stdout is piped)
  -h, --help          this text

  Every node carries size (recursive total), files (recursive count) and its
  direct children, so you can find the directory that is eating your disk.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const root = o._[0];
if (!root) die('need a directory — node tools/treejson.js ./src');

const maxDepth = num(get(o, 'depth', 6), 6);
const minSize = num(get(o, 'min-size', 0), 0);
const extFilter = get(o, 'ext', null) ? String(get(o, 'ext')).split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()) : null;
const excludes = [];
for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--exclude' && process.argv[i + 1]) excludes.push(process.argv[i + 1]);
const dirsOnly = flag(o, 'dirs-only') || flag(o, 'no-files');
const sortMode = String(get(o, 'sort', 'name'));
const topN = num(get(o, 'top', 15), 15);

const extTotals = new Map();
const dirTotals = [];
let filesSeen = 0, dirsSeen = 0, errors = 0, skipped = 0;

function walk(dir, depth) {
  const node = { name: basename(dir) || dir, type: 'dir', size: 0, files: 0, dirs: 0, children: [] };
  dirsSeen++;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { errors++; return node; }
  for (const ent of ents) {
    const full = join(dir, ent.name);
    if (excludes.some((x) => full.includes(x))) { skipped++; continue; }
    let st;
    try { st = lstatSync(full); } catch { errors++; continue; }
    if (st.isSymbolicLink()) { node.children.push({ name: ent.name, type: 'symlink', size: 0 }); continue; }
    if (st.isDirectory()) {
      if (maxDepth && depth + 1 > maxDepth) { node.children.push({ name: ent.name, type: 'dir', truncated: true, size: 0, files: 0 }); continue; }
      const child = walk(full, depth + 1);
      node.size += child.size;
      node.files += child.files;
      node.dirs += child.dirs + 1;
      if (!dirsOnly || true) node.children.push(child);
    } else if (st.isFile()) {
      const e = extname(ent.name).replace(/^\./, '').toLowerCase() || '(none)';
      extTotals.set(e, (extTotals.get(e) || 0) + st.size);
      if (st.size < minSize) { skipped++; continue; }
      if (extFilter && !extFilter.includes(e)) { skipped++; continue; }
      filesSeen++;
      node.size += st.size;
      node.files += 1;
      if (!dirsOnly) {
        node.children.push({ name: ent.name, type: 'file', size: st.size, ext: e, mtime: new Date(st.mtimeMs).toISOString() });
      }
    }
  }
  if (sortMode === 'size') node.children.sort((a, b) => b.size - a.size);
  else if (sortMode === 'count') node.children.sort((a, b) => (b.files || 0) - (a.files || 0));
  else node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  dirTotals.push({ path: dir, size: node.size, files: node.files });
  return node;
}

let tree;
try {
  const st = lstatSync(root);
  if (!st.isDirectory()) die(`${root} is not a directory`);
  tree = walk(root, 0);
} catch (e) { die(`cannot read ${root}: ${e.message}`); }

const human = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const exts = [...extTotals.entries()].sort((a, b) => b[1] - a[1]);
const heaviest = [...dirTotals].sort((a, b) => b.size - a.size);

const useText = flag(o, 'text') || (!flag(o, 'json') && process.stdout.isTTY && !process.env.TREEJSON_JSON);

if (flag(o, 'json') || !useText) {
  process.stdout.write(JSON.stringify({
    root,
    generated: new Date().toISOString(),
    totals: { files: filesSeen, dirs: dirsSeen, size: tree.size, humanSize: human(tree.size), errors, skipped },
    extensions: exts.map(([ext, size]) => ({ ext, size, humanSize: human(size), share: tree.size ? Number((size / tree.size).toFixed(4)) : 0 })),
    heaviestDirs: heaviest.slice(0, topN).map((d) => ({ path: d.path, size: d.size, humanSize: human(d.size), files: d.files })),
    tree,
  }, null, 2) + '\n');
} else {
  const out = [];
  const render = (node, prefix, isLast, depth) => {
    const label = node.type === 'dir' ? `${node.name}/` : node.name;
    out.push(`${prefix}${isLast ? '└─ ' : '├─ '}${label}${node.type === 'file' ? `  ${human(node.size)}` : node.type === 'dir' ? `  ${human(node.size)} (${node.files} files)` : ''}`);
    if (node.children) {
      const kids = node.children;
      kids.forEach((c, i) => render(c, prefix + (isLast ? '   ' : '│  '), i === kids.length - 1, depth + 1));
    }
  };
  out.push(`${root}  ${human(tree.size)}  ${tree.files} files  ${tree.dirs} dirs`);
  render(tree, '', true, 0);
  out.push('', 'EXTENSIONS');
  out.push(table(exts.slice(0, topN).map(([ext, size]) => ({ ext, size: human(size), files: '', share: `${tree.size ? ((size / tree.size) * 100).toFixed(1) : '0.0'}%` })), ['ext', 'size', 'share']));
  out.push('', 'HEAVIEST DIRECTORIES');
  out.push(table(heaviest.slice(0, topN).map((d) => ({ path: d.path.length > 60 ? '...' + d.path.slice(-57) : d.path, size: human(d.size), files: d.files })), ['path', 'size', 'files']));
  if (errors) out.push('', `${errors} unreadable path(s), ${skipped} skipped by filter`);
  process.stdout.write(out.join('\n') + '\n');
}
