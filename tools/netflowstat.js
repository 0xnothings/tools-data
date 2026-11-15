#!/usr/bin/env node
// netflowstat.js — aggregate flow records (CSV/JSON) into per-host byte, packet and port totals.
// Copyright (c) 2026 0xnothings
// @tool netflowstat
// @desc Roll up flow records by source, destination, port and ASN-ish group with top-N and share tables
// @usage node tools/netflowstat.js flows.csv --by src,dst --top 15 --json
// @tags data,network,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `netflowstat — flow record aggregation

  node tools/netflowstat.js <flows.csv|flows.json|-> [options]

  --by <list>       group keys: src,dst,sport,dport,proto,dir,pair (default src)
  --bytes <col>     byte column name (auto-detected)
  --packets <col>   packet column name (auto-detected)
  --top <n>         rows per table (default 15)
  --since <time>    drop records before this ISO time
  --until <time>    drop records after this ISO time
  --min-bytes <n>   drop records smaller than n bytes
  --subnet <n>      roll IPs up to /n (e.g. --subnet 24)
  --share           add a percentage-of-total column (default on)
  --json            machine-readable output
  -h, --help        this text

  Accepts CSV/TSV with a header (columns matched by common aliases: srcaddr,
  source_ip, sa, client, …) or a JSON array of objects. 'pair' groups by the
  unordered {src,dst} conversation, which is what you want for top talker
  lists where both directions should merge.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['json']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need input — node tools/netflowstat.js flows.csv');
const text = await readInput(src);
if (!text.trim()) die('input is empty');

