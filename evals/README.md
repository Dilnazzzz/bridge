# Tutor evals

The tutor is an LLM, so "it looks right" isn't a standard. This harness encodes the pedagogy invariants a turn must satisfy and measures the shipped model against them.

## What it checks

**Structural invariants** (every turn): plain text only (no markdown), balanced `«…»` around target-language spans, no leaked control tokens, every produced word carries a gloss.

**Case expectations** (`cases.ts`): mastery fires only on a correct independent production; a characteristic mistake is tagged with the right error (e.g. `to-insertion`); spoken homophones are judged by sound (so `s'est` counts as `c'est`); the tutor never hands over the answer before the learner reaches it; gibberish speech isn't scored as a wrong answer.

## Running

```bash
npm test          # harness self-tests (fixtures, no API key) — runs in CI
npm run evals     # live suite against the real tutor (needs ANTHROPIC_API_KEY)
```

`tests/evals.test.ts` validates the assertions themselves against recorded good/bad outputs, so CI verifies the checks with no key. `evals/run.ts` applies the same assertions to live model output using the production schema, and prints a scored report.

## Current live result

29/30 assertions pass. The one failing assertion is a genuine finding, not a harness bug: the tutor occasionally confirms a *repeated* word ("that's it exactly") without re-listing it in `wordsProduced`, so a re-production can miss the spaced-repetition bump. Tracked here rather than hidden — surfacing this kind of inconsistency is the point of the suite.
