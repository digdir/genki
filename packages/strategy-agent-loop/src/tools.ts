import { z } from 'zod';
import {
  detectInsufficientContext,
  numberByDocument,
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
  sameLanguageRule,
  untrustedData,
} from './prompts.js';
import { buildEvidencePlan } from './read-signals.js';
import { json } from './structured.js';
import { skillsSection } from './skills.js';
import {
  defaultSearchDisplayLimit,
  expandShortDocReads,
  nextReadSuggestions,
  planRangeRead,
  readBudgetNote,
  selectChunkIdsWithinBudget,
  trimChunksToBudget,
  type AgentRetrieval,
  type BudgetState,
  type Chunk,
  type ChunkSummary,
  type ConversationTurn,
  type FilterField,
  type ReadSource,
  type SearchAttribution,
  type SearchType,
  type Workspace,
} from './workspace.js';

export type Synthesize = (systemPrompt: string, userPrompt: string) => Promise<string>;

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
  search?: SearchSettings;
}

export interface RetrievalHit {
  id: string;
  document?: string;
  position?: number;
  score?: number;
  title?: string;
}

export interface SearchMade {
  queries: string[];
  filters?: FilterField[];
  fellBack?: boolean;
}

export interface ToolOutcome {
  content: string;
  generated?: string;
  retrieved?: RetrievalHit[];
  search?: SearchMade;
  read?: { chunks: RetrievalHit[]; auto?: boolean };
  planned?: { queries: string[]; userIntent?: string };
}

export const retrievalHits = (chunks: ChunkSummary[]): RetrievalHit[] =>
  chunks.map((c) => ({
    id: c.chunkId,
    ...(c.document === undefined ? {} : { document: c.document }),
    ...(c.position === undefined ? {} : { position: c.position }),
    ...(c.score === undefined ? {} : { score: c.score }),
    ...(c.title === undefined ? {} : { title: c.title }),
  }));

