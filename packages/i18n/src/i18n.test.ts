import { describe, expect, it } from 'vitest';
import {
  catalogueProblems,
  createFormat,
  createRetranslator,
  createTranslator,
  defineCatalogue,
  negotiate,
  parseRich,
  resolveLocale,
  type Translation,
} from './index.js';

const nb = defineCatalogue({
  chat: {
    send: 'Send',
    greeting: 'Hei, {name}!',
    sources: { one: '{count} kilde', other: '{count} kilder' },
    more: 'Les <link>mer om {topic}</link>.',
  },
});
const en = {
  chat: {
    send: 'Send',
    greeting: 'Hello, {name}!',
    sources: { one: '{count} source', other: '{count} sources' },
    more: 'Read <link>more about {topic}</link>.',
  },
} satisfies Translation<typeof nb>;

describe('translator', () => {
  it('interpolates, pluralises and falls back to the key', () => {
    const t = createTranslator({ nb, en }, 'en');
    expect(t('chat.greeting', { name: 'Kari' })).toBe('Hello, Kari!');
    expect(t('chat.sources', { count: 1 })).toBe('1 source');
    expect(t('chat.sources', { count: 1200 })).toBe('1,200 sources');
    expect(createTranslator({ nb, en }, 'nb')('chat.sources', { count: 1200 })).toBe(
      '1 200 kilder',
    );
  });

  it('parses rich text into tags and params', () => {
    expect(parseRich('Les <link>mer om {topic}</link>.')).toEqual([
      { kind: 'text', text: 'Les ' },
      {
        kind: 'tag',
        name: 'link',
        children: [
          { kind: 'text', text: 'mer om ' },
          { kind: 'param', name: 'topic' },
        ],
      },
      { kind: 'text', text: '.' },
    ]);
  });
});

describe('catalogue check', () => {
  it('accepts a complete translation', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('reports missing, empty, placeholder and tag problems', () => {
    const broken = {
      chat: { send: ' ', greeting: 'Hello, {who}!', sources: { one: 'x', other: 'y' }, more: 'm' },
      extra: { key: 'x' },
    };
    expect(catalogueProblems(nb, broken)).toEqual([
      'chat.send: empty',
      'chat.greeting: placeholders {name} vs {who}',
      'chat.more: placeholders {topic} vs {}',
      'chat.more: tags <link> vs <>',
      'extra.key: not in source',
    ]);
  });
});

describe('locale negotiation', () => {
  it('reads Accept-Language, ui_locales and browser lists', () => {
    expect(negotiate('en-US,en;q=0.9,nb;q=0.8')).toBe('en');
    expect(negotiate('de, nb;q=0.5, en;q=0.4')).toBe('nb');
    expect(negotiate('nn en')).toBe('nb');
    expect(negotiate(['no-NO', 'en'])).toBe('nb');
    expect(negotiate('de')).toBeUndefined();
    expect(resolveLocale(undefined, 'fr', 'en-GB')).toBe('en');
    expect(resolveLocale(null)).toBe('nb');
  });
});

describe('format', () => {
  const at = new Date('2026-10-07T08:05:00Z');

  it('formats dates, times and money per locale in Oslo time', () => {
    const nbf = createFormat('nb');
    const enf = createFormat('en');
    expect(nbf.date(at)).toBe('7. oktober 2026');
    expect(enf.date(at)).toBe('7 October 2026');
    expect(nbf.dateTime(at)).toBe('7. oktober 2026 kl. 10.05');
    expect(enf.dateTime(at)).toBe('7 October 2026, 10:05');
    expect(nbf.currency(1234.5)).toBe('1 234,5 kr');
    expect(enf.currency(1234.5)).toBe('NOK 1,234.5');
    expect(enf.list(['a', 'b', 'c'])).toBe('a, b and c');
    expect(nbf.list(['a', 'b', 'c'])).toBe('a, b og c');
  });

  it('formats relative time', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    expect(createFormat('en').relative(new Date('2026-10-07T09:57:00Z'), now)).toBe(
      '3 minutes ago',
    );
    expect(createFormat('nb').relative(new Date('2026-10-06T10:00:00Z'), now)).toBe('i går');
  });
});

describe('format with a missing date', () => {
  it('shows nothing instead of throwing', () => {
    const f = createFormat('nb');
    expect([
      f.date(''),
      f.time(''),
      f.dateTime(''),
      f.month(''),
      f.weekday(''),
      f.relative(''),
    ]).toEqual(['', '', '', '', '', '']);
  });
});

describe('retranslator', () => {
  it('maps bokmål text, including filled templates, to the target language', () => {
    const to = createRetranslator(nb, { en }, 'en');
    expect(to('Send')).toBe('Send');
    expect(to('Hei, Kari Nordmann!')).toBe('Hello, Kari Nordmann!');
    expect(to('3 kilder')).toBe('3 sources');
    expect(to('Ukjent tekst')).toBeUndefined();
    expect(createRetranslator(nb, {}, 'en')('Send')).toBeUndefined();
  });
});
