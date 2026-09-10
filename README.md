# Bridge

Learn a new language through the ones you already speak.

![Bridge — onboarding screen showing your cognate head start](public/screenshot.png)

Bridge is a Socratic tutor that never gives you the answer. It asks you one small question at a time until you build the new language yourself — out of the words and structures your existing languages already gave you.

## Why this exists

Most language apps treat you as a blank slate: flashcards, multiple choice, repeat-after-me. But nobody starts a language from zero. Every language you speak is full of words and patterns shared with the one you want to learn — and much of the new grammar is a short reasoning step away from grammar you already command. Bridge exploits that head start: it hands you pieces you already own and guides you, question by question, until you assemble real sentences on your own. What you construct yourself, you keep.

The first bridge shipped here is **English → French**, where the head start is enormous: *information*, *situation*, *possible*, *important* are spelled identically, and constructions like *je veux + verb* map almost one-to-one onto English. The engine, however, is pair-agnostic — a curriculum file declares its own `from` and `to` languages.

## How it works

The design principle: **code owns the curriculum, memory, and scheduling; the model owns only the conversation.**

- A **syllabus graph** of 48 constructions (`data/constructions.json`) — building blocks like *c'est + [word you already know]* through *je voudrais*, both past tenses, pronouns, and a narration capstone. Each node declares prerequisites; a lesson unlocks when its prereqs are mastered. Nodes c13+ are machine-authored in the Thinking-Method spirit and should be verified by a fluent speaker.
- A **learner model** (`.data/learner.json`, server-side, gitignored) — every word you've produced with its meaning, a memory half-life that grows with each successful recall and collapses on a miss (spaced repetition, exponential-forgetting model), plus a log of your characteristic error patterns (gender, "to"-insertion, word order…).
- A **session planner** that assembles each request: due review words, the current unlocked construction, and your recurring errors to watch for. The tutor opens lessons with warm-up quizzes, re-tests something every few turns, and every 5 mastered constructions runs a **checkpoint** — 5 rapid challenges, no hints, scored and recorded.
- The tutor's replies are **structured output** (typed JSON, not free text): the conversational reply plus machine-readable observations — words produced, review misses, error tags, mastery, and a pronunciation rating. No fragile control tokens.
- **Pronunciation is scored by sound, not spelling.** Spoken answers are judged phonetically — saying *c'est* that gets transcribed "s'est" is correct pronunciation, and each voice answer gets a 🗣 clear/close/unclear badge with a coaching note.
- **📖 Story mode** generates a micro-story almost entirely from words you already own (~95% comprehensible input), spoken aloud, with tap-to-reveal translations and comprehension questions.
- **📄 Coverage tool**: paste any real French text and see it color-coded — words you've produced, instant cognates, genuinely new — with a % readable score. When the percentage gets high, you're ready for real content.

## Setup

You need Node.js 20+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
echo "ANTHROPIC_API_KEY=your-key-here" > .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How to use it

1. Click **Start**.
2. Answer the tutor's questions in the chat — in the language you know at first, in growing amounts of the new one as you go.
3. Say your answers out loud before you send them; pronunciation is part of the point. The tutor's replies are spoken aloud too — French in a French voice — via the 🔊 toggle, and clicking any tutor message replays it.
4. Or answer by voice: press 🎤 and speak your French. What the browser heard lands in the input box so you can check it before sending — if the transcript is mangled, your pronunciation probably needs another try, which is useful feedback in itself. (Voice input works in Chrome, Edge, and Safari.)
5. Fully hands-free, Language-Transfer-style: tap **"go hands-free"** under the input. The tutor speaks, then opens the mic by itself; say your answer and it sends when you pause — no typing in the loop at all. A big state button shows whether it's listening, speaking, or thinking; tap it to interrupt or re-listen.
6. Explore the tabs: **Learn** is the tutor, **Story** generates comprehensible-input micro-stories from your words, **Read** analyzes any pasted French for readability, and **Progress** holds your word bank, checkpoint scores, and the 48-lesson syllabus map.
7. Don't fish for the answer. The tutor won't give it — one more honest guess usually gets you there, and that's by design.

The header shows which lesson you're on. When you master a construction, the next one begins on its own.

## Tests

```bash
npm test
```

Vitest suite covering the spaced-repetition scheduler (growth, lapses, key normalization), the syllabus graph unlocking, the session planner (due-word selection, error ranking, checkpoint cadence), persistence, and bilingual reply segmentation.

## Adding a language pair

- Write a new `data/constructions.json` for the pair: set `language.from` / `language.to`, and give each construction a `title`, `goal`, `transferHook`, `targetPattern`, `examples`, and `watchFor`. The transfer hooks are the heart of it — find what the known language already gives the learner.
- Adjust the teaching feel in `data/tutor-prompt.md` if the pair needs it.
- Have a fluent speaker of the target language verify every construction before you trust it.
