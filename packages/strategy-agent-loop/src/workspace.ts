import type { Citation, CitationIndex, CitationValidation } from './citations.js';
import type { QueryIntent } from './intent.js';
import type { EvidencePlan, ReadSignal } from './read-signals.js';
import type { SufficiencyDecision } from './sufficiency.js';
import type { RuntimeSkill } from './skills.js';

export type SearchType = 'phrase' | 'metadata' | 'content';

export interface ChunkSummary {
  chunkId: string;
  document?: string;
  position?: number;
  totalChunks?: number;
  contentLength?: number;
  title?: string;
  url?: string;
  headers?: string[];
  score?: number;
  rerankScore?: number;
  rank?: number;
  version?: string;
  publishedAt?: string;
  hitCount?: number;
  searchTypes?: SearchType[];
  matchedQuestions?: string[];
  snippet?: string;
}

export interface Chunk extends ChunkSummary {
  content: string;
}

export interface FilterField {
  field: string;
  selectedOptions: string[];
  valueType?: 'string' | 'integer';
}

export interface SearchAttribution {
  phrase?: number;
  metadata?: number;
  content?: number;
  autoFilter?: { field: string; options: string[] };
  autoFilterFallback?: boolean;
  rerankEnabled?: boolean;
  rerankMs?: number;
  rerankError?: string;
  callerFilter?: {
    type: string;
    field: string;
    'selected-options': string[];
    'value-type': string;
  }[];
}

export interface SearchOutcome {
  chunks: ChunkSummary[];
  attribution?: SearchAttribution;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentRetrieval {
  search(
    queries: string[],
    options: { filters?: FilterField[]; userIntent?: string },
    signal: AbortSignal,
  ): Promise<SearchOutcome>;
  read(chunkIds: string[], signal: AbortSignal): Promise<Chunk[]>;
  readRange(document: string, from: number, to: number, signal: AbortSignal): Promise<Chunk[]>;
  plan(
    query: string,
    history: ConversationTurn[],
    signal: AbortSignal,
  ): Promise<{ queries: string[]; userIntent?: string }>;
  rerank(query: string, chunks: Chunk[], signal: AbortSignal): Promise<Chunk[]>;
  filterFields(
    signal: AbortSignal,
  ): Promise<{ field: string; type: string; valueType: 'string' | 'integer' }[]>;
  facets(
    fields: string[],
    maxOptions: number,
    signal: AbortSignal,
  ): Promise<Record<string, { value: string; count: number }[]>>;
}

export interface BudgetLimits {
  searches: number;
  reads: number;
  readChars: number;
}

export interface BudgetState {
  searchesUsed: number;
  maxSearches: number;
  searchesRemaining: number;
  readsUsed: number;
  maxReads: number;
  readsRemaining: number;
  readCharsUsed: number;
  maxReadChars: number;
  readCharsRemaining: number;
  searchExhausted: boolean;
  readsExhausted: boolean;
  readCharsExhausted: boolean;
  lowSearchBudget: boolean;
  lowReadBudget: boolean;
}

export interface SearchSummary {
  'chunk-id': string;
  'doc-num': string | null;
  'chunk-index': number | null;
  'total-chunks': number | null;
  'content-length': number | null;
  title: string | null;
  headers: string | null;
  'search-types': SearchType[] | null;
  'rerank-score': number | null;
  'retrieval-prior': number | null;
  'hit-count': number | null;
  'original-rank': number | null;
  'matched-questions'?: string[];
}

export interface SearchEntry {
  queries: string[];
  resultCount: number;
  newCount: number;
  chunkIds: string[];
  summaries: SearchSummary[];
  fallback: boolean;
  filters?: FilterField[];
  attribution?: SearchAttribution;
}

export interface ChunkRange {
  from: number;
  to: number;
}

export interface ReadEntry {
  mode: 'chunk-ids' | 'doc-range' | 'empty';
  chunkIds?: string[];
  document?: string;
  chunkRange?: ChunkRange;
  defaultRange?: boolean;
  returnedCount: number;
  returnedChunkIds: string[];
  contentLength: number;
  maxContentLength?: number;
  autoRead?: boolean;
}

export interface ReadSource {
  chunkIds?: string[];
  document?: string;
  chunkRange?: ChunkRange;
  defaultRange?: boolean;
  maxContentLength?: number;
  autoRead?: boolean;
}

export interface ShadowDecision {
  source: 'read-signals';
  status: 'conflicting' | 'ambiguous' | 'sufficient' | 'insufficient';
  reasonCode: string;
  suggestedStrategy: string;
  missingClaims: string[];
  contradictions: ReadSignal['contradictions'];
  supportedClaimCount: number;
  stagnantGapClaims: string[];
}

export interface OpenGap {
  claimId: string;
  critical: boolean;
  text?: string;
  reason: string;
}

export interface ClaimCoverage {
  claimId: string;
  supportLevel: 'explicit' | 'partial';
  chunkIds: string[];
}

export const shortDocThreshold = 6;
export const defaultSearchDisplayLimit = 20;
const fallbackEstimatedChunkLength = 1500;
const defaultMaxRangeWidth = 3;
const lowBudgetMaxRangeWidth = 2;
const broadRangeThreshold = 5;
const repeatedGapWindow = 2;

export const chunkContentLength = (
  c: { contentLength?: number; content?: string } | undefined,
): number => c?.contentLength ?? c?.content?.length ?? 0;

const headerString = (headers?: string[]) => (headers?.length ? JSON.stringify(headers) : null);

export class Workspace {
  readonly loadedSkills = new Map<string, RuntimeSkill>();
  readonly searches: SearchEntry[] = [];
  readonly reads: ReadEntry[] = [];
  readonly seen = new Set<string>();
  readonly chunks = new Map<string, Chunk>();
  queries: string[] = [];
  readCharsUsed = 0;
  contextDocs: Chunk[] = [];
  lastUserIntent: string | undefined;
  queryIntent: QueryIntent | undefined;
  evidencePlan: EvidencePlan | undefined;
  pendingEval: Chunk[] = [];
  readEvaluations: ReadSignal[] = [];
  lastReadSignal: ReadSignal | undefined;
  claimCoverage = new Map<string, ClaimCoverage>();
  openGaps: OpenGap[] = [];
  contradictions: ReadSignal['contradictions'] = [];
  nonSupporting = new Set<string>();
  refunded = new Set<string>();
  shadowDecisions: ShadowDecision[] = [];
  sufficiencyDecisions: SufficiencyDecision[] = [];
  responseValidations: SufficiencyDecision[] = [];
  lastGeneratedResponse: string | undefined;
  lastGenerateInsufficient = false;
  citations: Citation[] = [];
  citationIndex: CitationIndex = new Map();
  attached: Chunk[] = [];
  sourceOrder: Chunk[] = [];
  citationValidation: CitationValidation | undefined;
  noToolCallRetries = 0;

