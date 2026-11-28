import type {
  Catalogue,
  Format,
  Locale,
  MessageKey,
  PlainKey as PlainKeyOf,
  Translation,
} from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { api as enApi } from './en/api';
import { common as enCommon } from './en/common';
import { contentView as enContentView } from './en/contentView';
import { frame as enFrame } from './en/frame';
import { orgList as enOrgList } from './en/orgList';
import { queue as enQueue } from './en/queue';
import { searchEngines as enSearchEngines } from './en/searchEngines';
import { shell as enShell } from './en/shell';
import { tenantServices as enTenantServices } from './en/tenantServices';
import { tenants as enTenants } from './en/tenants';
import type { nb as nbFull } from './full';
import { api } from './nb/api';
import { common } from './nb/common';
import { contentView } from './nb/contentView';
import { frame } from './nb/frame';
import { orgList } from './nb/orgList';
import { queue } from './nb/queue';
import { searchEngines } from './nb/searchEngines';
import { shell } from './nb/shell';
import { tenantServices } from './nb/tenantServices';
import { tenants } from './nb/tenants';

type Nb = typeof nbFull;

const texts = {
  nb: {
    api,
    common,
    contentView,
    frame,
    orgList,
    queue,
    searchEngines,
    shell,
    tenantServices,
    tenants,
  } as Catalogue,
  en: {
    api: enApi,
    common: enCommon,
    contentView: enContentView,
    frame: enFrame,
    orgList: enOrgList,
    queue: enQueue,
    searchEngines: enSearchEngines,
    shell: enShell,
    tenantServices: enTenantServices,
    tenants: enTenants,
  } as Catalogue,
};

export const addTexts = (nb: Catalogue, en: Catalogue) => {
  Object.assign(texts.nb, nb);
  Object.assign(texts.en, en);
};

export const { useT, translator } = defineTranslations<Nb>(
  texts as unknown as { nb: Nb; en: Translation<Nb> },
);
export type Key = MessageKey<Nb>;
export type PlainKey = PlainKeyOf<Nb>;
export type T = ReturnType<typeof translator>;
export type { Format, Locale };
