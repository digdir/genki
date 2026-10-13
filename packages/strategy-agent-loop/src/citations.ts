export interface Citation {
  index: number;
  chunkId: string;
}

export type CitationIndex = Map<number, string>;

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
      /(?<![\p{L}\p{N}])(ikke nok|utilstrekkelig|ingen)(?![\p{L}\p{N}])[\s\S]{0,80}(?<![\p{L}\p{N}])(informasjon|kontekst|kilder)(?![\p{L}\p{N}])/u,
  },
  {
    signal: 'kan-ikke-svare-fra-kilder',
    pattern:
      /(?<![\p{L}\p{N}])(kan ikke|klarer ikke|kunne ikke)(?![\p{L}\p{N}])[\s\S]{0,100}(?<![\p{L}\p{N}])(svare|finne)(?![\p{L}\p{N}])[\s\S]{0,120}(?<![\p{L}\p{N}])(informasjon|kontekst|kilder)(?![\p{L}\p{N}])/u,
  },
  {
    signal: 'finner-ikke-i-kildene',
    pattern:
      /(?<![\p{L}\p{N}])(jeg (har|finner) ikke)(?![\p{L}\p{N}])[\s\S]{0,120}(?<![\p{L}\p{N}])(informasjon|grunnlag|kilder)(?![\p{L}\p{N}])/u,
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
  content: string;
}

export const documentKey = (c: { chunkId: string; document?: string; url?: string }) =>
  c.document || c.url || c.chunkId;

export const numberByDocument = <C extends Numberable>(docs: C[]) => {
  const groups = new Map<string, C[]>();
  for (const d of docs) groups.set(documentKey(d), [...(groups.get(documentKey(d)) ?? []), d]);
  const ordered = [...groups.values()];
  return {
    context: ordered
      .map((g, i) => `[${i + 1}] ${g.map((c) => stripPageMarkers(c.content)).join('\n\n')}`)
      .join('\n\n'),
    index: new Map(ordered.map((g, i) => [i + 1, (g[0] as C).chunkId])) as CitationIndex,
    chunks: ordered.flat(),
  };
};

export const sourcesFirst = <C extends { chunkId: string }>(first: C[], rest: C[]): C[] => {
  const ids = new Set(first.map((c) => c.chunkId));
  return [...first, ...rest.filter((c) => !ids.has(c.chunkId))];
};

const sourceListLine =
  /^\s*[*#_>-]*\s*(kilder|kilde|kjelder|kjelde|sources?|references?)\s*[*_]*\s*:?\s*[*_]*\s*(\[\d+\]\s*(?:[-–,.;]|og|and)?\s*)+[*_]*\s*$/iu;

export const stripSourceLists = (text: string): string => {
  const lines = text.split('\n');
  const kept = lines.filter((line) => !sourceListLine.test(line));
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
      const key = documentKey(chunk);
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
