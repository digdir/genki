// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, blocksOf, visibleText } from './Markdown.js';
import { findHits } from './textSearch.js';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders headings, bold, italic, lists and code as elements, never as literal Markdown', () => {
    const { container } = render(
      <Markdown text={'# Mål\n\n**viktigst** og *felles*\n\n- a\n- b\n\n```\nkode\n```'} />,
    );
    expect(container.textContent).not.toContain('**');
    expect(screen.getByText('Mål').closest('.uib-markdown-heading')).toBeTruthy();
    expect(screen.getByText('viktigst').tagName).toBe('STRONG');
    expect(screen.getByText('felles').tagName).toBe('EM');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelector('pre > code')?.textContent).toBe('kode');
  });

  it('shows raw HTML and scripts as text, never as elements', () => {
    const { container } = render(
      <Markdown
        text={
          '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<a href="javascript:alert(1)">lenke</a>'
        }
      />,
    );
    expect(container.querySelector('script, img, a, [onerror]')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('links only http and https, in a new tab without opener or referrer', () => {
    const { container } = render(
      <Markdown
        text={'[trygg](https://example.no) [skript](javascript:alert(1)) [data](data:text/html,x)'}
      />,
    );
    const link = screen.getByRole('link', { name: 'trygg' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.textContent).toBe('trygg skript data');
  });

  it('turns [N] into what the frontend draws for it, and leaves it as text otherwise', () => {
    render(
      <Markdown
        text="Svar [1] og [2]."
        cite={(n, key) => (n === 1 ? <button key={key}>Kilde {n}</button> : undefined)}
      />,
    );
    expect(screen.getByRole('button', { name: 'Kilde 1' })).toBeTruthy();
    expect(screen.getByText(/\[2\]/)).toBeTruthy();
  });

  it('draws a Markdown table with column headers, aligned cells and an empty corner as a plain cell', () => {
    const { container } = render(
      <Markdown
        text={
          'Før tabellen\n| | 2022 | 2023 |\n|---|---:|:---:|\n| Sykefravær | 5,1 | 4,9 |\n| Ansatte | 120 |\n\nEtter'
        }
      />,
    );
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['2022', '2023']);
    expect(table.querySelector('thead td')?.textContent).toBe('');
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((tr) => [...tr.children].map((td) => td.textContent)),
    ).toEqual([
      ['Sykefravær', '5,1', '4,9'],
      ['Ansatte', '120', ''],
    ]);
    expect(within(table).getByText('5,1').getAttribute('data-align')).toBe('right');
    expect(within(table).getByText('4,9').getAttribute('data-align')).toBe('center');
    expect(container.textContent).not.toContain('|');
    expect(screen.getByText('Før tabellen').tagName).toBe('P');
    expect(screen.getByText('Etter').tagName).toBe('P');
  });

  it('keeps a line with pipes as text when no delimiter row follows it', () => {
    const { container } = render(<Markdown text={'a | b\nc | d'} />);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('a | b');
  });

  it('escapes HTML and links only http and https inside table cells', () => {
    const { container } = render(
      <Markdown
        text={
          '| Kilde | Lenke |\n|---|---|\n| <img src=x onerror=alert(1)> | [ok](https://example.no) [nei](javascript:alert(1)) |\n| a \\| b | **fet** |'
        }
      />,
    );
    expect(container.querySelector('img, script, [onerror]')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'ok' }).getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    expect(screen.getByText('a | b')).toBeTruthy();
    expect(screen.getByText('fet').tagName).toBe('STRONG');
  });

  it('draws sup, sub and br without attributes as elements, and every other tag as text', () => {
    const { container } = render(
      <Markdown
        text={
          'CO<sub>2</sub> og 10<sup>21</sup><br>neste <sup onclick=alert(1)>x</sup> <b>fet</b> <sup><script>alert(1)</script></sup>'
        }
      />,
    );
    expect(container.querySelector('sup')?.textContent).toBe('21');
    expect(container.querySelector('sub')?.textContent).toBe('2');
    expect(container.querySelectorAll('sup, sub, br')).toHaveLength(3);
    expect(container.querySelector('script, b, [onclick]')).toBeNull();
    expect(container.textContent).toContain('<sup onclick=alert(1)>x</sup>');
    expect(container.textContent).toContain('<b>fet</b>');
    expect(container.textContent).toContain('<sup><script>alert(1)</script></sup>');
  });

  it('draws an escaped character as itself, never as markup', () => {
    const { container } = render(
      <Markdown text={'\\*ikke kursiv\\* og \\[1\\] og \\_x\\_ og C:\\mappe'} />,
    );
    expect(container.textContent).toBe('*ikke kursiv* og [1] og _x_ og C:\\mappe');
    expect(container.querySelector('em')).toBeNull();
  });

  it('draws entities as the characters they stand for, never as markup or a link', () => {
    const { container } = render(
      <Markdown
        text={
          'A &amp; B&nbsp;&#167; 4 &lt;sup&gt;1&lt;/sup&gt; [x](&#106;avascript:alert(1)) `&amp;`'
        }
      />,
    );
    expect(container.textContent).toBe('A & B\u00a0§ 4 <sup>1</sup> x &amp;');
    expect(container.querySelector('sup, a')).toBeNull();
  });

  it('draws underscores and tildes as emphasis only around words', () => {
    const { container } = render(
      <Markdown text={'_kursiv_ og __fet__ og ~~strøket~~ men snake_case og a_b_c'} />,
    );
    expect(screen.getByText('kursiv').tagName).toBe('EM');
    expect(screen.getByText('fet').tagName).toBe('STRONG');
    expect(screen.getByText('strøket').tagName).toBe('DEL');
    expect(container.textContent).toBe('kursiv og fet og strøket men snake_case og a_b_c');
  });

  it('draws an image as its alt text and a link to anything but http as its label', () => {
    const { container } = render(
      <Markdown text={'![Figur 1](https://example.no/f.png) og [side 4](#page-4-0)'} />,
    );
    expect(container.querySelector('img, a')).toBeNull();
    expect(container.textContent).toBe('Figur 1 og side 4');
  });

  it('draws an autolink as a link that shows its address, for http and https only', () => {
    const { container } = render(
      <Markdown text={'¹⁹ <https://example.no/a?b=1> og <javascript:alert(1)>'} />,
    );
    const link = screen.getByRole('link', { name: 'https://example.no/a?b=1' });
    expect(link.getAttribute('href')).toBe('https://example.no/a?b=1');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.textContent).toBe('¹⁹ https://example.no/a?b=1 og <javascript:alert(1)>');
  });

  it('draws no link with links off, wherever the link sits: a link as its words, an autolink as its address', () => {
    const text =
      '# Om [lenke](https://a.no)\n\nSe <https://b.no/x> og **[fet](https://c.no)**.\n\n- [punkt](https://d.no)\n\n| [celle](https://e.no) | <https://f.no> |\n|---|---|\n| <sup>[1](https://g.no)</sup> | https://h.no |';
    const words = 'Om lenkeSe https://b.no/x og fet.punktcellehttps://f.no1https://h.no';
    const off = render(<Markdown text={text} links={false} />).container;
    expect([off.querySelector('a'), off.textContent]).toEqual([null, words]);
    cleanup();
    // The control: the same text with links on draws every http link but the bare address.
    const on = render(<Markdown text={text} />).container;
    expect([on.querySelectorAll('a').length, on.textContent]).toEqual([7, words]);
  });

  it('uses the class the frontend gives it', () => {
    const { container } = render(<Markdown text="Tekst" className="playground-markdown" />);
    expect(container.firstElementChild?.className).toBe('playground-markdown');
  });

  it('reads the words on screen, not the Markdown behind them', () => {
    const text = 'Vi har en **viktig** tekst om lønn.\n\nNeste avsnitt.';
    const { container } = render(<Markdown text={text} links={false} />);

    // A newline where the drawing breaks a line, nothing between two leaves of one line.
    expect(visibleText(text, false).text).toBe('Vi har en viktig tekst om lønn.\nNeste avsnitt.');
    expect(visibleText(text, false).text.replace(/\n/g, '')).toBe(container.textContent);
  });

  it('counts its leaves in the order it draws them, so a mark lands where the hit is', () => {
    // Everything that puts a plain string in the document: text, emphasis, a code span, an entity,
    // an escape, an image's alt text, a link drawn as its words, a table cell, a list item, a
    // fenced block and an uncited [1].
    const text = [
      '# Tittel med **fet**',
      'Tekst &amp; \\* `kode` ![bilde](x.png) [ord](https://a.no) <https://b.no> [1]',
      '- punkt <sup>2</sup>',
      '| a | b |',
      '|---|---|',
      '| c | d |',
      '```',
      'kode\nblokk',
      '```',
    ].join('\n');

    const { text: flat, offsets } = visibleText(text, false);
    const { container } = render(<Markdown text={text} links={false} />);

    // The drawn text and the collected text are the same walk: same pieces, same order. Newlines
    // go from both sides, since a fenced block holds real ones and a block gap is one of ours.
    expect(flat.replace(/\n/g, '')).toBe((container.textContent ?? '').replace(/\n/g, ''));
    // Every offset points at a real place, and they only move forward.
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets.at(-1)).toBeLessThan(flat.length);
  });

  it('marks a hit that runs across emphasis as one hit in two places', () => {
    const text = 'Vi har en **viktig** tekst om lønn.';
    const { text: flat, offsets } = visibleText(text, false);
    const hits = findHits([{ id: 'r', text: flat }], 'viktig tekst');
    const { container } = render(
      <Markdown
        text={text}
        links={false}
        highlight={{ hits, offsets, current: hits[0], markClassName: 'uib-sources-mark' }}
      />,
    );

    const marks = [...container.querySelectorAll('mark')];
    expect(hits).toHaveLength(1);
    expect(marks.map((mark) => mark.textContent)).toEqual(['viktig', ' tekst']);
    expect(marks.map((mark) => mark.getAttribute('data-current'))).toEqual(['true', 'true']);
    // The bold is still bold: marking a quotation does not flatten it.
    expect(container.querySelector('strong')?.textContent).toBe('viktig');
    expect(container.textContent).toBe('Vi har en viktig tekst om lønn.');
  });

  it('draws no mark at all without hits, and leaves the text as it was', () => {
    const text = 'Vi har en **viktig** tekst.';
    const plain = render(<Markdown text={text} links={false} />).container.innerHTML;
    cleanup();
    const { container } = render(
      <Markdown text={text} links={false} highlight={{ hits: [], offsets: [] }} />,
    );
    expect(container.innerHTML).toBe(plain);
  });

  it('draws headings as headings from the level it is given, deeper ones below, and as bold lines without one', () => {
    const text = '# Mål\n\nTekst\n\n### Delmål';
    render(<Markdown text={text} headingLevel={3} />);
    expect(
      screen.getAllByRole('heading').map((h) => [h.tagName, h.textContent, h.dataset.size]),
    ).toEqual([
      ['H3', 'Mål', 'md'],
      ['H5', 'Delmål', 'xs'],
    ]);
    cleanup();
    const { container } = render(<Markdown text={text} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('Mål').tagName).toBe('STRONG');
    expect(container.textContent).toBe('MålTekstDelmål');
  });

  it('puts a table in a named scroll box a keyboard can reach, only when asked to name it', () => {
    const text = '| År | Beløp |\n|---|---:|\n| 2023 | **5** |\n\n| a |\n|---|\n| b |';
    render(
      <Markdown
        text={text}
        tableName={({ number, count, columns }) => `Tabell ${number} av ${count}: ${columns}`}
      />,
    );
    const boxes = screen.getAllByRole('group');
    expect(boxes.map((box) => box.getAttribute('aria-label'))).toEqual([
      'Tabell 1 av 2: År,Beløp',
      'Tabell 2 av 2: a',
    ]);
    expect(boxes.map((box) => box.tabIndex)).toEqual([0, 0]);
    expect(within(boxes[0] as HTMLElement).getByRole('table')).toBeTruthy();
    cleanup();
    render(<Markdown text={text} />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getAllByRole('table')).toHaveLength(2);
  });

  it('holds a footnote it draws on the line of the word before it, with the punctuation after it', () => {
    const { container } = render(
      <Markdown
        text="Bevilgningen var 594 mill. kroner. [1] Neste setning [2][3], og slutt"
        cite={(n, key) => (
          <a key={key} href={`#${n}`}>
            {n}
          </a>
        )}
      />,
    );
    const runs = [...container.querySelectorAll('.uib-markdown-cite-run')];
    expect(runs.map((run) => run.textContent)).toEqual(['. 1', 'g 23,']);
    // The whitespace the answer wrote is still there for copying, but kept out of sight.
    expect(container.textContent).toBe(
      'Bevilgningen var 594 mill. kroner. 1 Neste setning 23, og slutt',
    );
    expect(
      [...container.querySelectorAll('.uib-markdown-cite-space')].map((s) => s.textContent),
    ).toEqual([' ', ' ']);
    expect(runs[1]?.querySelector('.uib-markdown-cite-marks')?.textContent).toBe('23,');
  });

  it('draws a footnote drawn as nothing without the whitespace before it', () => {
    const { container } = render(
      <Markdown text="Rapportert kvartalsvis [1]. Og [2] her." cite={() => false} />,
    );
    expect(container.textContent).toBe('Rapportert kvartalsvis. Og her.');
    expect(container.querySelector('.uib-markdown-cite-run')).toBeNull();
  });

  it('holds nothing for a footnote it leaves as text, so a quotation reads as it did', () => {
    const text = 'Se tabell [1] og [2].';
    const { container } = render(<Markdown text={text} links={false} />);
    expect(container.querySelector('.uib-markdown-cite-run')).toBeNull();
    expect(container.textContent).toBe('Se tabell [1] og [2].');
    expect(visibleText(text, false).text).toBe(container.textContent);
  });

  it('splits text into paragraphs, headings, lists and code blocks', () => {
    expect(blocksOf('## Mål\nLinje en\nlinje to\n\n- a\n  fortsatt\n- b\n```\nkode\n```')).toEqual([
      { kind: 'heading', text: 'Mål', depth: 2 },
      { kind: 'paragraph', lines: ['Linje en', 'linje to'] },
      { kind: 'list', ordered: false, start: 1, items: ['a fortsatt', 'b'] },
      { kind: 'code', text: 'kode' },
    ]);
  });
});
