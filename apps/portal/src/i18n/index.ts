import type {
  Catalogue,
  Format,
  Locale,
  MessageKey,
  PlainKey as PlainKeyOf,
  Translation,
} from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { enBuilder, nbBuilder } from '@genai/ui-blocks/builder';
import type { build as enBuild } from './en/build';
import { core as enCore } from './en/core';
import type { data as enData } from './en/data';
import type { operate as enOperate } from './en/operate';
import type { build } from './nb/build';
import { core } from './nb/core';
import type { data } from './nb/data';
import type { operate } from './nb/operate';

// The interface tab's block, option, template and reason words are the UI blocks catalogue's own.
type Nb = typeof core & typeof build & typeof data & typeof operate & { builder: typeof nbBuilder };
type En = typeof enCore &
  typeof enBuild &
  typeof enData &
  typeof enOperate & { builder: typeof enBuilder };
type Complete<T extends Translation<Nb>> = T;
export type EnglishCatalogue = Complete<En>;

const texts = {
  nb: { ...core, builder: nbBuilder } as Catalogue,
  en: { ...enCore, builder: enBuilder } as Catalogue,
};

export const addTexts = (nb: Catalogue, en: Catalogue) => {
  Object.assign(texts.nb, nb);
  Object.assign(texts.en, en);
};

export const loadedTexts = (locale: Locale): Catalogue => texts[locale];

export const { useT, translator } = defineTranslations<Nb>(
  texts as unknown as { nb: Nb; en: Translation<Nb> },
);
export type Key = MessageKey<Nb>;
export type PlainKey = PlainKeyOf<Nb>;
export type T = ReturnType<typeof translator>;
export type { Format, Locale };
