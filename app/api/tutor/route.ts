import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getConstruction, getLanguage } from '@/lib/constructions';
import { toSegments } from '@/lib/segments';
import {
  buildPlan,
  loadLearner,
  reviewMiss,
  reviewSuccess,
  saveLearner,
  snapshot,
  CHECKPOINT_QUESTIONS,
} from '@/lib/learner';

const client = new Anthropic();
const MODEL = 'claude-sonnet-5';

type IncomingMessage = { role: 'user' | 'assistant'; content: string };

const TurnSchema = z.object({
  reply: z.string().describe('Your conversational tutor reply, plain text, target-language spans wrapped in «guillemets».'),
  mastered: z.boolean().describe('True only when the learner clearly produced the current construction correctly on their own.'),
  wordsProduced: z
    .array(z.object({ word: z.string(), gloss: z.string() }))
    .describe("REQUIRED bookkeeping, never skip: every target-language word/phrase the learner produced correctly in their LATEST message (typed or spoken — for spoken, list the intended form, e.g. «c'est possible» even if transcribed 's'est possible'), each with a short English gloss. Include re-productions of already-known words. Empty only when the latest message contains no correct target-language production."),
  reviewMisses: z
    .array(z.string())
    .describe('Word-bank items the learner attempted in their latest message and got wrong. Empty if none.'),
  errors: z
    .array(
      z.object({
        tag: z.enum(['to-insertion', 'gender', 'word-order', 'conjugation', 'pronunciation', 'vocab', 'negation', 'other']),
        note: z.string(),
      }),
    )
    .describe('Characteristic mistakes observed in the latest learner message. Empty if none.'),
  speech: z
    .object({
      rating: z.enum(['clear', 'close', 'unclear', 'na']),
      note: z.string(),
    })
    .describe("For SPOKEN learner messages: how the pronunciation sounded, judged phonetically from the transcript ('na' for typed messages). Note = one short coaching phrase."),
  checkpointResult: z
    .object({ asked: z.boolean(), correct: z.boolean() })
    .nullable()
    .describe('When running a checkpoint and the learner just answered a checkpoint item: whether it was correct. Null otherwise.'),
});

const StorySchema = z.object({
  title: z.string().describe('Short story title in the target language, wrapped in «guillemets».'),
  sentences: z
    .array(z.object({ fr: z.string(), en: z.string() }))
    .describe('4-7 short target-language sentences built almost entirely from the learner word bank and transferable cognates, each with its English translation.'),
  questions: z
    .array(z.object({ q: z.string(), answer: z.string() }))
    .describe('2 comprehension questions in English about the story, with short answers.'),
});

function buildSystemPrompt(constructionId: string): string {
  const template = fs.readFileSync(path.join(process.cwd(), 'data', 'tutor-prompt.md'), 'utf-8');
  const c = getConstruction(constructionId);
  const block = c
    ? `title: ${c.title}\ngoal: ${c.goal}\ntransferHook: ${c.transferHook}\ntargetPattern: ${c.targetPattern}\nexamples: ${c.examples.join(', ')}\nwatchFor: ${c.watchFor}`
    : 'No construction found.';
  return template.replace('{{CONSTRUCTION}}', block);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      mode?: 'lesson' | 'story';
      constructionId?: string;
      messages?: IncomingMessage[];
      spoken?: boolean;
      asrConfidence?: number;
    };
    const lang = getLanguage();
    const state = loadLearner();

    if (body.mode === 'story') {
      const bank = Object.values(state.words).map((w) => w.word).slice(0, 120);
      const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 1500,
        system:
          'You write tiny comprehensible-input stories for a beginner French learner (English speaker). Use ONLY simple present/passé composé/futur proche, and build sentences almost entirely from the learner\'s known inventory plus obvious English-French cognates, so ~95% of words are recognizable. Keep sentences short and concrete.',
        messages: [
          {
            role: 'user',
            content: `My known inventory: ${bank.join(', ') || 'only very common cognates (information, possible, important...)'}. Write me a micro-story.`,
          },
        ],
        output_config: { format: zodOutputFormat(StorySchema) },
      });
      const story = response.parsed_output;
      if (!story) return NextResponse.json({ error: 'Story generation failed' }, { status: 502 });
      const segments = story.sentences.map((s) => ({ lang: lang.to, text: s.fr }));
      return NextResponse.json({ story, segments });
    }

    const { constructionId, messages } = body;
    if (!constructionId || !messages) {
      return NextResponse.json({ error: 'constructionId and messages required' }, { status: 400 });
    }

    let system = buildSystemPrompt(constructionId);

    const plan = buildPlan(state);
    const planLines: string[] = [];
    if (plan.dueWords.length) {
      planLines.push(
        `Due review words (least stable first): ${plan.dueWords
          .map((w) => `«${w.word}»${w.gloss ? ` = ${w.gloss}` : ''}`)
          .join(' | ')}`,
      );
    }
    if (plan.errorFocus.length) {
      planLines.push(
        `Recurring error patterns to watch for: ${plan.errorFocus.map((e) => `${e.tag} (×${e.count})`).join(', ')}`,
      );
    }
    if (plan.checkpoint) {
      planLines.push(
        `CHECKPOINT REQUESTED: run the ${CHECKPOINT_QUESTIONS}-question rapid check now (progress so far: ${state.checkpoint.correct}/${state.checkpoint.total}).`,
      );
    }
    if (planLines.length) system += `\n\nSESSION PLAN:\n${planLines.join('\n')}`;
    if (body.spoken) {
      const conf = body.asrConfidence != null ? ` (recognition confidence ${(body.asrConfidence * 100).toFixed(0)}%)` : '';
      system += `\n\nThe learner's latest message was SPOKEN via speech recognition${conf}. Judge it by sound, not spelling.`;
    }

    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 1200,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { format: zodOutputFormat(TurnSchema) },
    });
    const turn = response.parsed_output;
    if (!turn) return NextResponse.json({ error: 'Tutor response failed to parse' }, { status: 502 });

    // --- update the learner model from the structured observations ---
    for (const { word, gloss } of turn.wordsProduced) reviewSuccess(state, word, gloss, constructionId);
    for (const word of turn.reviewMisses) reviewMiss(state, word);
    const now = new Date().toISOString();
    for (const e of turn.errors) state.errors.push({ ts: now, tag: e.tag, note: e.note });
    if (state.errors.length > 200) state.errors = state.errors.slice(-200);

    if (plan.checkpoint && turn.checkpointResult?.asked) {
      state.checkpoint.active = true;
      state.checkpoint.total += 1;
      if (turn.checkpointResult.correct) state.checkpoint.correct += 1;
      if (state.checkpoint.total >= CHECKPOINT_QUESTIONS) {
        state.checkpoints.push({
          ts: now,
          masteredNodes: state.masteredNodes.length,
          correct: state.checkpoint.correct,
          total: state.checkpoint.total,
        });
        state.checkpoint = { active: false, correct: 0, total: 0 };
        state.lastCheckpointAtMastered = state.masteredNodes.length;
      }
    }

    if (turn.mastered && !state.masteredNodes.includes(constructionId)) {
      state.masteredNodes.push(constructionId);
    }
    saveLearner(state);

    const segments = toSegments(turn.reply, lang.from, lang.to);
    return NextResponse.json({
      reply: turn.reply,
      mastered: turn.mastered,
      speech: turn.speech,
      segments,
      state: snapshot(state),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
