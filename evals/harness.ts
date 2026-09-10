// Eval harness for the tutor's structured output.
//
// The tutor is an LLM, so "it looks right" is not a standard — these are the
// invariants a turn must satisfy to be pedagogically correct, expressed as
// pure assertions over the structured TurnResult. `run.ts` calls the live
// tutor and scores each case with these; `tests/evals.test.ts` proves the
// assertions themselves catch violations, so CI verifies the harness with no
// API key.

export type TurnResult = {
  reply: string;
  mastered: boolean;
  wordsProduced: { word: string; gloss: string }[];
  reviewMisses: string[];
  errors: { tag: string; note: string }[];
  speech?: { rating: string; note?: string };
};

export type EvalCase = {
  name: string;
  constructionId: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  spoken?: boolean;
  expect: {
    mastered?: boolean;
    errorTag?: string; // this characteristic error must be reported
    producesWord?: string; // wordsProduced must include this (homophone-tolerant)
    forbidReveal?: string; // reply must NOT contain this string unless mastered
    speechRating?: string[]; // allowed pronunciation ratings
  };
};

export type Assertion = { id: string; pass: boolean; detail?: string };

const stripAccents = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[«»?!.,;:'']/g, ' ').toLowerCase();

function loose(a: string, b: string): boolean {
  const na = stripAccents(a).replace(/\s+/g, ' ').trim();
  const nb = stripAccents(b).replace(/\s+/g, ' ').trim();
  return na.includes(nb) || nb.includes(na);
}

// Universal invariants — every tutor turn must satisfy these.
export function structuralAssertions(t: TurnResult): Assertion[] {
  const a: Assertion[] = [];
  a.push({
    id: 'no-markdown',
    pass: !/\*\*|^#{1,6}\s|__/m.test(t.reply),
    detail: 'reply must be plain text (no **, ##, __)',
  });
  const opens = (t.reply.match(/«/g) ?? []).length;
  const closes = (t.reply.match(/»/g) ?? []).length;
  a.push({ id: 'balanced-guillemets', pass: opens === closes, detail: `« ${opens} vs » ${closes}` });
  a.push({
    id: 'no-control-tokens',
    pass: !/\[MASTERED\]|\[WORDS?:/i.test(t.reply),
    detail: 'raw control tokens must never leak into the reply',
  });
  a.push({
    id: 'words-have-glosses',
    pass: t.wordsProduced.every((w) => w.word.trim() && w.gloss.trim()),
    detail: 'each produced word needs a non-empty gloss',
  });
  return a;
}

// Case-specific expectations.
export function caseAssertions(c: EvalCase, t: TurnResult): Assertion[] {
  const a: Assertion[] = [];
  if (c.expect.mastered !== undefined) {
    a.push({ id: `mastered=${c.expect.mastered}`, pass: t.mastered === c.expect.mastered });
  }
  if (c.expect.errorTag) {
    a.push({
      id: `error:${c.expect.errorTag}`,
      pass: t.errors.some((e) => e.tag === c.expect.errorTag),
      detail: `errors seen: ${t.errors.map((e) => e.tag).join(', ') || 'none'}`,
    });
  }
  if (c.expect.producesWord) {
    a.push({
      id: `produced:${c.expect.producesWord}`,
      pass: t.wordsProduced.some((w) => loose(w.word, c.expect.producesWord!)),
      detail: `produced: ${t.wordsProduced.map((w) => w.word).join(', ') || 'none'}`,
    });
  }
  if (c.expect.forbidReveal && !t.mastered) {
    a.push({
      id: `no-giveaway:${c.expect.forbidReveal}`,
      pass: !loose(t.reply, c.expect.forbidReveal),
      detail: 'tutor should guide, not hand over the answer',
    });
  }
  if (c.expect.speechRating && t.speech) {
    a.push({
      id: `speech:${c.expect.speechRating.join('|')}`,
      pass: c.expect.speechRating.includes(t.speech.rating),
      detail: `got ${t.speech.rating}`,
    });
  }
  return a;
}

export function evaluateTurn(c: EvalCase, t: TurnResult): Assertion[] {
  return [...structuralAssertions(t), ...caseAssertions(c, t)];
}
