import { normaliseCitationMarkers, untrustedData } from '@genai/port-model';
import { z } from 'zod';
import {
  detectInsufficientContext,
  numberByDocument,
  locateSentences,
  numberByExcerpt,
  unlocated,
  withoutSentenceIds,
  pageField,
  type CiteBy,
  parseCitations,
  sourcesFirst,
  stripSourceLists,
  validateCitations,
} from './citations.js';
import { inferQueryIntent, plannedQueryBatch } from './intent.js';
import {
  ambiguityInstruction,
  citationInstruction,
  defaultGenerationPrompt,
  excerptCitationInstruction,
  sameLanguageRule,
} from './prompts.js';
import { buildEvidencePlan } from './read-signals.js';
import { json } from './structured.js';
import { skillsSection } from './skills.js';
import {
  defaultSearchDisplayLimit,
  expandShortDocReads,
  nextReadSuggestions,
  planRangeRead,
  rangeCutNote,
  readPositions,
  readBudgetNote,
  selectChunkIdsWithinBudget,
  maxAround,
  maxAroundChars,
  partReadKinds,
  trimChunksToBudget,
  type AgentRetrieval,
  type BudgetState,
  type Chunk,
  type ChunkSummary,
  type ConversationTurn,
  type FilterField,
  type PartReadKind,
  type PartsAround,
  type ReadSource,
  type SearchAttribution,
  type SearchDetection,
  type SearchType,
  type Workspace,
} from './workspace.js';

/** Writes a draft; undefined when the model refused to write one. */
export type Synthesize = (systemPrompt: string, userPrompt: string) => Promise<string | undefined>;

export interface SearchSettings {
  titleOverlapWeight: number;
  strategyQuota: number;
  autoReadTopK: number;
  displayLimit: number;
  showSnippets: boolean;
}

export const defaultSearchSettings: SearchSettings = {
  titleOverlapWeight: 0,
  strategyQuota: 0,
  autoReadTopK: 0,
  displayLimit: defaultSearchDisplayLimit,
  showSnippets: false,
};

export interface ToolEnvironment {
  workspace: Workspace;
  retrieval: AgentRetrieval;
  synthesize: Synthesize;
  query: string;
  history: ConversationTurn[];
  signal: AbortSignal;
  systemPrompt: string;
  generationPrompt?: string;
  citeBy?: CiteBy;
  search?: SearchSettings;
}

export interface RetrievalHit {
  id: string;
  document?: string;
  position?: number;
  page?: number;
  /** The last page of a chunk that runs over several. */
  pageEnd?: number;
  score?: number;
  title?: string;
}

export interface ReadRequest {
  chunkIds?: string[];
  document?: string;
  chunkRange?: { from?: number | undefined; to?: number | undefined };
}

export type SearchFailureReason =
  'timeout' | 'query-too-long' | 'text-unavailable' | 'vector-unavailable' | 'error';

export interface SearchFailure {
  strategy: string;
  reason: SearchFailureReason;
}

export interface SearchMade {
  queries: string[];
  page?: number;
  filters?: FilterField[];
  fellBack?: boolean;
  detections?: SearchDetection[];
  failed?: SearchFailure[];
  /** The whole search threw, so no strategy found anything. */
  failedCompletely?: SearchFailureReason;
}

const searchSeparator = ' search: ';

/** `<strategy> search: <message>`, but not the pipeline's `skipped <x> search: …` notices. */
const failedStrategy = (warning: string) => {
  if (warning.startsWith('skipped ')) return undefined;
  const at = warning.indexOf(searchSeparator);
  const message = warning.slice(at + searchSeparator.length);
  return at > 0 && message ? { strategy: warning.slice(0, at), message } : undefined;
};

const timedOut = /statement timeout|took longer than|timed out/i;

const failureReasons: [RegExp, SearchFailureReason][] = [
  [/^text search (?:took longer|failed)/, 'text-unavailable'],
  [/^vector search (?:is unavailable|failed)|^no query vector/, 'vector-unavailable'],
  [timedOut, 'timeout'],
  [/^the query is too long/, 'query-too-long'],
];

