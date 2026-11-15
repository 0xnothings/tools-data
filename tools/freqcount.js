// freqcount.js — word, line and n-gram frequency with stopword filtering.
// Copyright (c) 2026 0xnothings
// @tool freqcount
// @desc Word/line/n-gram frequency counts with stopwords, stemming-lite and TF tables
// @usage node tools/freqcount.js book.txt --mode words --top 25
// @tags text,analysis,frequency,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const HELP = `freqcount — frequency counts for text

  node tools/freqcount.js <file|-> [options]

  --mode <m>        words (default) | lines | chars | ngrams | bigrams | trigrams
  --top <n>         rows to show (default 20, 0 = all)
  --min <n>         minimum count to report (default 1)
  --min-len <n>     minimum token length (default 1)
  --case            keep case (default: lowercased)
  --stem            crude suffix stemming (s, es, ing, ed, ly)
  --stopwords <l>   none | english | indonesian | custom:<file>
  --delim <c>       for --mode lines, split on this and count the first field
  --bar             draw a bar chart in the text output
  --csv             emit CSV
  --json            machine-readable output
  -h, --help        this text

  Reads the whole input as UTF-8, tokenizes with a Unicode-aware word regex,
  and reports count, percentage of total and rank.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a file or pipe on stdin');

const STOP_EN = new Set('a,about,above,after,again,against,all,am,an,and,any,are,aren,as,at,be,because,been,before,being,below,between,both,but,by,can,cannot,could,did,do,does,doing,don,down,during,each,few,for,from,further,had,has,have,having,he,her,here,hers,herself,him,himself,his,how,i,if,in,into,is,it,its,itself,let,me,more,most,must,my,myself,no,nor,not,of,off,on,once,only,or,other,ought,our,ours,ourselves,out,over,own,same,she,should,so,some,such,than,that,the,their,theirs,them,themselves,then,there,these,they,this,those,through,to,too,under,until,up,very,was,we,were,what,when,where,which,while,who,whom,why,will,with,would,you,your,yours,yourself,yourselves'.split(','));
const STOP_ID = new Set('yang,dan,di,itu,dengan,untuk,tidak,ini,dari,dalam,akan,pada,juga,saya,ke,oleh,sebuah,karena,tersebut,bisa,ada,mereka,lebih,adalah,sudah,atau,saat,ia,setelah,akan,tapi,anda,hal,kami,bagi,nya,apa,mereka,orang,pun,kalau,sama,sekali,kita,jadi,hanya,anda,bila,seperti,masih,maka,harus,mampu,dia,hal,agar,sebagai,para,kepada,antara,namun,apabila,bagaimana,sebagainya,yaitu,serta,ialah,merupakan,terhadap,supaya,sebelum,oleh,kepada'.split(','));

const stopMode = String(get(o, 'stopwords', 'none'));
let stop = new Set();
if (stopMode === 'english') stop = STOP_EN;
else if (stopMode === 'indonesian') stop = STOP_ID;
else if (stopMode.startsWith('custom:')) {
  const t = await readInput(stopMode.slice(7));
  stop = new Set(t.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const stem = (w) => {
  if (!flag(o, 'stem')) return w;
  if (w.length <= 4) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/ses$/.test(w)) return w.slice(0, -2);
  if (/(ing|ings)$/.test(w)) return w.replace(/ings?$/, '');
  if (/ed$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (/ly$/.test(w) && w.length > 5) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
};

const text = await readInput(src);
if (!text) die('empty input');
const mode = String(get(o, 'mode', 'words'));
const minCount = num(get(o, 'min', 1), 1);
const minLen = num(get(o, 'min-len', 1), 1);
const keepCase = flag(o, 'case');

const counts = new Map();
let totalUnits = 0;
const bump = (k) => { counts.set(k, (counts.get(k) || 0) + 1); totalUnits++; };

if (mode === 'words' || mode === 'ngrams' || mode === 'bigrams' || mode === 'trigrams') {
  const tokens = [];
  const n = mode === 'bigrams' ? 2 : mode === 'trigrams' ? 3 : 1;
  const raw = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
  for (let t of raw) {
    if (!keepCase) t = t.toLowerCase();
    if (t.length < minLen) continue;
    if (stop.has(t.toLowerCase())) continue;
    tokens.push(stem(t));
  }
  for (let i = 0; i + n <= tokens.length; i++) bump(tokens.slice(i, i + n).join(' '));
} else if (mode === 'lines') {
  const d = get(o, 'delim', null);
  for (const line of text.split(/\r?\n/)) {
    const v = d ? (line.split(d === 'tab' ? '\t' : String(d))[0] ?? '') : line.replace(/\s+/g, ' ').trim();
    const key = keepCase ? v : v.toLowerCase();
    if (!key) continue;
    bump(key);
  }
} else if (mode === 'chars') {
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue;
    if (stop.size && ch === ' ') continue;
    bump(ch);
  }
} else die(`--mode must be words | lines | chars | ngrams | bigrams | trigrams (got ${mode})`);

const rows = [...counts.entries()]
  .filter(([, c]) => c >= minCount)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([value, count], i) => ({
    rank: i + 1,
    value,
    count,
    percent: Number(((count / (totalUnits || 1)) * 100).toFixed(3)),
    per1000: Number(((count / (totalUnits || 1)) * 1000).toFixed(2)),
  }));

const topN = num(get(o, 'top', 20), 20);
const shown = topN > 0 ? rows.slice(0, topN) : rows;
const hapax = rows.filter((r) => r.count === 1).length;

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    source: src === '-' ? '<stdin>' : src,
    mode, totalUnits, distinct: rows.length,
    hapaxLegomena: hapax,
    stopwords: stopMode, stemmed: flag(o, 'stem'),
    top: shown,
    all: topN > 0 && rows.length > topN ? undefined : rows,
  }, null, 2) + '\n');
} else if (flag(o, 'csv')) {
  const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  process.stdout.write(['rank,value,count,percent', ...shown.map((r) => [r.rank, esc(r.value), r.count, r.percent].join(','))].join('\n') + '\n');
} else {
  const out = [];
  const maxCount = shown.length ? shown[0].count : 1;
  out.push(`${mode} frequency — ${totalUnits.toLocaleString('en-US')} total, ${rows.length.toLocaleString('en-US')} distinct, ${hapax} appearing once`);
  if (stopMode !== 'none') out.push(`stopwords: ${stopMode}`);
  out.push('');
  if (flag(o, 'bar')) {
    for (const r of shown) {
      const bar = '#'.repeat(Math.max(1, Math.round((r.count / maxCount) * 40)));
      out.push(`${String(r.rank).padStart(4)}  ${String(r.count).padStart(7)}  ${bar} ${r.value.slice(0, 60)}`);
    }
  } else {
    out.push(table(shown.map((r) => ({ rank: r.rank, value: r.value.slice(0, 50), count: r.count, percent: r.percent })), ['rank', 'value', 'count', 'percent']));
  }
  if (topN > 0 && rows.length > topN) out.push('', `${rows.length - topN} more row(s) — use --top 0 for all or --json`);
  process.stdout.write(out.join('\n') + '\n');
}