const topN = num(get(o, 'top', 15), 15);
const byKeys = String(get(o, 'by', 'src')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const validKeys = ['src', 'dst', 'sport', 'dport', 'proto', 'dir', 'pair', 'srcport', 'dstport'];
for (const k of byKeys) if (!validKeys.includes(k)) die(`unknown --by key "${k}" — use ${validKeys.join(', ')}`);
const subnet = num(get(o, 'subnet', 0), 0);
const minBytes = num(get(o, 'min-bytes', 0), 0);
const since = get(o, 'since', null) !== null ? Date.parse(String(get(o, 'since'))) : null;
const until = get(o, 'until', null) !== null ? Date.parse(String(get(o, 'until'))) : null;

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const ALIASES = {
  src: ['src', 'source', 'srcaddr', 'src_ip', 'sip', 'source_ip', 'ip.src', 'sa', 'client', 'srcip', 'sourceaddress'],
  dst: ['dst', 'dest', 'destination', 'dstaddr', 'dst_ip', 'dip', 'destination_ip', 'ip.dst', 'da', 'server', 'dstip', 'destinationaddress'],
  sport: ['sport', 'srcport', 'src_port', 'source_port', 'sport_num', 'l4_src_port'],
  dport: ['dport', 'dstport', 'dst_port', 'dest_port', 'destination_port', 'l4_dst_port'],
  proto: ['proto', 'protocol', 'ip_proto', 'prot'],
  bytes: ['bytes', 'byte_count', 'octets', 'in_bytes', 'out_bytes', 'total_bytes', 'length', 'traffic', 'totalbytes'],
  packets: ['packets', 'packet_count', 'pkts', 'in_pkts', 'flows', 'flow_count', 'count', 'totalpackets'],
  time: ['time', 'timestamp', 'ts', 'start', 'starttime', 'first', 'date', 'start_time'],
};

const META = Object.keys(ALIASES);
let records = [];

if (/^\s*[[{]/.test(text)) {
  let data;
  try { data = JSON.parse(text); } catch (e) { die(`JSON parse failed: ${e.message}`); }
  const arr = Array.isArray(data) ? data : (Array.isArray(data.flows) ? data.flows : Array.isArray(data.records) ? data.records : Array.isArray(data.data) ? data.data : null);
  if (!arr) die('JSON input must be an array, or an object with a flows/records/data array');
  records = arr.filter((x) => x && typeof x === 'object').map((r) => {
    const lower = {};
    for (const [k, v] of Object.entries(r)) lower[k.toLowerCase().replace(/[\s-]/g, '_')] = v;
    return lower;
  });
} else {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) die('no non-empty lines');
  const delim = [',', '\t', ';', '|'].map((d) => ({ d, n: lines[0].split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const header = splitCsvLine(lines[0], delim).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/[\s-]/g, '_'));
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line, delim);
    const rec = {};
    header.forEach((h, i) => { rec[h] = (f[i] ?? '').trim().replace(/^"|"$/g, ''); });
    records.push(rec);
  }
  const map = {};
  for (const k of META) {
    const explicit = get(o, k === 'bytes' ? 'bytes' : k === 'packets' ? 'packets' : k, null);
    if (explicit !== null && explicit !== undefined && explicit !== true) { map[k] = String(explicit).toLowerCase(); continue; }
    map[k] = ALIASES[k].find((a) => header.includes(a)) || null;
  }
  o._colmap = map;
}

const colMap = o._colmap || null;
const field = (rec, key) => {
  if (colMap && colMap[key]) return rec[colMap[key]];
  for (const a of ALIASES[key]) if (rec[a] !== undefined && rec[a] !== '') return rec[a];
  return undefined;
};

const rollIp = (ip) => {
  if (!subnet || subnet <= 0 || subnet > 32) return ip;
  const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return ip;
  const n = (Number(m[1]) << 24 | Number(m[2]) << 16 | Number(m[3]) << 8 | Number(m[4])) >>> 0;
  const mask = subnet === 0 ? 0 : (0xffffffff << (32 - subnet)) >>> 0;
  const base = (n & mask) >>> 0;
  return `${(base >>> 24) & 255}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${base & 255}/${subnet}`;
};

let dropped = 0, kept = 0;
const flows = [];
for (const r of records) {
  const s = field(r, 'src'), d = field(r, 'dst');
  if (!s || !d) { dropped++; continue; }
  const rawBytes = num(field(r, 'bytes'), 0);
  const rawPackets = num(field(r, 'packets'), 1);
  const bytes = Number.isFinite(rawBytes) ? rawBytes : 0;
  const packets = Number.isFinite(rawPackets) ? rawPackets : 1;
  const tsRaw = field(r, 'time');
  const ts = tsRaw ? Date.parse(String(tsRaw)) : null;
  if (bytes < minBytes) { dropped++; continue; }
  if (since !== null && ts !== null && ts < since) { dropped++; continue; }
  if (until !== null && ts !== null && ts > until) { dropped++; continue; }
  const proto = (field(r, 'proto') || 'unknown').toString().toUpperCase();
  const sport = num(field(r, 'sport'), null);
  const dport = num(field(r, 'dport'), null);
  // forward/reverse inference: the higher port is normally the client
  const dir = (sport !== null && dport !== null && sport > dport) ? 'outbound' : 'inbound';
  kept++;
  flows.push({
    src: rollIp(s), dst: rollIp(d), rawSrc: s, rawDst: d,
    sport, dport, proto, bytes, packets, dir,
    pair: [String(s), String(d)].sort().join(' <-> '),
    ts: ts && Number.isFinite(ts) ? ts : null,
  });
}
if (!flows.length) die('no usable flow records — check the byte/src/dst column detection');

function keyOf(f, key) {
  switch (key) {
    case 'src': return f.src;
    case 'dst': return f.dst;
    case 'sport': return f.sport === null ? null : `sport ${f.sport}`;
    case 'dport': return f.dport === null ? null : `dport ${f.dport}`;
    case 'proto': return f.proto;
    case 'dir': return f.dir;
    case 'pair': return f.pair;
    default: return null;
  }
}

function aggregate(keys) {
  const m = new Map();
  for (const f of flows) {
    const parts = keys.map((k) => keyOf(f, k));
    if (parts.some((p) => p === null || p === undefined || p === '')) continue;
    const k = parts.join(' | ');
    const cur = m.get(k) || { key: k, bytes: 0, packets: 0, flows: 0, protos: new Set() };
    cur.bytes += f.bytes;
    cur.packets += f.packets;
    cur.flows += 1;
    cur.protos.add(f.proto);
    m.set(k, cur);
  }
  return [...m.values()].map((x) => ({ ...x, protos: [...x.protos].join(',') })).sort((a, b) => b.bytes - a.bytes || b.flows - a.flows);
}

const primary = aggregate(byKeys);
const totalBytes = flows.reduce((a, f) => a + f.bytes, 0);
const totalPackets = flows.reduce((a, f) => a + f.packets, 0);
const protos = aggregate(['proto']);
const ports = aggregate(['dport']);
const dirs = aggregate(['dir']);
const pairs = aggregate(['pair']);

const withShare = (list) => list.map((x) => ({
  ...x,
  byteShare: totalBytes ? Number(((x.bytes / totalBytes) * 100).toFixed(3)) : 0,
  packetShare: totalPackets ? Number(((x.packets / totalPackets) * 100).toFixed(3)) : 0,
  avgBytesPerFlow: x.flows ? Number((x.bytes / x.flows).toFixed(2)) : 0,
}));

const timeRange = (() => {
  const ts = flows.map((f) => f.ts).filter((x) => x !== null);
  if (!ts.length) return null;
  return { from: new Date(Math.min(...ts)).toISOString(), to: new Date(Math.max(...ts)).toISOString(), spanSeconds: (Math.max(...ts) - Math.min(...ts)) / 1000 };
})();

const report = {
  input: src, format: colMap ? 'csv' : 'json', columnMap: colMap,
  recordsRead: records.length, recordsKept: kept, recordsDropped: dropped,
  groupedBy: byKeys, subnetRollup: subnet || null, timeRange,
  totals: { bytes: totalBytes, packets: totalPackets, flows: flows.length, uniqueSrc: new Set(flows.map((f) => f.src)).size, uniqueDst: new Set(flows.map((f) => f.dst)).size },
  groups: withShare(primary).slice(0, topN),
  protocols: withShare(protos),
  topPorts: withShare(ports).slice(0, topN),
  directions: withShare(dirs),
  topPairs: withShare(pairs).slice(0, topN),
};

const human = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`; };

if (flag(o, 'json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  console.log(`${src} — ${report.format}, ${fmt(records.length)} record(s) read, ${fmt(kept)} kept, ${fmt(dropped)} dropped`);
  console.log(`grouped by: ${byKeys.join(', ')}${subnet ? `, rolled up to /${subnet}` : ''}`);
  console.log(`${fmt(totalPackets)} packets, ${human(totalBytes)} across ${flows.length} flow(s), ${report.totals.uniqueSrc} src / ${report.totals.uniqueDst} dst`);
  if (timeRange) console.log(`time range: ${timeRange.from} .. ${timeRange.to} (${fmt(timeRange.spanSeconds)} s)`);
  const tbl = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    console.log(table(list.map((x) => ({ key: x.key, bytes: fmt(x.bytes), human: human(x.bytes), share: `${x.byteShare}%`, packets: fmt(x.packets), flows: fmt(x.flows), avg: fmt(x.avgBytesPerFlow), protos: x.protos })), ['key', 'bytes', 'human', 'share', 'packets', 'flows', 'avg', 'protos']));
  };
  tbl(`TOP ${topN} BY ${byKeys.join('+').toUpperCase()}`, report.groups);
  tbl('PROTOCOLS', report.protocols);
  tbl(`TOP ${topN} DESTINATION PORTS`, report.topPorts);
  tbl('DIRECTIONS (by higher-port heuristic)', report.directions);
  tbl(`TOP ${topN} CONVERSATION PAIRS`, report.topPairs);
}
