// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from '../markdown/Markdown.js';
import { excerptMarkdown, headingText } from './excerptMarkdown.js';
import markerChunks from './fixtures/marker-chunks.json' with { type: 'json' };
import { Sources } from './Sources.js';

afterEach(cleanup);

// Real Kudos chunks, cut short, as Marker converted them; the id in each comment is
// doc_num/chunk_index. The cases are those of KA's readableText tests.

/** 372017/1: Marker's page marker between two paragraphs. */
const PAGE_BREAK =
  'Regjeringen har pekt ut offentlige anskaffelser som et viktig område. Vi ser en positiv utvikling i virksomhetenes modenhet både når det gjelder bruk av digitale verktøy og innen bærekraftige anskaffelser.\n\n{5}\n\n------------------------------------------------\n\n\n\nGjennom markedsplassen for skytjenester bidrar vi til å forbedre tilgjengeligheten for skytjenester til offentlig sektor.';

/** 140/22: italic run-in heading and a list. */
const ITALIC_AND_LIST =
  'Nedenfor er Direktoratet for økonomistyrings (DFØ) vurderinger av søknadene.\n\n*1) Søknad om unntak fra krav til årsrapport for statlige virksomheter* Det følger av bestemmelser om økonomistyring i staten pkt. 2.3.3, jf. pkt. 1.5.1, at en statlig virksomhet skal utarbeide en årsrapport som inneholder seks deler, med følgende benevnelse og rekkefølge:\n\n- I. Leders beretning\n- II. Introduksjon til virksomheten og hovedtall\n- III. Årets aktiviteter og resultater';

/** 375022/117: a table with an empty spacer row, and footnotes in `<sup>`. */
const TABLE_AND_FOOTNOTES =
  '|                                                   | 31.12.2024 |\n|---------------------------------------------------|------------|\n|                                                   |            |\n| Husleie1)                                         | 3 024 010  |\n| Vedlikehold egne bygg og anlegg                   | 0          |\n| Sum andre driftskostnader                         | 10 795 764 |\n\n<sup>1)</sup> I tillegg til husleien føres også annen lokalleie på denne posten.';

/** 372017/0: the table of contents, a `<br>` inside a cell. */
const BREAK_IN_CELL =
  '{1}\n\n------------------------------------------------\n\n| 1 Leders beretning<br>4 |   |\n|----------------------------------------------|---|\n| 2 Introduksjon til virksomheten og hovedtall<br>6 |   |';

/** 375022/117: a sparse row in a wider table. */
const SPARSE_ROW =
  '|                        | Immaterielle<br>eiendeler | Tomter, bygninger<br>og annen fast<br>eiendom | Sum       |\n|------------------------|---------------------------|-----------------------------------------------|-----------|\n| Varighet 1-5 år        |                           | 2 912 432                                     | 2 912 432 |';

const drawn = (markdown: string) => render(<Markdown text={excerptMarkdown(markdown)} />).container;

const textOf = (node: Node): string =>
  node.nodeName === 'BR'
    ? '\n'
    : node.nodeType === Node.TEXT_NODE
      ? (node.textContent ?? '')
      : [...node.childNodes].map(textOf).join('');

// The text as a reader sees it: paragraphs apart, lines and bullets each on a line.
const shown = (markdown: string) =>
  [...(drawn(markdown).firstElementChild?.children ?? [])]
    .map((block) =>
      block.tagName === 'UL'
        ? [...block.children].map((li) => `• ${textOf(li)}`).join('\n')
        : textOf(block),
    )
    .join('\n\n');

