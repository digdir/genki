import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseYaml, toYaml, YamlError } from './yaml';

const examples = import.meta.glob<string>('../../../packages/definitions/examples/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('yaml', () => {
  it('round-trips multi-line strings as block scalars', () => {
    const value = {
      spec: { instructions: 'Svar kort.\n\nOppgi kilder.', examples: ['a\nb', 'c\n'] },
    };
    const text = toYaml(value);
    expect(text).toContain('instructions: |');
    expect(parseYaml(text)).toEqual(value);
  });

  it('reads flow mappings, flow sequences and folded text', () => {
    const text = [
      'metadata: { tenant: "999888777", id: a }',
      'list: [en, "to, tre", { key: k }]',
      'purpose: >-',
      '  Første linje',
      '  fortsetter her',
      'body: |',
      '  linje',
    ].join('\n');
    expect(parseYaml(text)).toEqual({
      metadata: { tenant: '999888777', id: 'a' },
      list: ['en', 'to, tre', { key: 'k' }],
      purpose: 'Første linje fortsetter her',
      body: 'linje\n',
    });
  });

  it('quotes strings that would read back as something else', () => {
    const value = {
      tall: '42',
      versjon: '1.2.3',
      dato: '2026-10-08',
      sann: 'true',
      at: '@navn',
      mal: '{{input.query}}',
      kolon: 'a: b',
      '2024': 'år',
      innrykk: '  starter med mellomrom\nog fortsetter',
      ekstra: 'slutter med\n\n',
    };
    expect(parseYaml(toYaml(value))).toEqual(value);
  });

  it('reports the line of a syntax error and duplicate keys in Norwegian', () => {
    expect(() => parseYaml('a: 1\nb: [1, 2\n')).toThrow(YamlError);
    expect(() => parseYaml('a: 1\na: 2\n')).toThrow('samme navn står to ganger');
    expect(() => parseYaml('a:\n\t- b\n')).toThrow('Linje 2: bruk mellomrom, ikke tabulator.');
  });

  it.each(Object.entries(examples))('reads and round-trips %s', (_, text) => {
    const value = parseYaml(text);
    expect(value).toEqual(parse(text));
    expect(parseYaml(toYaml(value))).toEqual(value);
  });
});
