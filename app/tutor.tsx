'use client';

import { useEffect, useRef, useState } from 'react';

type Seg = { lang: string; text: string };
type SpeechRating = { rating: 'clear' | 'close' | 'unclear' | 'na'; note?: string };
type Msg = { role: 'user' | 'assistant'; content: string; segments?: Seg[]; speech?: SpeechRating };
type C = { id: string; title: string };

type WordItem = {
  word: string;
  gloss?: string;
  constructionId?: string;
  firstSeen: string;
  lastReview: string;
  due: string;
  stability: number;
  reps: number;
  lapses: number;
};

type Snapshot = {
  currentNodeId: string | null;
  nodeIndex: number;
  nodeTotal: number;
  masteredNodes: string[];
  words: WordItem[];
  dueCount: number;
  checkpoints: { ts: string; masteredNodes: number; correct: number; total: number }[];
  checkpointActive: boolean;
};

type Story = {
  title: string;
  sentences: { fr: string; en: string }[];
  questions: { q: string; answer: string }[];
};

type HeadStart = {
  total: number;
  scopeTotal: number;
  clusters: { type: string; count: number; examples: string[] }[];
  words: string[];
};

const VOICE_KEY = 'bridge.voice.v1';
const VOICE_PREFS_KEY = 'bridge.voiceprefs.v1';
const HANDSFREE_KEY = 'bridge.handsfree.v1';

const REGION_MAP: Record<string, string> = {
  en: 'en-US', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', it: 'it-IT',
  pt: 'pt-PT', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN',
};

function regionalize(code: string): string {
  const lc = code.toLowerCase();
  return REGION_MAP[lc] ?? (lc.length === 2 ? `${lc}-${lc.toUpperCase()}` : code);
}

function normLang(lang: string): string {
  return lang.toLowerCase().replace('_', '-');
}