describe('excerptMarkdown, headings as Marker gives them', () => {
  // KA cleans the heading path from chunk metadata; the contract's excerpts have no
  // path, so the same rules are pinned on heading lines in the text, drawn as lines.
  it('drops the page anchor and keeps the heading as a line of its own', () => {
    const container = drawn(
      '# DFØs årsrapport 2024\n## <span id="page-4-0"></span>**1 Leders beretning**',
    );
    expect(textOf(container)).toBe('DFØs årsrapport 2024\n1 Leders beretning');
    expect(container.querySelector('span[id], h1, h2, .uib-markdown-heading')).toBeNull();
  });

  it('cleans every heading, not only the first', () => {
    expect(
      shown(
        '# <span id="page-14-0"></span>**5.3 Årsrapport**\n### **4.2 Beredskaps- og kontinuitetsplanverk**\n## **5.1 Styringsdokumenter**',
      ),
    ).toBe('5.3 Årsrapport\n4.2 Beredskaps- og kontinuitetsplanverk\n5.1 Styringsdokumenter');
  });

  it('cleans an anchor in a heading between others', () => {
    expect(
      shown(
        '### REGNSKAPSPRINSIPPER FOR BRUTTOBUDSJETTERTE VIRKSOMHETER\n# 6.2 Kontantregnskapet 2024\n## <span id="page-37-0"></span>NOTE 4 Andre driftskostnader',
      ),
    ).toBe(
      'REGNSKAPSPRINSIPPER FOR BRUTTOBUDSJETTERTE VIRKSOMHETER\n6.2 Kontantregnskapet 2024\nNOTE 4 Andre driftskostnader',
    );
  });

  it('drops a heading that was nothing but an anchor', () => {
    expect(excerptMarkdown('# Årsrapport 2024\n## <span id="page-2-0"></span>')).toBe(
      'Årsrapport 2024',
    );
    expect(excerptMarkdown('<span id="page-2-0"></span>')).toBe('');
  });

  it('leaves an empty excerpt empty', () => {
    expect(excerptMarkdown('')).toBe('');
  });
});

describe('headingText, KA’s readableHeading for an excerpt’s section line', () => {
  // The heading paths as KA's adapter joins them from the chunk metadata.
  it('drops the page anchor and the bold, keeps the path', () => {
    expect(
      headingText('DFØs årsrapport 2024 › <span id="page-4-0"></span>**1 Leders beretning**'),
    ).toBe('DFØs årsrapport 2024 › 1 Leders beretning');
  });

  it('cleans every step, not only the first', () => {
    expect(
      headingText(
        '<span id="page-14-0"></span>**5.3 Årsrapport** › **4.2 Beredskaps- og kontinuitetsplanverk** › **5.1 Styringsdokumenter**',
      ),
    ).toBe('5.3 Årsrapport › 4.2 Beredskaps- og kontinuitetsplanverk › 5.1 Styringsdokumenter');
  });

  it('cleans an anchor in the middle of the path', () => {
    expect(
      headingText(
        'REGNSKAPSPRINSIPPER FOR BRUTTOBUDSJETTERTE VIRKSOMHETER › 6.2 Kontantregnskapet 2024 › <span id="page-37-0"></span>NOTE 4 Andre driftskostnader',
      ),
    ).toBe(
      'REGNSKAPSPRINSIPPER FOR BRUTTOBUDSJETTERTE VIRKSOMHETER › 6.2 Kontantregnskapet 2024 › NOTE 4 Andre driftskostnader',
    );
  });

  it('drops a step that was nothing but an anchor, with its separator', () => {
    expect(headingText('Årsrapport 2024 › <span id="page-2-0"></span>')).toBe('Årsrapport 2024');
    expect(headingText('<span id="page-2-0"></span>')).toBeUndefined();
  });

  it('leaves no heading as no heading', () => {
    expect(headingText(undefined)).toBeUndefined();
  });

  it('raises a mark in <sup>, leaves a glued one alone, and keeps escapes and private use', () => {
    expect(headingText('Noter › Husleie<sup>1)</sup>')).toBe('Noter › Husleie¹⁾');
    expect(headingText('Utslipp av CO<sub>2</sub> › Tabell<sup>i</sup>')).toBe(
      'Utslipp av CO₂ › Tabelli',
    );
    expect(headingText('Noter › Husleie1)')).toBe('Noter › Husleie1)');
    expect(headingText('<span/id="page-4-0"></span>1 Leders beretning')).toBe('1 Leders beretning');
    expect(headingText('<sp<b>an id="page-4-0"></span>1 Leders beretning')).toBe(
      '1 Leders beretning',
    );
    expect(headingText('Note › a\ue03cb \\*fotnote &amp; [lenke](https://x.no)')).toBe(
      'Note › a\ue03cb *fotnote & lenke',
    );
  });
});

