import { readFileSync } from 'node:fs';
import { isHttpsAddress, isSitePath, templatePathPattern } from '@genai/contracts/block-template';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { templatePrePass, templateReads } from './block-template.js';
import { validateDefinition, type BlockDefinition, type PluginSchemas } from './index.js';

const plugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map(),
};

const fixture = (name: string) =>
  parse(readFileSync(`${import.meta.dirname}/fixtures/blocks/${name}.yaml`, 'utf8')) as {
    spec: Record<string, unknown>;
  };

const block = (root: unknown, spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant: '991825827', id: 'kort' },
  spec: {
    tier: 'declarative',
    title: { nb: 'Kort' },
    zones: ['main'],
    events: ['ask', 'open-document', 'set-filter', 'notify'],
    states: ['empty', 'filled'],
    texts: {
      nb: {
        label: 'Spørsmål',
        open: 'Åpne',
        'n.one': '{count} kilde',
        'n.other': '{count} kilder',
      },
    },
    template: { version: 1, root },
    ...spec,
  },
});

const errorsOf = (input: unknown) => {
  const result = validateDefinition(input, plugins);
  return result.ok ? [] : result.errors;
};

const pathsOf = (input: unknown) => errorsOf(input).map((e) => e.path);

const paragraph = (text: unknown) => ({ type: 'paragraph', text });
const each = (children: unknown[], of = 'sources', as = 'source') => ({
  type: 'each',
  of,
  as,
  children,
});