const searchArgs = z.object({
  queries: z.array(z.string()).min(1),
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

export const formatSearchMetadataResults = (
  chunks: (ChunkSummary & { titleOverlapBonus?: number })[],
  newCount: number,
  totalSeen: number,
  pass: number,
  attribution: SearchAttribution | undefined,
  displayLimit = defaultSearchDisplayLimit,
  showSnippets = false,
): string => {
  const shown = chunks.slice(0, displayLimit);
  const omitted = Math.max(0, chunks.length - shown.length);
  const lines = shown.map((c, i) => {
    const matched = (c.matchedQuestions ?? []).filter((q) => q.trim() !== '').slice(0, 2);
    return (
      `${i + 1}. chunk_id=${c.chunkId} doc_num=${c.document ?? ''} chunk_index=${c.position ?? ''}/${c.totalChunks ?? '?'}` +
      (c.contentLength === undefined ? '' : ` content_length=${c.contentLength}`) +
      (c.title ? ` title="${c.title}"` : '') +
      (c.url ? ` url=${c.url}` : '') +
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
  });
  const af = attribution?.autoFilter;
  return (
    `Search pass ${pass}: found ${chunks.length} chunks (${newCount} new). ${totalSeen} total seen.` +
    (af ? ` Auto-filtered by ${af.field}: ${af.options.join(', ')}.` : '') +
    (attribution?.autoFilterFallback
      ? ' (filter returned 0 results, fell back to unfiltered)'
      : '') +
    (attribution?.rerankError
      ? ` ColBERT rerank failed (${attribution.rerankError}) — original ranking preserved.`
      : attribution?.rerankEnabled
        ? ` Ranking: ColBERT semantic rerank${attribution.rerankMs === undefined ? '' : ` (${attribution.rerankMs}ms)`}. Higher rerank= means more semantically relevant to the query.`
        : '') +
    (omitted > 0
      ? ` Showing top ${shown.length} by rank; ${omitted} lower-ranked chunks omitted. Refine the query or read from the visible set.`
      : '') +
    `\n${lines.join('\n')}`
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
      (c.title ? ` title="${c.title}"` : '') +
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

const search = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const { workspace, retrieval, signal } = env;
  const settings = env.search ?? defaultSearchSettings;
  const budget = workspace.budget();
  if (budget.searchExhausted) return { content: searchBudgetExhaustedMessage(budget) };
  const args = searchArgs.safeParse(raw);
  if (!args.success)
    return { content: 'Invalid search arguments: queries must be a non-empty list of strings.' };
  const filters: FilterField[] | undefined = args.data.filter_by?.fields.map((f) => ({
    field: f.field,
    selectedOptions: f.selected_options.map(String),
    ...(f.value_type ? { valueType: f.value_type } : {}),
  }));
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
    return {
      content: `Search backend error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let fellBack = false;
  if (filters?.length && outcome.chunks.length === 0) {
    try {
      outcome = await retrieval.search(args.data.queries, options, signal);
      fellBack = true;
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        content: `Filtered retrieval returned 0 chunks; retry without filters failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const rescored = rescoreWithTitleBonus(
    outcome.chunks,
    args.data.queries[0] ?? '',
    settings.titleOverlapWeight,
  );
  const effective = enforceStrategyQuota(rescored, settings.strategyQuota);
  const fresh = workspace.recordSearch(args.data.queries, effective, fellBack, {
    ...(!fellBack && filters?.length ? { filters } : {}),
    ...(outcome.attribution ? { attribution: outcome.attribution } : {}),
  });
  const autoRead = await autoReadTopK(env, effective, settings.autoReadTopK);
  const summary = formatSearchMetadataResults(
    effective,
    fresh,
    workspace.seen.size,
    workspace.searches.length,
    outcome.attribution,
    settings.displayLimit,
    settings.showSnippets,
  );
  return {
    content:
      (fellBack
        ? `Filtered retrieval returned 0 chunks; retried without filters. ${summary}`
        : summary) +
      (autoRead.length
        ? `\nAuto-read top ${autoRead.length} by rank into workspace: ${autoRead.map((c) => c.chunkId).join(', ')}. Do NOT re-read these via read_chunks.`
        : ''),
    retrieved: retrievalHits(effective),
    search: {
      queries: args.data.queries,
      ...(!fellBack && filters?.length ? { filters } : {}),
      ...(fellBack ? { fellBack } : {}),
    },
    ...(autoRead.length ? { read: { chunks: retrievalHits(autoRead), auto: true } } : {}),
  };
};

const read = async (env: ToolEnvironment, raw: unknown): Promise<ToolOutcome> => {
  const { workspace, retrieval, signal } = env;
  const budget = workspace.budget();
  if (budget.readsExhausted || budget.readCharsExhausted)
    return { content: readBudgetExhaustedMessage(budget) };
  const args = readArgs.safeParse(raw);
  if (!args.success) return { content: 'Invalid read_chunks arguments.' };
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
      rangeSelected = plan.selected !== undefined;
      if (plan.selected) {
        fetched = await retrieval.readRange(docNum, plan.selected.from, plan.selected.to, signal);
        source = {
          document: docNum,
          chunkRange: plan.selected,
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
  const budgetNote = readBudgetNote({
    returned: kept.length,
    prefetchSkipped,
    postfetchTrimmed: trimmed,
    remaining,
  });

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
    read: { chunks: retrievalHits(kept) },
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
    return { content: `Reranked to top ${reranked.length} chunks. Top results: ${top}` };
  } catch (error) {
    if (env.signal.aborted) throw error;
    return {
      content: `Error executing rerank_results: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export const generationPromptFor = (template: string, context: string, question: string) =>
  `${template.replace('{context}', context).replace('{question}', question)}\n\n${ambiguityInstruction}\n\n${citationInstruction}\n\n${sameLanguageRule}`;

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
  const { context, index, chunks: ordered } = numberByDocument(docs);
  let text: string;
  try {
    text = stripSourceLists(
      await env.synthesize(
        env.systemPrompt + skillsSection([...workspace.loadedSkills.values()]),
        generationPromptFor(
          env.generationPrompt ?? defaultGenerationPrompt,
          context,
          args.data.query,
        ),
      ),
    );
  } catch (error) {
    if (env.signal.aborted) throw error;
    return {
      content: `Error executing generate_response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  workspace.lastGeneratedResponse = text;
  workspace.citations = parseCitations(text, index);
  workspace.citationIndex = index;
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
