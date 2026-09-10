'use client';

import { useEffect, useRef, useState } from 'react';

type Seg = { lang: string; text: string };
type Msg = { role: 'user' | 'assistant'; content: string; segments?: Seg[] };
type C = { id: string; title: string };
type WordEntry = {
  word: string;
  gloss?: string;
  constructionId: string;
  firstSeen: string;
  lastProduced?: string;
  timesProduced: number;
};
type ApiWord = { word: string; gloss?: string };
type Progress = { idx: number; masteredIds: string[] };

const WORDS_KEY = 'bridge.words.v1';
const PROGRESS_KEY = 'bridge.progress.v1';
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

function loadVoicePrefs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

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

function speechAvailable() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

// SpeechRecognition is not in TypeScript's DOM lib yet — minimal local types.
type RecognitionEvent = {
  results: { length: number; [i: number]: { 0: { transcript: string } } };
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

type HeadStart = {
  total: number;
  scopeTotal: number;
  clusters: { type: string; count: number; examples: string[] }[];
  words: string[];
};

function clusterLabel(type: string): string {
  if (type === 'identical') return 'spelled the same';
  if (type === 'accent-only') return 'accents aside';
  if (type === 'near') return 'nearly the same';
  return type.replace('rule:', '');
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
  const [idx, setIdx] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [words, setWords] = useState<Record<string, WordEntry>>({});
  const [showWords, setShowWords] = useState(false);
  const [resume, setResume] = useState<Progress | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const [recording, setRecording] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicePrefs, setVoicePrefs] = useState<Record<string, string>>({});
  const [showVoices, setShowVoices] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const voicePrefsRef = useRef<Record<string, string>>({});
  const voiceOnRef = useRef(true);
  const recRef = useRef<Recognition | null>(null);
  const handsFreeRef = useRef(false);
  const wordsRef = useRef<Record<string, WordEntry>>({});
  const transcriptRef = useRef('');
  const speakIdRef = useRef(0);
  const emptyListensRef = useRef(0);

  useEffect(() => {
    const w = loadWords();
    setWords(w);
    wordsRef.current = w;
    setResume(loadProgress());
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
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      transcriptRef.current = text;
      setInput(text);
    };
    rec.onend = () => {
      setRecording(false);
      const heard = transcriptRef.current.trim();
      if (!handsFreeRef.current) return;
      if (heard) {
        emptyListensRef.current = 0;
        void sendText(heard);
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

  function bankForRequest(): ApiWord[] {
    return Object.values(wordsRef.current)
      .sort((a, b) =>
        (a.lastProduced ?? a.firstSeen) < (b.lastProduced ?? b.firstSeen) ? -1 : 1,
      )
      .slice(0, 20)
      .map((w) => ({ word: w.word, gloss: w.gloss }));
  }

  async function post(constructionId: string, history: Msg[]) {
    const res = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        constructionId,
        messages: history.map((m) => ({ role: m.role, content: m.content })),
        knownWords: bankForRequest(),
      }),
    });
    return res.json() as Promise<{
      reply?: string;
      mastered?: boolean;
      words?: ApiWord[];
      segments?: Seg[];
      error?: string;
    }>;
  }

  function bankWords(newWords: ApiWord[], constructionId: string) {
    if (!newWords.length) return;
    setWords((prev) => {
      const next = { ...prev };
      const now = new Date().toISOString();
      for (const { word, gloss } of newWords) {
        const key = word.trim().toLowerCase();
        if (!key) continue;
        if (next[key]) {
          next[key] = {
            ...next[key],
            gloss: gloss ?? next[key].gloss,
            lastProduced: now,
            timesProduced: next[key].timesProduced + 1,
          };
        } else {
          next[key] = { word: word.trim(), gloss, constructionId, firstSeen: now, lastProduced: now, timesProduced: 1 };
        }
      }
      saveWords(next);
      wordsRef.current = next;
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

  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || loading) return;
    if (recording) recRef.current?.stop();
    transcriptRef.current = '';
    const history: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setLoading(true);
    try {
      const data = await post(constructions[idx].id, history);
      setMessages([...history, { role: 'assistant', content: data.reply ?? `⚠ ${data.error ?? 'error'}`, segments: data.segments }]);
      speak(data.segments, () => {
        if (data.mastered) {
          if (idx < constructions.length - 1) setTimeout(() => beginLesson(idx + 1), 800);
        } else if (handsFreeRef.current) {
          startRecognition();
        }
      });
      bankWords(data.words ?? [], constructions[idx].id);
      if (data.mastered) {
        recordMastery(idx);
        if (idx >= constructions.length - 1) {
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

  function send() {
    void sendText(input);
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
  const producedTokens = new Set<string>();
  for (const w of wordList) {
    for (const t of w.word.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüçœæ'-]+/)) {
      if (t) producedTokens.add(t);
    }
  }
  const networkCovered = headStart ? headStart.words.filter((f) => producedTokens.has(f)).length : 0;
  const canResume = resume !== null && (resume.idx > 0 || resume.masteredIds.length > 0);

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
        <div style={{ display: 'flex', gap: 8 }}>
          {micSupported && (
            <button
              onClick={toggleHandsFree}
              title={handsFree ? 'Hands-free on — the tutor listens after speaking' : 'Hands-free off — click to converse by voice only'}
              style={{ fontSize: 14, padding: '6px 12px', borderRadius: 999, border: '1px solid #ddd', background: handsFree ? '#111' : '#fafafa', color: handsFree ? '#fff' : '#333', cursor: 'pointer' }}
            >
              🎧
            </button>
          )}
          <button
            onClick={() => setShowVoices((s) => !s)}
            title="Choose voices"
            style={{ fontSize: 14, padding: '6px 12px', borderRadius: 999, border: '1px solid #ddd', background: showVoices ? '#111' : '#fafafa', color: showVoices ? '#fff' : '#333', cursor: 'pointer' }}
          >
            ⚙
          </button>
          <button
            onClick={toggleVoice}
            title={voiceOn ? 'Voice on — click to mute' : 'Voice off — click to unmute'}
            style={{ fontSize: 14, padding: '6px 12px', borderRadius: 999, border: '1px solid #ddd', background: '#fafafa', color: '#333', cursor: 'pointer' }}
          >
            {voiceOn ? '🔊' : '🔇'}
          </button>
          <button
            onClick={() => setShowWords((s) => !s)}
            style={{ fontSize: 14, padding: '6px 12px', borderRadius: 999, border: '1px solid #ddd', background: showWords ? '#111' : '#fafafa', color: showWords ? '#fff' : '#333', cursor: 'pointer' }}
          >
            ★ {wordCount} {wordCount === 1 ? 'word' : 'words'}
          </button>
        </div>
      </div>
      {handsFree && (
        <div style={{ fontSize: 13, color: '#888', padding: '6px 0', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
          {loading ? '… thinking' : speaking ? '🔊 speaking — listen' : recording ? '🎤 listening — just answer out loud' : 'hands-free: tap 🎤 if I stop listening'}
        </div>
      )}
      {showVoices && (
        <div style={{ border: '1px solid #eee', borderRadius: 10, padding: '12px 14px', marginBottom: 8, fontSize: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
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
        <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #eee', borderRadius: 10, padding: '10px 14px', marginBottom: 8, fontSize: 14 }}>
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
                  {constructions.find((c) => c.id === w.constructionId)?.title ?? w.constructionId}
                  {w.timesProduced > 1 ? ` · ×${w.timesProduced}` : ''}
                </span>
              </div>
            ))
          )}
          {headStart && (
            <div style={{ color: '#999', fontSize: 12, paddingTop: 6 }}>
              Cognate network: {networkCovered} of {Math.min(headStart.words.length, headStart.total).toLocaleString()} instant-transfer words produced so far.
            </div>
          )}
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
        {visible.map((m, i) => (
          <div
            key={i}
            onClick={m.role === 'assistant' && m.segments?.length ? () => speak(m.segments) : undefined}
            title={m.role === 'assistant' && m.segments?.length ? 'Click to hear it again' : undefined}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
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
          onChange={(e) => setInput(e.target.value)}
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