describe('excerptMarkdown, the chunk as the reader sees it', () => {
  it("drops Marker's page marker and its dashes, and keeps the paragraphs", () => {
    const text = excerptMarkdown(PAGE_BREAK);
    expect(text).not.toContain('{5}');
    expect(text).not.toMatch(/-{3,}/);
    expect(text).toBe(
      'Regjeringen har pekt ut offentlige anskaffelser som et viktig område. Vi ser en positiv utvikling i virksomhetenes modenhet både når det gjelder bruk av digitale verktøy og innen bærekraftige anskaffelser.\n\nGjennom markedsplassen for skytjenester bidrar vi til å forbedre tilgjengeligheten for skytjenester til offentlig sektor.',
    );
  });

  it('starts at the text when the chunk starts with page 0 and its dashes', () => {
    expect(
      excerptMarkdown(
        '{0}\n\n------------------------------------------------\n\nÅrsrapport 2024 for Direktoratet for forvaltning og økonomistyring.',
      ),
    ).toBe('Årsrapport 2024 for Direktoratet for forvaltning og økonomistyring.');
  });

  it('draws the italic as emphasis and the list items as bullet lines, with no star left', () => {
    const text = shown(ITALIC_AND_LIST);
    expect(text).not.toContain('*');
    expect(
      screen.getByText('1) Søknad om unntak fra krav til årsrapport for statlige virksomheter')
        .tagName,
    ).toBe('EM');
    expect(text).toContain(
      '1) Søknad om unntak fra krav til årsrapport for statlige virksomheter Det følger av',
    );
    expect(text).toContain(
      'rekkefølge:\n\n• I. Leders beretning\n• II. Introduksjon til virksomheten og hovedtall\n• III. Årets aktiviteter og resultater',
    );
  });

  it('draws a table row as a line, without pipes, delimiter or spacer rows', () => {
    const text = shown(TABLE_AND_FOOTNOTES);
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
    expect(screen.queryByRole('table')).toBeNull();
    expect(text.split('\n').slice(0, 4)).toEqual([
      '– · 31.12.2024',
      'Husleie¹⁾ · 3 024 010',
      'Vedlikehold egne bygg og anlegg · 0',
      'Sum andre driftskostnader · 10 795 764',
    ]);
  });

  it('turns a <br> inside a cell into a space', () => {
    expect(shown(BREAK_IN_CELL)).toBe(
      '1 Leders beretning 4\n2 Introduksjon til virksomheten og hovedtall 6',
    );
  });

  it('keeps an empty cell before a number, so the number keeps its column', () => {
    expect(shown(SPARSE_ROW)).toBe(
      '– · Immaterielle eiendeler · Tomter, bygninger og annen fast eiendom · Sum\nVarighet 1-5 år · – · 2 912 432 · 2 912 432',
    );
  });
});

