// Builds data/lexicon.json — the cognate network between the known and target
// language, from two free public datasets:
//   - MUSE bilingual dictionary (Meta AI): https://dl.fbaipublicfiles.com/arrival/dictionaries/en-fr.txt
//   - OpenSubtitles frequency list (hermitdave/FrequencyWords): fr_50k.txt
//
// Every entry is a translation pair (so meaning matches by construction),
// classified by HOW transferable the form is:
//   identical    — spelled the same (information)
//   accent-only  — same letters, accents aside (différent)
//   rule:<x>     — a productive suffix transform (-ty → -té: society → société)
//   near         — high string similarity (tomate/tomato)
//   opaque       — no useful form transfer; must be learned
//
// Usage: node scripts/build-lexicon.mjs <en-fr.txt> <fr_50k.txt> <en_50k.txt>

import fs from 'node:fs';
import path from 'node:path';

const [, , dictPath, freqPath, enFreqPath] = process.argv;
if (!dictPath || !freqPath || !enFreqPath) {
  console.error('usage: node scripts/build-lexicon.mjs <en-fr.txt> <fr_50k.txt> <en_50k.txt>');
  process.exit(1);
}

const OUT = path.join(process.cwd(), 'data', 'lexicon.json');
const MAX_WORDS = 8000; // most frequent French words kept in the network

// Productive en→fr suffix correspondences, checked on accent-stripped forms.
const SUFFIX_RULES = [
  ['tion', 'tion'], ['sion', 'sion'], ['able', 'able'], ['ible', 'ible'],
  ['ence', 'ence'], ['ance', 'ance'], ['ent', 'ent'], ['ant', 'ant'],
  ['ism', 'isme'], ['ist', 'iste'], ['ical', 'ique'], ['ic', 'ique'],
  ['ary', 'aire'], ['ory', 'oire'], ['ity', 'ite'], ['ty', 'te'],
  ['ous', 'eux'], ['ology', 'ologie'], ['graphy', 'graphie'],
  ['or', 'eur'], ['ure', 'ure'], ['age', 'age'], ['al', 'al'],
];

const strip = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae');

// French words whose look-alike English "match" means something else (faux
// amis) or that only match through MUSE noise — never count them as free.
const FALSE_FRIENDS = new Set([
  'elle', 'plus', 'faire', 'sans', 'vie', 'ans', 'mal', 'mon', 'pour', 'tout',
  'fort', 'sale', 'pain', 'main', 'coin', 'chat', 'vent', 'dent', 'sang',
  'bras', 'chair', 'four', 'sort', 'tort', 'pont', 'banc', 'loin', 'cent',
  'sous', 'chose', 'bout', 'fond', 'champ', 'gras', 'mère', 'mer', 'fille',
  'pièce', 'gens', 'corps', 'don', 'car', 'rue', 'sac', 'roi', 'loi', 'fou',
]);

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function classify(en, fr) {
  if (FALSE_FRIENDS.has(fr)) return { type: 'opaque', sim: 0 };
  if (en === fr) return fr.length >= 4 ? { type: 'identical', sim: 1 } : { type: 'opaque', sim: 0 };
  const enS = strip(en), frS = strip(fr);
  if (enS === frS) return fr.length >= 4 ? { type: 'accent-only', sim: 1 } : { type: 'opaque', sim: 0 };
  for (const [es, fs] of SUFFIX_RULES) {
    if (enS.endsWith(es) && frS === enS.slice(0, -es.length) + fs && enS.length - es.length >= 2) {
      return { type: `rule:-${es}→-${fs}`, sim: 0.9 };
    }
  }
  const dist = levenshtein(enS, frS);
  const sim = 1 - dist / Math.max(enS.length, frS.length);
  if (sim >= 0.72 && Math.min(enS.length, frS.length) >= 4) return { type: 'near', sim };
  return { type: 'opaque', sim };
}

// Frequency ranks for French words.
const freqRank = new Map();
fs.readFileSync(freqPath, 'utf8')
  .split('\n')
  .forEach((line, i) => {
    const w = line.split(' ')[0];
    if (w && !freqRank.has(w)) freqRank.set(w, i + 1);
  });

// Real-English filter: MUSE has noisy pairs whose "English" side is actually
// French (veux/avez...); require the en side to exist in an English freq list.
const englishWords = new Set();
fs.readFileSync(enFreqPath, 'utf8')
  .split('\n')
  .forEach((line) => {
    const w = line.split(' ')[0];
    if (w) englishWords.add(w);
  });

// Translation pairs; keep the most transferable English source per French word.
const FR_RE = /^[a-zàâäéèêëîïôöùûüçœæ'-]{3,}$/;
const EN_RE = /^[a-z'-]{3,}$/;
const byFr = new Map();
for (const line of fs.readFileSync(dictPath, 'utf8').split('\n')) {
  const [en, fr] = line.trim().toLowerCase().split(/\s+/);
  if (!en || !fr || !EN_RE.test(en) || !FR_RE.test(fr)) continue;
  if (!englishWords.has(en)) continue;
  const rank = freqRank.get(fr);
  if (!rank) continue;
  const c = classify(en, fr);
  const prev = byFr.get(fr);
  if (!prev || c.sim > prev.sim) byFr.set(fr, { fr, en, rank, ...c });
}

const words = [...byFr.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_WORDS);

const counts = {};
for (const w of words) counts[w.type] = (counts[w.type] ?? 0) + 1;
const transferable = words.filter((w) => w.type !== 'opaque');

const clusters = Object.entries(counts)
  .filter(([type]) => type !== 'opaque' && type !== 'near')
  .map(([type, count]) => ({
    type,
    count,
    examples: words.filter((w) => w.type === type).slice(0, 8).map((w) => w.fr),
  }))
  .sort((a, b) => b.count - a.count);
clusters.push({
  type: 'near',
  count: counts.near ?? 0,
  examples: words.filter((w) => w.type === 'near').slice(0, 8).map((w) => w.fr),
});

const lexicon = {
  source: 'MUSE en-fr dictionary (Meta AI) × OpenSubtitles fr frequency list (hermitdave/FrequencyWords)',
  language: { from: 'en', to: 'fr' },
  scope: `${MAX_WORDS} most frequent French words with an English translation pair`,
  counts: { total: words.length, transferable: transferable.length, ...counts },
  clusters,
  words: words.map(({ fr, en, rank, type, sim }) => ({ fr, en, rank, type, sim: Math.round(sim * 100) / 100 })),
};

fs.writeFileSync(OUT, JSON.stringify(lexicon, null, 1) + '\n');
console.log(`wrote ${OUT}`);
console.log('counts:', JSON.stringify(lexicon.counts));
console.log('clusters:', clusters.map((c) => `${c.type}:${c.count}`).join('  '));
