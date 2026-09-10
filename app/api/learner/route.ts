import { NextRequest, NextResponse } from 'next/server';
import { loadLearner, resetLearner, reviewSuccess, saveLearner, snapshot } from '@/lib/learner';

export async function GET() {
  return NextResponse.json({ state: snapshot(loadLearner()) });
}

export async function DELETE() {
  return NextResponse.json({ state: snapshot(resetLearner()) });
}

// One-time migration: absorb a word bank + mastered lessons that an older
// version of the app kept in the browser's localStorage.
export async function POST(req: NextRequest) {
  try {
    const { words, masteredIds } = (await req.json()) as {
      words?: { word: string; gloss?: string; constructionId?: string }[];
      masteredIds?: string[];
    };
    const state = loadLearner();
    if (state.imported) return NextResponse.json({ state: snapshot(state) });
    for (const w of words ?? []) reviewSuccess(state, w.word, w.gloss, w.constructionId);
    for (const id of masteredIds ?? []) {
      if (!state.masteredNodes.includes(id)) state.masteredNodes.push(id);
    }
    state.imported = true;
    saveLearner(state);
    return NextResponse.json({ state: snapshot(state) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
