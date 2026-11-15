// textstat.js — readability metrics: Flesch, syllables, readability grades, top words.
// Copyright (c) 2026 0xnothings
// @tool textstat
// @desc Readability metrics for text: words, sentences, Flesch/Flesch-Kincaid, top words
// @usage node tools/textstat.js essay.txt --top 15
// @tags text,analysis,nlp,cli
import { args, get, num, flag, die, readInput, table } from '../_lib.js';

const HELP = `textstat — readability and vocabulary statistics

  node tools/textstat.js <file|-> [options]

  --top <n>         how many frequent words to list (default 10)
  --min-len <n>     ignore words shorter than n chars when ranking (default 3)
  --stopwords <l>   none | english | indonesian | custom:<file>  (default none)
  --sentences       print per-sentence length distribution
  --paragraphs      report paragraph stats
  --compare <file>  compare against a second document's metrics
  --json            machine-readable output
  -h, --help        this text

  Syllables use a vowel-group heuristic with silent-e correction; it is within
  a few percent of dictionary counts on normal prose. Metrics reported:
  Flesch Reading Ease, Flesch-Kincaid Grade, Gunning Fog, SMOG, ARI,
  Coleman-Liau, plus lexical diversity and hapax ratio.`;

const o = args(process.argv.slice(2));
if (flag(o, 'help') || flag(o, 'h')) { console.log(HELP); process.exit(0); }

const src = o._[0];
if (!src && process.stdin.isTTY) die('no input — pass a text file or pipe on stdin');

const STOP_EN = new Set(('a,about,above,after,again,against,all,am,an,and,any,are,as,at,be,because,been,before,being,below,between,both,but,by,cannot,could,did,do,does,doing,down,during,each,few,for,from,further,had,has,have,having,he,her,here,hers,herself,him,himself,his,how,i,if,in,into,is,it,its,itself,me,more,most,my,myself,no,nor,not,of,off,on,once,only,or,other,ought,our,ours,ourselves,out,over,own,same,she,should,so,some,such,than,that,the,their,theirs,them,themselves,then,there,these,they,this,those,through,to,too,under,until,up,very,was,we,were,what,when,where,which,while,who,whom,why,with,would,you,your,yours,yourself,yourselves,s, t, will, can, may, just, also, its').split(','));

const STOP_ID = new Set(('ada,adalah,adanya,adapun,agak,agaknya,agar,akan,akankah,akhir,akhiri,akhirnya,aku,akulah,amat,amatlah,anda,andalah,andanya,apa,apaan,apabila,apakah,apakalah,apalagi,apatah,arti,artinya,asal,asalkan,atas,atau,ataukah,ataupun,awal,awalnya,badah,badannya,bagai,bagaikan,bagaimana,bagaimanakah,bagi,bagian,bahkan,bahwa,bahwasanya,baik,baiknya,bakal,bakalan,bakalnyakah,baku,balik,banyak,baru,barulah,begini,begini,beginian,begini,begitu,begitukah,begitulah,begitupun,belum,belumlah,benar,benarkah,benarlah,berada,berakhirlah,berakhirnya,berapa,berapakah,berapalah,berapapun,berarti,berawal,berbagai,berdatangan,beri,berikan,berikut,berikutnya,berjumlah,berkali,kali,berkata,berkehendak,berkeinginan,berkenaan,berlainan,berlalu,berlangsung,berlebihan,bermacam,bermaksud,bermula,bersama,bersiap,bertanya,bertutur,berubah,berujung,berupa,besar,sesama,sesat,sesuatu,sesuatunya,sesudah,sesudahnya,setelah,setempat,setengah,setiap,setiba,setibanya,setidak,setidaknya,setinggi,seusai,sewaktu,siap,siapa,siapakah,siapapun,sini,sinilah,suatu,sudah,sudahkah,sudahlah,supaya,tadi,tadinya,tahap,tahu,tahun,tak,takkan,tampak,tampaknya,tandas,tandasnya,tanpa,tanya,tanyakan,tapi,tegas,tegasnya,telah,tempat,tengah,tentang,tentu,tentulah,tentunya,tepat,terakhir,terasa,terbaik,terbang,terbanyak,terdahulu,terdapat,terdiri,terhadap,terhadapnya,teringat,terjadi,terjadilah,terjadinya,terjadi,terkadang,termasuk,ternyata,tersebut,tersebutlah,tertentu,tertuju,terus,terutama,tetap,tetapi,tetap,tiap,tidak,tidakkah,tidaklah,toh,ya,yaitu,yakni,yalah,yang').split(','));

