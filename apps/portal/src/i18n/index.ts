import {
  defineCatalogue,
  type Format,
  type Locale,
  type MessageKey,
  type PlainKey as PlainKeyOf,
  type Translation,
} from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { build as enBuild } from './en/build';
import { core as enCore } from './en/core';
import { data as enData } from './en/data';
import { operate as enOperate } from './en/operate';
import { build } from './nb/build';
import { core } from './nb/core';
import { data } from './nb/data';
import { operate } from './nb/operate';

export const nb = defineCatalogue({ ...core, ...build, ...data, ...operate });

export const en = {
  ...enCore,
  ...enBuild,
  ...enData,
  ...enOperate,
} satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
export type Key = MessageKey<typeof nb>;
export type PlainKey = PlainKeyOf<typeof nb>;
export type T = ReturnType<typeof translator>;
export type { Format, Locale };
