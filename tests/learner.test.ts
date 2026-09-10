import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the learner store at a fresh temp directory before importing it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
process.env.BRIDGE_DATA_DIR = tmp;

const {
  loadLearner,
  saveLearner,
  resetLearner,
  reviewSuccess,
  reviewMiss,
  currentNode,
  buildPlan,
  snapshot,
} = await import('../lib/learner');

beforeEach(() => {
  resetLearner();
});

describe('scheduler', () => {
  it('creates a new item on first success', () => {
    const state = loadLearner();
    reviewSuccess(state, "c'est possible", "it's possible", 'c02-cest');
    const item = state.words["c'est possible"];
    expect(item).toBeDefined();
    expect(item.reps).toBe(1);
    expect(item.lapses).toBe(0);
    expect(item.gloss).toBe("it's possible");
    expect(new Date(item.due).getTime()).toBeGreaterThan(new Date(item.lastReview).getTime());
  });

  it('grows stability multiplicatively on repeat success', () => {
    const state = loadLearner();
    reviewSuccess(state, 'important');
    const s1 = state.words['important'].stability;
    reviewSuccess(state, 'important');
    const s2 = state.words['important'].stability;
    expect(s2).toBeCloseTo(s1 * 2.2, 5);
    expect(state.words['important'].reps).toBe(2);
  });

  it('collapses stability on a miss and counts the lapse', () => {
    const state = loadLearner();
    reviewSuccess(state, 'organiser');
    reviewSuccess(state, 'organiser');
    const before = state.words['organiser'].stability;
    reviewMiss(state, 'organiser');
    const item = state.words['organiser'];
    expect(item.stability).toBeLessThan(before);
    expect(item.stability).toBeGreaterThanOrEqual(0.3);
    expect(item.lapses).toBe(1);
  });

  it('ignores a miss for an unknown word', () => {
    const state = loadLearner();
    reviewMiss(state, 'jamais-vu');
    expect(state.words['jamais-vu']).toBeUndefined();
  });

  it('normalizes keys case-insensitively', () => {
    const state = loadLearner();
    reviewSuccess(state, "C'est Possible");
    reviewSuccess(state, "c'est possible");
    expect(Object.keys(state.words)).toHaveLength(1);
    expect(state.words["c'est possible"].reps).toBe(2);
  });
});

describe('syllabus graph', () => {
  it('starts at the first node', () => {
    const state = loadLearner();
    expect(currentNode(state)?.id).toBe('c01-cognates');
  });

  it('unlocks the next node whose prereqs are mastered', () => {
    const state = loadLearner();
    state.masteredNodes.push('c01-cognates');
    expect(currentNode(state)?.id).toBe('c02-cest');
  });

  it('skips nodes with unmet prereqs', () => {
    const state = loadLearner();
    // c03 requires c02; mastering only c01 must not unlock c04 (needs c02).
    state.masteredNodes.push('c01-cognates', 'c02-cest');
    const next = currentNode(state);
    expect(['c03-negation', 'c04-je-veux-inf']).toContain(next?.id);
  });
});

describe('session planner', () => {
  it('surfaces overdue words, least stable first', () => {
    const state = loadLearner();
    reviewSuccess(state, 'possible');
    reviewSuccess(state, 'important');
    state.words['possible'].due = new Date(Date.now() - 86400_000).toISOString();
    state.words['important'].due = new Date(Date.now() - 3600_000).toISOString();
    const plan = buildPlan(state);
    expect(plan.dueWords.map((w) => w.word)).toEqual(['possible', 'important']);
  });

  it('excludes words that are not yet due', () => {
    const state = loadLearner();
    reviewSuccess(state, 'possible');
    state.words['possible'].due = new Date(Date.now() + 86400_000).toISOString();
    expect(buildPlan(state).dueWords).toHaveLength(0);
  });

  it('ranks recurring error tags', () => {
    const state = loadLearner();
    for (let i = 0; i < 3; i++) state.errors.push({ ts: new Date().toISOString(), tag: 'to-insertion' });
    state.errors.push({ ts: new Date().toISOString(), tag: 'gender' });
    const plan = buildPlan(state);
    expect(plan.errorFocus[0]).toMatchObject({ tag: 'to-insertion', count: 3 });
  });

  it('requests a checkpoint every 5 mastered nodes', () => {
    const state = loadLearner();
    expect(buildPlan(state).checkpoint).toBe(false);
    state.masteredNodes.push('c01-cognates', 'c02-cest', 'c03-negation', 'c04-je-veux-inf', 'c05-no-to');
    expect(buildPlan(state).checkpoint).toBe(true);
  });
});

describe('persistence', () => {
  it('round-trips state through the JSON store', () => {
    const state = loadLearner();
    reviewSuccess(state, 'décider', 'to decide');
    state.masteredNodes.push('c01-cognates');
    saveLearner(state);
    const loaded = loadLearner();
    expect(loaded.words['décider'].gloss).toBe('to decide');
    expect(loaded.masteredNodes).toContain('c01-cognates');
  });

  it('snapshot reports node position and due counts', () => {
    const state = loadLearner();
    reviewSuccess(state, 'possible');
    state.words['possible'].due = new Date(Date.now() - 1000).toISOString();
    state.masteredNodes.push('c01-cognates');
    const snap = snapshot(state);
    expect(snap.currentNodeId).toBe('c02-cest');
    expect(snap.nodeIndex).toBe(1);
    expect(snap.dueCount).toBe(1);
    expect(snap.words).toHaveLength(1);
  });
});
