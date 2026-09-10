// Live eval runner: calls the real tutor for each case and scores the
// structured output against the pedagogy invariants. Needs ANTHROPIC_API_KEY.
//
//   npx tsx evals/run.ts
//
// Reuses the exact prompt-composition the API route uses, so this evaluates the
// shipped behavior, not a reimplementation.

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getConstruction } from '../lib/constructions';
import { CASES } from './cases';
import { evaluateTurn, type TurnResult } from './harness';

const MODEL = 'claude-sonnet-5';

// Mirrors the production schema in app/api/tutor/route.ts (same enums and the
// key field descriptions) so the eval exercises the shipped behavior.
const TurnSchema = z.object({
  reply: z.string().describe('Conversational tutor reply, plain text, target-language spans in «guillemets».'),
  mastered: z.boolean().describe('True only when the learner clearly produced the current construction correctly on their own.'),
  wordsProduced: z
    .array(z.object({ word: z.string(), gloss: z.string() }))
    .describe("REQUIRED bookkeeping, never skip: every target-language word/phrase the learner produced correctly in their LATEST message (for spoken, the intended form, e.g. «c'est possible» even if transcribed 's'est possible'), each with a short English gloss. Empty only when the latest message has no correct target-language production."),
  reviewMisses: z.array(z.string()),
  errors: z.array(
    z.object({
      tag: z.enum(['to-insertion', 'gender', 'word-order', 'conjugation', 'pronunciation', 'vocab', 'negation', 'other']),
      note: z.string(),
    }),
  ),
  speech: z.object({
    rating: z.enum(['clear', 'close', 'unclear', 'na']),
    note: z.string(),
  }),
});

function systemFor(constructionId: string, spoken?: boolean): string {
  const template = fs.readFileSync(path.join(process.cwd(), 'data', 'tutor-prompt.md'), 'utf-8');
  const c = getConstruction(constructionId);
  const block = c
    ? `title: ${c.title}\ngoal: ${c.goal}\ntransferHook: ${c.transferHook}\ntargetPattern: ${c.targetPattern}\nexamples: ${c.examples.join(', ')}\nwatchFor: ${c.watchFor}`
    : 'No construction found.';
  let s = template.replace('{{CONSTRUCTION}}', block);
  if (spoken) s += '\n\nThe learner\'s latest message was SPOKEN via speech recognition. Judge it by sound, not spelling.';
  return s;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY to run the live evals. (CI runs the offline harness tests instead.)');
    process.exit(2);
  }
  const client = new Anthropic();
  let passed = 0;
  let total = 0;

  for (const c of CASES) {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 1000,
      system: systemFor(c.constructionId, c.spoken),
      messages: c.history,
      output_config: { format: zodOutputFormat(TurnSchema) },
    });
    const turn = response.parsed_output as TurnResult | null;
    if (!turn) {
      console.log(`✗ ${c.name}: no parseable output`);
      total += 1;
      continue;
    }
    const results = evaluateTurn(c, turn);
    const failures = results.filter((r) => !r.pass);
    total += results.length;
    passed += results.length - failures.length;
    if (failures.length === 0) {
      console.log(`✓ ${c.name}`);
    } else {
      console.log(`✗ ${c.name}`);
      for (const f of failures) console.log(`    ✗ ${f.id}${f.detail ? ` — ${f.detail}` : ''}`);
      console.log(`    reply: ${turn.reply.replace(/\n/g, ' ').slice(0, 120)}`);
    }
  }

  console.log(`\n${passed}/${total} assertions passed across ${CASES.length} cases`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
