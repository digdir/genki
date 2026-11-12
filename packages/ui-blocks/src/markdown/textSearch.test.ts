import { describe, expect, it } from 'vitest';
import {
  MIN_QUERY_LENGTH,
  findHits,
  hitsFor,
  runsIn,
  splitByHits,
  stepHit,
  type SearchableItem,
} from './textSearch.js';

// KA's own cases for this module, plus the two that map a hit onto drawn Markdown.
const risk: SearchableItem = { id: 'a', text: 'Risiko og risikovurdering' };
const goals: SearchableItem = { id: 'b', text: 'Måloppnåelse og ressursbruk' };
const more: SearchableItem = { id: 'c', text: 'Risiko står også her' };
const items = [risk, goals, more];

/** The matched text, read back out of the original, which is what an offset is for. */
const matched = (item: SearchableItem, query: string) =>
  findHits([item], query).map((hit) => item.text.slice(hit.start, hit.end));

describe('findHits', () => {
  it('ignores a query shorter than the minimum', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(findHits(items, 'r')).toEqual([]);
    expect(findHits(items, '  ')).toEqual([]);
  });

  it('matches without regard to case, and keeps offsets into the original', () => {
    expect(findHits([risk], 'RISIKO')).toMatchObject([
      { itemId: 'a', start: 0, end: 6 },
      { itemId: 'a', start: 10, end: 16 },
    ]);
    // The offsets point into the original string, so the casing survives.
    expect(matched(risk, 'RISIKO')).toEqual(['Risiko', 'risiko']);
  });

  it('matches Norwegian letters', () => {
    expect(matched(goals, 'måloppnåelse')).toEqual(['Måloppnåelse']);
    expect(matched(goals, 'MÅLOPPNÅELSE')).toEqual(['Måloppnåelse']);
  });

  it('folds a superscript to its plain twin, since a keyboard has no «²»', () => {
    // What `excerptMarkdown` raised: «m²» and a footnote mark the reader can see but not type.
    expect(findHits([{ id: 'a', text: 'arealet er 42 m²' }], 'm2')).toHaveLength(1);
    expect(findHits([{ id: 'a', text: 'Husleie¹⁾' }], 'husleie1')).toHaveLength(1);
  });

  it('keeps every offset after an İ, whose lowercase is two characters', () => {
    const item = { id: 'a', text: 'İstanbul og Oslo, İSTANBUL' };
    expect(matched(item, 'oslo')).toEqual(['Oslo']);
    expect(matched(item, 'istanbul')).toEqual(['İstanbul', 'İSTANBUL']);
    expect(matched(item, 'İstanbul')).toEqual(['İstanbul', 'İSTANBUL']);
  });

  it('folds no character but İ to a lowercase of another length, so no offset drifts', () => {
    const longer: number[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      if (char.toLocaleLowerCase('nb').length !== char.length) longer.push(code);
    }
    expect(longer).toEqual([0x130]);
  });

  it('does not overlap matches', () => {
    expect(findHits([{ id: 'a', text: 'aaaa' }], 'aa')).toHaveLength(2);
  });

  it('returns hits in the order the items were given', () => {
    const positions = findHits(items, 'risiko').map((hit) =>
      items.findIndex((item) => item.id === hit.itemId),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('hitsFor', () => {
  it('picks out the hits inside one item', () => {
    const hits = findHits(items, 'risiko');
    expect(hitsFor(hits, 'a').every((hit) => hit.itemId === 'a')).toBe(true);
    expect(hitsFor(hits, 'a')).toHaveLength(2);
    expect(hitsFor(hits, 'finnes-ikke')).toEqual([]);
  });
});

describe('stepHit', () => {
  it('stops at both ends rather than wrapping', () => {
    expect(stepHit(3, 2, 1)).toBe(2);
    expect(stepHit(3, 0, -1)).toBe(0);
    expect(stepHit(3, 0, 1)).toBe(1);
    expect(stepHit(3, 2, -1)).toBe(1);
  });

  it('stays at zero when there is nothing to step through', () => {
    expect(stepHit(0, 0, 1)).toBe(0);
    expect(stepHit(0, 0, -1)).toBe(0);
  });
});

describe('splitByHits', () => {
  it('covers the whole text exactly once', () => {
    const text = 'Risiko og risikovurdering';
    const hits = findHits([{ id: 'a', text }], 'risiko');
    const runs = splitByHits(text, hits);

    expect(runs.map((run) => run.text).join('')).toBe(text);
    expect(runs.filter((run) => run.hit !== undefined)).toHaveLength(2);
  });

  it('returns the text untouched when nothing matched', () => {
    expect(splitByHits('Ressursbruk', [])).toEqual([{ text: 'Ressursbruk' }]);
  });
});

describe('runsIn', () => {
  // `Vi har en **viktig** tekst` is three strings drawn with nothing between them.
  const leaves = ['Vi har en ', 'viktig', ' tekst om lønn.'];
  const flat = leaves.join('');
  // Where each leaf starts in the flat text, as `visibleText` reports it.
  const starts = leaves.map((_, i) => leaves.slice(0, i).join('').length);
  const drawn = (query: string) => {
    const hits = findHits([{ id: 'x', text: flat }], query);
    return leaves.map((leaf, i) =>
      runsIn(leaf, starts[i] ?? 0, hits).map((run) => [run.text, run.hit !== undefined]),
    );
  };

  it('clips one hit onto each leaf it covers', () => {
    expect(findHits([{ id: 'x', text: flat }], 'viktig tekst')).toHaveLength(1);
    expect(drawn('viktig tekst')).toEqual([
      [['Vi har en ', false]],
      [['viktig', true]],
      [
        [' tekst', true],
        [' om lønn.', false],
      ],
    ]);
  });

  it('is one hit, although it is drawn in two places', () => {
    const hits = findHits([{ id: 'x', text: flat }], 'viktig tekst');
    const marked = leaves
      .flatMap((leaf, i) => runsIn(leaf, starts[i] ?? 0, hits))
      .map((run) => run.hit)
      .filter((hit) => hit !== undefined);
    expect(marked).toHaveLength(2);
    expect(new Set(marked).size).toBe(1);
  });

  it('leaves a leaf with no hit in it whole', () => {
    expect(drawn('lønn')[0]).toEqual([['Vi har en ', false]]);
  });

  it('covers every leaf exactly once, hit or no hit', () => {
    expect(drawn('e').map((runs) => runs.map(([text]) => text).join(''))).toEqual(leaves);
  });
});
