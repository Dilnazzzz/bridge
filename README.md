# Parler

A Socratic French tutor for English speakers. It never gives you the answer — it asks you one small question at a time until you build the French yourself.

## Why this exists

Most language apps drill you: flashcards, multiple choice, repeat-after-me. Parler works the other way around. As an English speaker you already own thousands of French words — *information*, *situation*, *possible*, *important* are spelled the same — and much of French grammar is a short reasoning step away from English. In the spirit of the Thinking Method, the tutor exploits that head start: it hands you pieces you already have and guides you, question by question, until you assemble real French sentences on your own. What you construct yourself, you keep.

## How it works

- A curriculum of 12 **constructions** (`data/constructions.json`) — ordered building blocks like *c'est + [word you already know]*, *je veux + verb*, *there is no "to"*. Each one is a scaffold for a live conversation, not a script.
- A tutor prompt (`data/tutor-prompt.md`) that enforces the method: one guiding question per turn, respond to your actual answer, never lecture, never hand over the solution.
- When you produce a construction's target correctly on your own, the lesson advances automatically.

There are no accounts and no database — refresh the page to start over.

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
2. Answer the tutor's questions in the chat — in English at first, in growing French as you go.
3. Say your answers out loud before you send them; pronunciation is part of the point.
4. Don't fish for the answer. The tutor won't give it — one more honest guess usually gets you there, and that's by design.

The header shows which lesson you're on (1–12). When you master a construction, the next one begins on its own.

## Extending it

- Add or reorder lessons by editing `data/constructions.json` — each entry needs a `title`, `goal`, `transferHook`, `targetPattern`, `examples`, and `watchFor`.
- Change how the tutor teaches by editing `data/tutor-prompt.md`.
- If you add lessons for a language you don't speak fluently, have a fluent speaker verify them before trusting them.