// macOS exposes many novelty voices (Eddy, Grandma, Bells…) that often sort
// first; rank real voices above them and prefer enhanced/regional matches.
function rankVoice(v: SpeechSynthesisVoice, code: string): number {
  let score = 0;
  const name = v.name.toLowerCase();
  const lang = normLang(v.lang);
  if (lang === normLang(regionalize(code))) score += 4;
  else if (lang.startsWith(code.toLowerCase())) score += 2;
  if (/enhanced|premium|natural|neural/.test(name)) score += 3;
  if (name.includes('google')) score += 3;
  if (v.localService) score += 1;
  if (/albert|bad news|bahh|bells|boing|bubbles|cellos|organ|superstar|trinoids|whisper|wobble|zarvox|jester|grandma|grandpa|rocko|shelley|eddy|flo|reed|sandy|fred|junior|kathy|ralph/.test(name)) score -= 8;
  return score;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function clusterLabel(type: string): string {
  if (type === 'identical') return 'spelled the same';
  if (type === 'accent-only') return 'accents aside';
  if (type === 'near') return 'nearly the same';
  return type.replace('rule:', '');
}

function loadVoicePrefs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function speechAvailable() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// SpeechRecognition is not in TypeScript's DOM lib yet — minimal local types.
type RecognitionEvent = {
  results: { length: number; [i: number]: { 0: { transcript: string; confidence?: number } } };
};
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getRecognitionCtor(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Legacy localStorage bank from pre-server-state versions of the app.
function readLegacy(): { words: { word: string; gloss?: string; constructionId?: string }[]; masteredIds: string[] } | null {
  try {
    const words = JSON.parse(localStorage.getItem('bridge.words.v1') ?? 'null') as Record<
      string,
      { word: string; gloss?: string; constructionId?: string }
    > | null;
    const prog = JSON.parse(localStorage.getItem('bridge.progress.v1') ?? 'null') as { masteredIds?: string[] } | null;
    if (!words && !prog) return null;
    return {
      words: words ? Object.values(words).map((w) => ({ word: w.word, gloss: w.gloss, constructionId: w.constructionId })) : [],
      masteredIds: prog?.masteredIds ?? [],
    };
  } catch {
    return null;
  }
}

const pill = (active: boolean): React.CSSProperties => ({
  fontSize: 14,
  padding: '6px 12px',
  borderRadius: 999,
  border: '1px solid #ddd',
  background: active ? '#111' : '#fafafa',
  color: active ? '#fff' : '#333',
  cursor: 'pointer',
});

const panelBox: React.CSSProperties = {
  border: '1px solid #eee',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 8,
  fontSize: 14,
};

export default function Tutor({
  constructions,
  language,
  headStart,
}: {
  constructions: C[];
  language: { from: string; to: string };
  headStart: HeadStart | null;
}) {
  const [started, setStarted] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showWords, setShowWords] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [recording, setRecording] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicePrefs, setVoicePrefs] = useState<Record<string, string>>({});
  const [showVoices, setShowVoices] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [story, setStory] = useState<Story | null>(null);
  const [storySegs, setStorySegs] = useState<Seg[]>([]);
  const [showStory, setShowStory] = useState(false);
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyEnglish, setStoryEnglish] = useState(false);
  const [revealedAnswers, setRevealedAnswers] = useState<Record<number, boolean>>({});
  const [showCoverage, setShowCoverage] = useState(false);
  const [coverageText, setCoverageText] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const voicePrefsRef = useRef<Record<string, string>>({});
  const voiceOnRef = useRef(true);
  const recRef = useRef<Recognition | null>(null);
  const handsFreeRef = useRef(false);
  const snapRef = useRef<Snapshot | null>(null);
  const transcriptRef = useRef('');
  const confidenceRef = useRef<number | undefined>(undefined);
  const inputFromMicRef = useRef(false);
  const speakIdRef = useRef(0);
  const emptyListensRef = useRef(0);

  const nodeIdx = Math.min(snap?.nodeIndex ?? 0, constructions.length - 1);
  const node = constructions[nodeIdx];
  const courseComplete = snap !== null && snap.currentNodeId === null;

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/learner');
        let s = (await res.json()).state as Snapshot;
        if (s && s.words.length === 0 && s.masteredNodes.length === 0) {
          const legacy = readLegacy();
          if (legacy && (legacy.words.length || legacy.masteredIds.length)) {
            const r2 = await fetch('/api/learner', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(legacy),
            });
            const d2 = (await r2.json()) as { state?: Snapshot };
            if (d2.state) s = d2.state;
          }
        }
        setSnap(s);
        snapRef.current = s;
      } catch {}
    })();
    try {
      const v = localStorage.getItem(VOICE_KEY);
      if (v !== null) {
        setVoiceOn(v === '1');
        voiceOnRef.current = v === '1';
      }
      const hf = localStorage.getItem(HANDSFREE_KEY);
      if (hf !== null) {
        setHandsFree(hf === '1');
        handsFreeRef.current = hf === '1';
      }
    } catch {}
    setMicSupported(getRecognitionCtor() !== null);
    const prefs = loadVoicePrefs();
    setVoicePrefs(prefs);
    voicePrefsRef.current = prefs;
  }, []);

  useEffect(() => {
    if (!speechAvailable()) return;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      voicesRef.current = list;
      setVoices(list);
    };
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages, loading]);

  function pickVoice(code: string): SpeechSynthesisVoice | undefined {
    const list = voicesRef.current;
    const pref = voicePrefsRef.current[code];
    if (pref) {
      const chosen = list.find((v) => v.name === pref);
      if (chosen) return chosen;
    }
    const lc = code.toLowerCase();
    return list
      .filter((v) => normLang(v.lang).startsWith(lc))
      .sort((a, b) => rankVoice(b, code) - rankVoice(a, code))[0];
  }

  function setVoicePref(code: string, name: string) {
    const next = { ...voicePrefsRef.current };
    if (name) next[code] = name;
    else delete next[code];
    voicePrefsRef.current = next;
    setVoicePrefs(next);
    try {
      localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next));
    } catch {}
  }

  function previewVoice(code: string) {
    if (!speechAvailable()) return;
    window.speechSynthesis.cancel();
    const sample = code.toLowerCase().startsWith('fr')
      ? "Bonjour ! C'est possible, c'est important."
      : 'Hello! This is how I sound.';
    const u = new SpeechSynthesisUtterance(sample);
    const voice = pickVoice(code);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? regionalize(code);
    u.rate = code === language.to ? 0.85 : 1;
    window.speechSynthesis.speak(u);
  }

  function speak(segments?: Seg[], after?: () => void) {
    if (!segments?.length || !voiceOnRef.current || !speechAvailable()) {
      after?.();
      return;
    }
    window.speechSynthesis.cancel();
    const id = ++speakIdRef.current;
    setSpeaking(true);
    const finish = () => {
      if (id !== speakIdRef.current) return; // superseded by a newer speak()
      setSpeaking(false);
      after?.();
    };
    segments.forEach((seg, i) => {
      const u = new SpeechSynthesisUtterance(seg.text);
      const voice = pickVoice(seg.lang);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? seg.lang;
      u.rate = seg.lang === language.to ? 0.85 : 1;
      if (i === segments.length - 1) {
        u.onend = finish;
        u.onerror = finish;
      }
      window.speechSynthesis.speak(u);
    });
  }

  function startRecognition() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;
    if (speechAvailable()) window.speechSynthesis.cancel();
    const rec = new Ctor();
    // Recognition listens in the target language — that's the skill being
    // trained; known-language answers can be typed.
    rec.lang = regionalize(language.to);
    rec.interimResults = true;
    rec.continuous = false;
    transcriptRef.current = '';
    confidenceRef.current = undefined;
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        const c = e.results[i][0].confidence;
        if (typeof c === 'number' && c > 0) confidenceRef.current = c;
      }
      transcriptRef.current = text;
      inputFromMicRef.current = true;
      setInput(text);
    };
    rec.onend = () => {
      setRecording(false);
      const heard = transcriptRef.current.trim();
      if (!handsFreeRef.current) return;
      if (heard) {
        emptyListensRef.current = 0;
        void sendText(heard, { spoken: true, confidence: confidenceRef.current });
      } else if (emptyListensRef.current < 2) {
        // heard nothing — listen again a couple of times before giving up
        emptyListensRef.current += 1;
        startRecognition();
      } else {
        emptyListensRef.current = 0;
      }
    };
    rec.onerror = () => setRecording(false);
    recRef.current = rec;
    setRecording(true);
    rec.start();
  }

  function toggleMic() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    startRecognition();
  }

  function toggleHandsFree() {
    const next = !handsFree;
    setHandsFree(next);
    handsFreeRef.current = next;
    try {
      localStorage.setItem(HANDSFREE_KEY, next ? '1' : '0');
    } catch {}
    if (next) {
      if (!recording && !loading && !speaking) startRecognition();
    } else if (recording) {
      recRef.current?.stop();
    }
  }

  function toggleVoice() {
    const next = !voiceOn;
    setVoiceOn(next);
    voiceOnRef.current = next;
    try {
      localStorage.setItem(VOICE_KEY, next ? '1' : '0');
    } catch {}
    if (!next && speechAvailable()) window.speechSynthesis.cancel();
  }

  async function post(body: object) {
    const res = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<{
      reply?: string;
      mastered?: boolean;
      speech?: SpeechRating;
      segments?: Seg[];
      state?: Snapshot;
      story?: Story;
      error?: string;
    }>;
  }

  async function beginLesson() {
    const current = snapRef.current;
    const nodeId = current?.currentNodeId;
    if (!nodeId) return;
    const seed: Msg[] = [{ role: 'user', content: "Let's begin." }];
    setMessages(seed);
    setLoading(true);
    try {
      const data = await post({
        constructionId: nodeId,
        messages: seed.map((m) => ({ role: m.role, content: m.content })),
      });
      if (data.state) {
        setSnap(data.state);
        snapRef.current = data.state;
      }
      setMessages([...seed, { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}`, segments: data.segments }]);
      speak(data.segments, () => {
        if (handsFreeRef.current) startRecognition();
      });
    } catch {
      setMessages([...seed, { role: 'assistant', content: '⚠ Could not reach the tutor.' }]);
    } finally {
      setLoading(false);
    }
  }

  async function sendText(raw: string, opts?: { spoken?: boolean; confidence?: number }) {
    const text = raw.trim();
    if (!text || loading) return;
    if (recording) recRef.current?.stop();
    transcriptRef.current = '';
    inputFromMicRef.current = false;
    const nodeId = snapRef.current?.currentNodeId ?? node.id;
    const history: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setLoading(true);
    try {
      const data = await post({
        constructionId: nodeId,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        spoken: opts?.spoken ?? false,
        asrConfidence: opts?.confidence,
      });
      if (data.state) {
        setSnap(data.state);
        snapRef.current = data.state;
      }
      const badge = opts?.spoken && data.speech && data.speech.rating !== 'na' ? data.speech : undefined;
      const userMsg: Msg = badge ? { ...history[history.length - 1], speech: badge } : history[history.length - 1];
      const assistantMsg: Msg = { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}`, segments: data.segments };
      setMessages([...history.slice(0, -1), userMsg, assistantMsg]);
      speak(data.segments, () => {
        if (data.mastered) {
          if (data.state?.currentNodeId) setTimeout(() => void beginLesson(), 800);
        } else if (handsFreeRef.current) {
          startRecognition();
        }
      });
      if (data.mastered && data.state?.currentNodeId === null) {
        setMessages((m) => [
          ...m,
          { role: 'assistant', content: `🎉 That was the last lesson — you've worked through all ${constructions.length} constructions.` },
        ]);
      }
    } catch {
      setMessages([...history, { role: 'assistant', content: '⚠ Could not reach the tutor.' }]);
    } finally {
      setLoading(false);
    }
  }

  function send() {
    void sendText(input, { spoken: inputFromMicRef.current, confidence: confidenceRef.current });
  }

  async function startOver() {
    try {
      const res = await fetch('/api/learner', { method: 'DELETE' });
      const data = (await res.json()) as { state?: Snapshot };
      if (data.state) {
        setSnap(data.state);
        snapRef.current = data.state;
      }
      localStorage.removeItem('bridge.words.v1');
      localStorage.removeItem('bridge.progress.v1');
    } catch {}
    setStarted(true);
    void beginLesson();
  }

  async function loadStory() {
    setShowStory(true);
    setStoryLoading(true);
    setRevealedAnswers({});
    setStoryEnglish(false);
    try {
      const data = await post({ mode: 'story' });
      if (data.story) {
        setStory(data.story);
        setStorySegs(data.segments ?? []);
      }
    } finally {
      setStoryLoading(false);
    }
  }

  const visible = messages.filter((m, i) => !(i === 0 && m.content === "Let's begin."));
  const wordList = snap?.words ?? [];
  const wordCount = wordList.length;
  const producedTokens = new Set<string>();
  for (const w of wordList) {
    for (const t of w.word.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüçœæ'-]+/)) {
      if (t) producedTokens.add(t);
    }
  }
  const networkCovered = headStart ? headStart.words.filter((f) => producedTokens.has(f)).length : 0;
  const cognateSet = headStart ? new Set(headStart.words) : new Set<string>();
  const canResume = snap !== null && (wordCount > 0 || snap.masteredNodes.length > 0);
  const lastCheckpoint = snap?.checkpoints[snap.checkpoints.length - 1];
  const nowIso = new Date().toISOString();

  const coverageTokens = coverageText
    ? coverageText.split(/([A-Za-zÀ-ÖØ-öø-ÿœæŒÆ'-]+)/).map((tok, i) => {
        const isWord = /^[A-Za-zÀ-ÖØ-öø-ÿœæŒÆ'-]+$/.test(tok);
        if (!isWord) return { key: i, tok, cls: 'x' };
        const lc = tok.toLowerCase();
        if (producedTokens.has(lc)) return { key: i, tok, cls: 'known' };
        if (cognateSet.has(lc)) return { key: i, tok, cls: 'cognate' };
        return { key: i, tok, cls: 'unknown' };
      })
    : [];
  const covWords = coverageTokens.filter((t) => t.cls !== 'x');
  const covKnown = covWords.filter((t) => t.cls === 'known').length;
  const covCognate = covWords.filter((t) => t.cls === 'cognate').length;
  const covPct = covWords.length ? Math.round(((covKnown + covCognate) / covWords.length) * 100) : 0;

  if (!started) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '4rem 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>Bridge</h1>
        {headStart ? (
          <>
            <p style={{ fontSize: 18, lineHeight: 1.6, color: '#333' }}>
              Of the {headStart.scopeTotal.toLocaleString()} most common French words,{' '}
              <strong>you can already read about {headStart.total.toLocaleString()}</strong> — they&apos;re the same words English borrowed or shares. This tutor won&apos;t give you answers. It will ask you questions until you build French yourself.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
              {headStart.clusters.map((c) => (
                <span
                  key={c.type}
                  title={c.examples.join(', ')}
                  style={{ fontSize: 13, padding: '4px 10px', borderRadius: 999, background: '#f2f2f2', color: '#444' }}
                >
                  {clusterLabel(c.type)} · {c.count.toLocaleString()}
                </span>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize: 18, lineHeight: 1.6, color: '#333' }}>
            You already recognize thousands of French words — the ones ending in -tion, -able, -ent are nearly the same. This tutor won&apos;t give you answers. It will ask you questions until you build French yourself.
          </p>
        )}
        {canResume && snap && (
          <p style={{ marginTop: 16, fontSize: 15, color: '#555' }}>
            Welcome back — you own {wordCount} {wordCount === 1 ? 'word' : 'words'}
            {snap.dueCount > 0 ? ` (${snap.dueCount} due for review)` : ''} and you&apos;re on lesson {Math.min(snap.nodeIndex + 1, snap.nodeTotal)} of {snap.nodeTotal}.
            {lastCheckpoint ? ` Last checkpoint: ${lastCheckpoint.correct}/${lastCheckpoint.total}.` : ''}
          </p>
        )}
        <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
          <button
            onClick={() => {
              setStarted(true);
              void beginLesson();
            }}
            disabled={snap === null}
            style={{ padding: '12px 20px', fontSize: 16, borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', cursor: 'pointer', opacity: snap === null ? 0.5 : 1 }}
          >
            {snap === null ? 'Loading…' : canResume ? 'Continue' : 'Start'}
          </button>
          {canResume && (
            <button
              onClick={() => void startOver()}
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
      <div style={{ borderBottom: '1px solid #eee', paddingBottom: 8, marginBottom: 8, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: '#888' }}>
            {courseComplete ? 'Course complete 🎉' : `Lesson ${nodeIdx + 1} of ${constructions.length}`}
            {snap && snap.dueCount > 0 ? ` · ${snap.dueCount} due` : ''}
            {snap?.checkpointActive ? ' · 📋 checkpoint' : ''}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.title}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button onClick={() => void loadStory()} title="A tiny story from the words you own" style={pill(showStory)}>📖</button>
          <button onClick={() => setShowCoverage((s) => !s)} title="Paste French text — see how much you can already read" style={pill(showCoverage)}>📄</button>
          {micSupported && (
            <button onClick={toggleHandsFree} title={handsFree ? 'Hands-free on' : 'Hands-free off — click to converse by voice only'} style={pill(handsFree)}>🎧</button>
          )}
          <button onClick={() => setShowVoices((s) => !s)} title="Choose voices" style={pill(showVoices)}>⚙</button>
          <button onClick={toggleVoice} title={voiceOn ? 'Voice on — click to mute' : 'Voice off — click to unmute'} style={pill(false)}>
            {voiceOn ? '🔊' : '🔇'}
          </button>
          <button onClick={() => setShowWords((s) => !s)} style={pill(showWords)}>★ {wordCount}</button>
        </div>
      </div>
      {handsFree && (
        <div style={{ fontSize: 13, color: '#888', padding: '6px 0', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
          {loading ? '… thinking' : speaking ? '🔊 speaking — listen' : recording ? '🎤 listening — just answer out loud' : 'hands-free: tap 🎤 if I stop listening'}
        </div>
      )}
      {showStory && (
        <div style={panelBox}>
          {storyLoading || !story ? (
            <div style={{ color: '#888' }}>Writing a story from your words…</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <strong>{story.title}</strong>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => speak(storySegs)} title="Listen" style={{ ...pill(false), padding: '4px 10px' }}>🔊</button>
                  <button onClick={() => setStoryEnglish((s) => !s)} style={{ ...pill(storyEnglish), padding: '4px 10px' }}>EN</button>
                  <button onClick={() => setShowStory(false)} style={{ ...pill(false), padding: '4px 10px' }}>✕</button>
                </span>
              </div>
              <div style={{ marginTop: 8, lineHeight: 1.7 }}>
                {story.sentences.map((s, i) => (
                  <div key={i}>
                    <span>{s.fr}</span>
                    {storyEnglish && <span style={{ color: '#999' }}> — {s.en}</span>}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, borderTop: '1px solid #f5f5f5', paddingTop: 8 }}>
                {story.questions.map((q, i) => (
                  <div key={i} style={{ padding: '2px 0' }}>
                    <button
                      onClick={() => setRevealedAnswers((r) => ({ ...r, [i]: !r[i] }))}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#333', fontSize: 14, textAlign: 'left' }}
                    >
                      {q.q} {revealedAnswers[i] ? <span style={{ color: '#888' }}>→ {q.answer}</span> : <span style={{ color: '#bbb' }}>(tap for answer)</span>}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {showCoverage && (
        <div style={panelBox}>
          <textarea
            value={coverageText}
            onChange={(e) => setCoverageText(e.target.value)}
            placeholder="Paste any French text — a headline, a paragraph, song lyrics — and see how much of it you can already read."
            style={{ width: '100%', minHeight: 64, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
        />
          {coverageText && (
            <>
              <div style={{ marginTop: 8, lineHeight: 1.8 }}>
                {coverageTokens.map((t) =>
                  t.cls === 'x' ? (
                    <span key={t.key}>{t.tok}</span>
                  ) : (
                    <span
                      key={t.key}
                      style={{
                        background: t.cls === 'known' ? '#dff2df' : t.cls === 'cognate' ? '#e6ebfa' : '#fdeaea',
                        borderRadius: 3,
                        padding: '0 2px',
                      }}
                    >
                      {t.tok}
                    </span>
                  ),
                )}
              </div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
                {covPct}% readable — {covKnown} produced by you, {covCognate} instant cognates, {covWords.length - covKnown - covCognate} new. Green = yours, blue = cognate, red = new.
              </div>
            </>
          )}
        </div>
      )}
      {showVoices && (
        <div style={{ ...panelBox, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[language.to, language.from].map((code) => {
            const options = voices
              .filter((v) => normLang(v.lang).startsWith(code.toLowerCase()))
              .sort((a, b) => rankVoice(b, code) - rankVoice(a, code));
            return (
              <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 100, color: '#555', flexShrink: 0 }}>{languageName(code)} voice</span>
                <select
                  value={voicePrefs[code] ?? ''}
                  onChange={(e) => setVoicePref(code, e.target.value)}
                  style={{ flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff', color: '#111' }}
                >
                  <option value="">Auto{options[0] ? ` — ${options[0].name}` : ' — no voice found'}</option>
                  {options.map((v) => (
                    <option key={v.name + v.lang} value={v.name}>
                      {v.name} ({v.lang}{v.localService ? '' : ', online'})
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => previewVoice(code)}
                  title="Preview this voice"
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #ccc', background: '#fafafa', cursor: 'pointer' }}
                >
                  🔈
                </button>
              </div>
            );
          })}
          <div style={{ color: '#999', fontSize: 12, lineHeight: 1.5 }}>
            No good {languageName(language.to)} option? In Chrome, pick a &quot;Google&quot; voice — no download needed. To add system voices on a Mac: System Settings → Accessibility → Spoken Content → System voice → choose &quot;Manage Voices…&quot; from the voice dropdown (on older macOS, click the ⓘ next to the voice) → search the language → download an &quot;Enhanced&quot; or &quot;Premium&quot; voice → quit and reopen the browser.
          </div>
        </div>
      )}
      {showWords && (
        <div style={{ ...panelBox, maxHeight: 200, overflowY: 'auto' }}>
          {wordCount === 0 ? (
            <div style={{ color: '#888' }}>No words yet — they&apos;ll appear here as you produce French yourself.</div>
          ) : (
            wordList.map((w) => (
              <div key={w.word} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0', borderBottom: '1px solid #f5f5f5' }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{w.word}</span>
                  {w.gloss && <span style={{ color: '#888' }}> — {w.gloss}</span>}
                </span>
                <span style={{ color: '#999', flexShrink: 0 }}>
                  {w.due <= nowIso ? 'due' : ''} ×{w.reps}
                  {w.lapses > 0 ? ` ✗${w.lapses}` : ''}
                </span>
              </div>
            ))
          )}
          {(headStart || lastCheckpoint) && (
            <div style={{ color: '#999', fontSize: 12, paddingTop: 6 }}>
              {headStart && (
                <>Cognate network: {networkCovered} of {Math.min(headStart.words.length, headStart.total).toLocaleString()} instant-transfer words produced. </>
              )}
              {lastCheckpoint && <>Last checkpoint: {lastCheckpoint.correct}/{lastCheckpoint.total}.</>}
            </div>
          )}
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
        {visible.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%', display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div
              onClick={m.role === 'assistant' && m.segments?.length ? () => speak(m.segments) : undefined}
              title={m.role === 'assistant' && m.segments?.length ? 'Click to hear it again' : undefined}
              style={{
                padding: '10px 14px',
                borderRadius: 14,
                background: m.role === 'user' ? '#111' : '#f2f2f2',
                color: m.role === 'user' ? '#fff' : '#111',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
                cursor: m.role === 'assistant' && m.segments?.length ? 'pointer' : 'default',
              }}
            >
              {m.content}
            </div>
            {m.speech && (
              <div
                title={m.speech.note}
                style={{
                  fontSize: 12,
                  marginTop: 2,
                  color: m.speech.rating === 'clear' ? '#2c7' : m.speech.rating === 'close' ? '#c90' : '#999',
                }}
              >
                {m.speech.rating === 'clear' ? '🗣 clear ✓' : m.speech.rating === 'close' ? '🗣 close ≈' : '🗣 unclear ?'}
              </div>
            )}
          </div>
        ))}
        {loading && <div style={{ alignSelf: 'flex-start', color: '#aaa', fontStyle: 'italic' }}>…</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
        {micSupported && (
          <button
            onClick={toggleMic}
            title={recording ? 'Listening — click to stop' : 'Speak your French answer'}
            style={{
              padding: '12px 16px',
              fontSize: 16,
              borderRadius: 8,
              border: recording ? '1px solid #c00' : '1px solid #ccc',
              background: recording ? '#c00' : '#fafafa',
              color: recording ? '#fff' : '#333',
              cursor: 'pointer',
            }}
          >
            🎤
          </button>
        )}
        <input
          value={input}
          onChange={(e) => {
            inputFromMicRef.current = false;
            setInput(e.target.value);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder={recording ? 'Listening — speak French…' : 'Say it in French…'}
          style={{ flex: 1, padding: '12px 14px', fontSize: 16, borderRadius: 8, border: recording ? '1px solid #c00' : '1px solid #ccc' }}
        />
        <button onClick={send} disabled={loading} style={{ padding: '12px 18px', fontSize: 16, borderRadius: 8, border: '1px solid #111', background: '#111', color: '#fff', cursor: 'pointer' }}>
          Send
        </button>
      </div>
    </main>
  );
}
