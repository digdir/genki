import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateDefinition, type PluginSchemas } from '@genai/definitions';
import { importDesign, ImportRefused, importLimits } from './index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const options = { tenant: '991825827', id: 'kildekort', title: 'Kildekort' };

const noPlugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map(),
};

const overDrawn = Array.from(
  { length: 7 },
  () =>
    `<div data-genki-each="sources" data-genki-max="50">${'<p>{{ sources.title }}</p>'.repeat(5)}</div>`,
).join('');

const codes = (result: ReturnType<typeof importDesign>) => result.report.map((n) => n.code);

const json = (value: unknown) => JSON.stringify(value);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('importDesign', () => {
  it('turns headings, paragraphs, lists, links, tables and details into a declarative template', () => {
    const result = importDesign(fixture('sources-card.html'), options);
    const template = json(result.definition.spec.template);

    expect(result.tier).toBe('declarative');
    expect(result.files).toEqual({});
    for (const type of ['card', 'heading', 'paragraph', 'list', 'link', 'keyValue', 'details'])
      expect(template).toContain(`"type":"${type}"`);
    expect(template).toContain('"type":"divider"');
    expect(template).toContain('"type":"alert","color":"warning"');
    expect(template).toContain('"href":"https://www.digdir.no/om-oss"');
    expect(result.definition.spec.events).toEqual(['ask']);
  });

  it('keeps every visible text as a bokmål text key', () => {
    const result = importDesign(fixture('sources-card.html'), options);
    const texts = Object.values(result.definition.spec.texts?.nb ?? {});

    for (const text of [
      'Kilder til svaret',
      'Svaret bygger på disse dokumentene.',
      'Om kildene',
      'Les mer om Digdir',
      'Sjekk alltid kildene.',
      'Hva betyr dette?',
    ])
      expect(texts).toContain(text);
    expect(result.definition.spec.texts).not.toHaveProperty('en');
    expect(codes(result)).toContain('englishLeftOut');
  });

  it('binds data-genki-bind and {{path}} to fields in the field list', () => {
    const result = importDesign(fixture('sources-card.html'), options);
    const template = json(result.definition.spec.template);

    expect(template).toContain('"type":"each","of":"sources","as":"item"');
    expect(template).toContain('{"bind":"item.title"}');
    expect(template).toContain('{"bind":"item.publisher"}');
    expect(template).toContain('{"bind":"service.name"}');
  });

  it('keeps a {{path}} outside the field list as text and says so', () => {
    const result = importDesign('<p>Hei {{ person.fodselsnummer }}</p>', options);

    expect(result.tier).toBe('declarative');
    expect(Object.values(result.definition.spec.texts?.nb ?? {})).toContain(
      'Hei {{ person.fodselsnummer }}',
    );
    expect(result.report).toContainEqual(
      expect.objectContaining({ kind: 'data', code: 'bindOutsideFields' }),
    );
  });

  it('keeps a binding to a whole list as text', () => {
    const result = importDesign('<p>Kilder: {{ sources }}</p>', options);

    expect(JSON.stringify(result.definition.spec.texts)).toContain('{{ sources }}');
    expect(result.report).toContainEqual(
      expect.objectContaining({ kind: 'data', code: 'bindOutsideFields' }),
    );
  });

  it('refuses svg, canvas, forms and media as needing code, naming the element', () => {
    const designs = {
      svg: `<p>Graf</p><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`,
      canvas: '<p>Graf</p><canvas></canvas>',
      form: '<form><input name="q"></form>',
      img: '<img src="data:image/png;base64,AA==" alt="Logo">',
      video: '<video></video>',
    };
    for (const [element, html] of Object.entries(designs))
      expect(() => importDesign(html, options), element).toThrow(
        expect.objectContaining({ code: 'codeElement', values: { element } }),
      );
  });

  it('refuses scripts as needing code, also when the script is all the design has', () => {
    for (const html of [
      '<p>Teller</p><script>let n = 0;</script>',
      '<html><head><script>document.body.textContent = "Hei";</script></head><body></body></html>',
      '<script src="app.js"></script><div id="root"></div>',
    ])
      expect(() => importDesign(html, options), html).toThrow(
        expect.objectContaining({ code: 'codeScript' }),
      );
  });

  it('refuses animations in a style sheet or a style attribute as needing code', () => {
    for (const html of [
      '<style>.a { transition: all 1s; }</style><p>Fade</p>',
      '<p style="animation: spin 1s infinite">Snurr</p>',
    ])
      expect(() => importDesign(html, options), html).toThrow(
        expect.objectContaining({ code: 'codeAnimation' }),
      );
  });

  it('refuses a design whose elements draw nothing as empty, not as needing code', () => {
    expect(() => importDesign('<div></div><span></span>', options)).toThrow(
      expect.objectContaining({ code: 'empty' }),
    );
  });

  it('refuses a design with a text over 1000 characters as too much text, not as needing code', () => {
    expect(() => importDesign(`<p>${'Lang tekst. '.repeat(100)}</p>`, options)).toThrow(
      expect.objectContaining({ code: 'tooMuchText' }),
    );
  });

  it('notes that inline styles are dropped', () => {
    const result = importDesign('<p style="font-weight: bold">Hei</p>', options);

    expect(codes(result)).toContain('droppedStyle');
  });

  it('keeps a small icon inside a button or heading in a declarative template', () => {
    const result = importDesign(
      '<h2><svg viewBox="0 0 4 4"><path d="M0 0h4"/></svg>Kilder</h2>',
      options,
    );

    expect(result.tier).toBe('declarative');
    expect(codes(result)).toContain('droppedElement');
  });

  it('removes external scripts, stylesheets, fonts and inline handlers and says so', () => {
    const card = importDesign(fixture('sources-card.html'), options);

    expect(codes(card)).toEqual(
      expect.arrayContaining(['droppedScript', 'droppedStylesheet', 'droppedHandler', 'colours']),
    );
    expect(json(card.definition)).not.toContain('onclick');
  });

  it('drops javascript: and non-https links', () => {
    const declarative = importDesign(
      '<a href="javascript:alert(1)">A</a><a href="http://example.com">B</a><a href="https://example.com">C</a>',
      options,
    );

    expect(json(declarative.definition.spec.template)).not.toContain('javascript');
    expect(json(declarative.definition.spec.template)).not.toContain('http://');
    expect(json(declarative.definition.spec.template)).toContain('https://example.com');
  });

  it('never fetches anything the design points to', () => {
    const fetch = vi.fn(() => {
      throw new Error('no network');
    });
    vi.stubGlobal('fetch', fetch);

    importDesign(fixture('sources-card.html'), options);
    expect(() => importDesign(fixture('chart.dc.html'), options)).toThrow(ImportRefused);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a design over 512 KiB', () => {
    const html = `<p>${'a'.repeat(importLimits.htmlBytes)}</p>`;

    expect(() => importDesign(html, options)).toThrow(
      expect.objectContaining({ code: 'tooLarge' }),
    );
  });

  it('refuses an empty design', () => {
    expect(() => importDesign('<html><body>  </body></html>', options)).toThrow(
      expect.objectContaining({ code: 'empty' }),
    );
  });

  it('parses a deeply nested design in linear time', () => {
    const nested = (n: number) => `${'<div>'.repeat(n)}x${'</div>'.repeat(n)}`;
    const time = (n: number) => {
      const start = performance.now();
      try {
        importDesign(nested(n), options);
      } catch (error) {
        expect(error).toBeInstanceOf(ImportRefused);
      }
      return performance.now() - start;
    };
    time(2_000);
    const small = time(4_000);
    const large = time(40_000);

    expect(large).toBeLessThan(Math.max(small, 5) * 40);
  });

  it('keeps a table caption as text', () => {
    const result = importDesign(
      '<table><caption>Frister</caption><tr><th>Søknad</th><td>1. mars</td></tr></table>',
      options,
    );

    expect(JSON.stringify(result.definition)).toContain('Frister');
  });

  it('scans nested svg in linear time', () => {
    const nested = (n: number) => `<p>x</p>${'<svg>'.repeat(n)}${'</svg>'.repeat(n)}`;
    const time = (n: number) => {
      const start = performance.now();
      try {
        importDesign(nested(n), options);
      } catch (error) {
        expect(error).toBeInstanceOf(ImportRefused);
      }
      return performance.now() - start;
    };
    time(2_000);
    const small = time(4_000);
    const large = time(40_000);

    expect(large).toBeLessThan(Math.max(small, 5) * 40);
  });

  it('refuses a design with more than 200 elements or nesting deeper than 12, since it needs code', () => {
    const many = () => importDesign('<p>Rad</p>'.repeat(importLimits.nodes + 1), options);
    const deep = () => importDesign(`${'<div>'.repeat(13)}Dypt${'</div>'.repeat(13)}`, options);

    expect(many).toThrow(expect.objectContaining({ code: 'codeLimits' }));
    expect(deep).toThrow(expect.objectContaining({ code: 'codeLimits' }));
  });

  it('refuses a design whose template would draw more than 2000 elements, since it needs code', () => {
    expect(() => importDesign(overDrawn, options)).toThrow(
      expect.objectContaining({ code: 'codeInvalid', values: { path: 'spec.template' } }),
    );
  });

  it('repeats an element over a list at most data-genki-max times, 10 without it', () => {
    const result = importDesign(
      '<p data-genki-each="sources" data-genki-max="3">{{ sources.title }}</p><p data-genki-each="threads">{{ threads.title }}</p>',
      options,
    );
    const template = json(result.definition.spec.template);

    expect(template).toContain('"of":"sources","as":"item","max":3');
    expect(template).toContain('"of":"threads","as":"item","max":10');
  });

  it('repeats nothing inside another repeat, and says so', () => {
    const nested = importDesign(
      `<div data-genki-each="sources"><p>{{ sources.title }}</p><div data-genki-each="sources"><p>x</p></div></div>`,
      options,
    );

    expect(codes(nested)).toContain('eachOutsideFields');
  });

  it('takes the title from the design when none is given', () => {
    const result = importDesign(
      '<html><head><title>Velkommen</title></head><body><p>Hei</p></body></html>',
      {
        tenant: '991825827',
        id: 'velkommen',
      },
    );

    expect(result.definition.spec.title).toEqual({ nb: 'Velkommen' });
    expect(result.definition.metadata).toEqual({
      tenant: '991825827',
      id: 'velkommen',
      name: 'Velkommen',
    });
  });

  it('proposes a block shared only with the organisation', () => {
    for (const name of ['sources-card.html', 'plain.html'])
      expect(importDesign(fixture(name), options).definition.spec.sharing).toBe('organisation');
  });

  it('produces a definition that passes validation', () => {
    for (const name of ['sources-card.html', 'plain.html']) {
      const result = importDesign(fixture(name), options);
      const checked = validateDefinition(result.definition, noPlugins);
      expect(checked.ok ? [] : checked.errors, name).toEqual([]);
    }
  });

  it('turns Designsystemet tags in a flex row into a row of tags', () => {
    const result = importDesign(fixture('plain.html'), options);
    const template = json(result.definition.spec.template);

    expect(template).toContain('"type":"row","children":[{"type":"tag","color":"success"');
    expect(template).toContain('"type":"list","ordered":true');
    expect(template).toContain('"event":{"name":"open-page","page":"om"}');
    expect(template).toContain('"type":"heading","level":2');
  });

  it('is deterministic', () => {
    const html = fixture('sources-card.html');

    expect(json(importDesign(html, options))).toBe(json(importDesign(html, options)));
  });
});
