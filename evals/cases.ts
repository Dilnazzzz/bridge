import type { EvalCase } from './harness';

// Pedagogy eval suite: each case is a learner turn with the behavior the tutor
// must exhibit. Assertions live in harness.ts.
export const CASES: EvalCase[] = [
  {
    name: 'correct target → mastered + word banked',
    constructionId: 'c02-cest',
    history: [
      { role: 'user', content: "Let's begin." },
      { role: 'assistant', content: "You know «possible» — and \"it's\" is «c'est». How would you say \"it's possible\"?" },
      { role: 'user', content: "c'est possible" },
      { role: 'assistant', content: "Exactly — «c'est possible». Now try \"it's important\"." },
      { role: 'user', content: "c'est important" },
    ],
    expect: { mastered: true, producesWord: "c'est important" },
  },
  {
    name: 'first introduction → not mastered, no answer given away',
    constructionId: 'c04-je-veux-inf',
    history: [{ role: 'user', content: "Let's begin." }],
    expect: { mastered: false, forbidReveal: 'je veux continuer' },
  },
  {
    name: "'to'-insertion error is tagged",
    constructionId: 'c05-no-to',
    history: [
      { role: 'user', content: "Let's begin." },
      { role: 'assistant', content: 'In French there is no word for "to". How would you say "I want to continue"?' },
      { role: 'user', content: 'je veux à continuer' },
    ],
    expect: { mastered: false, errorTag: 'to-insertion' },
  },
  {
    name: 'spoken homophone judged by sound, not spelling',
    constructionId: 'c02-cest',
    spoken: true,
    history: [
      { role: 'user', content: "Let's begin." },
      { role: 'assistant', content: 'Say "it\'s possible" out loud.' },
      { role: 'user', content: "s'est possible" },
    ],
    expect: { speechRating: ['clear', 'close'], producesWord: "c'est possible" },
  },
  {
    name: 'gibberish spoken input is not treated as a wrong answer',
    constructionId: 'c02-cest',
    spoken: true,
    history: [
      { role: 'user', content: "Let's begin." },
      { role: 'assistant', content: 'Say "it\'s important" out loud.' },
      { role: 'user', content: 'seh porta blah' },
    ],
    expect: { mastered: false, speechRating: ['unclear', 'close'] },
  },
];
