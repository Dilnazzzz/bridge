'use client';

import { useEffect, useRef, useState } from 'react';

type Seg = { lang: string; text: string };
type SpeechRating = { rating: 'clear' | 'close' | 'unclear' | 'na'; note?: string };
type Msg =
  | { role: 'user' | 'assistant'; content: string; segments?: Seg[]; speech?: SpeechRating }
  | { role: 'divider'; content: string; n: number }
  | { role: 'mastery'; content: string };
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

type Tab = 'learn' | 'story' | 'read' | 'progress';

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

// Render a reply string with «target language» spans styled.
function renderReply(content: string) {
  const parts = content.split(/(«[^»]*»)/g);
  return parts.map((p, i) =>
    p.startsWith('«') ? (
      <span key={i} className="fr" lang="fr">
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

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
  const [tab, setTab] = useState<Tab>('learn');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [recording, setRecording] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicePrefs, setVoicePrefs] = useState<Record<string, string>>({});
  const [showVoices, setShowVoices] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [story, setStory] = useState<Story | null>(null);
  const [storySegs, setStorySegs] = useState<Seg[]>([]);
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyEnglish, setStoryEnglish] = useState(false);
  const [revealedAnswers, setRevealedAnswers] = useState<Record<number, boolean>>({});
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
  const masteredCount = snap?.masteredNodes.length ?? 0;

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

  function chatHistory(msgs: Msg[]) {
    return msgs
      .filter((m): m is Extract<Msg, { role: 'user' | 'assistant' }> => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async function beginLesson(existing: Msg[] = []) {
    const current = snapRef.current;
    const nodeId = current?.currentNodeId;
    if (!nodeId) return;
    const idx = current ? Math.min(current.nodeIndex, constructions.length - 1) : 0;
    const title = constructions[idx]?.title ?? '';
    const divider: Msg = { role: 'divider', content: title, n: idx + 1 };
    const seed: Msg = { role: 'user', content: "Let's begin." };
    const base: Msg[] = [...existing, divider, seed];
    setMessages(base);
    setLoading(true);
    try {
      const data = await post({ constructionId: nodeId, messages: [{ role: 'user', content: "Let's begin." }] });
      if (data.state) {
        setSnap(data.state);
        snapRef.current = data.state;
      }
      setMessages([...base, { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}`, segments: data.segments }]);
      speak(data.segments, () => {
        if (handsFreeRef.current) startRecognition();
      });
    } catch {
      setMessages([...base, { role: 'assistant', content: '⚠ Could not reach the tutor.' }]);
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
    const nodeTitle = node.title;
    const history: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setLoading(true);
    try {
      // Only user/assistant turns go to the API — dividers stay client-side.
      const data = await post({
        constructionId: nodeId,
        messages: chatHistory(history),
        spoken: opts?.spoken ?? false,
        asrConfidence: opts?.confidence,
      });
      if (data.state) {
        setSnap(data.state);
        snapRef.current = data.state;
      }
      const badge = opts?.spoken && data.speech && data.speech.rating !== 'na' ? data.speech : undefined;
      const userMsg: Msg = badge ? { role: 'user', content: text, speech: badge } : { role: 'user', content: text };
      const assistantMsg: Msg = { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}`, segments: data.segments };
      let next: Msg[] = [...history.slice(0, -1), userMsg, assistantMsg];
      if (data.mastered) {
        next = [...next, { role: 'mastery', content: nodeTitle }];
        if (data.state?.currentNodeId === null) {
          next = [...next, { role: 'assistant', content: `🎉 That was the last lesson — you've worked through all ${constructions.length} constructions.` }];
        }
      }
      setMessages(next);
      speak(data.segments, () => {
        if (data.mastered) {
          if (data.state?.currentNodeId) setTimeout(() => void beginLesson(next), 800);
        } else if (handsFreeRef.current) {
          startRecognition();
        }
      });
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
    setShowMenu(false);
    setStarted(true);
    setTab('learn');
    void beginLesson();
  }

  async function loadStory() {
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

  function openTab(t: Tab) {
    setTab(t);
    if (t === 'story' && !story && !storyLoading) void loadStory();
  }

  const visible = messages.filter((m) => !(m.role === 'user' && m.content === "Let's begin."));
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
  const canResume = snap !== null && (wordCount > 0 || masteredCount > 0);
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

  const heroState = loading ? 'thinking' : speaking ? 'speaking' : recording ? 'listening' : 'idle';
  const heroStatus =
    heroState === 'thinking' ? 'thinking…' :
    heroState === 'speaking' ? 'listen…' :
    heroState === 'listening' ? 'listening — just answer out loud' :
    'tap to speak';

  if (!started) {
    return (
      <main className="onboarding">
        <h1>Bridge</h1>
        {headStart ? (
          <>
            <p className="lede">
              Of the {headStart.scopeTotal.toLocaleString()} most common French words,{' '}
              <strong>you can already read about {headStart.total.toLocaleString()}</strong> — they&apos;re the same words English borrowed or shares. This tutor won&apos;t give you answers. It will ask you questions until you build French yourself.
            </p>
            <div className="cluster-chips">
              {headStart.clusters.map((c) => (
                <span key={c.type} title={c.examples.join(', ')}>
                  {clusterLabel(c.type)} · {c.count.toLocaleString()}
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="lede">
            You already recognize thousands of French words — the ones ending in -tion, -able, -ent are nearly the same. This tutor won&apos;t give you answers. It will ask you questions until you build French yourself.
          </p>
        )}
        {canResume && snap && (
          <p className="welcome-back">
            Welcome back — you own {wordCount} {wordCount === 1 ? 'word' : 'words'}
            {snap.dueCount > 0 ? ` (${snap.dueCount} due for review)` : ''} and you&apos;re on lesson {Math.min(snap.nodeIndex + 1, snap.nodeTotal)} of {snap.nodeTotal}.
            {lastCheckpoint ? ` Last checkpoint: ${lastCheckpoint.correct}/${lastCheckpoint.total}.` : ''}
          </p>
        )}
        <div className="onboarding-actions">
          <button
            className="primary-btn"
            disabled={snap === null}
            onClick={() => {
              setStarted(true);
              void beginLesson();
            }}
          >
            {snap === null ? 'Loading…' : canResume ? 'Continue' : 'Start'}
          </button>
          {canResume && (
            <button className="ghost-btn" onClick={() => void startOver()}>
              Start over
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="app">
      <div className="topbar">
        <div className="wordmark">Bridge</div>
        <div className="topbar-mid">
          <div className="lesson-label">
            {courseComplete ? 'Course complete 🎉' : `Lesson ${nodeIdx + 1} of ${constructions.length}`}
            {snap && snap.dueCount > 0 ? ` · ${snap.dueCount} due` : ''}
            {snap?.checkpointActive ? ' · 📋 checkpoint' : ''}
          </div>
          <div className="lesson-title">{node.title}</div>
          <div className="progress-track" role="progressbar" aria-valuenow={masteredCount} aria-valuemin={0} aria-valuemax={constructions.length} aria-label="Course progress">
            <div className="progress-fill" style={{ width: `${(masteredCount / constructions.length) * 100}%` }} />
          </div>
        </div>
        <div className="menu-wrap">
          <button className="menu-btn" aria-label="Menu" aria-expanded={showMenu} onClick={() => setShowMenu((s) => !s)}>⋯</button>
          {showMenu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => { setShowVoices((s) => !s); setShowMenu(false); }}>Voices…</button>
              <button role="menuitem" onClick={() => { toggleVoice(); setShowMenu(false); }}>{voiceOn ? 'Mute tutor voice' : 'Unmute tutor voice'}</button>
              <button role="menuitem" className="danger" onClick={() => void startOver()}>Start over</button>
            </div>
          )}
        </div>
      </div>

      <div className="tabs" role="tablist">
        <button className={`tab ${tab === 'learn' ? 'active' : ''}`} role="tab" aria-selected={tab === 'learn'} onClick={() => openTab('learn')}>Learn</button>
        <button className={`tab ${tab === 'story' ? 'active' : ''}`} role="tab" aria-selected={tab === 'story'} onClick={() => openTab('story')}>Story</button>
        <button className={`tab ${tab === 'read' ? 'active' : ''}`} role="tab" aria-selected={tab === 'read'} onClick={() => openTab('read')}>Read</button>
        <button className={`tab ${tab === 'progress' ? 'active' : ''}`} role="tab" aria-selected={tab === 'progress'} onClick={() => openTab('progress')}>
          Progress <span className="count">★{wordCount}</span>
        </button>
      </div>

      {showVoices && (
        <div className="panel">
          {[language.to, language.from].map((code) => {
            const options = voices
              .filter((v) => normLang(v.lang).startsWith(code.toLowerCase()))
              .sort((a, b) => rankVoice(b, code) - rankVoice(a, code));
            return (
              <div key={code} className="voice-row">
                <span className="label">{languageName(code)} voice</span>
                <select value={voicePrefs[code] ?? ''} onChange={(e) => setVoicePref(code, e.target.value)} aria-label={`${languageName(code)} voice`}>
                  <option value="">Auto{options[0] ? ` — ${options[0].name}` : ' — no voice found'}</option>
                  {options.map((v) => (
                    <option key={v.name + v.lang} value={v.name}>
                      {v.name} ({v.lang}{v.localService ? '' : ', online'})
                    </option>
                  ))}
                </select>
                <button className="chip-btn" onClick={() => previewVoice(code)} aria-label={`Preview ${languageName(code)} voice`}>🔈</button>
              </div>
            );
          })}
          <p className="hint" style={{ marginTop: 8 }}>
            No good {languageName(language.to)} option? In Chrome, pick a &quot;Google&quot; voice — no download needed. On a Mac: System Settings → Accessibility → Spoken Content → System voice → &quot;Manage Voices…&quot; → download an Enhanced voice, then restart the browser.
          </p>
        </div>
      )}

      {tab === 'learn' && (
        <>
          <div ref={scrollRef} className="chat">
            {visible.map((m, i) => {
              if (m.role === 'divider') {
                return (
                  <div key={i} className="divider-card">
                    Lesson <span className="n">{m.n}</span> · <span className="n">{m.content}</span>
                  </div>
                );
              }
              if (m.role === 'mastery') {
                return (
                  <div key={i} className="mastery-card">
                    ✓ Mastered — {m.content}
                  </div>
                );
              }
              const speakable = m.role === 'assistant' && !!m.segments?.length;
              return (
                <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'tutor'}`}>
                  <div
                    className={`bubble ${speakable ? 'speakable' : ''}`}
                    onClick={speakable ? () => speak(m.segments) : undefined}
                    title={speakable ? 'Click to hear it again' : undefined}
                  >
                    {m.role === 'assistant' ? renderReply(m.content) : m.content}
                  </div>
                  {m.role === 'user' && m.speech && (
                    <div className={`speech-badge ${m.speech.rating}`} title={m.speech.note}>
                      {m.speech.rating === 'clear' ? '🗣 clear ✓' : m.speech.rating === 'close' ? '🗣 close ≈' : '🗣 unclear ?'}
                    </div>
                  )}
                </div>
              );
            })}
            {loading && <div className="thinking">…</div>}
          </div>
          {handsFree ? (
            <div className="hero">
              <button
                className={`hero-circle ${heroState}`}
                aria-label={heroStatus}
                onClick={() => {
                  if (recording) recRef.current?.stop();
                  else if (speaking && speechAvailable()) {
                    window.speechSynthesis.cancel();
                    startRecognition();
                  } else if (!loading) startRecognition();
                }}
              >
                {heroState === 'listening' ? '🎤' : heroState === 'speaking' ? '🔊' : heroState === 'thinking' ? '…' : '🎤'}
              </button>
              <div className="hero-status">{heroStatus}</div>
              <button className="link-btn" onClick={toggleHandsFree}>type instead</button>
            </div>
          ) : (
            <>
              <div className="composer">
                {micSupported && (
                  <button
                    className={`icon-btn mic-btn ${recording ? 'rec' : ''}`}
                    onClick={toggleMic}
                    aria-label={recording ? 'Stop listening' : 'Speak your answer'}
                  >
                    🎤
                  </button>
                )}
                <input
                  className={`text-input ${recording ? 'rec' : ''}`}
                  value={input}
                  onChange={(e) => {
                    inputFromMicRef.current = false;
                    setInput(e.target.value);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
                  placeholder={recording ? 'Listening — speak French…' : 'Say it in French…'}
                  aria-label="Your answer"
                />
                <button className="send-btn" onClick={send} disabled={loading}>Send</button>
              </div>
              {micSupported && (
                <div className="composer-hint">
                  <span>Answers you speak are scored on pronunciation, not spelling.</span>
                  <button className="link-btn" onClick={toggleHandsFree}>🎧 go hands-free</button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === 'story' && (
        <div className="panel panel-scroll">
          <div className="panel-head">
            <h3>{storyLoading || !story ? 'Story' : story.title}</h3>
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="chip-btn" onClick={() => speak(storySegs)} aria-label="Listen to the story" disabled={!story}>🔊 Listen</button>
              <button className={`chip-btn ${storyEnglish ? 'active' : ''}`} onClick={() => setStoryEnglish((s) => !s)} disabled={!story}>EN</button>
              <button className="chip-btn" onClick={() => void loadStory()} disabled={storyLoading}>↻ New</button>
            </span>
          </div>
          {storyLoading || !story ? (
            <p className="hint">Writing a story from the words you own…</p>
          ) : (
            <>
              <div className="story-fr">
                {story.sentences.map((s, i) => (
                  <div key={i}>
                    <span lang="fr">{s.fr}</span>
                    {storyEnglish && <span className="story-en"> — {s.en}</span>}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                {story.questions.map((q, i) => (
                  <button key={i} className="story-q" onClick={() => setRevealedAnswers((r) => ({ ...r, [i]: !r[i] }))}>
                    {q.q}{' '}
                    {revealedAnswers[i] ? <span className="a">→ {q.answer}</span> : <span className="tap">(tap for answer)</span>}
                  </button>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 10 }}>
                ~95% of these words are yours or free cognates — that&apos;s comprehensible input. Listen first, read second, peek at English last.
              </p>
            </>
          )}
        </div>
      )}

      {tab === 'read' && (
        <div className="panel panel-scroll">
          <h3>How much can you already read?</h3>
          <textarea
            className="coverage-input"
            value={coverageText}
            onChange={(e) => setCoverageText(e.target.value)}
            placeholder="Paste any French text — a headline, a paragraph, song lyrics…"
            aria-label="French text to analyze"
          />
          {coverageText && (
            <>
              <div className="coverage-render" lang="fr">
                {coverageTokens.map((t) =>
                  t.cls === 'x' ? <span key={t.key}>{t.tok}</span> : <span key={t.key} className={`tok ${t.cls}`}>{t.tok}</span>,
                )}
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                {covPct}% readable — {covKnown} produced by you, {covCognate} instant cognates, {covWords.length - covKnown - covCognate} new. Green = yours, blue = cognate, red = new. When this number gets high, you&apos;re ready for real French content.
              </p>
            </>
          )}
        </div>
      )}

      {tab === 'progress' && (
        <div className="panel-scroll">
          <div className="stat-grid">
            <div className="stat"><div className="v">{wordCount}</div><div className="k">words you own</div></div>
            <div className="stat"><div className="v">{snap?.dueCount ?? 0}</div><div className="k">due for review</div></div>
            <div className="stat"><div className="v">{masteredCount}/{constructions.length}</div><div className="k">lessons mastered</div></div>
            <div className="stat"><div className="v">{lastCheckpoint ? `${lastCheckpoint.correct}/${lastCheckpoint.total}` : '—'}</div><div className="k">last checkpoint</div></div>
            {headStart && (
              <div className="stat"><div className="v">{networkCovered}</div><div className="k">of {Math.min(headStart.words.length, headStart.total).toLocaleString()} instant cognates produced</div></div>
            )}
          </div>
          <div className="panel">
            <h3>Word bank</h3>
            {wordCount === 0 ? (
              <p className="hint">No words yet — they&apos;ll appear here as you produce French yourself.</p>
            ) : (
              wordList.map((w) => (
                <div key={w.word} className="word-row">
                  <span>
                    <span className="w" lang="fr">{w.word}</span>
                    {w.gloss && <span className="g"> — {w.gloss}</span>}
                  </span>
                  <span className="meta">
                    {w.due <= nowIso ? <span className="due-tag">due </span> : ''}×{w.reps}
                    {w.lapses > 0 ? ` ✗${w.lapses}` : ''}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="panel">
            <h3>Syllabus</h3>
            {constructions.map((c, i) => {
              const done = snap?.masteredNodes.includes(c.id);
              const current = c.id === snap?.currentNodeId;
              return (
                <div key={c.id} className={`syllabus-row ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
                  <span className="idx">{i + 1}</span>
                  <span className="marker">{done ? '✓' : current ? '▸' : '·'}</span>
                  <span>{c.title}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </main>
  );
}
