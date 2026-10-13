const legacyDocument =
  /^(?:digdir:\/\/doc\/|https:\/\/kudos\.dfo\.no\/dokument\/)(\d{1,10})(?:[/?#].*)?$/;
const legacyNumber = /^\d{1,10}$/;

export const sourceLinkRules = ['kudos-legacy'] as const;
export type SourceLinkRule = (typeof sourceLinkRules)[number];

export const kudosSearchUrl = (title: string) =>
  `https://kudos.dfo.no/dokumenter?query=${encodeURIComponent(title)}`;

export interface LinkableSource {
  url?: string | null | undefined;
  document?: string | null | undefined;
  title?: string | null | undefined;
}

export const publicSourceUrl = (
  source: LinkableSource,
  rule?: SourceLinkRule,
): string | undefined => {
  const url = source.url?.trim();
  if (rule !== 'kudos-legacy') return url || undefined;
  const legacy = url ? legacyDocument.exec(url)?.[1] : (source.document ?? undefined);
  if (legacy && legacyNumber.test(legacy))
    return source.title ? kudosSearchUrl(source.title) : undefined;
  return url || undefined;
};

export const plainHeading = (value: string): string =>
  (value.split('\n', 1)[0] ?? '')
    .replace(/^\s*#+\s*/, '')
    .replace(/\s#+(?=\s|$)/g, ' ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\*\*|__|`+/g, '')
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

export const sourceBreadcrumb = (headers: string[] = []): string | undefined => {
  const levels = [...new Set(headers.map(plainHeading).filter((h) => h.length > 0))];
  return levels.length > 0 ? levels.join(' › ') : undefined;
};

export const withPlainHeadings = <T extends { title?: string; headers?: string[] }>(
  source: T,
): T => {
  const title = source.title === undefined ? undefined : plainHeading(source.title);
  return {
    ...source,
    ...(title === undefined ? {} : { title }),
    ...(source.headers ? { headers: source.headers.map(plainHeading).filter(Boolean) } : {}),
  };
};
