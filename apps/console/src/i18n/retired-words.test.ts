import { describe, expect, it } from 'vitest';
import { en, nb } from './index';

const word = (stem: string, endings = '') =>
  new RegExp(`(?<![\\p{L}])${stem}${endings ? `(?:${endings})?` : ''}(?![\\p{L}])`, 'iu');

const retiredNb: Record<string, RegExp> = {
  Byggeklosser: /byggekloss/iu,
  Tillegg: word('tillegg', 'et|ene'),
  Vakter: word('vakt', 'er|en|ene'),
  Vern: word('vern', 'et|regel|regler|reglene'),
  Utviklerverktøy: /utviklerverktøy/iu,
  Grensesnitt: /grensesnitt/iu,
  Versjoner: word('versjon(?:er|ene)'),
  Miljø: /miljø/iu,
  prod: word('prod'),
  'Samlet jobb': /samlet jobb/iu,
  Dommere: word('dommer', 'e|en|ne'),
  Kroker: word('krok', 'er|en|ene'),
  Stegflyter: /stegflyt/iu,
  Ferdigheter: /ferdighet/iu,
  Fellestjenester: /fellestjenest/iu,
  Datasett: /datasett/iu,
  Tråder: word('tråd(?:er|ene)'),
  Organisasjonsnummer: /organisasjonsnummer/iu,
  Revisjon: word('revisjon'),
};

const retiredEn: Record<string, RegExp> = {
  'Building blocks': /building block/iu,
  'Plug-ins': /plug-ins?/iu,
  Guards: word('guards?'),
  'Developer tools': /developer tools/iu,
  Interface: word('interface'),
  Versions: word('versions'),
  Environments: word('environments?'),
  prod: word('prod'),
  'Batch job': /batch jobs?/iu,
  Judges: word('judges?'),
  Hooks: word('hooks?'),
  'Step flows': /step flows?/iu,
  Skills: word('skills?'),
  Datasets: word('datasets?'),
  Threads: word('threads'),
};

interface Exception {
  key: string;
  word: string;
}

const exceptions: Exception[] = [];

const externalTerms = ['Agent Skills', 'SKILL.md', 'dataset_config_key', 'dataset_not_authorized'];

const strings = (node: unknown, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : node && typeof node === 'object'
      ? Object.entries(node).flatMap(([key, value]) => strings(value, [...path, key]))
      : [];

const withoutPlaceholders = (text: string) =>
  externalTerms.reduce(
    (rest, term) => rest.replaceAll(term, ''),
    text
      .replace(/\{[^{}]*\}/gu, '')
      .replaceAll('<', ' ')
      .replaceAll('>', ' '),
  );

const covers = (exception: Exception, key: string) =>
  exception.key.endsWith('*') ? key.startsWith(exception.key.slice(0, -1)) : exception.key === key;

const excepted = (key: string, name: string) =>
  exceptions.some((exception) => covers(exception, key) && exception.word === name);

const offenders = (catalogue: object, retired: Record<string, RegExp>) =>
  strings(catalogue).flatMap(([key, text]) =>
    Object.entries(retired)
      .filter(([name, pattern]) => pattern.test(withoutPlaceholders(text)) && !excepted(key, name))
      .map(([name]) => `${key}: ${name}: ${text}`),
  );

describe('console naming', () => {
  it('never uses a retired word in the bokmål catalogue', () => {
    expect(offenders(nb, retiredNb)).toEqual([]);
  });

  it('never uses a retired word in the English catalogue', () => {
    expect(offenders(en, retiredEn)).toEqual([]);
  });

  it('fails when a retired word comes back', () => {
    expect(offenders({ shell: { page: 'Byggeklosser' } }, retiredNb)).toHaveLength(1);
    expect(offenders({ shell: { page: 'Building blocks' } }, retiredEn)).toHaveLength(1);
  });

  it('keeps every exception pointing at a text that still needs it', () => {
    const texts = [...strings(nb), ...strings(en)];
    const stale = exceptions.filter((exception) => {
      const pattern = retiredNb[exception.word] ?? retiredEn[exception.word];
      return !texts.some(
        ([key, text]) =>
          covers(exception, key) && pattern?.test(withoutPlaceholders(text)) === true,
      );
    });
    expect(stale).toEqual([]);
  });
});
