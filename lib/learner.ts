import fs from 'node:fs';
import path from 'node:path';
import { getConstructions, type Construction } from './constructions';

// ---------------------------------------------------------------------------
// Learner model: server-side store of everything known about the learner.
// Persistence is a JSON file under .data/ (gitignored) — durable across
// browsers, no accounts, no external database.
// ---------------------------------------------------------------------------

export type WordItem = {
  word: string;
  gloss?: string;
  constructionId?: string;
  firstSeen: string;
  lastReview: string;
  due: string;
  stability: number; // half-life in days
  reps: number;
  lapses: number;
};

export type ErrorEvent = { ts: string; tag: string; note?: string };
export type CheckpointRecord = { ts: string; masteredNodes: number; correct: number; total: number };

export type LearnerState = {
  words: Record<string, WordItem>;
  masteredNodes: string[];
  errors: ErrorEvent[];
  checkpoints: CheckpointRecord[];
  checkpoint: { active: boolean; correct: number; total: number };
  lastCheckpointAtMastered: number;
  imported: boolean;
};

// Overridable so tests can point the store at a temp directory.
const DATA_DIR = () => process.env.BRIDGE_DATA_DIR ?? path.join(process.cwd(), '.data');
const FILE = () => path.join(DATA_DIR(), 'learner.json');

const EMPTY: LearnerState = {
  words: {},
  masteredNodes: [],
  errors: [],
  checkpoints: [],
  checkpoint: { active: false, correct: 0, total: 0 },
  lastCheckpointAtMastered: 0,
  imported: false,
};

export function loadLearner(): LearnerState {
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as LearnerState) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function resetLearner(): LearnerState {
  const state = structuredClone(EMPTY);
  state.imported = true; // a reset learner should not re-import legacy data
  saveLearner(state);
  return state;
}

export function saveLearner(state: LearnerState) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Scheduler: exponential-forgetting half-life model (FSRS-inspired, simplified
// and documented rather than a claimed FSRS implementation). Each success
// multiplies the item's half-life; a miss collapses it. The next review is
// scheduled at half of one half-life (~71% modeled retention at review time —
// a deliberate "desirable difficulty" for conversational reinforcement).
// ---------------------------------------------------------------------------

const GROW = 2.2;
const LAPSE_FACTOR = 0.3;
const NEW_STABILITY = 0.8; // days
const INTERVAL_OF_STABILITY = 0.5;

function nextDue(from: Date, stability: number): string {
  return new Date(from.getTime() + stability * INTERVAL_OF_STABILITY * 86400_000).toISOString();
}

export function reviewSuccess(state: LearnerState, word: string, gloss?: string, constructionId?: string) {
  const key = word.trim().toLowerCase();
  if (!key) return;
  const now = new Date();
  const item = state.words[key];
  if (item) {
    item.stability *= GROW;
    item.reps += 1;
    item.lastReview = now.toISOString();
    item.due = nextDue(now, item.stability);
    if (gloss) item.gloss = gloss;
  } else {
    state.words[key] = {
      word: word.trim(),
      gloss,
      constructionId,
      firstSeen: now.toISOString(),
      lastReview: now.toISOString(),
      stability: NEW_STABILITY,
      due: nextDue(now, NEW_STABILITY),
      reps: 1,
      lapses: 0,
    };
  }
}

export function reviewMiss(state: LearnerState, word: string) {
  const key = word.trim().toLowerCase();
  const item = state.words[key];
  const now = new Date();
  if (!item) return;
  item.stability = Math.max(0.3, item.stability * LAPSE_FACTOR);
  item.lapses += 1;
  item.lastReview = now.toISOString();
  item.due = nextDue(now, item.stability);
}

// ---------------------------------------------------------------------------
// Syllabus graph
// ---------------------------------------------------------------------------

export function currentNode(state: LearnerState): Construction | null {
  const mastered = new Set(state.masteredNodes);
  for (const node of getConstructions()) {
    if (mastered.has(node.id)) continue;
    if ((node.prereqs ?? []).every((p) => mastered.has(p))) return node;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session planner: what should this turn's conversation work on?
// ---------------------------------------------------------------------------

export type SessionPlan = {
  node: Construction | null;
  dueWords: WordItem[];
  errorFocus: { tag: string; count: number }[];
  checkpoint: boolean;
};

const CHECKPOINT_EVERY = 5; // mastered nodes between checkpoints
export const CHECKPOINT_QUESTIONS = 5;

export function buildPlan(state: LearnerState): SessionPlan {
  const now = new Date().toISOString();
  const dueWords = Object.values(state.words)
    .filter((w) => w.due <= now)
    .sort((a, b) => (a.due < b.due ? -1 : 1))
    .slice(0, 6);

  const recent = state.errors.slice(-30);
  const tagCounts = new Map<string, number>();
  for (const e of recent) tagCounts.set(e.tag, (tagCounts.get(e.tag) ?? 0) + 1);
  const errorFocus = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 2);

  const checkpointDue =
    state.checkpoint.active ||
    state.masteredNodes.length - state.lastCheckpointAtMastered >= CHECKPOINT_EVERY;

  return { node: currentNode(state), dueWords, errorFocus, checkpoint: checkpointDue };
}

// Client-facing snapshot returned with every tutor response.
export function snapshot(state: LearnerState) {
  const nodes = getConstructions();
  const node = currentNode(state);
  const now = new Date().toISOString();
  return {
    currentNodeId: node?.id ?? null,
    nodeIndex: node ? nodes.findIndex((n) => n.id === node.id) : nodes.length,
    nodeTotal: nodes.length,
    masteredNodes: state.masteredNodes,
    words: Object.values(state.words).sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1)),
    dueCount: Object.values(state.words).filter((w) => w.due <= now).length,
    checkpoints: state.checkpoints,
    checkpointActive: state.checkpoint.active,
  };
}
