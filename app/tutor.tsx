'use client';

import { useEffect, useRef, useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };
type C = { id: string; title: string };

export default function Tutor({ constructions }: { constructions: C[] }) {
  const [started, setStarted] = useState(false);
  const [idx, setIdx] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, loading]);

  async function post(constructionId: string, history: Msg[]) {
    const res = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ constructionId, messages: history }),
    });
    return res.json() as Promise<{ reply?: string; mastered?: boolean; error?: string }>;
  }

  async function beginLesson(atIdx: number) {
    setIdx(atIdx);
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
      if (data.mastered && idx < constructions.length - 1) {
        setTimeout(() => beginLesson(idx + 1), 1400);
      }
    } catch {
      setMessages([...history, { role: 'assistant', content: '⚠ Could not reach the tutor.' }]);
    } finally {
      setLoading(false);
    }
  }

  const visible = messages.filter((m, i) => !(i === 0 && m.content === "Let's begin."));

  if (!started) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '4rem 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>Parler</h1>
        <p style={{ fontSize: 18, lineHeight: 1.6, color: '#333' }}>
          You already recognize thousands of French words — the ones ending in -tion, -able, -ent are nearly the same. This tutor won&apos;t give you answers. It will ask you questions until you build French yourself.
        </p>
        <button
          onClick={() => { setStarted(true); beginLesson(0); }}
          style={{ marginTop: 24, padding: '12px 20px', fontSize: 16, borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', cursor: 'pointer' }}
        >
          Start
        </button>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem', fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ borderBottom: '1px solid #eee', paddingBottom: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: '#888' }}>Lesson {idx + 1} of {constructions.length}</div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{constructions[idx].title}</div>
      </div>
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
