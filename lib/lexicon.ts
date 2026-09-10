import fs from 'node:fs';
import path from 'node:path';

export type LexiconWord = { fr: string; en: string; rank: number; type: string; sim: number };
export type LexiconCluster = { type: string; count: number; examples: string[] };

type Lexicon = {
  counts: { total: number; transferable: number } & Record<string, number>;
  clusters: LexiconCluster[];
  words: LexiconWord[];
};

export type HeadStart = {
  total: number;
  scopeTotal: number;
  clusters: LexiconCluster[];
  words: string[];
};

let cache: Lexicon | null | undefined;

export function getLexicon(): Lexicon | null {
  if (cache === undefined) {
    try {
      const p = path.join(process.cwd(), 'data', 'lexicon.json');
      cache = JSON.parse(fs.readFileSync(p, 'utf-8')) as Lexicon;
    } catch {
      cache = null; // lexicon is optional — run scripts/build-lexicon.mjs to create it
    }
  }
  return cache;
}

export function getHeadStart(): HeadStart | null {
  const lex = getLexicon();
  if (!lex) return null;
  return {
    total: lex.counts.transferable,
    scopeTotal: lex.counts.total,
    clusters: lex.clusters.slice(0, 6),
    words: lex.words.filter((w) => w.type !== 'opaque').slice(0, 2000).map((w) => w.fr),
  };
}
