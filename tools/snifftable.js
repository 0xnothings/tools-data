// snifftable.js — parse textual packet summaries or CSV exports into talker/port/protocol tables.
// Copyright (c) 2026 0xnothings
// @tool snifftable
// @desc Turn packet summaries or a CSV export into top talkers, port and protocol tables plus a conversation matrix
// @usage node tools/snifftable.js capture.txt --top 10 --matrix --json
// @tags data,network,cli
import { args, get, num, flag, die, readInput, table, fmt } from '../_lib.js';
import { readFileSync } from 'node:fs';

const HELP = `snifftable — packet summary analyser

  node tools/snifftable.js <capture.txt|capture.csv|-> [options]

  --csv                force CSV input mode
  --text               force free-text (tcpdump / tshark -T fields-ish) mode
  --src <col>          CSV column name or index for source address
  --dst <col>          CSV column for destination address
  --bytes <col>        CSV column for byte count
  --packets <col>      CSV column for packet count
  --port <col>         CSV column for the source port
  --dport <col>        CSV column for the destination port
  --proto <col>        CSV column for the protocol
  --top <n>            rows per top-N table (default 10)
  --matrix             print a src x dst conversation matrix
  --bins <n>           time-series bins when timestamps are present (default 0 = off)
  --json               machine-readable output
  -h, --help           this text

  Text mode understands the common tcpdump/Wireshark summary grammar:
  "12:00:01.123456 IP 10.0.0.5.44321 > 93.184.216.34.80: Flags [P.], ... 512"
  IPv6, "who-has" ARP lines and "length N" trailers are handled too.`;

const o = args(process.argv.slice(2));
// tolerant argv: a string value on a pure-boolean flag means the trailing positional was swallowed
for (const k of ['csv', 'json', 'matrix', 'text']) if (typeof o.f[k] === 'string') { o._.push(o.f[k]); o.f[k] = true; }

if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src) die('need input — node tools/snifftable.js capture.txt');
const text = await readInput(src);
if (!text.trim()) die('input is empty');

const topN = num(get(o, 'top', 10), 10);
const binCount = num(get(o, 'bins', 0), 0);

const ipv4 = /(\d{1,3}(?:\.\d{1,3}){3})(?:\.(\d{1,5}))?/g;
const ipv6 = /((?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})(?:\.(\d{1,5}))?/;

function parseLines(lines) {
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let time = null;
    const tm = t.match(/^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s/) || t.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
    if (tm) {
      time = tm[1];
      if (/^\d{1,2}:/.test(time)) {
        const [h, m, s] = time.split(':');
        time = `${h.padStart(2, '0')}:${m}:${s}`;
      }
    }
    const proto = /\bTCP\b|Flags \[|tcp\b/i.test(t) ? 'TCP'
      : /\bUDP\b|udp\b/i.test(t) ? 'UDP'
      : /\bICMP6?\b|icmp/i.test(t) ? 'ICMP'
      : /\bARP\b|who-has|tell/i.test(t) ? 'ARP'
      : /\bDNS\b|\bdomain\b/i.test(t) ? 'DNS'
      : /\bTLS\b|Client Hello|Encrypted/i.test(t) ? 'TLS'
      : 'unknown';
    const addrs = [];
    ipv4.lastIndex = 0;
    let m;
    while ((m = ipv4.exec(t)) !== null) addrs.push({ ip: m[1], port: m[2] ? num(m[2], null) : null, at: m.index });
    if (!addrs.length) {
      const v6 = t.match(ipv6);
      if (v6) addrs.push({ ip: v6[1], port: v6[2] ? num(v6[2], null) : null, at: t.indexOf(v6[1]) });
    }
    if (addrs.length < 2) {
      const arp = t.match(/who-has\s+(\S+)\s+tell\s+(\S+)/i);
      if (arp) addrs.push({ ip: arp[1], port: null, at: t.indexOf(arp[1]) }, { ip: arp[2], port: null, at: t.indexOf(arp[2]) });
    }
    if (addrs.length < 2) continue;
    const lenM = t.match(/\blength\s+(\d+)\b/i) || t.match(/\s(\d{2,6})\s*$/);
    const flags = (t.match(/Flags \[([^\]]*)\]/) || [, ''])[1];
    rows.push({
      time, proto,
      src: addrs[0].ip, sport: addrs[0].port,
      dst: addrs[1].ip, dport: addrs[1].port,
      bytes: lenM ? num(lenM[1], 0) : 0,
      packet: 1,
      flags: flags || null,
      info: t.slice(0, 160),
    });
  }
  return rows;
}

