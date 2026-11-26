import type { BlockOrigin, BlockZone, LanguageMap } from '@genai/contracts/blocks';
import type { Locale } from '@genai/i18n';
import type { PlainKey, T } from '../../i18n';

export const dayOf = (iso: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'nb-NO', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Oslo',
  }).format(new Date(iso));

export const titleOf = (title: LanguageMap | undefined, locale: Locale) =>
  title?.[locale] ?? title?.nb ?? title?.en ?? '';

export const versionName = (t: T, version: number | undefined) =>
  version === undefined ? '' : t('design.version', { version });

export const zoneKey: Record<BlockZone, PlainKey> = {
  primary: 'design.zonePrimary',
  main: 'design.zoneMain',
  secondary: 'design.zoneSecondary',
};

/** The catalogue's tag colour per origin, as the design's Fra genki, own and Delt tags. */
export const originColor: Record<BlockOrigin, 'info' | 'success' | 'warning'> = {
  'built-in': 'info',
  own: 'success',
  shared: 'warning',
};

export const designPath = (publisher: string, id: string) =>
  `/design/${encodeURIComponent(publisher)}/${encodeURIComponent(id)}`;

export const versionsPath = (publisher: string, id: string) =>
  `${designPath(publisher, id)}/versions`;

/** A technical id made from a name: lower case, Norwegian letters spelled out, words joined by hyphens. */
export const idFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/, '');