  constructor(readonly limits: BudgetLimits) {}

  budget(): BudgetState {
    const searchesRemaining = Math.max(0, this.limits.searches - this.searches.length);
    const readsRemaining = Math.max(0, this.limits.reads - this.reads.length);
    const readCharsRemaining = Math.max(0, this.limits.readChars - this.readCharsUsed);
    return {
      searchesUsed: this.searches.length,
      maxSearches: this.limits.searches,
      searchesRemaining,
      readsUsed: this.reads.length,
      maxReads: this.limits.reads,
      readsRemaining,
      readCharsUsed: this.readCharsUsed,
      maxReadChars: this.limits.readChars,
      readCharsRemaining,
      searchExhausted: searchesRemaining === 0,
      readsExhausted: readsRemaining === 0,
      readCharsExhausted: readCharsRemaining === 0,
      lowSearchBudget: searchesRemaining <= 1,
      lowReadBudget: readsRemaining <= 1 || readCharsRemaining <= 2000,
    };
  }

  recordSearch(
    queries: string[],
    found: ChunkSummary[],
    fallback: boolean,
    extra: { filters?: FilterField[]; attribution?: SearchAttribution } = {},
  ): number {
    const fresh = found.filter((c) => !this.seen.has(c.chunkId)).length;
    this.searches.push({
      queries,
      resultCount: found.length,
      newCount: fresh,
      chunkIds: found.map((c) => c.chunkId),
      summaries: found.map((c) => ({
        'chunk-id': c.chunkId,
        'doc-num': c.document ?? null,
        'chunk-index': c.position ?? null,
        'total-chunks': null,
        'content-length': c.contentLength ?? null,
        title: c.title ?? null,
        headers: headerString(c.headers),
        'search-types': c.searchTypes ?? null,
        'rerank-score': c.rerankScore ?? null,
        'retrieval-prior': c.score ?? null,
        'hit-count': c.hitCount ?? null,
        'original-rank': c.rank ?? null,
        ...(c.matchedQuestions?.length ? { 'matched-questions': c.matchedQuestions } : {}),
      })),
      fallback,
      ...(extra.filters?.length ? { filters: extra.filters } : {}),
      ...(extra.attribution ? { attribution: extra.attribution } : {}),
    });
    for (const c of found) this.seen.add(c.chunkId);
    this.queries = [...new Set([...this.queries, ...queries])];
    return fresh;
  }

