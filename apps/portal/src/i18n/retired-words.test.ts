import { enBuilder, nbBuilder } from '@genai/ui-blocks/builder';
import { describe, expect, it } from 'vitest';
import { build as enBuild } from './en/build';
import { core as enCore } from './en/core';
import { data as enData } from './en/data';
import { operate as enOperate } from './en/operate';
import { build } from './nb/build';
import { core } from './nb/core';
import { data } from './nb/data';
import { operate } from './nb/operate';

const nb = { ...core, ...build, ...data, ...operate, builder: nbBuilder };
const en = { ...enCore, ...enBuild, ...enData, ...enOperate, builder: enBuilder };

const word = (stem: string, endings = '') =>
  new RegExp(`(?<![\\p{L}])${stem}${endings ? `(?:${endings})?` : ''}(?![\\p{L}])`, 'iu');

const retiredNb: Record<string, RegExp> = {
  Byggeklosser: /byggekloss/iu,
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
};

const retiredEn: Record<string, RegExp> = {
  'Building blocks': /building block/iu,
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
  reason: string;
}

const exceptions: Exception[] = [
  {
    key: 'about.navBlocks',
    word: 'Byggeklosser',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.navBlocks',
    word: 'Building blocks',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.exploreBlocks',
    word: 'Byggeklosser',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.exploreBlocks',
    word: 'Building blocks',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.buildLede',
    word: 'Byggeklosser',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.buildLede',
    word: 'Building blocks',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.architectureSub',
    word: 'Byggeklosser',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'about.architectureSub',
    word: 'Building blocks',
    reason: 'the public site names the layers of the target picture byggeklosser, its own page',
  },
  {
    key: 'integLangfuse.*',
    word: 'Datasett',
    reason: 'Langfuse calls its own lists datasets, and owners must find them there',
  },
  {
    key: 'integLangfuse.*',
    word: 'Datasets',
    reason: 'Langfuse calls its own lists datasets, and owners must find them there',
  },
  {
    key: 'integLangfuse.guideLive',
    word: 'Environments',
    reason: 'a Langfuse filter on its environment field',
  },
  {
    key: 'quality.langfuseDataset',
    word: 'Datasett',
    reason: 'a Langfuse dataset',
  },
  {
    key: 'quality.langfuseDataset',
    word: 'Datasets',
    reason: 'a Langfuse dataset',
  },
];

const externalTerms = [
  'Agent Skills',
  'SKILL.md',
  'kind must be Skill',
  'dataset_config_key',
  'dataset_not_authorized',
];

const strings = (node: unknown, path: string[] = []): [string, string][] =>
  typeof node === 'string'
    ? [[path.join('.'), node]]
    : node && typeof node === 'object'
      ? Object.entries(node).flatMap(([key, value]) => strings(value, [...path, key]))
      : [];

const withoutPlaceholders = (text: string) =>
  externalTerms.reduce((rest, term) => rest.replaceAll(term, ''), text.replace(/\{[^{}]*\}/gu, ''));

const offenders = (catalogue: object, retired: Record<string, RegExp>) =>
  strings(catalogue).flatMap(([key, text]) =>
    Object.entries(retired)
      .filter(([name, pattern]) => pattern.test(withoutPlaceholders(text)) && !excepted(key, name))
      .map(([name]) => `${key}: ${name}: ${text}`),
  );

const covers = (exception: Exception, key: string) =>
  exception.key.endsWith('*') ? key.startsWith(exception.key.slice(0, -1)) : exception.key === key;

const excepted = (key: string, name: string) =>
  exceptions.some((exception) => covers(exception, key) && exception.word === name);

describe('portal naming', () => {
  it('never uses a retired word in the bokmål catalogue', () => {
    expect(offenders(nb, retiredNb)).toEqual([]);
  });

  it('never uses a retired word in the English catalogue', () => {
    expect(offenders(en, retiredEn)).toEqual([]);
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
