#!/usr/bin/env node
// Bridge MCP server — exposes the tutor's curriculum, the learner's word bank,
// their progress, and the cognate-coverage analysis as Model Context Protocol
// tools, so any MCP client (Claude Desktop, IDEs, agents) can read a learner's
// state and reason over it. Read-only and self-contained: it reads the same
// data files the Next.js app uses, with no database.
//
// Run:  node mcp/server.mjs   (or `npm run mcp`)
// Wire into an MCP client by pointing it at that command over stdio.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJSON(rel, fallback) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf-8'));
  } catch {
    return fallback;
  }
}

const curriculum = readJSON('data/constructions.json', { language: { from: 'en', to: 'fr' }, constructions: [] });
const constructions = curriculum.constructions ?? [];
const language = curriculum.language ?? { from: 'en', to: 'fr' };

function learner() {
  const dir = process.env.BRIDGE_DATA_DIR ?? path.join(ROOT, '.data');
  return readJSON(path.relative(ROOT, path.join(dir, 'learner.json')), {
    words: {},
    masteredNodes: [],
    checkpoints: [],
  });
}

function lexicon() {
  return readJSON('data/lexicon.json', null);
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const server = new McpServer({ name: 'bridge', version: '1.0.0' });

server.registerTool(
  'list_lessons',
  {
    title: 'List lessons',
    description: `List the ordered ${language.from}→${language.to} curriculum (the "constructions"), each marked mastered / current / locked based on the learner's progress.`,
    inputSchema: {},
  },
  async () => {
    const state = learner();
    const mastered = new Set(state.masteredNodes ?? []);
    let currentFound = false;
    const rows = constructions.map((c) => {
      const done = mastered.has(c.id);
      const unlocked = (c.prereqs ?? []).every((p) => mastered.has(p));
      let status = 'locked';
      if (done) status = 'mastered';
      else if (unlocked && !currentFound) {
        status = 'current';
        currentFound = true;
      }
      return { id: c.id, title: c.title, status };
    });
    return text({ total: rows.length, mastered: mastered.size, lessons: rows });
  },
);

server.registerTool(
  'get_lesson',
  {
    title: 'Get lesson',
    description: 'Get the full scaffold for one construction: goal, transfer hook from the known language, target pattern, examples, and what to watch for.',
    inputSchema: { id: z.string().describe('Construction id, e.g. "c02-cest"') },
  },
  async ({ id }) => {
    const c = constructions.find((x) => x.id === id);
    if (!c) return text(`No construction with id "${id}". Use list_lessons to see valid ids.`);
    return text(c);
  },
);

server.registerTool(
  'word_bank',
  {
    title: 'Word bank',
    description: "The learner's produced vocabulary: every word they built themselves, with its meaning, how many times produced, and whether it is due for spaced-repetition review.",
    inputSchema: {
      due_only: z.boolean().optional().describe('If true, return only words currently due for review.'),
    },
  },
  async ({ due_only }) => {
    const state = learner();
    const now = new Date().toISOString();
    let words = Object.values(state.words ?? {});
    if (due_only) words = words.filter((w) => (w.due ?? '') <= now);
    words = words.sort((a, b) => ((a.due ?? '') < (b.due ?? '') ? -1 : 1));
    return text({
      count: words.length,
      words: words.map((w) => ({
        word: w.word,
        meaning: w.gloss ?? null,
        timesProduced: w.reps ?? 0,
        lapses: w.lapses ?? 0,
        due: (w.due ?? '') <= now,
      })),
    });
  },
);

server.registerTool(
  'progress',
  {
    title: 'Progress',
    description: "A summary of the learner's state: current lesson, lessons mastered, words owned, words due for review, and checkpoint history.",
    inputSchema: {},
  },
  async () => {
    const state = learner();
    const mastered = new Set(state.masteredNodes ?? []);
    const current = constructions.find((c) => !mastered.has(c.id) && (c.prereqs ?? []).every((p) => mastered.has(p)));
    const now = new Date().toISOString();
    const words = Object.values(state.words ?? {});
    const last = (state.checkpoints ?? []).at(-1) ?? null;
    return text({
      currentLesson: current ? { id: current.id, title: current.title } : null,
      lessonsMastered: mastered.size,
      lessonsTotal: constructions.length,
      wordsOwned: words.length,
      wordsDue: words.filter((w) => (w.due ?? '') <= now).length,
      lastCheckpoint: last ? `${last.correct}/${last.total}` : null,
    });
  },
);

server.registerTool(
  'reading_coverage',
  {
    title: 'Reading coverage',
    description: `Given a passage in ${language.to}, estimate how much of it the learner can already read: words they have produced, instant cognates from ${language.from}, and genuinely new words, with a percent-readable score.`,
    inputSchema: { text: z.string().describe(`A passage in ${language.to} to analyze.`) },
  },
  async ({ text: passage }) => {
    const state = learner();
    const produced = new Set();
    for (const w of Object.values(state.words ?? {})) {
      for (const t of String(w.word).toLowerCase().split(/[^a-zàâäéèêëîïôöùûüçœæ'-]+/)) {
        if (t) produced.add(t);
      }
    }
    const lex = lexicon();
    const cognates = new Set((lex?.words ?? []).filter((w) => w.type !== 'opaque').map((w) => w.fr));
    const tokens = passage.toLowerCase().match(/[a-zàâäéèêëîïôöùûüçœæ'-]+/g) ?? [];
    let known = 0, cognate = 0, unknown = 0;
    const newWords = [];
    for (const t of tokens) {
      if (produced.has(t)) known++;
      else if (cognates.has(t)) cognate++;
      else { unknown++; newWords.push(t); }
    }
    const total = tokens.length || 1;
    return text({
      totalWords: tokens.length,
      producedByLearner: known,
      instantCognates: cognate,
      newWords: unknown,
      percentReadable: Math.round(((known + cognate) / total) * 100),
      sampleNewWords: [...new Set(newWords)].slice(0, 15),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('bridge MCP server running on stdio');