  recordRead(source: ReadSource, chunks: Chunk[]) {
    const contentLength = chunks.reduce((n, c) => n + chunkContentLength(c), 0);
    const mode: ReadEntry['mode'] = source.chunkIds?.length
      ? 'chunk-ids'
      : source.document !== undefined && source.chunkRange
        ? 'doc-range'
        : 'empty';
    this.reads.push({
      mode,
      ...(mode === 'chunk-ids' ? { chunkIds: source.chunkIds ?? [] } : {}),
      ...(mode === 'doc-range'
        ? {
            document: source.document as string,
            chunkRange: source.chunkRange as ChunkRange,
            defaultRange: Boolean(source.defaultRange),
          }
        : {}),
      returnedCount: chunks.length,
      returnedChunkIds: chunks.map((c) => c.chunkId),
      contentLength,
      ...(source.maxContentLength === undefined
        ? {}
        : { maxContentLength: source.maxContentLength }),
      ...(source.autoRead ? { autoRead: true } : {}),
    });
    this.readCharsUsed += contentLength;
  }

  addChunks(chunks: Chunk[]) {
    for (const c of chunks) this.chunks.set(c.chunkId, c);
  }

  queuePendingEval(chunks: Chunk[]) {
    this.pendingEval.push(...chunks);
  }

  drainPendingEval(): Chunk[] {
    const pending = this.pendingEval;
    this.pendingEval = [];
    return pending;
  }

  workspaceChunks(): Chunk[] {
    return [...this.chunks.values()];
  }

  chunksForSynthesis(): Chunk[] {
    const read = this.readChunkIds();
    const explicit = new Set(
      this.reads.filter((r) => !r.autoRead).flatMap((r) => r.returnedChunkIds),
    );
    const evidence = new Set([
      ...[...this.claimCoverage.values()].flatMap((c) => c.chunkIds),
      ...this.contradictions.flatMap((c) => c.chunkIds),
    ]);
    const summaries = new Map<string, SearchSummary>();
    for (const search of this.searches) {
      for (const summary of search.summaries) {
        const id = summary['chunk-id'];
        summaries.set(id, {
          ...summary,
          // A degraded search or an unranked tail must not erase a known score.
          'rerank-score': summary['rerank-score'] ?? summaries.get(id)?.['rerank-score'] ?? null,
        });
      }
    }
    const priority = (c: Chunk) => {
      const summary = summaries.get(c.chunkId);
      return [
        Number(evidence.has(c.chunkId)),
        Number(explicit.has(c.chunkId)),
        summary?.['rerank-score'] ?? c.rerankScore ?? 0,
        summary?.['retrieval-prior'] ?? c.score ?? 0,
        summary?.['hit-count'] ?? c.hitCount ?? 0,
        -(summary?.['original-rank'] ?? c.rank ?? Number.MAX_SAFE_INTEGER),
      ];
    };
    const ranked = this.workspaceChunks()
      .filter((c) => read.has(c.chunkId))
      .map((chunk, index) => ({ chunk, index, priority: priority(chunk) }))
      .sort((a, b) => {
        for (let i = 0; i < a.priority.length; i++) {
          const difference = (b.priority[i] as number) - (a.priority[i] as number);
          if (difference !== 0) return difference;
        }
        return a.index - b.index;
      });
    // Refunds can leave more readable content than the read budget. Bound synthesis
    // by actual text size, without cutting evidence mid-chunk or imposing a count cap.
    let remaining = this.limits.readChars;
    return ranked.flatMap(({ chunk }) => {
      const length = Math.max(1, chunk.content.length);
      if (length > remaining) return [];
      remaining -= length;
      return [chunk];
    });
  }

