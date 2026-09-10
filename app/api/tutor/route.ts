import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getConstruction, getLanguage } from '@/lib/constructions';

const client = new Anthropic();

type IncomingMessage = { role: 'user' | 'assistant'; content: string };
type Segment = { lang: string; text: string };
type KnownWord = { word: string; gloss?: string };

// Split a reply into spoken-language segments: text inside «…» is the target
// language, everything else is the learner's known language.
function toSegments(text: string, from: string, to: string): Segment[] {
  const segments: Segment[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ lang: from, text: text.slice(last, m.index) });
    segments.push({ lang: to, text: m[1] });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ lang: from, text: text.slice(last) });
  return segments.filter((s) => /\p{L}/u.test(s.text));
}

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
    const { constructionId, messages, knownWords } = (await req.json()) as {
      constructionId: string;
      messages: IncomingMessage[];
      knownWords?: KnownWord[];
    };

    let system = buildSystemPrompt(constructionId);
    if (knownWords?.length) {
      const bank = knownWords
        .slice(0, 20)
        .map((k) => `- «${k.word}»${k.gloss ? ` = ${k.gloss}` : ''}`)
        .join('\n');
      system += `\n\nWORD BANK — items the learner has already produced on their own, least recently practiced first:\n${bank}\n\nTest recall often. When a lesson is just beginning, open with a quick warm-up: ask the learner to produce two or three of these from their meanings, one at a time, before introducing anything new. After that, roughly every third turn, weave one quick recall test from this bank into the conversation before continuing. Prefer items near the top of the list.`;
    }

    const msg = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const textBlock = msg.content.find((b) => b.type === 'text');
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';
    const mastered = raw.includes('[MASTERED]');
    const wordsMatch = raw.match(/\[WORDS:([^\]]*)\]/);
    const words: KnownWord[] = wordsMatch
      ? wordsMatch[1]
          .split('|')
          .map((pair) => {
            const eq = pair.indexOf('=');
            const w = (eq >= 0 ? pair.slice(0, eq) : pair).replace(/[«»]/g, '').trim();
            const g = eq >= 0 ? pair.slice(eq + 1).replace(/[«»]/g, '').trim() : '';
            return { word: w, gloss: g || undefined };
          })
          .filter((k) => k.word)
      : [];
    const reply = raw
      .replace(/\[WORDS:[^\]]*\]/g, '')
      .replace('[MASTERED]', '')
      .trim();
    const lang = getLanguage();
    const segments = toSegments(reply, lang.from, lang.to);

    return NextResponse.json({ reply, mastered, words, segments });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