/** Failed strategies with the kind of failure only, never the engine's own message. */
export const searchFailures = (attribution: SearchAttribution | undefined): SearchFailure[] => {
  const seen = new Set<string>();
  return (attribution?.warnings ?? []).flatMap((warning) => {
    const failed = failedStrategy(warning);
    if (!failed) return [];
    const { strategy, message } = failed;
    const reason = failureReasons.find(([p]) => p.test(message))?.[1] ?? 'error';
    const key = `${strategy}:${reason}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ strategy, reason }];
  });
};

const failureText: Record<SearchFailureReason, string> = {
  timeout: 'timed out',
  'query-too-long': 'refused a query as too long',
  'text-unavailable': 'could not search by words, only by meaning',
  'vector-unavailable': 'could not search by meaning',
  error: 'failed',
};

/** Why a whole search threw, as a reason: never the engine's message. */
const thrownReason = (error: unknown): SearchFailureReason =>
  (error as { code?: unknown } | undefined)?.code === 'timeout' ||
  timedOut.test(error instanceof Error ? error.message : String(error))
    ? 'timeout'
    : 'error';

const searchWarning = (failed: SearchFailure[], hits = true): string =>
  failed.length
    ? `\nSearch warning: ${failed.map((f) => `${f.strategy} search ${failureText[f.reason]}`).join('; ')}.${hits ? ' These hits come only from the searches that worked and may miss the answer: search with other words, or say that search is failing.' : ''}`
    : '';

export interface ToolOutcome {
  content: string;
  generated?: string;
  retrieved?: RetrievalHit[];
  search?: SearchMade;
  read?: { chunks: RetrievalHit[]; auto?: boolean; request?: ReadRequest };
  planned?: { queries: string[]; userIntent?: string };
  /** The engine's message when the whole search threw: for the audit log only, never the model. */
  searchError?: string;
}

export const retrievalHits = (chunks: ChunkSummary[]): RetrievalHit[] =>
  chunks.map((c) => ({
    id: c.chunkId,
    ...(c.document === undefined ? {} : { document: c.document }),
    ...(c.position === undefined ? {} : { position: c.position }),
    ...(c.page === undefined ? {} : { page: c.page }),
    ...(c.pageEnd === undefined ? {} : { pageEnd: c.pageEnd }),
    ...(c.score === undefined ? {} : { score: c.score }),
    ...(c.title === undefined ? {} : { title: c.title }),
  }));

const searchArgs = z.object({
  queries: z.array(z.string()).min(1),
  page: z.coerce.number().int().min(1).max(1000).optional(),
  filter_by: z
    .object({
      fields: z.array(
        z.object({
          field: z.string().min(1),
          selected_options: z.array(z.union([z.string(), z.number()])),
          value_type: z.enum(['string', 'integer']).optional(),
        }),
      ),
    })
    .optional(),
});

const readArgs = z.object({
  chunk_ids: z.array(z.string()).optional(),
  doc_num: z.union([z.string(), z.number()]).optional(),
  chunk_range: z
    .object({ from: z.number().int().optional(), to: z.number().int().optional() })
    .optional(),
  max_content_length: z.number().int().optional(),
  around: z
    .object({
      chunk_id: z.string().min(1),
      read: z.enum(partReadKinds).optional(),
      n: z.number().int().min(0).max(maxAround).optional(),
    })
    .optional(),
});

const queryArgs = z.object({ query: z.string() });

const inspectArgs = z.object({
  fields: z.array(z.string()).optional(),
  max_options: z.number().int().positive().optional(),
});

const unsafeFilterValue = (value: string) =>
  [...value].some(
    (c) => c === '`' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  );

export const filterErrors = (fields: FilterField[]): string[] => {
  const errors: string[] = [];
  if (fields.length > 20) errors.push('At most 20 filter fields are allowed.');
  for (const f of fields) {
    if (f.selectedOptions.length > 100) errors.push(`Too many options for ${f.field}.`);
    if (unsafeFilterValue(f.field) || f.selectedOptions.some(unsafeFilterValue))
      errors.push(`Filter ${f.field} contains characters that are not allowed.`);
  }
  return errors;
};

export const queryTokens = (query: string): Set<string> =>
  new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= 3),
  );

export const titleOverlapBonus = (tokens: Set<string>, c: ChunkSummary): number => {
  if (tokens.size === 0) return 0;
  const haystack = new Set(
    `${c.title ?? ''} ${c.url ?? ''} ${(c.headers ?? []).join(' ')}`.toLowerCase().match(/\w+/g) ??
      [],
  );
  return [...tokens].filter((t) => haystack.has(t)).length;
};

export const rescoreWithTitleBonus = (
  chunks: ChunkSummary[],
  query: string,
  weight: number,
): (ChunkSummary & { titleOverlapBonus?: number })[] => {
  if (!(weight > 0) || chunks.length === 0 || query.trim() === '') return chunks;
  const tokens = queryTokens(query);
  return chunks
    .map((c, i) => {
      const bonus = titleOverlapBonus(tokens, c);
      return {
        c: { ...c, titleOverlapBonus: bonus },
        i,
        key: (c.rerankScore ?? c.score ?? 0) + weight * bonus,
      };
    })
    .sort((a, b) => b.key - a.key || a.i - b.i)
    .map((x) => x.c);
};

const strategies: SearchType[] = ['phrase', 'metadata', 'content'];

export const enforceStrategyQuota = <T extends ChunkSummary>(chunks: T[], quota: number): T[] => {
  if (!(quota > 0) || chunks.length === 0) return chunks;
  const perStrategy = new Map(
    strategies.map((s) => [s, chunks.filter((c) => c.searchTypes?.includes(s)).slice(0, quota)]),
  );
  const interleaved: T[] = [];
  for (let i = 0; i < quota; i += 1) {
    for (const s of strategies) {
      const c = perStrategy.get(s)?.[i];
      if (c) interleaved.push(c);
    }
  }
  const seen = new Set<string>();
  const ordered = interleaved.filter((c) =>
    seen.has(c.chunkId) ? false : (seen.add(c.chunkId), true),
  );
  return [...ordered, ...chunks.filter((c) => !seen.has(c.chunkId))];
};

const fixed = (n: number, digits: number) => n.toFixed(digits);

const pageText = (c: ChunkSummary) => {
  const page = pageField(c);
  return page ? ` ${page[0]}=${page[1]}` : '';
};

/** Whose document a chunk is, so same-title documents such as each ministry's Prop. 1 S tell apart (issue 754). */
const publisherText = (c: ChunkSummary) =>
  c.publisher ? ` publisher=${JSON.stringify(c.publisher)}` : '';

const detectionHint = (d: SearchDetection) => {
  const names = d.values.map((v) => JSON.stringify(v)).join(', ');
  const them = d.values.length > 1 ? 'them' : 'it';
  const what =
    d.kind === 'year'
      ? `names the year${d.values.length > 1 ? 's' : ''} ${names}`
      : d.kind === 'organisation'
        ? `names ${names}`
        : `suggests ${d.field} ${names}`;
  return `The query ${what}; ${d.field} can filter on ${them}.`;
};

const ownDocumentHint = (hints: SearchDetection[]) => {
  const organisation = hints.find((d) => d.kind === 'organisation');
  return organisation
    ? ` For an organisation's own documents, filter ${organisation.field} with ${organisation.values.map((v) => JSON.stringify(v)).join(' or ')}.`
    : '';
};

const searchHints = (attribution: SearchAttribution | undefined): string => {
  const hints = (attribution?.detections ?? []).filter((d) => d.use === 'hint');
  return hints.length
    ? `\nHint, no filter applied: ${hints.map(detectionHint).join(' ')} Use filter_by when the question is only about these; search without it when the question also needs other documents.${ownDocumentHint(hints)}`
    : '';
};

export interface SearchPage {
  pass: number;
  newCount: number;
  totalSeen: number;
  page?: number;
  displayLimit?: number;
  showSnippets?: boolean;
  filters?: FilterField[];
}

const hitsShownPerDocument = 3;

const publishedText = (publishedAt: string | undefined) => {
  if (!publishedAt) return '';
  const day = /^\d{4}-\d{2}-\d{2}/.exec(publishedAt)?.[0];
  return ` published=${day ?? JSON.stringify(publishedAt)}`;
};

export const groupByDocument = <T extends { chunkId: string; document?: string }>(
  chunks: T[],
): T[][] => {
  const groups = new Map<string, T[]>();
  for (const c of chunks) {
    const key = c.document ?? c.chunkId;
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.values()];
};

export const shownOnPage = <T extends { chunkId: string; document?: string }>(
  hits: T[],
  displayLimit: number,
  page = 1,
): T[] => {
  const offset = Number.isFinite(displayLimit) ? (Math.max(1, page) - 1) * displayLimit : 0;
  return groupByDocument(hits)
    .slice(offset, offset + displayLimit)
    .flatMap((group) => group.slice(0, hitsShownPerDocument));
};

const filterClause = (field: string, options: string[], type?: string) =>
  `${field} ${type === 'not-in-set' ? 'is none of' : 'is one of'} ${options.join(', ')}`;

export const activeFiltersText = (
  attribution: SearchAttribution | undefined,
  filters: FilterField[] | undefined,
): string => {
  const caller = (attribution?.callerFilter ?? []).map((f) =>
    filterClause(f.field, f['selected-options'], f.type),
  );
  const own = (filters ?? []).map((f) => filterClause(f.field, f.selectedOptions));
  const auto =
    attribution?.autoFilter && !attribution.autoFilterFallback ? [attribution.autoFilter] : [];
  const parts = [
    ...(caller.length ? [`set by the service or caller: ${caller.join('; ')}`] : []),
    ...(own.length ? [`set by your filter_by: ${own.join('; ')}`] : []),
    ...auto.map((f) => `added from the query: ${filterClause(f.field, f.options)}`),
  ];
  return `Filters: ${parts.length ? parts.join('. ') : 'none'}.`;
};

const hitLine = (c: ChunkSummary & { titleOverlapBonus?: number }, showSnippets: boolean) => {
  const matched = (c.matchedQuestions ?? []).filter((q) => q.trim() !== '').slice(0, 2);
  return (
    `   chunk_id=${c.chunkId} chunk_index=${c.position ?? ''}/${c.totalChunks ?? '?'}` +
    pageText(c) +
    (c.contentLength === undefined ? '' : ` content_length=${c.contentLength}`) +
    (c.headers?.length ? ` headers=${JSON.stringify(c.headers)}` : '') +
    (c.rerankScore === undefined ? '' : ` rerank=${fixed(c.rerankScore, 2)}`) +
    (c.score === undefined ? '' : ` score=${fixed(c.score, 3)}`) +
    (c.rank === undefined ? '' : ` rank=${c.rank}`) +
    (c.titleOverlapBonus ? ` title_match=${c.titleOverlapBonus}` : '') +
    (matched.length ? ` matched_q=${matched.map((q) => JSON.stringify(q)).join(' | ')}` : '') +
    (showSnippets && c.snippet && c.snippet.trim() !== ''
      ? ` snippet=${JSON.stringify(c.snippet)}`
      : '')
  );
};

const documentBlock = (
  hits: (ChunkSummary & { titleOverlapBonus?: number })[],
  n: number,
  showSnippets: boolean,
) => {
  const first = hits[0] as ChunkSummary;
  const shown = hits.slice(0, hitsShownPerDocument);
  const more = hits.length - shown.length;
  return [
    `${n}. doc_num=${first.document ?? ''}` +
      (first.title ? ` title="${first.title}"` : '') +
      publisherText(first) +
      publishedText(first.publishedAt) +
      (first.url ? ` url=${first.url}` : '') +
      ` hits=${hits.length}`,
    ...shown.map((c) => hitLine(c, showSnippets)),
    ...(more > 0
      ? [
          `   ${more} more hit${more === 1 ? '' : 's'} in this document: read it by doc_num and chunk_range`,
        ]
      : []),
  ].join('\n');
};

export const formatSearchMetadataResults = (
  chunks: (ChunkSummary & { titleOverlapBonus?: number })[],
  attribution: SearchAttribution | undefined,
  view: SearchPage,
): string => {
  const limit = view.displayLimit ?? defaultSearchDisplayLimit;
  const documents = groupByDocument(chunks);
  const pages = Math.max(1, Math.ceil(documents.length / limit));
  const page = Math.max(1, view.page ?? 1);
  const offset = (page - 1) * limit;
  const shown = documents.slice(offset, offset + limit);
  const more = offset + shown.length < documents.length;
  const window =
    documents.length === 0
      ? ''
      : shown.length === 0
        ? ` Page ${page} is past the last page: this search has ${pages} page${pages === 1 ? '' : 's'} of ${limit} documents.`
        : ` Showing documents ${offset + 1} to ${offset + shown.length} of ${documents.length}${
            more
              ? `; more available: search again with the same queries and filter_by and page=${page + 1}`
              : '; that is all this search found'
          }.`;
  const af = attribution?.autoFilter;
  return (
    `Search pass ${view.pass}: found ${chunks.length} hits in ${documents.length} documents (${view.newCount} new hits). ${view.totalSeen} hits seen in all searches.` +
    window +
    ' Search returns only the best-matching passages, so the collection may hold more documents that match than these: narrow the search with filter_by or other words to reach them.' +
    `\n${activeFiltersText(attribution, view.filters)}` +
    (af && attribution?.autoFilterFallback
      ? ` A filter on ${af.field} from the query found nothing, so the search ran without it.`
      : '') +
    (attribution?.rerankError
      ? ` Rerank failed (${attribution.rerankError}), original ranking preserved.`
      : attribution?.rerankEnabled
        ? ` Ranking: semantic rerank${attribution.rerankMs === undefined ? '' : ` (${attribution.rerankMs}ms)`}. Higher rerank= means more semantically relevant to the query.`
        : '') +
    searchHints(attribution) +
    searchWarning(searchFailures(attribution)) +
    (shown.length
      ? `\n${untrustedData('search-results', shown.map((hits, i) => documentBlock(hits, offset + i + 1, view.showSnippets ?? false)).join('\n'))}`
      : '')
  );
};

export const formatReadResult = (
  chunks: Chunk[],
  charsThisCall: number,
  cumulative: number,
  budgetNote?: string,
  skippedNote?: string,
): string => {
  const blocks = chunks.map(
    (c) =>
      `--- chunk_id=${c.chunkId} doc_num=${c.document ?? ''} chunk_index=${c.position ?? ''}` +
      pageText(c) +
      (c.title ? ` title="${c.title}"` : '') +
      publisherText(c) +
      (c.url ? ` url=${c.url}` : '') +
      ` ---\n${c.content}`,
  );
  return (
    `Read ${chunks.length} chunks (${charsThisCall} chars this call, ${cumulative} cumulative):` +
    (blocks.length ? `\n\n${untrustedData('documents', blocks.join('\n\n'))}` : '') +
    (skippedNote ? `\n\n${skippedNote}` : '') +
    (budgetNote ? `\n\n${budgetNote}` : '')
  );
};

export const skippedNonSupportingReadNote = (ids: string[]): string | undefined =>
  ids.length
    ? `Skipped ${ids.length} previously non-supporting chunk${ids.length === 1 ? '' : 's'} for this query: [${ids.map((id) => JSON.stringify(id)).join(' ')}]. These chunks were already read and did not add support for the current question. Prefer unread chunks or start a more targeted search instead of rereading them.`
    : undefined;

export const searchBudgetExhaustedMessage = (b: BudgetState) =>
  `Search budget exhausted (${b.searchesUsed}/${b.maxSearches}). Do not call search again; rerank or generate from current evidence.`;

export const readBudgetExhaustedMessage = (b: BudgetState) =>
  `Read budget exhausted (${b.readsUsed}/${b.maxReads} read operations, ${b.readCharsUsed}/${b.maxReadChars} chars). Do not call read_chunks again; rerank or generate from already-read evidence.`;

export const readBudgetTooSmallMessage = (b: BudgetState) =>
  `Read budget exhausted for the requested read. Remaining budget (${b.readCharsRemaining}/${b.maxReadChars} chars) is too small for the requested read. Do not repeat the same read. If you already have evidence, use rerank_results or generate_response now; otherwise start a more targeted search. Only try read_chunks again if you can make a strictly narrower request that fits.`;

export const readGuidance = (
  workspace: Workspace,
  tool: 'rerank_results' | 'generate_response',
): string => {
  const { unreadCount, chunkIds, range } = nextReadSuggestions(workspace);
  const b = workspace.budget();
  const action = tool === 'rerank_results' ? 'rerank' : 'generate a response';
  const rangeJson = range
    ? json({ doc_num: range.document, chunk_range: range.chunkRange })
    : undefined;
  if (b.readsExhausted || b.readCharsExhausted)
    return `You only have search metadata right now, not readable content, but read budget is exhausted (${b.readsUsed}/${b.maxReads} read operations, ${b.readCharsUsed}/${b.maxReadChars} chars). Do not call read_chunks again. Work with already-read evidence, rerank it, or answer with explicit uncertainty.`;
  if (workspace.reads.length > 0) {
    const n = workspace.reads.length;
    return (
      `You called read_chunks ${n} time${n === 1 ? '' : 's'} but the workspace has no chunks to ${action}. Likely causes: every requested chunk was suppressed as previously non-supporting, dropped by the read-content budget, or otherwise filtered before content was stored. Read budget remaining: ${b.readCharsRemaining}/${b.maxReadChars} chars, ${b.readsRemaining}/${b.maxReads} read operations. Do NOT repeat the same read. Either start a more targeted search to surface different chunk_ids, or — if you have evidence in prior turns — answer with explicit uncertainty about what you couldn't retrieve.` +
      (chunkIds.length
        ? ` If unread hits remain, try fresh chunk_ids: read_chunks {"chunk_ids": ${json(chunkIds)}}.`
        : '') +
      (rangeJson ? ` Or expand local context with read_chunks ${rangeJson}.` : '')
    );
  }
  return (
    `You only have search metadata right now, not readable content. Use read_chunks before trying to ${action}. There are ${unreadCount} unread search hits from the latest search.` +
    (b.lowReadBudget
      ? ' Read budget is low, so prefer the most targeted chunk_ids instead of broad ranges.'
      : '') +
    (chunkIds.length ? ` Suggested next call: read_chunks {"chunk_ids": ${json(chunkIds)}}.` : '') +
    (rangeJson ? ` If you want adjacent context instead, try read_chunks ${rangeJson}` : '') +
    ' After reading content, call rerank_results or generate_response again.'
  );
};

const dedupe = (chunks: Chunk[]) => {
  const seen = new Set<string>();
  return chunks.filter((c) => (seen.has(c.chunkId) ? false : (seen.add(c.chunkId), true)));
};

const truncate = (chunk: Chunk, max?: number): Chunk =>
  max && chunk.content.length > max
    ? { ...chunk, content: `${chunk.content.slice(0, max)}\n[truncated]` }
    : chunk;

const ensureEvidencePlan = (env: ToolEnvironment) => {
  const { workspace } = env;
  workspace.evidencePlan ??= buildEvidencePlan(
    env.query,
    workspace.queryIntent ?? inferQueryIntent(env.query, env.history),
  );
};

const storeRead = (env: ToolEnvironment, source: ReadSource, chunks: Chunk[]) => {
  ensureEvidencePlan(env);
  env.workspace.recordRead(source, chunks);
  env.workspace.addChunks(chunks);
  env.workspace.queuePendingEval(chunks);
};

const autoReadTopK = async (
  env: ToolEnvironment,
  chunks: ChunkSummary[],
  k: number,
): Promise<Chunk[]> => {
  try {
    const budget = env.workspace.budget();
    if (!(k > 0) || budget.readsExhausted || budget.readCharsExhausted) return [];
    const already = new Set(env.workspace.reads.flatMap((r) => r.returnedChunkIds));
    const candidates = chunks
      .map((c) => c.chunkId)
      .filter((id) => !already.has(id))
      .slice(0, k);
    if (candidates.length === 0) return [];
    const raw = await env.retrieval.read(candidates, env.signal);
    const { kept } = trimChunksToBudget(raw, env.workspace.budget().readCharsRemaining);
    if (kept.length) {
      env.workspace.recordRead({ chunkIds: kept.map((c) => c.chunkId), autoRead: true }, kept);
      env.workspace.addChunks(kept);
      env.workspace.queuePendingEval(kept);
    }
    return kept;
  } catch (error) {
    if (env.signal.aborted) throw error;
    return [];
  }
};

/** Org-number filters that find nothing are kept, or a search returns others' documents as theirs. */
const keptWhenEmpty = new Set(['owner_orgnr', 'recipient_orgnr']);

const detectionsOf = (error: unknown): SearchDetection[] | undefined => {
  const detections = (error as { detections?: unknown } | null)?.detections;
  return Array.isArray(detections) && detections.length > 0
    ? (detections as SearchDetection[])
    : undefined;
};

/** A search that threw: the agent hears why, and the search step shows that every search failed. */
const thrown = (
  queries: string[],
  filters: FilterField[] | undefined,
  error: unknown,
  lead: string,
): ToolOutcome => {
  const reason = thrownReason(error);
  const detections = detectionsOf(error);
  return {
    content: `${lead}every search ${failureText[reason]}. Try again later, or say that search is failing.${searchHints(detections ? { detections } : undefined)}`,
    retrieved: [],
    search: {
      queries,
      ...(filters?.length ? { filters } : {}),
      ...(detections ? { detections } : {}),
      failedCompletely: reason,
    },
    searchError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
};

const searchKey = (queries: string[], filters: FilterField[] | undefined) =>
  JSON.stringify([queries, (filters ?? []).map((f) => [f.field, f.selectedOptions, f.valueType])]);

const search = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const { workspace, retrieval, signal } = env;
  const settings = env.search ?? defaultSearchSettings;
  const args = searchArgs.safeParse(raw);
  if (!args.success)
    return { content: 'Invalid search arguments: queries must be a non-empty list of strings.' };
  const filters: FilterField[] | undefined = args.data.filter_by?.fields.map((f) => ({
    field: f.field,
    selectedOptions: f.selected_options.map(String),
    ...(f.value_type ? { valueType: f.value_type } : {}),
  }));
  const page = args.data.page ?? 1;
  const key = searchKey(args.data.queries, filters);
  const previous = workspace.lastSearchWindow;
  if (page > 1 && previous?.key === key)
    return {
      content:
        previous.lead +
        formatSearchMetadataResults(previous.chunks, previous.attribution, {
          pass: workspace.searches.length,
          newCount: 0,
          totalSeen: workspace.seen.size,
          page,
          displayLimit: settings.displayLimit,
          showSnippets: settings.showSnippets,
          ...(previous.filters ? { filters: previous.filters } : {}),
        }) +
        '\nThis page of an earlier search did not use the search budget.',
    };
  const budget = workspace.budget();
  if (budget.searchExhausted) return { content: searchBudgetExhaustedMessage(budget) };
  const errors = filterErrors(filters ?? []);
  if (errors.length) return { content: `Invalid filter_by, search not run: ${errors.join(' ')}` };
  const options = workspace.lastUserIntent ? { userIntent: workspace.lastUserIntent } : {};
  let outcome;
  try {
    outcome = await retrieval.search(
      args.data.queries,
      { ...options, ...(filters?.length ? { filters } : {}) },
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return thrown(args.data.queries, filters, error, 'Search backend error: ');
  }
  const noted = [...(outcome.attribution?.warnings ?? [])];
  const kept = (filters ?? []).filter((f) => keptWhenEmpty.has(f.field));
  let narrowed = false;
  if (kept.length > 0 && kept.length < (filters?.length ?? 0) && outcome.chunks.length === 0) {
    try {
      outcome = await retrieval.search(args.data.queries, { ...options, filters: kept }, signal);
      noted.push(...(outcome.attribution?.warnings ?? []));
      narrowed = true;
    } catch (error) {
      if (signal.aborted) throw error;
      return thrown(
        args.data.queries,
        kept,
        error,
        'Filtered retrieval returned 0 chunks; retry with only the org-number filter failed: ',
      );
    }
  }
  if (kept.length > 0 && outcome.chunks.length === 0) {
    const failed = searchFailures({ warnings: noted });
    workspace.recordSearch(args.data.queries, [], false, { filters: kept });
    const named = kept.map((f) => `${f.field} ${f.selectedOptions.join(', ')}`).join(' and ');
    return {
      content: failed.length
        ? `Search found 0 chunks with ${named}, but part of the search failed, so this does not show that these organisations have no such documents.${searchWarning(failed, false)}`
        : `Search found 0 chunks with ${named}${narrowed ? ', even without the other filters' : ''}. The filter was kept: these organisations have no documents that match. Search again with other words, or say that their documents do not cover this.`,
      retrieved: [],
      search: { queries: args.data.queries, filters: kept, ...(failed.length ? { failed } : {}) },
    };
  }
  const searched = narrowed ? kept : filters;
  let fellBack = false;
  if (filters?.length && outcome.chunks.length === 0) {
    try {
      outcome = await retrieval.search(args.data.queries, options, signal);
      noted.push(...(outcome.attribution?.warnings ?? []));
      fellBack = true;
    } catch (error) {
      if (signal.aborted) throw error;
      return thrown(
        args.data.queries,
        searched,
        error,
        'Filtered retrieval returned 0 chunks; retry without filters failed: ',
      );
    }
  }
  const attribution = noted.length
    ? { ...outcome.attribution, warnings: noted }
    : outcome.attribution;
  const rescored = rescoreWithTitleBonus(
    outcome.chunks,
    args.data.queries[0] ?? '',
    settings.titleOverlapWeight,
  );
  const effective = enforceStrategyQuota(rescored, settings.strategyQuota);
  const fresh = workspace.recordSearch(args.data.queries, effective, fellBack, {
    ...(!fellBack && searched?.length ? { filters: searched } : {}),
    ...(attribution ? { attribution } : {}),
  });
  const autoRead = await autoReadTopK(env, effective, settings.autoReadTopK);
  const failed = searchFailures(attribution);
  const shownFilters = !fellBack && searched?.length ? searched : undefined;
  const summary = formatSearchMetadataResults(effective, attribution, {
    pass: workspace.searches.length,
    newCount: fresh,
    totalSeen: workspace.seen.size,
    page,
    displayLimit: settings.displayLimit,
    showSnippets: settings.showSnippets,
    ...(shownFilters ? { filters: shownFilters } : {}),
  });
  const lead = fellBack
    ? 'Filtered retrieval returned 0 chunks; retried without filters. '
    : narrowed
      ? `Filtered retrieval returned 0 chunks; retried with only ${kept.map((f) => f.field).join(' and ')}. `
      : '';
  workspace.lastSearchWindow = {
    key,
    chunks: effective,
    lead,
    ...(attribution ? { attribution } : {}),
    ...(shownFilters ? { filters: shownFilters } : {}),
  };
  return {
    content:
      lead +
      summary +
      (autoRead.length
        ? `\nAuto-read top ${autoRead.length} by rank into workspace: ${autoRead.map((c) => c.chunkId).join(', ')}. Do NOT re-read these via read_chunks.`
        : ''),
    retrieved: retrievalHits(effective),
    search: {
      queries: args.data.queries,
      ...(page > 1 ? { page } : {}),
      ...(!fellBack && searched?.length ? { filters: searched } : {}),
      ...(fellBack ? { fellBack } : {}),
      ...(outcome.attribution?.detections?.length
        ? { detections: outcome.attribution.detections }
        : {}),
      ...(failed.length ? { failed } : {}),
    },
    ...(autoRead.length ? { read: { chunks: retrievalHits(autoRead), auto: true } } : {}),
  };
};

/** The read's parts in order, each run headed by the page it starts on: its label, else its number. */
const aroundText = (read: PartsAround) => {
  const labels = new Map(read.units.map((u) => [u.unit, u.label]));
  const blocks: string[] = [];
  let page: number | undefined;
  for (const part of read.parts) {
    const unit = part.regions[0]?.unit;
    if (unit !== undefined && unit !== page) {
      page = unit;
      blocks.push(`--- page=${labels.get(unit) ?? unit} ---\n${part.text}`);
    } else blocks.push(part.text);
  }
  return blocks.join('\n\n');
};

/**
 * `read_chunks` with `around`: the parts before and after a hit, its section, or its pages, read
 * from the hit's file (ADR 0055). The read is stored as the hit's excerpt, so it can be cited.
 */
const readAround = async (
  env: ToolEnvironment,
  around: { chunk_id: string; read?: PartReadKind | undefined; n?: number | undefined },
  maxContentLength: number | undefined,
): Promise<ToolOutcome> => {
  const { workspace, retrieval, signal } = env;
  const budget = workspace.budget();
  if (!retrieval.readParts)
    return {
      content:
        'This collection cannot read around a hit. Read by chunk_ids, or by doc_num and chunk_range.',
    };
  const id = around.chunk_id;
  const kind = around.read ?? 'units';
  const n = around.n ?? 1;
  // Page headings take a little of the room the remaining read budget leaves.
  const chars = Math.min(
    maxAroundChars,
    maxContentLength ?? maxAroundChars,
    Math.floor(budget.readCharsRemaining * 0.9),
  );
  if (chars < 1) return { content: readBudgetTooSmallMessage(budget) };
  let hit: Chunk | undefined;
  let found: PartsAround;
  try {
    [hit] = await retrieval.read([id], signal);
    found = await retrieval.readParts(id, kind, n, chars, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      content: `Error executing read_chunks: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!hit || found.parts.length === 0)
    return {
      content: found?.cut
        ? readBudgetTooSmallMessage(budget)
        : `There is nothing to read around chunk ${JSON.stringify(id)}: its document is read by chunk, not by its parts, or it is gone. Read it by doc_num and chunk_range instead.`,
    };
  const units = found.parts.flatMap((p) => p.regions.map((r) => r.unit));
  const content = aroundText(found);
  const chunk: Chunk = {
    ...hit,
    content,
    contentLength: content.length,
    page: Math.min(...units),
    pageEnd: Math.max(...units),
  };
  const { kept, consumed } = trimChunksToBudget([chunk], budget.readCharsRemaining);
  if (kept.length === 0) return { content: readBudgetTooSmallMessage(budget) };
  storeRead(env, { chunkIds: [id] }, kept);
  const cutNote = found.cut
    ? `The ${kind} read around ${id} was cut at the read's limit of ${chars} characters, on a part boundary. Read again with a smaller n to see less, or by chunk_ids to see a later part.`
    : undefined;
  return {
    content: formatReadResult(kept, consumed, workspace.readCharsUsed, cutNote),
    read: { chunks: retrievalHits(kept), request: { chunkIds: [id] } },
  };
};

const read = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const { workspace, retrieval, signal } = env;
  const budget = workspace.budget();
  if (budget.readsExhausted || budget.readCharsExhausted)
    return { content: readBudgetExhaustedMessage(budget) };
  const args = readArgs.safeParse(raw);
  if (!args.success) return { content: 'Invalid read_chunks arguments.' };
  if (args.data.around)
    return readAround(
      env,
      args.data.around,
      args.data.max_content_length && args.data.max_content_length > 0
        ? args.data.max_content_length
        : undefined,
    );
  const { chunk_ids: chunkIds, chunk_range: chunkRange } = args.data;
  const maxContentLength =
    args.data.max_content_length && args.data.max_content_length > 0
      ? args.data.max_content_length
      : undefined;
  const docNum = args.data.doc_num === undefined ? undefined : String(args.data.doc_num);
  const remaining = budget.readCharsRemaining;

  let fetched: Chunk[] = [];
  let source: ReadSource = { chunkIds: [] };
  let prefetchSkipped = 0;
  let suppressed: string[] = [];
  let selectedIds: string[] | undefined;
  let rangeSelected = true;
  let rangePlan: ReturnType<typeof planRangeRead> | undefined;
  let alreadyRead = new Set<number>();
  try {
    if (chunkIds?.length) {
      suppressed = chunkIds.filter((id) => workspace.nonSupporting.has(id));
      const afterSuppression = chunkIds.filter((id) => !workspace.nonSupporting.has(id));
      const { selected, skipped } = selectChunkIdsWithinBudget(workspace, afterSuppression, budget);
      prefetchSkipped = skipped.length;
      const { chunkIdReads, docRangeReads } = expandShortDocReads(workspace, selected);
      const byId = chunkIdReads.length ? await retrieval.read(chunkIdReads, signal) : [];
      const ranges = (
        await Promise.all(
          docRangeReads.map((r) => retrieval.readRange(r.document, r.from, r.to, signal)),
        )
      ).flat();
      fetched = dedupe([...byId, ...ranges]);
      selectedIds = fetched.map((c) => c.chunkId);
      source = { chunkIds: selected };
    } else if (docNum !== undefined) {
      const plan = planRangeRead(workspace, docNum, chunkRange ?? { from: 0, to: 4 }, budget);
      prefetchSkipped = plan.prefetchSkippedCount;
      rangePlan = plan;
      alreadyRead = readPositions(workspace, docNum);
      rangeSelected = plan.selected !== undefined;
      if (plan.selected) {
        fetched = await retrieval.readRange(docNum, plan.selected.from, plan.selected.to, signal);
        source = {
          document: docNum,
          chunkRange: plan.selected,
          requestedRange: plan.requested,
          ...(chunkRange ? {} : { defaultRange: true }),
        };
      }
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      content: `Error executing read_chunks: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const shaped = fetched.map((c) => truncate(c, maxContentLength));
  const { kept, consumed, trimmed } = trimChunksToBudget(shaped, remaining);
  const skippedNote = skippedNonSupportingReadNote(suppressed);
  const cutNote =
    rangePlan && docNum !== undefined
      ? rangeCutNote({
          document: docNum,
          requested: rangePlan.requested,
          returned: kept,
          alreadyRead,
          cappedByCount: rangePlan.cappedByCount && trimmed === 0,
          narrowed:
            trimmed > 0 ||
            (rangePlan.selected !== undefined &&
              rangePlan.selected.to - rangePlan.selected.from <
                rangePlan.requested.to - rangePlan.requested.from),
          chunksPerRead: budget.chunksPerRead,
          remaining: Math.max(0, remaining - consumed),
          readsRemaining: Math.max(0, budget.readsRemaining - 1),
        })
      : undefined;
  const budgetNote =
    cutNote ??
    (rangePlan
      ? undefined
      : readBudgetNote({
          returned: kept.length,
          prefetchSkipped,
          postfetchTrimmed: trimmed,
          remaining,
        }));

  if (chunkIds?.length && selectedIds?.length === 0) {
    const survivors = chunkIds.length - suppressed.length;
    if (suppressed.length && survivors > 0)
      return { content: `${skippedNote}\n\n${readBudgetTooSmallMessage(budget)}` };
    if (suppressed.length) return { content: skippedNote as string };
    return { content: readBudgetTooSmallMessage(budget) };
  }
  if (docNum !== undefined && !chunkIds?.length && !rangeSelected)
    return {
      content:
        remaining === 0 ? readBudgetExhaustedMessage(budget) : readBudgetTooSmallMessage(budget),
    };
  if (shaped.length > 0 && kept.length === 0) return { content: readBudgetTooSmallMessage(budget) };

  storeRead(
    env,
    { ...source, ...(maxContentLength === undefined ? {} : { maxContentLength }) },
    kept,
  );
  return {
    content: formatReadResult(kept, consumed, workspace.readCharsUsed, budgetNote, skippedNote),
    read: {
      chunks: retrievalHits(kept),
      request: {
        ...(chunkIds?.length ? { chunkIds } : {}),
        ...(docNum === undefined ? {} : { document: docNum }),
        ...(chunkRange ? { chunkRange } : {}),
      },
    },
  };
};

const plan = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const args = queryArgs.safeParse(raw);
  if (!args.success) return { content: 'Invalid plan_queries arguments: query is required.' };
  env.workspace.queryIntent = inferQueryIntent(args.data.query, env.history);
  try {
    const planned = await env.retrieval.plan(args.data.query, env.history, env.signal);
    const queries = plannedQueryBatch(args.data.query, env.history, planned.queries);
    if (queries.length)
      env.workspace.queries = [...new Set([...env.workspace.queries, ...queries])];
    if (planned.userIntent) env.workspace.lastUserIntent = planned.userIntent;
    return {
      content: `Generated ${queries.length} queries: ${queries.map((q) => `"${q}"`).join(', ')}`,
      planned: { queries, ...(planned.userIntent ? { userIntent: planned.userIntent } : {}) },
    };
  } catch (error) {
    if (env.signal.aborted) throw error;
    return {
      content: `Error executing plan_queries: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const rerank = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const { workspace } = env;
  const args = queryArgs.safeParse(raw);
  if (!args.success) return { content: 'Invalid rerank_results arguments: query is required.' };
  const chunks = workspace.workspaceChunks();
  if (chunks.length === 0 && (workspace.searches.length || workspace.reads.length))
    return { content: readGuidance(workspace, 'rerank_results') };
  try {
    const truncatedIds = chunks
      .filter((c) => c.content.endsWith('\n[truncated]'))
      .map((c) => c.chunkId);
    if (truncatedIds.length) {
      for (const full of await env.retrieval.read(truncatedIds, env.signal)) {
        const known = workspace.chunks.get(full.chunkId);
        if (known) workspace.chunks.set(full.chunkId, { ...known, content: full.content });
      }
    }
    const reranked = await env.retrieval.rerank(
      args.data.query,
      workspace.workspaceChunks(),
      env.signal,
    );
    workspace.contextDocs = reranked;
    if (reranked.length === 0)
      return {
        content: 'No chunks in workspace to rerank. Use read_chunks first to load content.',
      };
    const top = reranked
      .slice(0, 3)
      .map((c, i) => `${i + 1}. ${c.content.slice(0, 80)}`)
      .join('; ');
    const done = env.retrieval.reranks
      ? `Reranked to top ${reranked.length} chunks.`
      : `No reranker: kept the search order of ${reranked.length} chunks.`;
    return { content: `${done} Top results:\n${untrustedData('excerpts', top)}` };
  } catch (error) {
    if (env.signal.aborted) throw error;
    return {
      content: `Error executing rerank_results: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export const generationPromptFor = (
  template: string,
  context: string,
  question: string,
  citeBy: CiteBy = 'document',
) =>
  `${template.replace('{context}', context).replace('{question}', question)}\n\n${ambiguityInstruction}\n\n${citeBy === 'excerpt' ? excerptCitationInstruction : citationInstruction}\n\n${sameLanguageRule}`;

const generate = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const { workspace } = env;
  const args = queryArgs.safeParse(raw);
  if (!args.success) return { content: 'Invalid generate_response arguments: query is required.' };
  const chunks = workspace.workspaceChunks();
  if (
    chunks.length === 0 &&
    workspace.attached.length === 0 &&
    (workspace.searches.length || workspace.reads.length)
  )
    return { content: readGuidance(workspace, 'generate_response') };
  const docs = sourcesFirst(
    workspace.attached,
    workspace.contextDocs.length ? workspace.contextDocs : workspace.chunksForSynthesis(),
  );
  const {
    context,
    index: numbered,
    chunks: ordered,
  } = env.citeBy === 'excerpt' ? numberByExcerpt(docs) : numberByDocument(docs);
  let index = numbered;
  let text: string;
  try {
    const written = await env.synthesize(
      env.systemPrompt + skillsSection([...workspace.loadedSkills.values()]),
      generationPromptFor(
        env.generationPrompt ?? defaultGenerationPrompt,
        context,
        args.data.query,
        env.citeBy,
      ),
    );
    // A refused draft leaves the earlier draft and its citations as they were.
    if (written === undefined) return { content: 'The model refused to write this draft.' };
    text = stripSourceLists(normaliseCitationMarkers(written, (n) => index.has(n)));
  } catch (error) {
    if (env.signal.aborted) throw error;
    return {
      content: `Error executing generate_response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const located =
    env.citeBy === 'excerpt' ? locateSentences(text, index, ordered) : unlocated(text, index);
  workspace.restream = located.text !== withoutSentenceIds(text);
  text = located.text;
  index = located.index;
  workspace.lastGeneratedResponse = text;
  workspace.citations = parseCitations(text, index);
  workspace.citationIndex = index;
  workspace.citationQuotes = located.quotes;
  workspace.sentenceIds = { located: located.located, missed: located.missed };
  workspace.quotedText = text;
  workspace.citationValidation = validateCitations(text, index);
  workspace.sourceOrder = ordered;
  for (const d of docs) if (!workspace.chunks.has(d.chunkId)) workspace.chunks.set(d.chunkId, d);
  return { content: text, generated: text };
};

const inspect = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const args = inspectArgs.safeParse(raw ?? {});
  if (!args.success) return { content: 'Invalid inspect_filters arguments.' };
  try {
    const available = await env.retrieval.filterFields(env.signal);
    const known = new Set(available.map((f) => f.field));
    const requested = [...new Set(args.data.fields ?? [])].filter((f) => known.has(f));
    const max = args.data.max_options ?? 10;
    const facets = requested.length
      ? await env.retrieval.facets(requested, max, env.signal)
      : undefined;
    const fieldLines = [...available]
      .sort((a, b) => a.field.localeCompare(b.field))
      .map((f) => `- ${f.field} (type: ${f.type}, filter-value-type: ${f.valueType})`)
      .join('\n');
    const facetLines = facets
      ? Object.entries(facets)
          .map(
            ([field, options]) =>
              `- ${field}: ${
                options.length
                  ? options
                      .slice(0, max)
                      .map((o) => `"${o.value}"(${o.count})`)
                      .join(', ')
                  : '(no options found)'
              }`,
          )
          .join('\n')
      : undefined;
    return {
      content: `Available filter fields:\n${fieldLines || '(none)'}${facetLines ? `\n\nTop facet options:\n${facetLines}` : ''}`,
    };
  } catch (error) {
    if (env.signal.aborted) throw error;
    return {
      content: `Error executing inspect_filters: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export const builtinToolNames = [
  'search',
  'read_chunks',
  'plan_queries',
  'rerank_results',
  'generate_response',
  'inspect_filters',
] as const;

export type BuiltinToolName = (typeof builtinToolNames)[number];

const handlers: Record<
  BuiltinToolName,
  (env: ToolEnvironment, args: unknown) => Promise<ToolOutcome>
> = {
  search,
  read_chunks: read,
  plan_queries: plan,
  rerank_results: rerank,
  generate_response: generate,
  inspect_filters: inspect,
};

export const isBuiltinTool = (name: string): name is BuiltinToolName =>
  (builtinToolNames as readonly string[]).includes(name);

export const runBuiltinTool = (name: BuiltinToolName, env: ToolEnvironment, args: unknown) =>
  handlers[name](env, args);

export const parseArguments = (
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: raw.trim() ? JSON.parse(raw) : {} };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
};

export const insufficientContextResponse = (text: string) =>
  detectInsufficientContext(text).insufficient;
