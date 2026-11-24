import { describe, expect, it } from 'vitest';
import { numberSentences, quoteOf, sentenceUnits } from './sentences.js';

const page = `# 7. Hovedfunn i evalueringen

Hovedfunnene i evalueringen er inndelt i tre deler. Valget av kontraktstrategi var en direkte årsak til problemene, jf. kap. 5. Det gjaldt bl.a. BVP og makspris (BMP) på 1,2 mrd. kr.

| Post | 2023 | 2024 | Endring i pst. |
| --- | --- | --- | --- |
| Driftsutgifter | 1 204 | 1 310 | 8,8 |

- Målet om å kutte kostnadene fikk for stor betydning.
- Anbefalingene fra KS2 ble ikke fulgt.`;

const texts = (text: string) => sentenceUnits(text).map((u) => text.slice(u.start, u.end));

describe('sentence ids in an excerpt', () => {
  it('splits an excerpt into headings, list items, table rows and sentences, one id each', () => {
    expect(texts(page)).toEqual([
      '# 7. Hovedfunn i evalueringen',
      'Hovedfunnene i evalueringen er inndelt i tre deler.',
      'Valget av kontraktstrategi var en direkte årsak til problemene, jf. kap. 5.',
      'Det gjaldt bl.a. BVP og makspris (BMP) på 1,2 mrd. kr.',
      '| Post | 2023 | 2024 | Endring i pst. |',
      '| Driftsutgifter | 1 204 | 1 310 | 8,8 |',
      '- Målet om å kutte kostnadene fikk for stor betydning.',
      '- Anbefalingene fra KS2 ble ikke fulgt.',
    ]);
  });

  it('keeps a Norwegian abbreviation such as «jf. kap. 5.» or «bl.a.» inside its sentence', () => {
    const text =
      'Se f.eks. tabell 3, jf. kap. 5. Tallene er ca. 12 pst. høyere enn i fjor, dvs. mer enn ventet. Neste setning.';
    expect(texts(text)).toEqual([
      'Se f.eks. tabell 3, jf. kap. 5.',
      'Tallene er ca. 12 pst. høyere enn i fjor, dvs. mer enn ventet.',
      'Neste setning.',
    ]);
  });

  it('gives the table separator line no id', () => {
    expect(texts('| a | b |\n| --- | :-: |\n| 1 | 2 |')).toEqual(['| a | b |', '| 1 | 2 |']);
  });

  it('shows the model each unit with its id before it and the text otherwise unchanged', () => {
    expect(numberSentences('# Tittel\n\nEn. To.\n\n| a |\n| --- |\n| 1 |')).toBe(
      '⟨1⟩ # Tittel\n\n⟨2⟩ En. ⟨3⟩ To.\n\n⟨4⟩ | a |\n| --- |\n⟨5⟩ | 1 |',
    );
  });

  it('quotes a range of units with up to 32 characters of text before and after', () => {
    const text = 'Første setning her. Andre setning. Tredje setning kommer til slutt.';
    expect(quoteOf(text, 2, 2)).toEqual({
      type: 'TextQuoteSelector',
      exact: 'Andre setning.',
      prefix: 'Første setning her. ',
      suffix: ' Tredje setning kommer til slutt',
    });
    expect(quoteOf(text, 1, 2)?.exact).toBe('Første setning her. Andre setning.');
  });

  it('has no quote for an id the excerpt does not have', () => {
    expect(quoteOf('En. To.', 3, 3)).toBeUndefined();
    expect(quoteOf('En. To.', 2, 1)).toBeUndefined();
    expect(quoteOf('En. To.', 0, 1)).toBeUndefined();
  });
});
