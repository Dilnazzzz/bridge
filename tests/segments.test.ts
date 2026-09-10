import { describe, expect, it } from 'vitest';
import { toSegments } from '../lib/segments';

describe('toSegments', () => {
  it('splits guillemet spans into target-language segments', () => {
    const segs = toSegments('Say «c\'est possible» out loud.', 'en', 'fr');
    expect(segs).toEqual([
      { lang: 'en', text: 'Say ' },
      { lang: 'fr', text: "c'est possible" },
      { lang: 'en', text: ' out loud.' },
    ]);
  });

  it('handles replies with no target language', () => {
    expect(toSegments('Just English here.', 'en', 'fr')).toEqual([
      { lang: 'en', text: 'Just English here.' },
    ]);
  });

  it('handles adjacent and leading/trailing spans', () => {
    const segs = toSegments('«bonjour»«merci» friend', 'en', 'fr');
    expect(segs).toEqual([
      { lang: 'fr', text: 'bonjour' },
      { lang: 'fr', text: 'merci' },
      { lang: 'en', text: ' friend' },
    ]);
  });

  it('drops punctuation-only fragments', () => {
    const segs = toSegments('«un», «deux» — !', 'en', 'fr');
    expect(segs).toEqual([
      { lang: 'fr', text: 'un' },
      { lang: 'fr', text: 'deux' },
    ]);
  });

  it('keeps accented characters intact', () => {
    const segs = toSegments('Try «différent» now', 'en', 'fr');
    expect(segs[1]).toEqual({ lang: 'fr', text: 'différent' });
  });
});
