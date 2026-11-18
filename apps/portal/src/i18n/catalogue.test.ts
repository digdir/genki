import { catalogueProblems } from '@genai/i18n';
import { enBuilder, nbBuilder } from '@genai/ui-blocks/builder';
import { describe, expect, it } from 'vitest';
import { loadedTexts } from '.';
import { loadAllTexts } from './areas';
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

describe('portal catalogue', () => {
  it('has an English text for every bokmål text', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('loads every text in both languages through some area', async () => {
    await loadAllTexts();
    expect(loadedTexts('nb')).toEqual(nb);
    expect(loadedTexts('en')).toEqual(en);
  });
});
