import type { BlockSharing, BlockTier, BlockZone, LanguageMap } from '@genai/contracts/blocks';
import type { Locale } from '@genai/i18n';
import type { PlainKey, T } from '../../i18n';

export const dayOf = (iso: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'nb-NO', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Oslo',
  }).format(new Date(iso));

/** The date an edition is named by, with «(2)» after the second one saved the same day. */
export const editionDates = (
  editions: readonly { version: number; publishedAt: string }[],
  locale: Locale,
  t: T,
): Map<number, string> => {
  const seen = new Map<string, number>();
  const names = new Map<number, string>();
  for (const edition of [...editions].sort((a, b) => a.version - b.version)) {
    const date = dayOf(edition.publishedAt, locale);
    const n = (seen.get(date) ?? 0) + 1;
    seen.set(date, n);
    names.set(edition.version, n === 1 ? date : t('design.sameDay', { date, n }));
  }
  return names;
};

export const titleOf = (title: LanguageMap, locale: Locale) =>
  title[locale] ?? title.nb ?? title.en ?? '';

export const tierKey: Record<BlockTier, PlainKey> = {
  'built-in': 'design.fromGenki',
  declarative: 'design.withoutCode',
  code: 'design.withCode',
};

export const tierColor: Record<BlockTier, 'neutral' | 'info' | 'warning'> = {
  'built-in': 'neutral',
  declarative: 'info',
  code: 'warning',
};

export const zoneKey: Record<BlockZone, PlainKey> = {
  primary: 'design.zonePrimary',
  main: 'design.zoneMain',
  secondary: 'design.zoneSecondary',
};

export const sharingKey = (sharing: BlockSharing): PlainKey =>
  sharing === 'everyone' ? 'design.sharingEveryone' : 'design.sharingOrganisation';

export const designPath = (publisher: string, id: string) =>
  `/design/${encodeURIComponent(publisher)}/${encodeURIComponent(id)}`;

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
