import fs from 'node:fs';
import path from 'node:path';

export type Construction = {
  id: string;
  title: string;
  goal: string;
  transferHook: string;
  targetPattern: string;
  examples: string[];
  watchFor: string;
};

type Curriculum = { language: { from: string; to: string }; note?: string; constructions: Construction[] };

let cache: Curriculum | null = null;

function load(): Curriculum {
  if (!cache) {
    const p = path.join(process.cwd(), 'data', 'constructions.json');
    cache = JSON.parse(fs.readFileSync(p, 'utf-8')) as Curriculum;
  }
  return cache;
}

export function getConstructions(): Construction[] {
  return load().constructions;
}

export function getLanguage(): { from: string; to: string } {
  return load().language;
}

export function getConstruction(id: string): Construction | undefined {
  return load().constructions.find((c) => c.id === id);
}