  chunksForOutput(): Chunk[] {
    const key = (c: Chunk) => [-(c.score ?? 0), -(c.hitCount ?? 0), -(c.rank ?? 0)];
    const read = this.readChunkIds();
    return [...this.chunks.values()]
      .filter((c) => read.has(c.chunkId))
      .map((chunk, index) => ({ chunk, index }))
      .sort((a, b) => {
        const ka = key(a.chunk);
        const kb = key(b.chunk);
        for (let i = 0; i < ka.length; i++) {
          const d = (ka[i] as number) - (kb[i] as number);
          if (d !== 0) return d;
        }
        return a.index - b.index;
      })
      .map((x) => x.chunk);
  }

  readChunkIds(): Set<string> {
    return new Set(this.reads.flatMap((r) => r.returnedChunkIds));
  }

  latestKnownChunkSummary(chunkId: string): SearchSummary | undefined {
    for (const entry of [...this.searches].reverse()) {
      const found = entry.summaries.find((s) => s['chunk-id'] === chunkId);
      if (found) return found;
    }
    return undefined;
  }

  latestSearchQueries(): string[] {
    return this.searches.at(-1)?.queries ?? [];
  }

  countSufficiencyRejections(): number {
    return [...this.sufficiencyDecisions, ...this.responseValidations].filter(
      (d) => d.status !== 'sufficient',
    ).length;
  }
}

export const computeBudgetRefund = (
  workspace: Workspace,
  signal: ReadSignal & { chunkIds: string[] },
): { refundedIds: string[]; refundedChars: number } => {
  const eligible = signal.confidence >= 0.5 && !signal.degraded && signal.status !== 'unclear';
  if (!eligible) return { refundedIds: [], refundedChars: 0 };
  const supported = new Set(signal.supportedClaims.flatMap((c) => c.chunkIds));
  const refundedIds = [...new Set(signal.chunkIds)].filter(
    (id) => !supported.has(id) && !workspace.refunded.has(id),
  );
  return {
    refundedIds,
    refundedChars: refundedIds.reduce(
      (n, id) => n + chunkContentLength(workspace.chunks.get(id)),
      0,
    ),
  };
};

export const recordReadEvaluation = (
  workspace: Workspace,
  signal: ReadSignal & { chunkIds: string[] },
) => {
  const supportedChunkIds = new Set(signal.supportedClaims.flatMap((c) => c.chunkIds));
  const confidentlyScoped = signal.scopeAssessment === 'aligned' && signal.status !== 'unclear';
  const nonSupporting =
    !signal.degraded &&
    confidentlyScoped &&
    signal.supportedClaims.length === 0 &&
    signal.contradictions.length === 0
      ? new Set(signal.chunkIds)
      : new Set<string>();
  for (const support of signal.supportedClaims) {
    const existing = workspace.claimCoverage.get(support.claimId);
    const existingIds = new Set(existing?.chunkIds ?? []);
    workspace.claimCoverage.set(support.claimId, {
      claimId: support.claimId,
      supportLevel:
        existing?.supportLevel === 'explicit' || support.supportLevel === 'explicit'
          ? 'explicit'
          : (support.supportLevel ?? existing?.supportLevel ?? 'partial'),
      chunkIds: [
        ...(existing?.chunkIds ?? []),
        ...support.chunkIds.filter((id) => !existingIds.has(id)),
      ],
    });
  }
  workspace.contradictions = [...workspace.contradictions, ...signal.contradictions];
  const gapById = new Map(signal.remainingGaps.map((g) => [g.claimId, g]));
  workspace.openGaps = (workspace.evidencePlan?.requiredClaims ?? [])
    .filter((c) => !workspace.claimCoverage.has(c.claimId))
    .map((c) => {
      const gap = gapById.get(c.claimId);
      return {
        claimId: c.claimId,
        critical: gap ? gap.critical : c.critical,
        text: c.text,
        reason: gap ? gap.reason : 'not-yet-supported',
      };
    });
  for (const id of nonSupporting) workspace.nonSupporting.add(id);
  for (const id of supportedChunkIds) workspace.nonSupporting.delete(id);
  const { refundedIds, refundedChars } = computeBudgetRefund(workspace, signal);
  for (const id of refundedIds) workspace.refunded.add(id);
  workspace.readCharsUsed = Math.max(0, workspace.readCharsUsed - refundedChars);
  workspace.readEvaluations.push(signal);
  workspace.lastReadSignal = signal;
};

export const nextReadSuggestions = (workspace: Workspace) => {
  const readIds = workspace.readChunkIds();
  const unread = (workspace.searches.at(-1)?.summaries ?? []).filter(
    (s) => !readIds.has(s['chunk-id']),
  );
  const anchor = unread.find(
    (s) =>
      s['doc-num'] !== null &&
      s['chunk-index'] !== null &&
      (s['total-chunks'] === null || s['total-chunks'] > 1),
  );
  return {
    unreadCount: unread.length,
    chunkIds: unread.slice(0, 3).map((s) => s['chunk-id']),
    range: anchor
      ? {
          document: anchor['doc-num'] as string,
          chunkRange: {
            from: Math.max(0, (anchor['chunk-index'] as number) - 1),
            to:
              anchor['total-chunks'] === null
                ? (anchor['chunk-index'] as number) + 1
                : Math.min(anchor['total-chunks'] - 1, (anchor['chunk-index'] as number) + 1),
          },
        }
      : undefined,
  };
};

const criticalGapIds = (signal: ReadSignal) =>
  new Set(signal.remainingGaps.filter((g) => g.critical).map((g) => g.claimId));

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

const repeatedGapStagnation = (workspace: Workspace) => {
  const recent = workspace.readEvaluations.slice(-repeatedGapWindow);
  const sets = recent.map(criticalGapIds);
  const last = sets.at(-1);
  if (
    recent.length === repeatedGapWindow &&
    last &&
    last.size > 0 &&
    sets.every((s) => s.size > 0 && sameSet(s, last)) &&
    recent.every((s) => s.supportedClaims.length === 0 && s.contradictions.length === 0)
  )
    return { gapIds: [...last] };
  return undefined;
};

export const aggregateReadSignals = (workspace: Workspace): ShadowDecision => {
  const critical = (workspace.evidencePlan?.requiredClaims ?? []).filter((c) => c.critical);
  const missing = critical
    .filter((c) => !workspace.claimCoverage.has(c.claimId))
    .map((c) => c.claimId);
  const contradictions = workspace.contradictions;
  const last = workspace.lastReadSignal;
  const degraded = Boolean(last?.degraded);
  const scope = last?.scopeAssessment;
  const stagnation = repeatedGapStagnation(workspace);
  const ambiguous =
    degraded || last?.status === 'unclear' || scope === 'ambiguous' || scope === 'wrong-scope';
  const unreadCount = nextReadSuggestions(workspace).unreadCount;
  const suggestedStrategy = contradictions.length
    ? 'finalize'
    : ambiguous
      ? (last?.nextActionHint ?? 're-search')
      : missing.length === 0
        ? 'finalize'
        : stagnation
          ? 're-search'
          : unreadCount > 0
            ? 'read-more'
            : 're-search';
  return {
    source: 'read-signals',
    status: contradictions.length
      ? 'conflicting'
      : ambiguous
        ? 'ambiguous'
        : missing.length === 0
          ? 'sufficient'
          : 'insufficient',
    reasonCode: contradictions.length
      ? 'contradictory-read-signals'
      : degraded
        ? 'degraded-local-read-signal'
        : scope === 'ambiguous'
          ? 'ambiguous-scope'
          : scope === 'wrong-scope'
            ? 'wrong-scope'
            : last?.status === 'unclear'
              ? 'unclear-read-signal'
              : missing.length === 0
                ? 'all-critical-claims-covered'
                : stagnation
                  ? 'repeated-critical-gaps'
                  : 'critical-gaps-remaining',
    suggestedStrategy,
    missingClaims: missing,
    contradictions,
    supportedClaimCount: workspace.claimCoverage.size,
    stagnantGapClaims: stagnation?.gapIds ?? [],
  };
};

export const rangeReadSuggestion = (workspace: Workspace) => {
  const last = workspace.reads.at(-1);
  if (!last || last.mode !== 'chunk-ids') return undefined;
  const rangeReadDocs = new Set(
    workspace.reads.filter((r) => r.mode === 'doc-range').map((r) => r.document),
  );
  const candidates = new Map<
    string,
    { total: number; title?: string; url?: string; chunkId: string }[]
  >();
  for (const id of last.returnedChunkIds) {
    const chunk = workspace.chunks.get(id);
    if (!chunk?.document || chunk.totalChunks === undefined || !Number.isInteger(chunk.totalChunks))
      continue;
    if (chunk.totalChunks <= 1 || rangeReadDocs.has(chunk.document)) continue;
    const list = candidates.get(chunk.document) ?? [];
    list.push({
      total: chunk.totalChunks,
      ...(chunk.title === undefined ? {} : { title: chunk.title }),
      ...(chunk.url === undefined ? {} : { url: chunk.url }),
      chunkId: chunk.chunkId,
    });
    candidates.set(chunk.document, list);
  }
  for (const [document, entries] of candidates) {
    const first = entries[0] as (typeof entries)[number];
    const readIndices = new Set(
      workspace
        .workspaceChunks()
        .filter((c) => c.document === document && c.position !== undefined)
        .map((c) => c.position as number),
    );
    const unread = Array.from({ length: first.total }, (_, i) => i).filter(
      (i) => !readIndices.has(i),
    );
    if (unread.length > 0) {
      return {
        document,
        title: first.title,
        totalChunks: first.total,
        readIndices: [...readIndices].sort((a, b) => a - b),
        unreadIndices: unread,
        chunkRange: { from: 0, to: first.total - 1 },
        triggeringChunkId: first.chunkId,
      };
    }
  }
  return undefined;
};

const ednVector = (xs: number[]) => `[${xs.join(' ')}]`;

export const rangeReadHintText = (s: NonNullable<ReturnType<typeof rangeReadSuggestion>>): string =>
  `\n\n[SYSTEM: The chunks you just read came from doc_num="${s.document}"` +
  (s.title ? ` (title="${s.title}", total_chunks=${s.totalChunks})` : '') +
  `. You have read chunk_index(es) ${ednVector(s.readIndices)} from this doc but chunk_index(es) ${ednVector(s.unreadIndices)} are still unread in the SAME doc.` +
  ' The answer is often in an adjacent chunk — before issuing any new search, call read_chunks with these exact args: {"doc_num": "' +
  s.document +
  `", "chunk_range": {"from": ${s.chunkRange.from}, "to": ${s.chunkRange.to}}}.]`;

const normalizeChunkRange = (r: {
  from?: number | undefined;
  to?: number | undefined;
}): ChunkRange => {
  const from = Math.max(0, Math.trunc(r.from ?? 0));
  return { from, to: Math.max(from, Math.trunc(r.to ?? from + 4)) };
};

const rangeWidth = (r: ChunkRange) => r.to - r.from + 1;

const clampRangeAroundAnchor = (anchor: number, r: ChunkRange, maxWidth: number): ChunkRange => {
  const width = Math.max(1, maxWidth);
  const half = Math.trunc((width - 1) / 2);
  const tentativeFrom = Math.max(r.from, anchor - half);
  const tentativeTo = Math.min(r.to, tentativeFrom + width - 1);
  return { from: Math.max(r.from, tentativeTo - (width - 1)), to: tentativeTo };
};

const preferredRangeAnchor = (workspace: Workspace, document: string, r: ChunkRange) => {
  const readIds = workspace.readChunkIds();
  return (
    (workspace.searches.at(-1)?.summaries ?? []).find(
      (s) =>
        s['doc-num'] === document &&
        s['chunk-index'] !== null &&
        s['chunk-index'] >= r.from &&
        s['chunk-index'] <= r.to &&
        !readIds.has(s['chunk-id']),
    )?.['chunk-index'] ?? undefined
  );
};

const mean = (xs: number[]) => Math.ceil(xs.reduce((a, b) => a + b, 0) / xs.length);

const estimatedRangeChunkLength = (workspace: Workspace, document: string, r: ChunkRange) => {
  const readIds = workspace.readChunkIds();
  const matching = (workspace.searches.at(-1)?.summaries ?? [])
    .filter(
      (s) =>
        s['doc-num'] === document &&
        s['chunk-index'] !== null &&
        s['chunk-index'] >= r.from &&
        s['chunk-index'] <= r.to &&
        !readIds.has(s['chunk-id']) &&
        (s['content-length'] ?? 0) > 0,
    )
    .map((s) => s['content-length'] as number);
  const history = workspace.reads
    .filter((e) => e.returnedCount > 0 && e.contentLength > 0)
    .map((e) => Math.ceil(e.contentLength / e.returnedCount));
  const samples = matching.length ? matching : history;
  return samples.length ? mean(samples) : fallbackEstimatedChunkLength;
};

const estimatedRangeIndexLength = (workspace: Workspace, document: string, index: number) => {
  const readIds = workspace.readChunkIds();
  for (const entry of [...workspace.searches].reverse()) {
    const hit = entry.summaries.find(
      (s) =>
        s['doc-num'] === document &&
        s['chunk-index'] === index &&
        !readIds.has(s['chunk-id']) &&
        (s['content-length'] ?? 0) > 0,
    );
    if (hit) return hit['content-length'] as number;
  }
  return estimatedRangeChunkLength(workspace, document, { from: index, to: index });
};

const candidateReadRange = (
  workspace: Workspace,
  document: string,
  requested: ChunkRange,
  budget: BudgetState,
) => {
  const r = normalizeChunkRange(requested);
  const base = budget.lowReadBudget ? lowBudgetMaxRangeWidth : defaultMaxRangeWidth;
  const remaining = budget.readCharsRemaining;
  const maxWidth =
    remaining > 0
      ? Math.min(
          base,
          Math.max(
            1,
            Math.trunc(remaining / Math.max(1, estimatedRangeChunkLength(workspace, document, r))),
          ),
        )
      : 1;
  if (rangeWidth(r) <= broadRangeThreshold) return r;
  return clampRangeAroundAnchor(
    preferredRangeAnchor(workspace, document, r) ?? r.from,
    r,
    maxWidth,
  );
};

const effectiveReadRange = (
  workspace: Workspace,
  document: string,
  requested: ChunkRange,
  budget: BudgetState,
) => {
  const candidate = candidateReadRange(workspace, document, requested, budget);
  const remaining = budget.readCharsRemaining;
  if (remaining <= 0) return undefined;
  const anchor = preferredRangeAnchor(workspace, document, candidate) ?? candidate.from;
  const options: { range: ChunkRange; width: number; distance: number; total: number }[] = [];
  for (let start = candidate.from; start <= anchor; start += 1) {
    for (let end = anchor; end <= candidate.to; end += 1) {
      let total = 0;
      for (let i = start; i <= end; i += 1)
        total += Math.max(1, estimatedRangeIndexLength(workspace, document, i));
      options.push({
        range: { from: start, to: end },
        width: end - start + 1,
        distance: anchor - start + (end - anchor),
        total,
      });
    }
  }
  const best = options
    .filter((o) => o.total <= remaining)
    .sort((a, b) => b.width - a.width || a.distance - b.distance || a.total - b.total)[0];
  return best?.range;
};

export const planRangeRead = (
  workspace: Workspace,
  document: string,
  requested: { from?: number | undefined; to?: number | undefined },
  budget: BudgetState,
) => {
  const r = normalizeChunkRange(requested);
  const candidate = candidateReadRange(workspace, document, r, budget);
  const selected = effectiveReadRange(workspace, document, r, budget);
  return {
    selected,
    prefetchSkippedCount: rangeWidth(candidate) - (selected ? rangeWidth(selected) : 0),
  };
};

const estimatedChunkReadLength = (workspace: Workspace, chunkId: string) => {
  const known = workspace.chunks.get(chunkId);
  if (known) return chunkContentLength(known);
  return (
    workspace.latestKnownChunkSummary(chunkId)?.['content-length'] ?? fallbackEstimatedChunkLength
  );
};

export const selectChunkIdsWithinBudget = (
  workspace: Workspace,
  chunkIds: string[],
  budget: BudgetState,
) => {
  const remaining = budget.readCharsRemaining;
  const selected: string[] = [];
  const skipped: string[] = [];
  let consumed = 0;
  for (const id of chunkIds) {
    const estimate = Math.max(1, estimatedChunkReadLength(workspace, id));
    if (consumed + estimate <= remaining) {
      selected.push(id);
      consumed += estimate;
    } else skipped.push(id);
  }
  if (remaining > 0 && chunkIds.length === 1 && selected.length === 0)
    return { selected: [chunkIds[0] as string], skipped: [] as string[] };
  return { selected, skipped };
};

export const expandShortDocReads = (workspace: Workspace, chunkIds: string[]) => {
  const byDoc = new Map<string, number>();
  const leftover: string[] = [];
  for (const id of chunkIds) {
    const summary = workspace.latestKnownChunkSummary(id);
    const total = summary?.['total-chunks'];
    const doc = summary?.['doc-num'];
    if (total !== null && total !== undefined && doc && total <= shortDocThreshold)
      byDoc.set(doc, total);
    else leftover.push(id);
  }
  return {
    chunkIdReads: leftover,
    docRangeReads: [...byDoc].map(([document, total]) => ({
      document,
      from: 0,
      to: Math.max(0, total - 1),
    })),
  };
};

export const trimChunksToBudget = (chunks: Chunk[], remaining: number) => {
  const kept: Chunk[] = [];
  let consumed = 0;
  let trimmed = 0;
  for (const c of chunks) {
    const len = Math.max(1, chunkContentLength(c));
    if (consumed + len <= remaining) {
      kept.push(c);
      consumed += len;
    } else trimmed += 1;
  }
  return { kept, consumed, trimmed };
};

export const readBudgetNote = (o: {
  returned: number;
  prefetchSkipped: number;
  postfetchTrimmed: number;
  remaining: number;
}): string | undefined => {
  if (o.prefetchSkipped + o.postfetchTrimmed <= 0) return undefined;
  return (
    `Budget limited this read. Returned ${o.returned} of ${o.returned + o.prefetchSkipped + o.postfetchTrimmed} requested/retrieved chunks within the remaining ${o.remaining}-char budget.` +
    (o.prefetchSkipped > 0 ? ` Skipped ${o.prefetchSkipped} before fetch.` : '') +
    (o.postfetchTrimmed > 0
      ? ` Trimmed ${o.postfetchTrimmed} after fetch because actual chunk sizes exceeded estimates.`
      : '')
  );
};

type HeadlessFilterField = {
  type: string;
  field: string;
  'selected-options': string[];
  'value-type': string;
};

export interface AppliedFilter {
  filter: { fields: HeadlessFilterField[] };
  source: 'merged' | 'auto' | 'explicit';
  auto_detected?: { fields: HeadlessFilterField[] };
  auto_detected_dropped?: true;
}

const explicitField = (f: FilterField): HeadlessFilterField => ({
  type: 'multiselect',
  field: f.field,
  'selected-options': f.selectedOptions,
  'value-type': f.valueType ?? 'string',
});

const detectedField = (a: { field: string; options: string[] }): HeadlessFilterField => ({
  type: a.field === 'title' ? 'contains' : 'multiselect',
  field: a.field,
  'selected-options': a.options,
  'value-type': 'string',
});

export const filtersApplied = (searches: SearchEntry[]): AppliedFilter[] => {
  const out: AppliedFilter[] = [];
  const seen = new Set<string>();
  for (const entry of searches) {
    const caller = entry.attribution?.callerFilter ?? [];
    const callerNamed = new Set(caller.map((f) => f.field));
    const explicit = [
      ...caller,
      ...(entry.filters ?? []).map(explicitField).filter((f) => !callerNamed.has(f.field)),
    ];
    const auto = entry.attribution?.autoFilter;
    const dropped = Boolean(entry.attribution?.autoFilterFallback);
    const detected = auto ? [detectedField(auto)] : [];
    const named = new Set(explicit.map((f) => f.field));
    const effective = dropped
      ? explicit
      : [...explicit, ...detected.filter((f) => !named.has(f.field))];
    if (effective.length === 0) continue;
    const source =
      explicit.length && detected.length && !dropped
        ? 'merged'
        : detected.length && !dropped
          ? 'auto'
          : 'explicit';
    const applied: AppliedFilter = {
      filter: { fields: effective },
      source,
      ...(detected.length ? { auto_detected: { fields: detected } } : {}),
      ...(dropped ? { auto_detected_dropped: true as const } : {}),
    };
    const id = JSON.stringify(applied);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(applied);
    }
  }
  return out;
};
