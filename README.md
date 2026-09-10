# Bridge

Learn a new language through the ones you already speak.

Bridge is a Socratic tutor that never gives you the answer. It asks you one small question at a time until you build the new language yourself — out of the words and structures your existing languages already gave you.

## Why this exists

Most language apps treat you as a blank slate: flashcards, multiple choice, repeat-after-me. But nobody starts a language from zero. Every language you speak is full of words and patterns shared with the one you want to learn — and much of the new grammar is a short reasoning step away from grammar you already command. Bridge exploits that head start: it hands you pieces you already own and guides you, question by question, until you assemble real sentences on your own. What you construct yourself, you keep.

The first bridge shipped here is **English → French**, where the head start is enormous: *information*, *situation*, *possible*, *important* are spelled identically, and constructions like *je veux + verb* map almost one-to-one onto English. The engine, however, is pair-agnostic — a curriculum file declares its own `from` and `to` languages.

## How it works

- A curriculum of ordered **constructions** (`data/constructions.json`) — building blocks like *c'est + [word you already know]*, each defined by a goal, a transfer hook from the known language, a target pattern, and pitfalls to watch for. Each is a scaffold for a live conversation, not a script.
- A tutor prompt (`data/tutor-prompt.md`) that enforces the method: one guiding question per turn, respond to the learner's actual answer, never lecture, never hand over the solution.
- When you produce a construction's target correctly on your own, the lesson advances automatically.

- Every word you produce correctly is banked in a **word bank** (★ counter in the header) with its meaning, and your lesson progress is remembered — both live in your browser (localStorage), so there are no accounts and no server database. Coming back later resumes where you left off; **Start over** wipes the slate.
- The tutor **tests you constantly**: each lesson opens with a rapid warm-up on your least-recently-practiced words, and every few turns it weaves in another quick recall check. Producing a word again refreshes its place in the queue — lightweight spaced repetition, by conversation instead of flashcards.

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
5. Fully hands-free, Language-Transfer-style: toggle **🎧**. The tutor speaks, then opens the mic by itself; say your answer and it sends when you pause — no typing in the loop at all. The status line shows whether it's speaking, listening, or thinking.
6. Don't fish for the answer. The tutor won't give it — one more honest guess usually gets you there, and that's by design.

The header shows which lesson you're on. When you master a construction, the next one begins on its own.

## Adding a language pair

- Write a new `data/constructions.json` for the pair: set `language.from` / `language.to`, and give each construction a `title`, `goal`, `transferHook`, `targetPattern`, `examples`, and `watchFor`. The transfer hooks are the heart of it — find what the known language already gives the learner.
- Adjust the teaching feel in `data/tutor-prompt.md` if the pair needs it.
- Have a fluent speaker of the target language verify every construction before you trust it.
