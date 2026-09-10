'use client';

import { useEffect, useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };
type C = { id: string; title: string };
type WordEntry = { word: string; constructionId: string; firstSeen: string; timesProduced: number };
type Progress = { idx: number; masteredIds: string[] };

const WORDS_KEY = 'bridge.words.v1';
const PROGRESS_KEY = 'bridge.progress.v1';

function loadWords(): Record<string, WordEntry> {
  try {
    return JSON.parse(localStorage.getItem(WORDS_KEY) ?? '{}') as Record<string, WordEntry>;
  } catch {
    return {};
  }
}

function saveWords(words: Record<string, WordEntry>) {
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify(words));
  } catch {}
}

function loadProgress(): Progress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as Progress) : null;
  } catch {
    return null;
  }
}

function saveProgress(p: Progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {}
}

export default function Tutor({ constructions }: { constructions: C[] }) {
  const [started, setStarted] = useState(false);
  const [idx, setIdx] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [words, setWords] = useState<Record<string, WordEntry>>({});
  const [showWords, setShowWords] = useState(false);
  const [resume, setResume] = useState<Progress | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setWords(loadWords());
    setResume(loadProgress());
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, loading]);

  async function post(constructionId: string, history: Msg[]) {
    const res = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ constructionId, messages: history }),
    });
    return res.json() as Promise<{ reply?: string; mastered?: boolean; words?: string[]; error?: string }>;
  }

  function bankWords(newWords: string[], constructionId: string) {
    if (!newWords.length) return;
    setWords((prev) => {
      const next = { ...prev };
      for (const w of newWords) {
        const key = w.trim().toLowerCase();
        if (!key) continue;
        if (next[key]) {
          next[key] = { ...next[key], timesProduced: next[key].timesProduced + 1 };
        } else {
          next[key] = { word: w.trim(), constructionId, firstSeen: new Date().toISOString(), timesProduced: 1 };
        }
      }
      saveWords(next);
      return next;
    });
  }

  function recordMastery(atIdx: number) {
    const masteredId = constructions[atIdx].id;
    const prev = loadProgress();
    const masteredIds = Array.from(new Set([...(prev?.masteredIds ?? []), masteredId]));
    const nextIdx = Math.min(atIdx + 1, constructions.length - 1);
    saveProgress({ idx: nextIdx, masteredIds });
  }

  async function beginLesson(atIdx: number) {
    setIdx(atIdx);
    const prev = loadProgress();
    saveProgress({ idx: atIdx, masteredIds: prev?.masteredIds ?? [] });
    const seed: Msg[] = [{ role: 'user', content: "Let's begin." }];
    setMessages(seed);
    setLoading(true);
    try {
      const data = await post(constructions[atIdx].id, seed);
      setMessages([...seed, { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}` }]);
    } catch {
      setMessages([...seed, { role: 'assistant', content: '⚠ Could not reach the tutor.' }]);
    } finally {
      setLoading(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const history = [...messages, { role: 'user' as const, content: text }];
    setMessages(history);
    setInput('');
    setLoading(true);
    try {
      const data = await post(constructions[idx].id, history);
      setMessages([...history, { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}` }]);
      bankWords(data.words ?? [], constructions[idx].id);
      if (data.mastered) {
        recordMastery(idx);
        if (idx < constructions.length - 1) {
          setTimeout(() => beginLesson(idx + 1), 1400);
        } else {
          setMessages((m) => [
            ...m,
            { role: 'assistant', content: `🎉 That was the last lesson — you've worked through all ${constructions.length} constructions.` },
          ]);
        }
      }
    } catch {
      setMessages([...history, { role: 'assistant', content: '⚠ Could not reach the tutor.' }]);
    } finally {
      setLoading(false);
    }
  }

  function startOver() {
    try {
      localStorage.removeItem(WORDS_KEY);
      localStorage.removeItem(PROGRESS_KEY);
    } catch {}
    setWords({});
    setResume(null);
    setStarted(true);
    beginLesson(0);
  }

  const visible = messages.filter((m, i) => !(i === 0 && m.content === "Let's begin."));
  const wordList = Object.values(words).sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1));
  const wordCount = wordList.length;
  const canResume = resume !== null && (resume.idx > 0 || resume.masteredIds.length > 0);

  if (!started) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '4rem 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>Bridge</h1>
        <p style={{ fontSize: 18, lineHeight: 1.6, color: '#333' }}>
          You already recognize thousands of French words — the ones ending in -tion, -able, -ent are nearly the same. This tutor won&apos;t give you answers. It will ask you questions until you build French yourself.
        </p>
        {canResume && (
          <p style={{ marginTop: 16, fontSize: 15, color: '#555' }}>
            Welcome back — you own {wordCount} {wordCount === 1 ? 'word' : 'words'} and you&apos;re on lesson {resume.idx + 1} of {constructions.length}.
          </p>
        )}
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button
            onClick={() => {
              setStarted(true);
              beginLesson(canResume ? resume.idx : 0);
            }}
            style={{ padding: '12px 20px', fontSize: 16, borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', cursor: 'pointer' }}
          >
            {canResume ? 'Continue' : 'Start'}
          </button>
          {canResume && (
            <button
              onClick={startOver}
              style={{ padding: '12px 20px', fontSize: 16, borderRadius: 8, border: '1px solid #ccc', background: '#fff', color: '#555', cursor: 'pointer' }}
            >
              Start over
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ borderBottom: '1px solid #eee', paddingBottom: 8, marginBottom: 8, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 13, color: '#888' }}>Lesson {idx + 1} of {constructions.length}</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{constructions[idx].title}</div>
        </div>
        <button
          onClick={() => setShowWords((s) => !s)}
          style={{ fontSize: 14, padding: '6px 12px', borderRadius: 999, border: '1px solid #ddd', background: showWords ? '#111' : '#fafafa', color: showWords ? '#fff' : '#333', cursor: 'pointer' }}
        >
          ★ {wordCount} {wordCount === 1 ? 'word' : 'words'}
        </button>
      </div>
      {showWords && (
        <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #eee', borderRadius: 10, padding: '10px 14px', marginBottom: 8, fontSize: 14 }}>
          {wordCount === 0 ? (
            <div style={{ color: '#888' }}>No words yet — they&apos;ll appear here as you produce French yourself.</div>
          ) : (
            wordList.map((w) => (
              <div key={w.word} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #f5f5f5' }}>
                <span style={{ fontWeight: 500 }}>{w.word}</span>
                <span style={{ color: '#999' }}>
                  {constructions.find((c) => c.id === w.constructionId)?.title ?? w.constructionId}
                  {w.timesProduced > 1 ? ` · ×${w.timesProduced}` : ''}
                </span>
              </div>
            ))
          )}
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
        {visible.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: '10px 14px', borderRadius: 14, background: m.role === 'user' ? '#111' : '#f2f2f2', color: m.role === 'user' ? '#fff' : '#111', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
            {m.content}
          </div>
        ))}
        {loading && <div style={{ alignSelf: 'flex-start', color: '#aaa', fontStyle: 'italic' }}>…</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Say it in French…"
          style={{ flex: 1, padding: '12px 14px', fontSize: 16, borderRadius: 8, border: '1px solid #ccc' }}
        />
        <button onClick={send} disabled={loading} style={{ padding: '12px 18px', fontSize: 16, borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', cursor: 'pointer' }}>
          Send
        </button>
      </div>
    </main>
  );
}