describe('excerptMarkdown, footnote marks and exponents stay raised', () => {
  it('raises a mark Marker left glued to the word', () => {
    const text = shown(TABLE_AND_FOOTNOTES);
    expect(text).toContain('Husleie¹⁾ · 3 024 010');
    expect(text).not.toContain('Husleie1)');
  });

  it('raises the mark in <sup> before the note, and drops the tag', () => {
    const text = shown(TABLE_AND_FOOTNOTES);
    expect(text).not.toContain('<sup>');
    expect(text).toContain(
      '\n\n¹⁾ I tillegg til husleien føres også annen lokalleie på denne posten.',
    );
  });

  it('raises an exponent in <sup>, in the text and in a heading', () => {
    expect(excerptMarkdown('Areal på 1 200 m<sup>2</sup> og 10<sup>-3</sup> per år.')).toBe(
      'Areal på 1 200 m² og 10⁻³ per år.',
    );
    expect(excerptMarkdown('## Husleie<sup>1)</sup>')).toBe('Husleie¹⁾');
  });

  it('keeps a parenthesis in a cell that closes one opened before it', () => {
    expect(
      shown(
        [
          '| Areal (1 000 m2) | Utslipp (CO2) |',
          '| 1) Utslipp (tonn CO2) | a) redusere og b) øke fangst (målt i CO2) |',
          '| 1) kontor og 2) lager (1 000 m2) | 1) Husleie2) |',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Areal (1 000 m2) · Utslipp (CO2)',
        '1) Utslipp (tonn CO2) · a) redusere og b) øke fangst (målt i CO2)',
        '1) kontor og 2) lager (1 000 m2) · 1) Husleie²⁾',
      ].join('\n'),
    );
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('raises a glued mark only in a table cell, not in prose or a heading', () => {
    for (const text of [
      'Tall for Q4) og Q1).',
      'tonn CO2) per år.',
      '1) Utslipp (tonn CO2) økte i 2024.',
      'Husleie1) i løpende tekst.',
    ]) {
      expect(shown(text)).toBe(text);
    }
    expect(excerptMarkdown('## Noter Husleie1)')).toBe('Noter Husleie1)');
  });

  it('keeps a list number and a section number as they are', () => {
    const text = '1) Første punkt\nSe punkt 2) og tabell 4.1).';
    expect(shown(text)).toBe(text);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps <sup> content it has no superscript for as plain text, as KA does', () => {
    const container = drawn('Husleie<sup class="fn">a)</sup> og drift.');
    expect([container.querySelector('sup'), container.textContent]).toEqual([
      null,
      'Husleiea) og drift.',
    ]);
  });

  it('writes a footnote star and a word Marker raised as plain text, with no element', () => {
    // The gallery's items 7 and 21, as V1's text has them.
    const star = drawn('<sup>\\*</sup>Grunnen til at det er stor differanse');
    expect([star.querySelector('sup'), star.textContent]).toEqual([
      null,
      '*Grunnen til at det er stor differanse',
    ]);
    const word = drawn(
      'om manetangrep <sup>i</sup> årene, satt ut <sup>i</sup> PO4 <sup>i</sup> <sup>2025</sup>',
    );
    expect([word.querySelector('sup'), word.textContent]).toEqual([
      null,
      'om manetangrep i årene, satt ut i PO4 i ²⁰²⁵',
    ]);
    // An unescaped star stays a star, and never opens emphasis with the next one.
    const stars = drawn('<sup>*</sup>Grunnen er at ansatte<sup>*</sup> sluttet');
    expect([stars.querySelector('sup, em'), stars.textContent]).toEqual([
      null,
      '*Grunnen er at ansatte* sluttet',
    ]);
  });
});

describe('excerptMarkdown, HTML is text or nothing', () => {
  it('never lets a tag through, and never keeps a script', () => {
    const text =
      'Før<img src="x" onerror="alert(1)"> etter.<script>alert(2)</script> <span id="page-4-0"></span>Slutt.';
    expect(excerptMarkdown(text)).toBe('Før etter. Slutt.');
    expect(drawn(text).querySelector('img, script, span')).toBeNull();
  });

  it('drops a tag with a / straight after its name', () => {
    expect(excerptMarkdown('<svg/onload=alert(1)>svg')).toBe('svg');
    expect(excerptMarkdown('Før<img/src=x onerror=alert(1)> etter.')).toBe('Før etter.');
    expect(excerptMarkdown('## <span/id="page-4-0"></span>1 Leders beretning')).toBe(
      '1 Leders beretning',
    );
  });

  it('leaves no tag or comment that taking another one out put together', () => {
    expect(excerptMarkdown('Før <scr<script>ipt> etter.')).toBe('Før etter.');
    expect(excerptMarkdown('Før <!<!<!-- -->-- -->-- skjult --> etter.')).toBe('Før etter.');
    expect(excerptMarkdown('Før <scr<b>ipt>alert(1)</scr</b>ipt> etter.')).toBe('Før etter.');
    expect(excerptMarkdown('| Sum <scr<script>ipt> | 5 |')).toBe('Sum · 5');
    expect(excerptMarkdown('## <sp<b>an id="page-4-0"></span>1 Leders beretning')).toBe(
      '1 Leders beretning',
    );
  });

  it('shows an escaped tag as the characters the document meant', () => {
    const container = drawn('Feltet heter &lt;span&gt; i malen.');
    expect(container.textContent).toBe('Feltet heter <span> i malen.');
    expect(container.querySelector('span')).toBeNull();
  });

  it('leaves a < in prose alone', () => {
    const text = 'Andelen var < 5 % i 2024, og a<b gjelder.';
    expect(excerptMarkdown(text)).toBe(text);
    expect(drawn(text).textContent).toBe(text);
  });
});

describe('excerptMarkdown, what is not markup stays', () => {
  it('an escaped star, a multiplication and a snake_case name', () => {
    const container = drawn('Regn 5 * 3 * 2, se \\*fotnote og feltet doc_num_id.');
    expect(container.textContent).toBe('Regn 5 * 3 * 2, se *fotnote og feltet doc_num_id.');
    expect(container.querySelector('em')).toBeNull();
  });

  it('every escaped character comes back as itself', () => {
    expect(
      drawn(
        'Tegn: \\\\ \\` \\* \\_ \\{ \\} \\[ \\] \\( \\) \\# \\+ \\- \\. \\! \\| \\" \\\' \\~ \\< \\>',
      ).textContent,
    ).toBe('Tegn: \\ ` * _ { } [ ] ( ) # + - . ! | " \' ~ < >');
  });

  it('a private-use character the text has stays itself', () => {
    // U+E037, U+E039 and U+E03C are in Kudos chunks, counted 2026-09-29.
    const privateUse = 'abc,  og .';
    expect(drawn(privateUse).textContent).toBe(privateUse);
    expect(drawn('Se \\*fotnote .').textContent).toBe('Se *fotnote .');
    expect(excerptMarkdown(`## Note ${privateUse}`)).toBe(`Note ${privateUse}`);
  });

  it('drops a noncharacter, so every placeholder put back is one made here', () => {
    expect(excerptMarkdown('a﷒b og ﷐c')).toBe('ab og c');
  });

  it('a hash that is not a heading', () => {
    expect(shown('Kapittel #3 handler om lønn.')).toBe('Kapittel #3 handler om lønn.');
  });

  it('keeps the false positives the design names: numbers, dates, paragraphs and names', () => {
    for (const text of [
      'Del 3.4 Digitalisering av saksbehandlingen',
      'Regn 5 * 3 = 15, se 2 * 4.',
      'Vedtatt 14.03.2025 for perioden 2022–2026.',
      'Se forvaltningsloven § 4-2 og § 11 a.',
      'Feltet doc_num_id i filen rapport_2024_endelig.pdf.',
      'Andelen var < 5 % og > 2 % i 2024.',
      'Ett (1) tilfelle, se note 3).',
    ]) {
      expect(shown(text)).toBe(text);
    }
  });

  it('plain text comes back as it went in', () => {
    const plain = 'DFØ har hatt en samlet tildeling på 1 151 millioner kroner.';
    expect(excerptMarkdown(plain)).toBe(plain);
  });
});

describe('excerptMarkdown, tables cut by the chunker', () => {
  it('writes rows without a header as lines, like any other rows', () => {
    expect(shown('| Husleie | 3 024 010 |\n| Sum | 10 795 764 |')).toBe(
      'Husleie · 3 024 010\nSum · 10 795 764',
    );
  });

  it('keeps a last row the chunk cut off', () => {
    expect(shown('| År | Sum |\n|---|---:|\n| 2023 | 5 |\n| 2024 | 10 7')).toBe(
      'År · Sum\n2023 · 5\n2024 · 10 7',
    );
  });

  it('keeps a row that starts with a number or a dash as a line, not a list item', () => {
    expect(shown('| 1. Lønn | 5 |\n| - | 3 |\n| # | 2 |')).toBe('1. Lønn · 5\n- · 3\n# · 2');
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps a heading that starts with a number as a line, not a list item', () => {
    expect(shown('## 1. Innledning\nTekst')).toBe('1. Innledning\nTekst');
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('excerptMarkdown, what else Marker leaves', () => {
  it('draws an image as its alt text and an internal link as its label', () => {
    const container = drawn(
      '![](_page_3_Picture_1.jpeg)\n\nSe ![Figur 2](_page_4.jpeg) og [kapittel 2](#page-4-0).',
    );
    expect(container.querySelector('img, a')).toBeNull();
    expect(container.textContent).toBe('Se Figur 2 og kapittel 2.');
  });

  it('writes <sub> as subscript characters when each has one, else as text, with no element', () => {
    const container = drawn('CO<sub class="x" onclick="alert(1)">2</sub>-utslipp og H<sub>a</sub>');
    expect([container.querySelector('sub'), container.textContent]).toEqual([
      null,
      'CO₂-utslipp og Ha',
    ]);
  });

  it('drops the quote marker and keeps the quote', () => {
    expect(excerptMarkdown('> Sitat fra leder')).toBe('Sitat fra leder');
  });

  it('leaves a fenced code block as it is', () => {
    const code = '```\n{5}\n<span id="x"></span>\n```';
    expect(excerptMarkdown(code)).toBe(code);
  });

  it('keeps a line that only held an anchor from splitting the paragraph', () => {
    expect(excerptMarkdown('Første linje\n<span id="page-9-0"></span>\nandre linje')).toBe(
      'Første linje\nandre linje',
    );
  });
});

describe('excerptMarkdown, what the corpus of 3 November found', () => {
  it('drops a running head or foot with its page number, on a line of its own', () => {
    expect(
      excerptMarkdown(
        'og i flere tilfeller gitt pålegg.\n\n\n\n1. Leders beretning Årsrapport 2024 | 4\n\nOvertredelsesgebyr har konsekvenser.',
      ),
    ).toBe('og i flere tilfeller gitt pålegg.\n\nOvertredelsesgebyr har konsekvenser.');
    expect(excerptMarkdown('| Sum | 9 586 051 |\n\nÅrsrapport 2022 | Lånekassen 46\n\n----')).toBe(
      'Sum · 9 586 051',
    );
    expect(excerptMarkdown('Tekst.\n\n12 | Årsrapport 2023')).toBe('Tekst.');
  });

  // Measured live: excerpts 2 and 3 of Nkom's 2020 report ended in a
  // running head that had crossed a page break — two pages' feet on one line, the page numbers in
  // bold and the title repeated.
  it('drops a running head that crossed a page break, numbers in bold and title repeated', () => {
    const head =
      '**42** | Nkom årsrapport 2020 Nkom årsrapport 2020 | **43 42** | Nkom årsrapport 2020';
    expect(excerptMarkdown(`Nkom fører tilsyn med markedet.\n\n${head}`)).toBe(
      'Nkom fører tilsyn med markedet.',
    );
    expect(excerptMarkdown(`${head}\n\nNkom fører tilsyn med markedet.`)).toBe(
      'Nkom fører tilsyn med markedet.',
    );
    // The same line with the emphasis off, and with the number alone at the other end.
    for (const line of [
      '42 | Nkom årsrapport 2020 Nkom årsrapport 2020 | 43 42 | Nkom årsrapport 2020',
      '_42_ | Nkom årsrapport 2020 | 43',
      'Nkom årsrapport 2020 | **43** | Nkom årsrapport 2020',
      // The page numbers of two pages run together: a page apart, so still page furniture.
      'Nkom årsrapport 2020 | 157 158 | Nkom årsrapport 2020',
    ])
      expect([line, excerptMarkdown(`Tekst.\n\n${line}`)]).toEqual([line, 'Tekst.']);
  });

  it('keeps a line of several cells that is not page furniture', () => {
    const long = 'Nkom fører tilsyn med markedet. '.repeat(3);
    expect([
      // No page number anywhere: a two-column line of prose.
      excerptMarkdown('Kapittel A | kapittel B | kapittel C'),
      // Numbers only, so there is no running title to go with them — one per cell, and two
      // in a cell, which is the shape a page break glues together.
      excerptMarkdown('42 | 43 | 44'),
      excerptMarkdown('42 | 43 42'),
      // A cell longer than a running head ever is.
      excerptMarkdown(`${long} | 42`),
      // A row of figures that lost its outer pipes. Two pages of a report are a page apart,
      // never a hundred, so these numbers are amounts and the line stays.
      excerptMarkdown('Husleie | 3 024 010 | 2 900 000'),
      excerptMarkdown('Årsverk | 158 | 162'),
    ]).toEqual([
      'Kapittel A | kapittel B | kapittel C',
      '42 | 43 | 44',
      '42 | 43 42',
      `${long.trim()} | 42`,
      'Husleie | 3 024 010 | 2 900 000',
      'Årsverk | 158 | 162',
    ]);
    // A table row keeps its pipes at both ends, and is still drawn as a row.
    expect(excerptMarkdown('| Nkom | 42 |')).toBe('Nkom · 42');
  });

  it('keeps the same shape inside a paragraph, and a pipe with no page number', () => {
    for (const text of [
      'Linje en\nÅrsrapport 2024 | 4\nlinje to',
      'Kapittel A | kapittel B',
      'Sum | ',
    ]) {
      expect(excerptMarkdown(text)).toBe(text.trim());
    }
  });

  it('raises a footnote mark whose escaped tag Marker split with a superscript «&»', () => {
    expect(
      excerptMarkdown(
        '<span id="page-72-0"></span><sup>&</sup>lt;sup>5</sup> IPCC. Climate Change 2022.',
      ),
    ).toBe('⁵ IPCC. Climate Change 2022.');
  });
});

describe('excerptMarkdown, the Markdown it hands on', () => {
  it('keeps a backslash escape as an escape, so Markdown draws the character', () => {
    expect(excerptMarkdown('Se \\*fotnote, a \\| b og \\<span\\>')).toBe(
      'Se \\*fotnote, a \\| b og \\<span\\>',
    );
    expect(excerptMarkdown('| a \\| b | c |')).toBe('a \\| b · c');
  });

  it('writes an image as its alt text, and a link or an autolink as its words', () => {
    expect(
      excerptMarkdown(
        'Se ![Figur 2](_page_4.jpeg), [veilederen](https://x.no/v) og <https://y.no/a?b=1>.',
      ),
    ).toBe('Se Figur 2, veilederen og https://y.no/a?b=1.');
  });

  it('writes every kind of line break in prose as one <br>, and in a cell as a space', () => {
    expect(excerptMarkdown('a<br/>b<BR >c<br>d')).toBe('a<br>b<br>c<br>d');
    expect(excerptMarkdown('| a<br/>b | c |')).toBe('a b · c');
  });

  it('reads a superscript’s own tags away before it raises it, and keeps one it cannot raise', () => {
    expect(excerptMarkdown('m<sup><b>2</b></sup> og x<sup class="n"><i>a</i>)</sup>')).toBe(
      'm² og xa)',
    );
    expect(excerptMarkdown('x<sup>1 < 2</sup> y')).toBe('x1 < 2 y');
    expect(excerptMarkdown('x<sub style="v">2</sub> og m<sup> 2 </sup>')).toBe('x₂ og m²');
  });

  it('drops a heading that was only an anchor, with no gap left where it stood', () => {
    expect(excerptMarkdown('# A\n## <span id="page-2-0"></span>\nB')).toBe('A\nB');
  });

  it('writes list items as bullet lines without their indentation, and a number as text', () => {
    expect(excerptMarkdown('- a\n  fortsatt\n* b\n+ c')).toBe('• a\nfortsatt\n• b\n• c');
    expect(excerptMarkdown('2. punkt og 3) punkt')).toBe('2\\. punkt og 3) punkt');
  });

  it('reads Windows and old Mac line ends as line breaks', () => {
    expect(excerptMarkdown('a\r\nb\r\rc')).toBe('a\nb\n\nc');
  });
});

describe('excerptMarkdown, the document’s own footnote stars', () => {
  it('keeps a note’s stars as text, and a reference’s stars after the word', () => {
    const container = drawn(
      'Ansatte: 120 årsverk\\*\\*\n\n<sup>\\*\\*</sup> Antall ansatte per 31.12.',
    );
    expect([container.querySelector('sup'), container.textContent]).toEqual([
      null,
      'Ansatte: 120 årsverk**** Antall ansatte per 31.12.',
    ]);
  });
});

describe('excerptMarkdown, two whole chunks as Marker left them', () => {
  // 372017/1 and 375022/117, read 2026-11-03; the fixture says where.
  const [dfo, klagenemnd] = markerChunks.documents.map((d) => d.chunk.contentMarkdown);

  it('keeps no page marker, rule, anchor link or tag, and raises every glued mark', () => {
    for (const chunk of [dfo ?? '', klagenemnd ?? '']) {
      const text = shown(chunk);
      expect(text).not.toMatch(/\{\d+\}|-{3,}|\]\(#page|<\/?[a-z]|\||\*\*/);
      expect(text).not.toMatch(/\p{Ll}{2}\d{1,2}\)/u);
    }
    expect(shown(klagenemnd ?? '')).toContain('Husleie¹⁾ · 3 024 010');
    expect(shown(klagenemnd ?? '')).toContain('¹⁾ I tillegg til husleien');
  });
});

describe('Sources, cleaning every excerpt', () => {
  it('cleans the text of every excerpt, and nothing else', () => {
    render(
      <Sources
        sources={[
          {
            index: 1,
            title: 'Årsrapport Direktoratet for forvaltning og økonomistyring 2024',
            documentId: 'kudos::372017',
            excerpts: [{ chunkId: 'kudos::372017-1', text: PAGE_BREAK }],
          },
        ]}
      />,
    );
    const quote = document.querySelector('.uib-sources-quote') as HTMLElement;
    expect(quote.textContent).not.toMatch(/\{5\}|-{3,}/);
    expect(quote.querySelectorAll('p')).toHaveLength(2);
    expect(
      screen.getByRole('heading', {
        name: 'Årsrapport Direktoratet for forvaltning og økonomistyring 2024',
      }),
    ).toBeTruthy();
  });
});
