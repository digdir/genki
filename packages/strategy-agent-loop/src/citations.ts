import { untrustedData } from '@genai/port-model';
import { numberSentences, quoteOf, type TextQuote } from './sentences.js';

export interface Citation {
  index: number;
  chunkId: string;
}

export type CitationIndex = Map<number, string>;

export type CiteBy = 'document' | 'excerpt';

const markers = /\[(\d+)\]/g;

export const buildCitationIndex = (chunkIds: string[]): CitationIndex =>
  new Map(chunkIds.map((id, i) => [i + 1, id]));

export const parseCitations = (text: string, index: CitationIndex): Citation[] => {
  const seen = new Set<number>();
  const found: Citation[] = [];
  for (const match of text.matchAll(markers)) {
    const n = Number(match[1]);
    const chunkId = index.get(n);
    if (chunkId !== undefined && !seen.has(n)) {
      seen.add(n);
      found.push({ index: n, chunkId });
    }
  }
  return found.sort((a, b) => a.index - b.index);
};

export const renumberCitations = (
  text: string,
  citations: Citation[],
  index: CitationIndex,
): { text: string; citations: Citation[]; index: CitationIndex } => {
  if (citations.length === 0) return { text, citations, index };
  const old = [...new Set(citations.map((c) => c.index))].sort((a, b) => a - b);
  const oldToNew = new Map(old.map((o, i) => [o, i + 1]));
  if (old.every((o, i) => o === i + 1)) return { text, citations, index };
  return {
    text: text.replace(markers, (full, n: string) => {
      const next = oldToNew.get(Number(n));
      return next === undefined ? full : `[${next}]`;
    }),
    citations: citations
      .map((c) => ({ ...c, index: oldToNew.get(c.index) ?? c.index }))
      .sort((a, b) => a.index - b.index),
    index: new Map(old.map((o) => [oldToNew.get(o) as number, index.get(o) as string])),
  };
};

export interface CitationValidation {
  validIndices: number[];
  invalidIndices: number[];
  allValid: boolean;
  totalReferences: number;
  grounded: boolean;
}

export const validateCitations = (text: string, index: CitationIndex): CitationValidation => {
  const referenced = new Set([...text.matchAll(markers)].map((m) => Number(m[1])));
  const valid = [...referenced].filter((n) => index.has(n)).sort((a, b) => a - b);
  const invalid = [...referenced].filter((n) => !index.has(n)).sort((a, b) => a - b);
  return {
    validIndices: valid,
    invalidIndices: invalid,
    allValid: invalid.length === 0,
    totalReferences: referenced.size,
    grounded: valid.length > 0,
  };
};