const isHostish = (v) => /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{4,}|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(String(v).trim());

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

function parseCsv(t) {
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = [',', '\t', ';', '|'].map((d) => ({ d, n: lines[0].split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const header = splitCsvLine(lines[0], delim).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const hasHeader = header.some((h) => /src|source|ip|addr|proto|byte|packet|port|dst|dest/.test(h));
  const pick = (name, fallbackIdx) => {
    const explicit = get(o, name, null);
    if (explicit !== null && explicit !== undefined && explicit !== true) {
      const s = String(explicit).toLowerCase();
      const idx = header.indexOf(s);
      return idx !== -1 ? idx : num(explicit, fallbackIdx);
    }
    const guesses = {
      src: ['src', 'source', 'src_ip', 'source_ip', 'srcaddr', 'ip.src', 'sa', 'saddr', 'client'],
      dst: ['dst', 'dest', 'destination', 'dst_ip', 'destination_ip', 'dstaddr', 'ip.dst', 'da', 'daddr', 'server'],
      port: ['sport', 'src_port', 'source_port', 'srcport', 'port'],
      dport: ['dport', 'dst_port', 'dest_port', 'dstport', 'destport'],
      proto: ['proto', 'protocol', 'ip_proto'],
      bytes: ['bytes', 'byte', 'length', 'len', 'octets', 'bytes_out', 'total_bytes'],
      packets: ['packets', 'packet', 'count', 'pkts', 'flows'],
    }[name] || [];
    for (const g of guesses) { const i = header.indexOf(g); if (i !== -1) return i; }
    return fallbackIdx;
  };
  const cols = hasHeader ? {
    src: pick('src', 0), dst: pick('dst', 1), port: pick('port', -1), dport: pick('dport', -1),
    proto: pick('proto', -1), bytes: pick('bytes', -1), packets: pick('packets', -1),
  } : { src: 0, dst: 1, port: -1, dport: -1, proto: -1, bytes: -1, packets: -1 };
  const rows = [];
  const body = lines;
  for (const line of body) {
    const f = splitCsvLine(line, delim);
    const at = (i) => (i >= 0 && i < f.length ? f[i].trim().replace(/^"|"$/g, '') : '');
    const srcV = at(cols.src), dstV = at(cols.dst);
    if (!isHostish(srcV) || !isHostish(dstV)) continue;
    const splitAddr = (v) => {
      const m = v.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/) || v.match(/^\[?([0-9a-fA-F:]+)\]?(?::(\d+))?$/);
      return m ? { ip: m[1], port: m[2] ? num(m[2], null) : null } : { ip: v, port: null };
    };
    const s = splitAddr(srcV), d = splitAddr(dstV);
    const portCol = at(cols.port), dportCol = at(cols.dport);
    rows.push({
      time: null, proto: (at(cols.proto) || 'unknown').toUpperCase() || 'unknown',
      src: s.ip, dst: d.ip,
      sport: s.port ?? (portCol ? num(portCol, null) : null),
      dport: d.port ?? (dportCol ? num(dportCol, null) : null),
      bytes: num(at(cols.bytes), 0) || 0,
      packet: num(at(cols.packets), 1) || 1,
      flags: null, info: line.slice(0, 160),
    });
  }
  return { rows, cols, delim, hasHeader };
}

const looksCsv = flag(o, 'csv') || (!flag(o, 'text') && (() => {
  const first = (text.split(/\r?\n/)[0] || '').trim();
  if (!first) return false;
  if (/^\S+\s+(IP6?|ARP|IP\s)\s/.test(first)) return false;      // tcpdump-style summary line
  if (/\bFlags \[/.test(first)) return false;
  if (!/,/.test(first) && /\s>\s|\blength\s+\d+/.test(first)) return false;
  const delim = [',', '\t', ';', '|'].map((d) => ({ d, n: first.split(d).length - 1 })).sort((a, b) => b.n - a.n)[0];
  if (!delim.n) return false;
  const header = first.split(delim.d).map((h) => h.trim().toLowerCase());
  return header.some((h) => /^(src|source|srcaddr|src_ip|source_ip|client|sa|dst|dest|destination|dst_ip|dstaddr|da|server|bytes|packets|proto|protocol|sport|dport|port)$/.test(h));
})());
let rows, meta;
if (looksCsv) {
  const r = parseCsv(text);
  rows = r.rows;
  meta = { mode: 'csv', delimiter: r.delim === '\t' ? 'TAB' : r.delim, headerDetected: r.hasHeader, columns: r.cols };
} else {
  rows = parseLines(text.split(/\r?\n/));
  meta = { mode: 'text' };
}
if (!rows.length) die(`no packet rows parsed (${meta.mode} mode) — check the format or force --text/--csv`);

function tally(keyFn) {
  const m = new Map();
  for (const r of rows) {
    const keys = [].concat(keyFn(r));
    for (const k of keys) {
      if (k === null || k === undefined || k === '') continue;
      const cur = m.get(k) || { key: k, packets: 0, bytes: 0, flows: 0 };
      cur.packets += r.packet;
      cur.bytes += r.bytes;
      cur.flows += 1;
      m.set(k, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes || b.packets - a.packets);
}

const bySrc = tally((r) => r.src);
const byDst = tally((r) => r.dst);
const byProto = tally((r) => r.proto);
const byPort = tally((r) => [r.sport ? `sport ${r.sport}` : null, r.dport ? `dport ${r.dport}` : null].filter(Boolean));

const conversations = new Map();
for (const r of rows) {
  const k = `${r.src}${r.sport ? ':' + r.sport : ''} -> ${r.dst}${r.dport ? ':' + r.dport : ''}`;
  const rev = `${r.dst}${r.dport ? ':' + r.dport : ''} -> ${r.src}${r.sport ? ':' + r.sport : ''}`;
  const key = conversations.has(rev) && !conversations.has(k) ? rev : k;
  const cur = conversations.get(key) || { key, packets: 0, bytes: 0, proto: r.proto, first: r.time, last: r.time };
  cur.packets += r.packet;
  cur.bytes += r.bytes;
  if (r.time) { if (!cur.first || r.time < cur.first) cur.first = r.time; if (!cur.last || r.time > cur.last) cur.last = r.time; }
  conversations.set(key, cur);
}
const convList = [...conversations.values()].sort((a, b) => b.bytes - a.bytes);

const hosts = new Set([...rows.map((r) => r.src), ...rows.map((r) => r.dst)]);
const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);
const totalPackets = rows.reduce((a, r) => a + r.packet, 0);

const report = {
  input: src, ...meta,
  rows: rows.length,
  uniqueHosts: hosts.size,
  uniqueConversations: convList.length,
  totalBytes, totalPackets,
  avgPacketBytes: totalPackets ? Number((totalBytes / totalPackets).toFixed(2)) : 0,
  protocols: byProto,
  topTalkers: bySrc.slice(0, topN),
  topReceivers: byDst.slice(0, topN),
  topPorts: byPort.slice(0, topN),
  topConversations: convList.slice(0, topN),
};

if (flag(o, 'matrix')) {
  const hostList = [...hosts].sort();
  const m = new Map();
  for (const r of rows) m.set(`${r.src}|${r.dst}`, (m.get(`${r.src}|${r.dst}`) || 0) + r.bytes);
  report.matrix = hostList.map((s) => ({ src: s, to: hostList.map((d) => m.get(`${s}|${d}`) || 0), total: hostList.reduce((a, d) => a + (m.get(`${s}|${d}`) || 0), 0) }));
}

if (binCount > 0) {
  const stamped = rows.filter((r) => r.time);
  if (stamped.length) {
    const secs = stamped.map((r) => { const [h, m, s] = r.time.split(':'); return num(h, 0) * 3600 + num(m, 0) * 60 + parseFloat(s); });
    const lo = Math.min(...secs), hi = Math.max(...secs);
    const span = Math.max(1, hi - lo);
    const bins = Array.from({ length: binCount }, (_, i) => ({ bin: i, from: lo + (span * i) / binCount, to: lo + (span * (i + 1)) / binCount, packets: 0, bytes: 0 }));
    stamped.forEach((r, i) => { const b = Math.min(binCount - 1, Math.floor(((secs[i] - lo) / span) * binCount)); bins[b].packets += r.packet; bins[b].bytes += r.bytes; });
    report.timeBins = bins.map((b) => ({ ...b, fromClock: fmtClock(b.from), toClock: fmtClock(b.to) }));
  }
}

function fmtClock(sec) {
  const s = Math.floor(sec % 60), m = Math.floor((sec / 60) % 60), h = Math.floor(sec / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const human = (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`; };

if (flag(o, 'json')) process.stdout.write(JSON.stringify({ ...report, sample: rows.slice(0, 50) }, null, 2) + '\n');
else {
  console.log(`${src} — ${meta.mode} mode, ${fmt(rows.length)} flow record(s), ${hosts.size} host(s), ${convList.length} conversation(s)`);
  console.log(`${fmt(totalPackets)} packets, ${human(totalBytes)} total, avg ${report.avgPacketBytes} B/packet`);
  const show = (title, list) => {
    console.log(`\n${title}`);
    console.log(table(list.map((x) => ({ key: x.key, packets: fmt(x.packets), bytes: fmt(x.bytes), human: human(x.bytes), records: fmt(x.flows) })), ['key', 'packets', 'bytes', 'human', 'records']));
  };
  show(`TOP ${topN} SOURCES`, bySrc.slice(0, topN));
  show(`TOP ${topN} DESTINATIONS`, byDst.slice(0, topN));
  show(`TOP ${topN} PORTS`, byPort.slice(0, topN));
  show('PROTOCOLS', byProto);
  console.log(`\nTOP ${topN} CONVERSATIONS`);
  console.log(table(convList.slice(0, topN).map((c) => ({
    key: c.key, packets: fmt(c.packets), bytes: fmt(c.bytes), human: human(c.bytes), window: c.first ? `${c.first} .. ${c.last}` : '-',
  })), ['key', 'packets', 'bytes', 'human', 'window']));
  if (report.matrix) {
    const list = report.matrix;
    const head = ['src \\ dst', ...list.map((x, i) => `h${i}`)];
    console.log('\nCONVERSATION MATRIX (bytes)');
    console.log('  ' + list.map((x, i) => `h${i}=${x.src}`).join('  '));
    console.log(table(list.map((x) => {
      const row = { 'src \\ dst': x.src };
      list.forEach((y, i) => { row[`h${i}`] = x.to[i] ? String(x.to[i]) : '.'; });
      return row;
    }), head));
  }
  if (report.timeBins) {
    console.log('\nTIME BINS');
    console.log(table(report.timeBins.map((b) => ({ bin: b.bin, from: b.fromClock, to: b.toClock, packets: fmt(b.packets), bytes: fmt(b.bytes) })), ['bin', 'from', 'to', 'packets', 'bytes']));
  }
}