const stopMode = String(get(o, 'stopwords', 'none'));
let stopwords = new Set();
if (stopMode === 'english') stopwords = STOP_EN;
else if (stopMode === 'indonesian') stopwords = STOP_ID;
else if (stopMode.startsWith('custom:')) {
  const p = stopMode.slice(7);
  const t = await readInput(p);
  stopwords = new Set(t.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let s = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = s.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function analyze(text) {
  const cleaned = text.replace(/\r/g, '');
  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentenceMatches = cleaned.replace(/\n+/g, ' ').match(/[^.!?…]+[.!?…]+(?:["')\]]+)?|[^.!?…]+$/g) || [];
  const sentences = sentenceMatches.map((s) => s.trim()).filter((s) => s.length > 0);
  const wordMatches = cleaned.match(/[A-Za-z\u00C0-\u024F\u0100-\u017F']+(?:-[A-Za-z']+)*|\d+(?:[.,]\d+)*/g) || [];
  const words = wordMatches.filter((w) => /[A-Za-z\u00C0-\u024F]/.test(w));

  const lower = words.map((w) => w.toLowerCase());
  const freq = new Map();
  for (const w of lower) freq.set(w, (freq.get(w) || 0) + 1);

  const syllables = words.reduce((s, w) => s + countSyllables(w), 0);
  const wordsN = words.length || 1;
  const sentN = sentences.length || 1;
  const complexWords = words.filter((w) => countSyllables(w) >= 3).length;
  const chars = cleaned.length;
  const letters = (cleaned.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;

  const sentLens = sentences.map((s) => (s.match(/[A-Za-z\u00C0-\u024F']+/g) || []).length).filter((n) => n > 0);
  const avgSentLen = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  const avgSyl = syllables / wordsN;

  const flesch = 206.835 - 1.015 * avgSentLen - 84.6 * avgSyl;
  const fkGrade = 0.39 * avgSentLen + 11.8 * avgSyl - 15.59;
  const fog = 0.4 * (avgSentLen + 100 * (complexWords / wordsN));
  const smog = sentLens.length >= 3 ? 1.0430 * Math.sqrt(complexWords * (30 / sentLens.length)) + 3.1291 : null;
  const ari = 4.71 * (letters / wordsN) + 0.5 * avgSentLen - 21.43;
  const L = (letters / wordsN) * 100;
  const S = (sentLens.length / wordsN) * 100;
  const coleman = 0.0588 * L - 0.296 * S - 15.8;

  const uniq = new Set(lower);
  const hapax = [...freq.values()].filter((c) => c === 1).length;

  const ranked = [...freq.entries()]
    .filter(([w]) => w.length >= num(get(o, 'min-len', 3), 3) && !stopwords.has(w))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, num(get(o, 'top', 10), 10));

  return {
    characters: chars,
    letters,
    words: words.length,
    uniqueWords: uniq.size,
    sentences: sentLens.length,
    paragraphs: paragraphs.length,
    avgSentenceLength: Number(avgSentLen.toFixed(2)),
    avgSyllablesPerWord: Number(avgSyl.toFixed(3)),
    complexWords,
    complexRatio: Number((complexWords / wordsN).toFixed(4)),
    syllables,
    readingTimeMinutes: Number((wordsN / 225).toFixed(2)),
    lexicalDiversity: Number((uniq.size / wordsN).toFixed(4)),
    hapaxLegomena: hapax,
    hapaxRatio: Number((hapax / wordsN).toFixed(4)),
    longestSentence: sentLens.length ? Math.max(...sentLens) : 0,
    shortestSentence: sentLens.length ? Math.min(...sentLens) : 0,
    fleschReadingEase: Number(flesch.toFixed(2)),
    fleschKincaidGrade: Number(fkGrade.toFixed(2)),
    gunningFog: Number(fog.toFixed(2)),
    smogIndex: smog === null ? null : Number(smog.toFixed(2)),
    automatedReadabilityIndex: Number(ari.toFixed(2)),
    colemanLiauIndex: Number(coleman.toFixed(2)),
    gradeLabel: flesch >= 90 ? 'very easy (5th grade)' : flesch >= 80 ? 'easy (6th grade)' : flesch >= 70 ? 'fairly easy (7th)' : flesch >= 60 ? 'standard (8th-9th)' : flesch >= 50 ? 'fairly difficult (10th-12th)' : flesch >= 30 ? 'difficult (college)' : 'very difficult (graduate)',
    topWords: ranked.map(([w, c]) => ({ word: w, count: c, per1000: Number(((c / wordsN) * 1000).toFixed(2)), syllables: countSyllables(w) })),
    sentenceLengths: sentLens,
  };
}

const text = await readInput(src);
if (!text.trim()) die('empty input');
const m = analyze(text);

let comparison = null;
const cmpFile = get(o, 'compare', null);
if (cmpFile) {
  const other = await readInput(String(cmpFile));
  const om = analyze(other);
  const keys = ['words', 'sentences', 'avgSentenceLength', 'lexicalDiversity', 'fleschReadingEase', 'fleschKincaidGrade', 'gunningFog', 'avgSyllablesPerWord'];
  comparison = keys.map((k) => ({ metric: k, a: m[k], b: om[k], delta: typeof m[k] === 'number' ? Number((m[k] - om[k]).toFixed(3)) : null }));
}

if (flag(o, 'json')) {
  process.stdout.write(JSON.stringify({
    source: src === '-' ? '<stdin>' : src,
    metrics: { ...m, sentenceLengths: flag(o, 'sentences') ? m.sentenceLengths : undefined },
    comparison,
  }, null, 2) + '\n');
} else {
  const out = [];
  out.push(`source      ${src === '-' ? '<stdin>' : src}`);
  out.push('');
  out.push(`words       ${m.words.toLocaleString('en-US')} (${m.uniqueWords.toLocaleString('en-US')} unique, ${(m.lexicalDiversity * 100).toFixed(1)}% diversity)`);
  out.push(`sentences   ${m.sentences}  paragraphs ${m.paragraphs}  avg length ${m.avgSentenceLength} words`);
  out.push(`syllables   ${m.syllables.toLocaleString('en-US')}  (${m.avgSyllablesPerWord}/word, ${m.complexWords} complex)`);
  out.push(`reading     ~${m.readingTimeMinutes} min at 225 wpm`);
  out.push(`hapax       ${m.hapaxLegomena} words used once (${(m.hapaxRatio * 100).toFixed(1)}%)`);
  out.push('');
  out.push('READABILITY');
  out.push(table([
    { metric: 'Flesch Reading Ease', score: m.fleschReadingEase, note: m.gradeLabel },
    { metric: 'Flesch-Kincaid Grade', score: m.fleschKincaidGrade, note: `US grade ${m.fleschKincaidGrade}` },
    { metric: 'Gunning Fog', score: m.gunningFog, note: 'years of schooling' },
    { metric: 'SMOG', score: m.smogIndex ?? '-', note: 'needs 30+ sentences' },
    { metric: 'ARI', score: m.automatedReadabilityIndex, note: 'grade level' },
    { metric: 'Coleman-Liau', score: m.colemanLiauIndex, note: 'grade level' },
  ]));
  out.push('');
  out.push(`TOP WORDS (stopwords: ${stopMode})`);
  out.push(table(m.topWords.map((w) => ({ word: w.word, count: w.count, per1000: w.per1000, syl: w.syllables })), ['word', 'count', 'per1000', 'syl']));
  if (flag(o, 'sentences') && m.sentenceLengths.length) {
    const buckets = { '1-5': 0, '6-10': 0, '11-15': 0, '16-20': 0, '21-30': 0, '31-50': 0, '51+': 0 };
    for (const n of m.sentenceLengths) {
      if (n <= 5) buckets['1-5']++;
      else if (n <= 10) buckets['6-10']++;
      else if (n <= 15) buckets['11-15']++;
      else if (n <= 20) buckets['16-20']++;
      else if (n <= 30) buckets['21-30']++;
      else if (n <= 50) buckets['31-50']++;
      else buckets['51+']++;
    }
    out.push('', 'SENTENCE LENGTH DISTRIBUTION');
    const max = Math.max(...Object.values(buckets)) || 1;
    for (const [k, v] of Object.entries(buckets)) out.push(`  ${k.padStart(6)}  ${'#'.repeat(Math.round((v / max) * 40))} ${v}`);
  }
  if (comparison) {
    out.push('', `COMPARISON vs ${cmpFile}`);
    out.push(table(comparison.map((c) => ({ metric: c.metric, a: c.a, b: c.b, delta: c.delta })), ['metric', 'a', 'b', 'delta']));
  }
  process.stdout.write(out.join('\n') + '\n');
}