const insufficientSignals: { signal: string; pattern: RegExp }[] = [
  {
    signal: 'not-enough-info',
    pattern:
      /\b(not enough|insufficient|don't have enough|do not have enough)\b[\s\S]{0,80}\b(info|information|context|sources?|documents?)\b/,
  },
  {
    signal: 'cannot-answer-from-sources',
    pattern:
      /\b(cannot|can't|unable to|could not)\b[\s\S]{0,80}\b(answer|determine|find|locate)\b[\s\S]{0,120}\b(context|sources?|documents?|provided)\b/,
  },
  {
    signal: 'no-relevant-information',
    pattern:
      /\b(no|not)\b[\s\S]{0,40}\b(relevant|available|matching)\b[\s\S]{0,80}\b(info|information|context|sources?|documents?)\b/,
  },
  {
    signal: 'ingen-nok-informasjon',
    pattern:
      /(?<![\p{L}\p{N}])(ikke nok|ikkje nok|utilstrekkelig|utilstrekkeleg|ingen)(?![\p{L}\p{N}])[\s\S]{0,80}(?<![\p{L}\p{N}])(informasjon|kontekst|kilder|kjelder|kjeldene)(?![\p{L}\p{N}])/u,
  },
  {
    signal: 'kan-ikke-svare-fra-kilder',
    pattern:
      /(?<![\p{L}\p{N}])(kan ikke|klarer ikke|kunne ikke|kan ikkje|klarer ikkje|kunne ikkje)(?![\p{L}\p{N}])[\s\S]{0,100}(?<![\p{L}\p{N}])(svare|finne)(?![\p{L}\p{N}])[\s\S]{0,120}(?<![\p{L}\p{N}])(informasjon|kontekst|kilder|kjelder|kjeldene)(?![\p{L}\p{N}])/u,
  },
  {
    signal: 'finner-ikke-i-kildene',
    pattern:
      /(?<![\p{L}\p{N}])(jeg (har|finner) ikke|eg (har|finn) ikkje)(?![\p{L}\p{N}])[\s\S]{0,120}(?<![\p{L}\p{N}])(informasjon|grunnlag|kilder|kjelder|kjeldene)(?![\p{L}\p{N}])/u,
  },
];

export const detectInsufficientContext = (
  text: string,
): { insufficient: boolean; signal?: string } => {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = insufficientSignals.find((s) => s.pattern.test(normalized));
  return hit ? { insufficient: true, signal: hit.signal } : { insufficient: false };
};

export const stripPageMarkers = (text: string): string =>
  text.replace(/\{(\d+)\}/g, '').replace(/\n-{3,}\n/g, '\n');

interface Numberable {
  chunkId: string;
  document?: string;
  url?: string;
  title?: string | undefined;
  publisher?: string | undefined;
  page?: number;
  pageEnd?: number;
  content: string;
}

/** A chunk's PDF page as the agent is shown it: `page` 67, or `pages` 67-69 when it spans several. */
export const pageField = (c: {
  page?: number;
  pageEnd?: number;
}): ['page' | 'pages', string] | undefined =>
  c.page === undefined
    ? undefined
    : c.pageEnd !== undefined && c.pageEnd > c.page
      ? ['pages', `${c.page}-${c.pageEnd}`]
      : ['page', String(c.page)];

const pageLine = (c: Numberable) => {
  const page = pageField(c);
  return page ? `--- ${page[0]}=${page[1]} ---\n` : '';
};

const pageAttribute = (c: Numberable) => {
  const page = pageField(c);
  return page ? { [page[0]]: page[1] } : {};
};

export const documentKey = (c: { chunkId: string; document?: string; url?: string }) =>
  c.document || c.url || c.chunkId;

export const numberByDocument = <C extends Numberable>(docs: C[]) => {
  const groups = new Map<string, C[]>();
  for (const d of docs) groups.set(documentKey(d), [...(groups.get(documentKey(d)) ?? []), d]);
  const ordered = [...groups.values()];
  return {
    context: ordered
      .map((g, i) => {
        const first = g[0] as C;
        const text = g.map((c) => pageLine(c) + stripPageMarkers(c.content)).join('\n\n');
        return `[${i + 1}] ${untrustedData('source', text, { id: documentKey(first), title: first.title, publisher: first.publisher })}`;
      })
      .join('\n\n'),
    index: new Map(ordered.map((g, i) => [i + 1, (g[0] as C).chunkId])) as CitationIndex,
    chunks: ordered.flat(),
  };
};

export const numberByExcerpt = <C extends Numberable>(docs: C[]) => {
  const groups = new Map<string, C[]>();
  for (const d of docs) groups.set(documentKey(d), [...(groups.get(documentKey(d)) ?? []), d]);
  const ordered = [...groups.values()].flat();
  return {
    context: ordered
      .map(
        (c, i) =>
          `[${i + 1}] ${untrustedData('source', numberSentences(excerptText(c.content)), { id: documentKey(c), title: c.title, publisher: c.publisher, ...pageAttribute(c) })}`,
      )
      .join('\n\n'),
    index: new Map(ordered.map((c, i) => [i + 1, c.chunkId])) as CitationIndex,
    chunks: ordered,
  };
};

export type CitationQuotes = Map<number, TextQuote>;

export interface ResolvedSentences {
  text: string;
  index: CitationIndex;
  quotes: CitationQuotes;
  located: number;
  missed: number;
}

const excerptMarker = /( ?)\[(\d{1,3})(?::([^\]\n]{0,40}))?\]/g;
const copiedSentenceMark = /⟨\d{1,3}⟩ ?/g;
const sentenceMarker = /\[\d{1,3}:[^\]\n]{0,40}\]/;
const sentenceRange = /^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/;

/** The excerpt's text as «Kilder» shows it, which sentence ids and quotes refer to. */
export const excerptText = (content: string) => stripPageMarkers(content).trim();