describe('the declarative template language', () => {
  it('accepts the compact source list example', () => {
    expect(errorsOf(fixture('kildeliste-kompakt'))).toEqual([]);
    expect(errorsOf(fixture('sporsmal-kort'))).toEqual([]);
  });

  it('refuses a binding outside the field list', () => {
    expect(errorsOf(block(paragraph({ bind: 'answer.secret' })))).toEqual([
      {
        path: 'spec.template.root.text.bind',
        message: 'answer.secret is not a field a block may read',
      },
    ]);
    expect(pathsOf(block(paragraph({ bind: 'tenant.apiKey' })))).toEqual([
      'spec.template.root.text.bind',
    ]);
  });

  it('refuses a prop the block does not declare', () => {
    expect(errorsOf(block(paragraph({ bind: 'props.secret' })))).toEqual([
      { path: 'spec.template.root.text.bind', message: 'props.secret is not a prop of the block' },
    ]);
    const props = { type: 'object', properties: { heading: { type: 'string' } } };
    expect(errorsOf(block(paragraph({ bind: 'props.heading' }), { props }))).toEqual([]);
  });

  it('refuses an item alias outside its each', () => {
    const root = {
      type: 'stack',
      children: [each([paragraph({ bind: 'source.title' })]), paragraph({ bind: 'source.title' })],
    };
    expect(errorsOf(block(root))).toEqual([
      {
        path: 'spec.template.root.children[1].text.bind',
        message: 'source.title is not a field a block may read',
      },
    ]);
  });

  it('refuses an item of a list read outside an each over it', () => {
    expect(errorsOf(block(paragraph({ bind: 'sources.title' })))).toEqual([
      {
        path: 'spec.template.root.text.bind',
        message: 'sources.title reads an item of sources outside an each over it',
      },
    ]);
  });

  it('refuses an alias that hides a field root', () => {
    expect(errorsOf(block(each([], 'sources', 'question')))).toEqual([
      {
        path: 'spec.template.root.as',
        message: 'question is the name of a field, so it cannot name an item',
      },
    ]);
    expect(pathsOf(block(each([], 'sources', 'props')))).toEqual(['spec.template.root.as']);
  });

  it('refuses a list binding where a single value is needed, and the other way round', () => {
    expect(errorsOf(block(paragraph({ bind: 'sources' })))).toEqual([
      {
        path: 'spec.template.root.text.bind',
        message: 'sources is a list, so it cannot stand where one value is needed',
      },
    ]);
    expect(errorsOf(block(each([], 'question.text', 'q')))).toEqual([
      { path: 'spec.template.root.of', message: 'question.text is not a list' },
    ]);
  });

  it('refuses a field its zones do not give the block', () => {
    const root = each([paragraph({ bind: 'one.title' })], 'threads', 'one');
    expect(errorsOf(block(root))).toEqual([
      {
        path: 'spec.template.root.of',
        message: 'threads is not given in every zone the block may stand in',
      },
    ]);
    expect(errorsOf(block(each([], 'threads', 'one'), { zones: ['primary'] }))).toEqual([]);
  });

  it('refuses an event the block does not declare', () => {
    const root = {
      type: 'button',
      text: { t: 'open' },
      event: { name: 'open-page', page: 'om' },
    };
    expect(errorsOf(block(root))).toEqual([
      {
        path: 'spec.template.root.event.name',
        message: 'open-page is not one of the events the block declares',
      },
    ]);
  });

  it('opens a document only by the index of a source', () => {
    const open = (source: string) =>
      each([{ type: 'button', text: { t: 'open' }, event: { name: 'open-document', source } }]);
    expect(errorsOf(block(open('source.index')))).toEqual([]);
    expect(pathsOf(block(open('source.title')))).toEqual([
      'spec.template.root.children[0].event.source',
    ]);
  });

  it('refuses a text key that is missing in bokmål', () => {
    expect(errorsOf(block(paragraph({ t: 'missing' })))).toEqual([
      { path: 'spec.template.root.text.t', message: 'missing is not a text in bokmål' },
    ]);
    expect(errorsOf(block(paragraph({ t: 'n', args: { count: { count: 'sources' } } })))).toEqual(
      [],
    );
    expect(
      pathsOf(block(paragraph({ t: 'label', args: { count: { count: 'sources' } } }))),
    ).toEqual(['spec.template.root.text.t', 'spec.template.root.text.t']);
  });

  it('refuses a literal text with letters, so every word is translatable', () => {
    expect(errorsOf(block(paragraph([{ t: 'label' }, ': ', { bind: 'question.text' }])))).toEqual(
      [],
    );
    expect(pathsOf(block(paragraph([{ t: 'label' }, ' og ', { bind: 'question.text' }])))).toEqual([
      'spec.template.root.text[1]',
    ]);
    expect(pathsOf(block(paragraph('<script>')))).toEqual(['spec.template.root.text']);
  });

  it('refuses a link that is not https or a page of the service', () => {
    const link = (href: unknown) => ({ type: 'link', href, text: { t: 'open' } });
    expect(errorsOf(block(link('https://www.digdir.no/klarsprak')))).toEqual([]);
    expect(errorsOf(block(link({ page: 'om' })))).toEqual([]);
    for (const href of [
      'javascript:alert(1)',
      'http://www.digdir.no',
      'https://user@evil.example',
      'https://',
      'data:text/html,<b>x</b>',
    ])
      expect(pathsOf(block(link(href)))).toEqual(['spec.template.root.href']);
    expect(pathsOf(block(link({ page: '../admin' })))).toEqual(['spec.template.root.href.page']);
    expect(errorsOf(block(each([link({ bind: 'source.title' })])))).toEqual([
      {
        path: 'spec.template.root.children[0].href.bind',
        message: 'source.title is not an address',
      },
    ]);
  });

  it('refuses a state template for a state the block does not declare', () => {
    const input = block(paragraph({ t: 'label' }));
    (input.spec.template as Record<string, unknown>).states = {
      error: paragraph({ t: 'label' }),
    };
    expect(errorsOf(input)).toEqual([
      {
        path: 'spec.template.states.error',
        message: 'error is not one of the states the block declares',
      },
    ]);
  });

  it('refuses an element or a field the language does not have', () => {
    expect(pathsOf(block({ type: 'html', html: '<script>alert(1)</script>' }))).toEqual([
      'spec.template.root.type',
    ]);
    expect(
      pathsOf(block({ type: 'paragraph', text: { t: 'label' }, style: 'color: red' })),
    ).toEqual(['spec.template.root']);
    expect(
      pathsOf(block({ type: 'paragraph', text: { t: 'label' }, onClick: 'alert(1)' })),
    ).toEqual(['spec.template.root']);
  });

  it('refuses each and table nested more than 2 deep', () => {
    const inner = each([], 'f.values', 'v');
    const two = each([inner], 'filters.fields', 'f');
    expect(errorsOf(block(two))).toEqual([]);
    expect(pathsOf(block(each([two], 'sources', 'source')))).toEqual([
      'spec.template.root.children[0].children[0]',
    ]);
  });

  it('refuses a table nested in two lists, as it refuses an each', () => {
    const table = {
      type: 'table',
      rows: 'f.values',
      as: 'v',
      columns: [{ header: { t: 'label' }, cell: { type: 'divider' } }],
    };
    const two = each([table], 'filters.fields', 'f');
    expect(errorsOf(block(two))).toEqual([]);
    expect(pathsOf(block(each([two], 'sources', 'source')))).toEqual([
      'spec.template.root.children[0].children[0]',
    ]);
  });

  it('refuses an alias that already names an item in scope', () => {
    expect(errorsOf(block(each([each([], 'sources', 'source')])))).toEqual([
      {
        path: 'spec.template.root.children[0].as',
        message: 'source already names an item here',
      },
    ]);
  });

  it('formats as a date or a number only a field of that type', () => {
    const shown = (format: string, field = 'source.title') =>
      each([paragraph({ bind: field, format })]);
    expect(errorsOf(block(shown('date', 'source.publishedAt')))).toEqual([]);
    expect(errorsOf(block(shown('number', 'source.index')))).toEqual([]);
    expect(errorsOf(block(shown('date')))).toEqual([
      { path: 'spec.template.root.children[0].text.format', message: 'source.title is not a date' },
    ]);
    expect(errorsOf(block(shown('number')))).toEqual([
      {
        path: 'spec.template.root.children[0].text.format',
        message: 'source.title is not a number',
      },
    ]);
  });

  it('sets a filter only to texts or a list of texts', () => {
    const filter = (values: unknown) => ({
      type: 'button',
      text: { t: 'open' },
      event: { name: 'set-filter', field: 'publisher', values },
    });
    expect(errorsOf(block(filter(['digdir'])))).toEqual([]);
    expect(errorsOf(block(filter('sources')))).toEqual([
      { path: 'spec.template.root.event.values', message: 'sources is not a list of texts' },
    ]);
  });

  it('asks for plural texts only for a count of a list', () => {
    expect(
      errorsOf(block(each([paragraph({ t: 'label', args: { count: 'source.index' } })]))),
    ).toEqual([]);
  });

  it('refuses a template that reads more than 200 paths', () => {
    const reads = (n: number) =>
      block({
        type: 'stack',
        children: Array.from({ length: Math.ceil(n / 8) }, (_, i) =>
          paragraph(
            Array.from({ length: Math.min(8, n - i * 8) }, () => ({ bind: 'question.text' })),
          ),
        ),
      });
    expect(errorsOf(reads(200))).toEqual([]);
    expect(errorsOf(reads(201)).map((e) => e.message)).toEqual([
      'a template reads at most 200 paths',
    ]);
  });

  it('refuses more than 8 columns, 8 text parts, 20 key and value pairs or a max over 50', () => {
    const cell = { header: { t: 'label' }, cell: { type: 'divider' } };
    const table = (n: number) => ({
      type: 'table',
      rows: 'sources',
      as: 'source',
      columns: Array.from({ length: n }, () => cell),
    });
    const pairs = (n: number) => ({
      type: 'keyValue',
      items: Array.from({ length: n }, () => ({ key: { t: 'label' }, value: { t: 'label' } })),
    });
    expect(errorsOf(block(table(8)))).toEqual([]);
    expect(pathsOf(block(table(9)))).toEqual(['spec.template.root.columns']);
    expect(pathsOf(block(paragraph(Array.from({ length: 9 }, () => ' '))))).toEqual([
      'spec.template.root.text',
    ]);
    expect(errorsOf(block(pairs(20)))).toEqual([]);
    expect(pathsOf(block(pairs(21)))).toEqual(['spec.template.root.items']);
    expect(errorsOf(block({ ...each([]), max: 50 }))).toEqual([]);
    expect(pathsOf(block({ ...each([]), max: 51 }))).toEqual(['spec.template.root.max']);
  });

  it('refuses JSON nested more than 64 levels before the schema reads it', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 64; i += 1) deep = [deep];
    expect(templatePrePass({ version: 1, root: { type: 'divider', extra: deep } })).toBe(
      'a template nests at most 64 levels of JSON',
    );
  });

  it('refuses a template whose each and table repeat it past 2000 elements', () => {
    const twice = (children: unknown[], max = 50) =>
      each([{ ...each(children, 'sources', 'b'), max }], 'sources', 'a');
    const dividers = (n: number) => Array.from({ length: n }, () => ({ type: 'divider' }));
    expect(errorsOf(block({ ...twice(dividers(1), 38), max: 50 }))).toEqual([]);
    expect(errorsOf(block({ ...twice(dividers(190)), max: 50 }))).toEqual([
      {
        path: 'spec.template',
        message: 'a template draws at most 2000 elements once its lists repeat',
      },
    ]);
    const table = {
      type: 'table',
      rows: 'sources',
      as: 'b',
      max: 50,
      columns: [{ header: { t: 'label' }, cell: { type: 'divider' } }],
    };
    expect(pathsOf(block({ ...each([table], 'sources', 'a'), max: 50 }))).toEqual([
      'spec.template',
    ]);
    const wide = (columns: number) => ({
      ...each(
        [{ ...table, max: 4, columns: Array.from({ length: columns }, () => table.columns[0]) }],
        'sources',
        'a',
      ),
      max: 50,
    });
    expect(errorsOf(block(wide(7)))).toEqual([]);
    expect(pathsOf(block(wide(8)))).toEqual(['spec.template']);
    const pairs = (n: number) =>
      twice(
        [
          {
            type: 'keyValue',
            items: Array.from({ length: n }, () => ({
              key: { t: 'label' },
              value: { t: 'label' },
            })),
          },
        ],
        2,
      );
    expect(errorsOf(block({ ...pairs(18), max: 50 }))).toEqual([]);
    expect(pathsOf(block({ ...pairs(20), max: 50 }))).toEqual(['spec.template']);
  });

  it('refuses a condition nested more than 3 deep', () => {
    const when = (c: unknown) => ({ type: 'if', when: c, then: [] });
    expect(errorsOf(block(when({ not: { not: { exists: 'sources' } } })))).toEqual([]);
    expect(pathsOf(block(when({ not: { not: { not: { exists: 'sources' } } } })))).toEqual([
      'spec.template.root.when.not.not.not',
    ]);
  });

  it('refuses more than 200 nodes or a depth over 12 before reading the tree', () => {
    const broad = {
      type: 'stack',
      children: Array.from({ length: 200 }, () => ({ type: 'divider' })),
    };
    expect(templatePrePass({ version: 1, root: broad })).toBe('a template has at most 200 nodes');
    let deep: unknown = { type: 'divider' };
    for (let i = 0; i < 12; i += 1) deep = { type: 'card', children: [deep] };
    expect(templatePrePass({ version: 1, root: deep })).toBe(
      'a template nests at most 12 nodes deep',
    );
    expect(errorsOf(block(broad))).toEqual([
      { path: 'spec.template', message: 'a template has at most 200 nodes' },
    ]);
  });

  it('refuses a template over 32 KiB', () => {
    const long = { nb: { label: 'Spørsmål', big: 'x'.repeat(900) } };
    const root = {
      type: 'stack',
      children: Array.from({ length: 150 }, () => paragraph([{ t: 'label' }, '·'.repeat(8)])),
    };
    expect(errorsOf(block(root, { texts: long }))).toEqual([]);
    const huge = paragraph({ bind: `question.${'a'.repeat(40_000)}` });
    expect(errorsOf(block(huge))).toEqual([
      { path: 'spec.template', message: 'a template is at most 32768 bytes as JSON' },
    ]);
  });

  it('checks a template in linear time', () => {
    const full = {
      type: 'card',
      children: Array.from({ length: 19 }, () =>
        each(
          [
            { type: 'heading', level: 3, text: { bind: 'source.title' } },
            paragraph([
              { bind: 'source.publisher' },
              ', ',
              { bind: 'source.publishedAt', format: 'date' },
            ]),
            { type: 'link', href: { bind: 'source.url' }, text: { t: 'open' } },
            {
              type: 'if',
              when: { exists: 'source.excerpt' },
              then: [paragraph({ bind: 'source.excerpt' })],
            },
            {
              type: 'button',
              text: { t: 'open' },
              event: { name: 'open-document', source: 'source.index' },
            },
            { type: 'divider' },
            { type: 'tag', text: { bind: 'source.documentType' } },
            { type: 'icon', name: 'file-text' },
          ],
          'sources',
          'source',
        ),
      ),
    };
    const started = performance.now();
    expect(errorsOf(block(full))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);

    const broad = {
      type: 'stack',
      children: Array.from({ length: 100_000 }, () => ({ type: 'divider' })),
    };
    let deep: unknown = { type: 'divider' };
    for (let i = 0; i < 100_000; i += 1) deep = { type: 'card', children: [deep] };
    for (const root of [broad, deep]) {
      const hostile = performance.now();
      expect(pathsOf(block(root))).toEqual(['spec.template']);
      expect(performance.now() - hostile).toBeLessThan(500);
    }
  });

  it('matches paths and addresses in linear time on long adversarial input', () => {
    const adversarial = [
      `${'a'.repeat(100_000)}!`,
      `${'a.'.repeat(50_000)}!`,
      `https://${'a-'.repeat(50_000)}..`,
      `/${'\\'.repeat(100_000)}`,
    ];
    const started = performance.now();
    for (const text of adversarial) {
      templatePathPattern.test(text);
      isHttpsAddress(text);
      isSitePath(text);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('reads only the canonical paths a template binds, a list left out when a field under it is read', () => {
    const { spec } = fixture('kildeliste-kompakt') as unknown as BlockDefinition;
    expect(templateReads(spec.template)).toEqual([
      'sources.index',
      'sources.publishedAt',
      'sources.publisher',
      'sources.title',
    ]);
    expect(templateReads({ version: 1, root: paragraph({ count: 'sources' }) } as never)).toEqual([
      'sources',
    ]);
  });
});
