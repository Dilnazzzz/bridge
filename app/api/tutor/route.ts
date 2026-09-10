import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getConstruction } from '@/lib/constructions';

const client = new Anthropic();

type IncomingMessage = { role: 'user' | 'assistant'; content: string };

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
    const { constructionId, messages } = (await req.json()) as {
      constructionId: string;
      messages: IncomingMessage[];
    };

    const system = buildSystemPrompt(constructionId);

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
    const words = wordsMatch
      ? wordsMatch[1].split('|').map((w) => w.trim()).filter(Boolean)
      : [];
    const reply = raw
      .replace(/\[WORDS:[^\]]*\]/g, '')
      .replace('[MASTERED]', '')
      .trim();

    return NextResponse.json({ reply, mastered, words });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