/** `[N:a]`, `[N:a-b]` and `[N:a, c]` become one plain `[M]` per cited place, each with its quote. */
export const resolveSentenceMarkers = (
  text: string,
  index: CitationIndex,
  textOf: (chunkId: string) => string | undefined,
): ResolvedSentences => {
  const cleaned = text.replace(copiedSentenceMark, '');
  if (!sentenceMarker.test(cleaned))
    return { text: cleaned, index, quotes: new Map(), located: 0, missed: 0 };
  const numbers = new Map<string, number>();
  const next: CitationIndex = new Map();
  const quotes: CitationQuotes = new Map();
  const located = new Set<string>();
  const missed = new Set<string>();
  const markerOf = (key: string, chunkId: string, quote?: TextQuote) => {
    let marker = numbers.get(key);
    if (marker === undefined) {
      marker = numbers.size + 1;
      numbers.set(key, marker);
      next.set(marker, chunkId);
      if (quote) quotes.set(marker, quote);
    }
    return `[${marker}]`;
  };
  const rewritten = cleaned.replace(
    excerptMarker,
    (_whole, space: string, n: string, ids?: string) => {
      const chunkId = index.get(Number(n));
      // A marker that leads to no excerpt goes, so it never takes a cited place's number.
      if (chunkId === undefined) return '';
      if (ids === undefined) return space + markerOf(n, chunkId);
      const body = textOf(chunkId);
      const marks = ids.split(',').map((part) => {
        const range = sentenceRange.exec(part.trim());
        const quote =
          range && body !== undefined
            ? quoteOf(body, Number(range[1]), Number(range[2] ?? range[1]))
            : undefined;
        const place = `${n}:${range ? `${range[1]}-${range[2] ?? range[1]}` : part.trim()}`;
        if (!quote) {
          missed.add(place);
          return markerOf(n, chunkId);
        }
        located.add(place);
        return markerOf(place, chunkId, quote);
      });
      return space + [...new Set(marks)].join('');
    },
  );
  return { text: rewritten, index: next, quotes, located: located.size, missed: missed.size };
};

const streamedSentenceId = /\[(\d{1,3}):[^\]\n]{0,40}\]/g;

// A start that may still become `[N:…]` or `⟨N⟩`, as long as the parser reads one.
const mayBecomeSentenceId = /^(?:\[\d{0,3}(?::[^\]\n]{0,40})?|⟨\d{0,3})$/;

export const withoutSentenceIds = (text: string) =>
  text.replace(streamedSentenceId, '[$1]').replace(copiedSentenceMark, '');

/** Keeps sentence ids out of a streamed answer, holding back a bracket that may still become one. */
export const sentenceIdFilter = (push: (text: string) => void) => {
  let held = '';
  return {
    push: (text: string) => {
      held += text;
      const open = Math.max(held.lastIndexOf('['), held.lastIndexOf('⟨'));
      const waits = open >= 0 && mayBecomeSentenceId.test(held.slice(open));
      const cut = waits ? open : held.length;
      const out = withoutSentenceIds(held.slice(0, cut));
      held = held.slice(cut);
      if (out) push(out);
    },
    end: () => {
      if (held) push(withoutSentenceIds(held));
      held = '';
    },
  };
};

/** Text as written, for a service that cites documents: no sentence ids are read. */
export const unlocated = (text: string, index: CitationIndex): ResolvedSentences => ({
  text,
  index,
  quotes: new Map(),
  located: 0,
  missed: 0,
});

/** Resolves sentence ids against the excerpts that were numbered for the model. */
export const locateSentences = (
  text: string,
  index: CitationIndex,
  chunks: { chunkId: string; content: string }[],
) => {
  const byId = new Map(chunks.map((c) => [c.chunkId, c.content]));
  return resolveSentenceMarkers(text, index, (id) => {
    const content = byId.get(id);
    return content === undefined ? undefined : excerptText(content);
  });
};

const unknownMarker = / ?\[(\d{1,3})\]/g;

export const dropUnknownMarkers = (text: string, index: CitationIndex) =>
  text.replace(unknownMarker, (whole, n: string) => (index.has(Number(n)) ? whole : ''));

