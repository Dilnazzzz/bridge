export type Segment = { lang: string; text: string };

// Split a tutor reply into spoken-language segments: text inside «…» is the
// target language, everything else is the learner's known language.
// Segments with no letters (bare punctuation) are dropped.
export function toSegments(text: string, from: string, to: string): Segment[] {
  const segments: Segment[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ lang: from, text: text.slice(last, m.index) });
    segments.push({ lang: to, text: m[1] });
    last = re.lastIndex;
  }
  if (last < text.length) segments.push({ lang: from, text: text.slice(last) });
  return segments.filter((s) => /\p{L}/u.test(s.text));
}
