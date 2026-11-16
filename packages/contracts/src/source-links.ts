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

const PAGE_ANCHOR = '<span id="page-';
const PAGE_ANCHOR_END = '"></span>';
const PAGE_LINK = '](#page-';
const DROPPED_TAGS = ['<u>', '</u>', '<sup>', '</sup>'];
const FOOTNOTE_LINKS = [
  ['[[', ']'],
  ['[\\[', '\\]'],
  ['[', ''],
] as const;
const RAISED = '⁰¹²³⁴⁵⁶⁷⁸⁹';

const isDigit = (char: string) => char >= '0' && char <= '9';

// Where a run of digits, or of page-id characters such as `12-0`, that starts at `from` ends.
const runEnd = (value: string, from: number, pageId = false) => {
  let at = from;
  while (isDigit(value.charAt(at)) || (pageId && value.charAt(at) === '-')) at += 1;
  return at;
};

// `open`, digits and `close` at `at` as superscript digits, and where they end.
const raisedAt = (
  value: string,
  at: number,
  open: string,
  close: string,
): [string, number] | undefined => {
  if (!value.startsWith(open, at)) return undefined;
  const end = runEnd(value, at + open.length);
  if (end === at + open.length || !value.startsWith(close, end)) return undefined;
  const digits = [...value.slice(at + open.length, end)];
  return [digits.map((d) => RAISED.charAt(Number(d))).join(''), end + close.length];
};

// Where `](#page-12-0)` at `at` ends, or -1.
const pageTargetEnd = (value: string, at: number) => {
  if (!value.startsWith(PAGE_LINK, at)) return -1;
  const id = runEnd(value, at + PAGE_LINK.length, true);
  return id > at + PAGE_LINK.length && value[id] === ')' ? id + 1 : -1;
};

// Marker's markup at `at`: what it reads as, and where it ends.
const markupAt = (value: string, at: number): [string, number] | undefined => {
  if (value[at] === '[') {
    for (const [open, close] of FOOTNOTE_LINKS) {
      const footnote = raisedAt(value, at, open, close);
      const end = footnote ? pageTargetEnd(value, footnote[1]) : -1;
      if (footnote && end > 0) return [footnote[0], end];
    }
    return undefined;
  }
  if (value[at] !== '<') return undefined;
  const id = value.startsWith(PAGE_ANCHOR, at) ? runEnd(value, at + PAGE_ANCHOR.length, true) : -1;
  if (id > at + PAGE_ANCHOR.length && value.startsWith(PAGE_ANCHOR_END, id))
    return ['', id + PAGE_ANCHOR_END.length];
  const tag = DROPPED_TAGS.find((t) => value.startsWith(t, at));
  const dropped: [string, number] | undefined = tag ? ['', at + tag.length] : undefined;
  return raisedAt(value, at, '<sup>', '</sup>') ?? dropped;
};

// Where the words of Marker's `[words](#page-12-0)` at `at` end, and where the link ends.
const pageLinkAt = (value: string, at: number): [number, number] | undefined => {
  if (value[at] !== '[') return undefined;
  let close = at + 1;
  while (close < value.length && value[close] !== ']' && value[close] !== '[') close += 1;
  const end = pageTargetEnd(value, close);
  return end > 0 ? [close, end] : undefined;
};

// One linear pass over a heading level that leaves out the markup Marker puts in headings.
const withoutMarkerMarkup = (value: string) => {
  let text = '';
  let words: [number, number] | undefined;
  for (let at = 0; at < value.length;) {
    const markup = markupAt(value, at);
    const link = words ? undefined : pageLinkAt(value, at);
    if (words && at === words[0]) [at, words] = [words[1], undefined];
    else if (markup) [text, at] = [text + markup[0], markup[1]];
    else if (link) [words, at] = [link, at + 1];
    else text += value.charAt(at++);
  }
  return text;
};

/** One heading level from the index as plain text, without the markup Marker leaves in it. */
export const plainHeadingLevel = (value: string): string =>
  plainHeading(withoutMarkerMarkup(value));

export const sourceBreadcrumb = (headers: string[] = []): string | undefined => {
  const levels = [...new Set(headers.map(plainHeadingLevel).filter((h) => h.length > 0))];
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