/** Renumbers markers by document position in the published sources and drops the rest. */
export const numberByPublished = <C extends { chunkId: string; document?: string; url?: string }>(
  text: string,
  citations: Citation[],
  published: C[],
  chunkOf: (chunkId: string) => C | undefined,
): { text: string; citations: Citation[]; index: CitationIndex } => {
  const position = new Map<string, number>();
  const first = new Map<number, string>();
  for (const c of published) {
    const key = documentKey(c);
    if (position.has(key)) continue;
    position.set(key, position.size + 1);
    first.set(position.size, c.chunkId);
  }
  const oldToNew = new Map<number, number>();
  for (const c of citations) {
    const n = position.get(documentKey(chunkOf(c.chunkId) ?? c));
    if (n !== undefined) oldToNew.set(c.index, n);
  }
  const renumbered = text.replace(unknownMarker, (whole, n: string) => {
    const next = oldToNew.get(Number(n));
    return next === undefined ? '' : whole.replace(/\[\d+\]/, `[${next}]`);
  });
  const index: CitationIndex = new Map(
    [...new Set(oldToNew.values())].map((n) => [n, first.get(n) as string]),
  );
  return { text: renumbered, citations: parseCitations(renumbered, index), index };
};

export const sourcesFirst = <C extends { chunkId: string }>(first: C[], rest: C[]): C[] => {
  const ids = new Set(first.map((c) => c.chunkId));
  return [...first, ...rest.filter((c) => !ids.has(c.chunkId))];
};

// The pages a source list may give after a source, as citations write them: `s. 4`,
// `s. 61 – 62`, `s. 5, 34 og 42`.
const listPages = String.raw`s\. ?\d+(?: ?[-–] ?\d+)?(?:(?:, | og )\d+(?: ?[-–] ?\d+)?)*`;
const sourceListLine = new RegExp(
  String.raw`^[#>-]* ?(kilder|kilde|kjelder|kjelde|sources?|references?) ?:? ?(\[\d+(?:,? ${listPages})?\](?: ${listPages})? ?(?:(?:[-–,.;]|og|and) ?)?)+$`,
  'iu',
);

const isSourceListLine = (line: string) =>
  sourceListLine.test(line.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim());

export const stripSourceLists = (text: string): string => {
  const lines = text.split('\n');
  const kept = lines.filter((line) => !isSourceListLine(line));
  return kept.length === lines.length ? text : kept.join('\n').trimEnd();
};

const listWords = ['kilder', 'kjelder', 'sources', 'references'];

const mayBecomeSourceList = (line: string) => {
  const head = line.replace(/^\s*[*#_>-]*\s*/, '').toLowerCase();
  return listWords.some((w) => {
    const n = Math.min(head.length, w.length - 1);
    return w.slice(0, n) === head.slice(0, n);
  });
};

export const sourceListFilter = (push: (text: string) => void) => {
  let held = '';
  return {
    push: (text: string) => {
      held += text;
      let out = '';
      let newline = held.indexOf('\n');
      while (newline >= 0) {
        const line = held.slice(0, newline);
        if (!sourceListLine.test(line)) out += `${line}\n`;
        held = held.slice(newline + 1);
        newline = held.indexOf('\n');
      }
      if (held && !mayBecomeSourceList(held)) {
        out += held;
        held = '';
      }
      if (out) push(out);
    },
    end: () => {
      if (held && !sourceListLine.test(held)) push(held);
      held = '';
    },
  };
};

const bracketed = /\[([^\]\n]{1,400})\]|\(([^)\n]{1,400})\)/g;

export const chunkIdsToMarkers = <C extends { chunkId: string; document?: string; url?: string }>(
  text: string,
  known: C[],
  citeBy: CiteBy = 'document',
): { text: string; index: CitationIndex; chunks: C[] } | undefined => {
  const byId = new Map(known.map((c) => [c.chunkId, c]));
  const numbers = new Map<string, number>();
  const index: CitationIndex = new Map();
  const chunks: C[] = [];
  const rewritten = text.replace(bracketed, (whole, square?: string, round?: string) => {
    const ids = (square ?? round ?? '')
      .split(/[,;]\s*|\s+og\s+|\s+and\s+/)
      .map((s) => s.trim().replace(/^chunk_id\s*[=:]\s*/i, ''));
    if (ids.length === 0 || !ids.every((id) => byId.has(id))) return whole;
    const marks = new Set<number>();
    for (const id of ids) {
      const chunk = byId.get(id) as C;
      const key = citeBy === 'excerpt' ? chunk.chunkId : documentKey(chunk);
      let n = numbers.get(key);
      if (n === undefined) {
        n = numbers.size + 1;
        numbers.set(key, n);
        index.set(n, chunk.chunkId);
        chunks.push(chunk);
      }
      marks.add(n);
    }
    return [...marks].map((n) => `[${n}]`).join('');
  });
  return index.size > 0 ? { text: rewritten, index, chunks } : undefined;
};
