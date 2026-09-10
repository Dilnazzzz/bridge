import { describe, expect, it } from 'vitest';
import { evaluateTurn, structuralAssertions, type TurnResult } from '../evals/harness';
import { CASES } from '../evals/cases';

// These tests validate the eval HARNESS itself against recorded good/bad tutor
// outputs, so CI can verify the pedagogy checks with no API key. The live suite
// (evals/run.ts) applies the same assertions to real model output.

const clean: TurnResult = {
  reply: "Nice — «c'est important». Can you try \"it's difficult\"?",
  mastered: true,
  wordsProduced: [{ word: "c'est important", gloss: "it's important" }],
  reviewMisses: [],
  errors: [],
};

describe('structural invariants', () => {
  it('passes a clean, well-formed turn', () => {
    expect(structuralAssertions(clean).every((a) => a.pass)).toBe(true);
  });

  it('flags markdown in the reply', () => {
    const bad = { ...clean, reply: 'Great job **c’est important**!' };
    const md = structuralAssertions(bad).find((a) => a.id === 'no-markdown');
    expect(md?.pass).toBe(false);
  });

  it('flags a leaked control token', () => {
    const bad = { ...clean, reply: 'Perfect. [MASTERED]' };
    const tok = structuralAssertions(bad).find((a) => a.id === 'no-control-tokens');
    expect(tok?.pass).toBe(false);
  });

  it('flags unbalanced guillemets', () => {
    const bad = { ...clean, reply: 'Try «c’est important' };
    const g = structuralAssertions(bad).find((a) => a.id === 'balanced-guillemets');
    expect(g?.pass).toBe(false);
  });

  it('flags a produced word missing its gloss', () => {
    const bad = { ...clean, wordsProduced: [{ word: "c'est important", gloss: '' }] };
    const w = structuralAssertions(bad).find((a) => a.id === 'words-have-glosses');
    expect(w?.pass).toBe(false);
  });
});

describe('case assertions', () => {
  const toInsertionCase = CASES.find((c) => c.name.includes("'to'-insertion"))!;

  it('passes when the expected error tag is reported', () => {
    const good: TurnResult = {
      reply: 'Almost! Where does the extra word go? Say it again with nothing between «veux» and «continuer».',
      mastered: false,
      wordsProduced: [],
      reviewMisses: [],
      errors: [{ tag: 'to-insertion', note: 'inserted à' }],
    };
    expect(evaluateTurn(toInsertionCase, good).every((a) => a.pass)).toBe(true);
  });

  it('fails when the expected error tag is missing', () => {
    const missed: TurnResult = {
      reply: 'Not quite, try again.',
      mastered: false,
      wordsProduced: [],
      reviewMisses: [],
      errors: [],
    };
    const tag = evaluateTurn(toInsertionCase, missed).find((a) => a.id === 'error:to-insertion');
    expect(tag?.pass).toBe(false);
  });

  it('catches the tutor giving away the answer before mastery', () => {
    const intro = CASES.find((c) => c.name.includes('first introduction'))!;
    const giveaway: TurnResult = {
      reply: 'Just say «je veux continuer» — that means "I want to continue".',
      mastered: false,
      wordsProduced: [],
      reviewMisses: [],
      errors: [],
    };
    const g = evaluateTurn(intro, giveaway).find((a) => a.id.startsWith('no-giveaway'));
    expect(g?.pass).toBe(false);
  });

  it('homophone spelling still counts as producing the intended word', () => {
    const spoken = CASES.find((c) => c.name.includes('homophone'))!;
    const turn: TurnResult = {
      reply: 'That sounded right!',
      mastered: false,
      wordsProduced: [{ word: "c'est possible", gloss: "it's possible" }],
      reviewMisses: [],
      errors: [],
      speech: { rating: 'clear', note: 'nice liaison' },
    };
    expect(evaluateTurn(spoken, turn).every((a) => a.pass)).toBe(true);
  });
});
