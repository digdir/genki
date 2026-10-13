import {
  capabilitiesOf,
  kindsOf,
  type FacetValue,
  type FilterClause,
  type FilterValue,
  type Hit,
  type KnowledgeCapability,
  type KnowledgePort,
  type SearchRequest,
  type SearchResult,
} from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import type { RerankPort } from '@genai/port-rerank';
import { detectFromRules } from './rules.js';
import {
  accepts,
  mergeTyped,
  portFilters,
  toInput,
  toSet,
  type FilterInput,
  type FilterSet,
} from './filters.js';
import { retrievalConfig, strategyWeights, type RetrievalConfig } from './config.js';
import { dedupeHits, mergeStrategyLists, type MergedHit, type StrategyHit } from './merge.js';
import {
  capPerDocument,
  detectOrgFilter,
  detectYears,
  fileDigestsOf,
  orgsOf,
  prioritize,
  relaxedCap,
  suppressDuplicateFiles,
  unionMerge,
  type Chunk,
} from './stages.js';
import {
  bestContentWindows,
  contentSnippet,
  formatMetadataHeaders,
  truncateHeadTail,
} from './text.js';

export class FacetCache {
  readonly #entries = new Map<string, { at: number; values: Record<string, FacetValue[]> }>();

  async get(
    key: string,
    ttlMs: number,
    now: number,
    load: () => Promise<Record<string, FacetValue[]>>,
  ) {
    const entry = this.#entries.get(key);
    if (entry && now - entry.at < ttlMs) return entry.values;
    const values = await load();
    this.#entries.set(key, { at: now, values });
    return values;
  }
}

const sharedFacetCache = new FacetCache();

export interface RetrieveInput {
  knowledge: KnowledgePort;
  rerank?: RerankPort;
  queries: string[];
  userIntent?: string;
  filters?: Record<string, FilterInput>;
  config?: unknown;
  facetCache?: FacetCache;
  model?: ModelPort;
  now?: () => number;
}

export type SkipReason = 'no_text' | 'unsupported_type' | 'outside_access';

export interface SkippedDocument {
  document: string;
  reason: SkipReason;
}

export type RerankStatus = 'off' | 'unconfigured' | 'reranked' | 'empty' | 'degraded';

export interface PassTrace {
  queries: string[];
  hitsPerStrategy: Record<string, number>;
  merged: MergedHit[];
  detectedFilter?: Record<string, FilterInput>;
  effectiveFilter?: Record<string, FilterInput>;
  autoFilterFallback: boolean;
  autoFilterError?: string;
  fetched: number;
  effectiveMaxPerDocument: number;
  chunksBeforeDiversity: number;
  chunksAfterDiversity: number;
  droppedByDiversity: number;
  droppedAsDuplicateFile: number;
  rerank: { status: RerankStatus; candidates: number; ms: number; error?: string };
  warnings: string[];
  skipped?: SkippedDocument[];
}

export interface RetrievalTrace {
  expansion: PassTrace;
  intent?: PassTrace;
  union?: { mode: string; cap: number; rrfK: number };
}

export interface RetrievalResult {
  chunks: Chunk[];
  trace: RetrievalTrace;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

type Note = (message: string) => void;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const isUnsupported = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === 'KnowledgeError' &&
  (error as { code?: unknown }).code === 'unsupported';

const unsupportedOr = async <T>(
  run: () => Promise<T>,
  fallback: (error: Error) => T | Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (!isUnsupported(error)) throw error;
    return fallback(error as Error);
  }
};

const inBatches = async (
  knowledge: KnowledgePort,
  requests: SearchRequest[],
  size: number,
  note: Note,
): Promise<SearchResult[]> => {
  const one = (request: SearchRequest) =>
    unsupportedOr(
      () => knowledge.search(request),
      (error): SearchResult => {
        note(`skipped ${request.profile ?? 'default'} search: ${error.message}`);
        return { hits: [] };
      },
    );
  const results: SearchResult[] = [];
  for (let i = 0; i < requests.length; i += size) {
    const batch = requests.slice(i, i + size);
    results.push(
      ...(await unsupportedOr(
        () => knowledge.searchMany(batch),
        () => Promise.all(batch.map(one)),
      )),
    );
  }
  return results;
};

const rerankText = (
  chunk: Chunk,
  content: string | undefined,
  query: string,
  config: RetrievalConfig['rerank'],
) => {
  const headers = chunk.metadata === undefined ? undefined : formatMetadataHeaders(chunk.metadata);
  const prefix = `${chunk.title === undefined ? '' : `Title: ${chunk.title}\n\n`}${headers ?? ''}`;
  return config.windowing
    ? prefix +
        bestContentWindows(content, query, Math.max(200, config.maxChunkLength - prefix.length))
    : truncateHeadTail(prefix + (content ?? ''), config.maxChunkLength);
};

export const retrieve = async (input: RetrieveInput): Promise<RetrievalResult> => {
  const config = retrievalConfig.parse(input.config ?? {});
  const { knowledge } = input;
  const info = knowledge.info();
  const now = input.now ?? Date.now;
  const facetCache = input.facetCache ?? sharedFacetCache;
  const weights = strategyWeights(config);
  const mergeOptions = {
    mode: config.merge.mode,
    weights,
    caps: config.merge.caps,
    rrfK: config.merge.rrfK,
  };
  const useContent = !config.metadataOnly;
  const keepDigests =
    config.duplicateFiles === 'always' || (config.duplicateFiles === 'when-content' && useContent);
  const capabilities = new Set<KnowledgeCapability>(capabilitiesOf(info));
  const profiles = new Set(info.profiles);
  const datasetNotices: string[] = [];
  const orgFields = config.autoFilter.orgFields.filter((f) => {
    const declared = info.filters[f];
    return Array.isArray(declared) ? declared.includes('multiselect') : declared === 'multiselect';
  });
  if (config.autoFilter.enabled) {
    for (const f of config.autoFilter.orgFields)
      if (!orgFields.includes(f) && info.filters[f] !== undefined)
        datasetNotices.push(`skipped org auto-filter on ${f}: dataset lacks a multiselect field`);
    if (orgFields.length > 0 && !capabilities.has('facets'))
      datasetNotices.push('skipped org auto-filter: engine lacks facets');
  }
  const searchableProfiles = (name: string, wanted: string[]) =>
    wanted.filter((p) => {
      if (profiles.has(p)) return true;
      datasetNotices.push(`skipped ${name} search: dataset lacks profile ${p}`);
      return false;
    });
  const configuredGroups =
    config.mode === 'hierarchical'
      ? []
      : [
          ...config.strategies.map((s) => ({ name: s.name, profiles: s.profiles, matched: false })),
          ...config.enrichment.map((e) => ({
            name: e.type,
            profiles: e.profiles,
            matched: e.type === 'hypothetical-questions',
          })),
        ];
  const groups = configuredGroups
    .map((g) => ({ ...g, profiles: searchableProfiles(g.name, g.profiles) }))
    .filter((g) => g.profiles.length > 0);
  const fallbackProfile = info.profiles[0];
  if (configuredGroups.length > 0 && groups.length === 0 && fallbackProfile !== undefined) {
    datasetNotices.push(`no configured profile on dataset, searching ${fallbackProfile}`);
    groups.push({ name: 'content', profiles: [fallbackProfile], matched: false });
  }
  const docTitle = (() => {
    if (!config.docTitle) return undefined;
    if (!capabilities.has('range')) {
      datasetNotices.push('skipped doc-title fan-out: engine lacks range');
      return undefined;
    }
    const titleProfiles = searchableProfiles('doc-title', config.docTitle.profiles);
    return titleProfiles.length > 0 ? { ...config.docTitle, profiles: titleProfiles } : undefined;
  })();
  const filterable = (field: string, value: FilterClause, note: Note) => {
    const declared = info.filters[field];
    if (!accepts(declared, value)) return false;
    const kinds = declared === undefined ? [] : kindsOf(declared);
    if (kinds.some((k) => capabilities.has(`filter.${k}`) && accepts(k, value))) return true;
    note(`skipped auto-filter on ${field}: engine lacks filter.${kinds.join('/')}`);
    return false;
  };
  const fetchHits = async (ids: string[], seen: Map<string, Hit>, note: Note) => {
    const fromSearch = () => ids.flatMap((id) => seen.get(id) ?? []);
    if (!capabilities.has('fetch')) {
      note('skipped fetch: engine lacks fetch, using search hits');
      return fromSearch();
    }
    return unsupportedOr(
      () => knowledge.fetch(ids),
      (error) => {
        note(`skipped fetch: ${error.message}, using search hits`);
        return fromSearch();
      },
    );
  };

  const detect = async (
    queries: string[],
    note: Note,
  ): Promise<{ filter?: FilterSet; error?: string }> => {
    if (!config.autoFilter.enabled || queries.length === 0) return {};
    try {
      const detected: FilterSet = {};
      const add = (field: string, value: FilterClause) => {
        if (!filterable(field, value, note)) return;
        const normalised =
          info.filters[field] === 'select' && Array.isArray(value)
            ? (value[0] as FilterClause)
            : value;
        detected[field] = [...(detected[field] ?? []), normalised];
      };
      if (orgFields.length > 0 && capabilities.has('facets')) {
        const facets = await unsupportedOr(
          () =>
            facetCache.get(
              `${info.id}:${orgFields.join(',')}`,
              config.autoFilter.cacheTtlMs,
              now(),
              () => knowledge.facets(orgFields),
            ),
          (error): Record<string, FacetValue[]> => {
            note(`skipped org auto-filter: ${error.message}`);
            return {};
          },
        );
        const org = detectOrgFilter(queries, facets, orgFields, config.autoFilter.minValueLength);
        if (org) add(org.field, org.values);
      }
      const years = detectYears(queries);
      if (years.length > 0) add(config.autoFilter.yearTitleField, { contains: years });
      const ruled = await detectFromRules(config.autoFilter.rules, queries, input.model);
      for (const [field, value] of Object.entries(ruled)) add(field, value);
      return Object.keys(detected).length > 0 ? { filter: detected } : {};
    } catch (error) {
      return { error: messageOf(error) };
    }
  };

  const runStrategies = async (
    queries: string[],
    filters: Record<string, FilterValue> | undefined,
    note: Note,
  ) => {
    const base = (query: string, profile: string): SearchRequest => ({
      query,
      profile,
      limit: config.limit,
      ...(filters ? { filters } : {}),
    });
    const plan = groups.flatMap((g) =>
      queries.flatMap((q) => g.profiles.map((p) => ({ group: g.name, request: base(q, p) }))),
    );
    const titlePlan = docTitle
      ? queries.flatMap((q) => docTitle.profiles.map((p) => base(q, p)))
      : [];
    const results = await inBatches(
      knowledge,
      [...plan.map((p) => p.request), ...titlePlan],
      config.batchSize,
      note,
    );
    const warnings = results.flatMap((r) => (r.warning ? [r.warning] : []));
    const seen = new Map<string, Hit>();
    const remember = (hits: Hit[]) => {
      for (const h of hits) if (!seen.has(h.id)) seen.set(h.id, h);
    };
    for (const r of results.slice(0, plan.length)) remember(r.hits);

    const listFor = (g: (typeof groups)[number]) => {
      const hits = plan
        .flatMap((p, i) => (p.group === g.name ? (results[i]?.hits ?? []) : []))
        .map((h: Hit, index): StrategyHit => ({
          id: h.id,
          rank: finite(h.score),
          index,
          searchType: g.name,
          ...(h.document === undefined ? {} : { document: h.document }),
          ...(g.matched && h.text ? { matchedQuestion: h.text } : {}),
        }));
      return { name: g.name, hits: dedupeHits(hits) };
    };
    const baseLists = groups
      .filter((g) => !config.enrichment.some((e) => e.type === g.name))
      .map(listFor);
    const enrichmentLists = groups
      .filter((g) => config.enrichment.some((e) => e.type === g.name))
      .map(listFor);
    const lists = [...baseLists];

    if (docTitle) {
      const docHits = results.slice(plan.length).flatMap((r) => r.hits);
      const best = new Map<string, number>();
      for (const h of docHits) {
        const doc = h.document ?? h.id;
        if (doc.trim() === '') continue;
        const rank = finite(h.score);
        const current = best.get(doc);
        if (current === undefined || rank >= current) best.set(doc, rank);
      }
      const docs = [...best].sort((x, y) => y[1] - x[1]).slice(0, docTitle.maxDocs);
      const fanout = docTitle.fanout;
      const chunks = await Promise.all(
        docs.map(([doc]) =>
          unsupportedOr(
            () => knowledge.range(doc, 0, fanout - 1),
            (error): Hit[] => {
              note(`skipped doc-title fan-out: ${error.message}`);
              return [];
            },
          ),
        ),
      );
      chunks.forEach(remember);
      const hits = chunks.flatMap((list, i) =>
        list.map((h): StrategyHit => ({
          id: h.id,
          rank: (docs[i] as [string, number])[1],
          index: h.position ?? 0,
          searchType: 'doc-title',
          ...(h.document === undefined ? {} : { document: h.document }),
        })),
      );
      lists.push({ name: 'doc-title', hits: dedupeHits(hits) });
    }
    lists.push(...enrichmentLists);

    return {
      hitsPerStrategy: Object.fromEntries(lists.map((l) => [l.name, l.hits.length])),
      baseLists,
      seen,
      merged: mergeStrategyLists(
        lists.map((l) => l.hits),
        mergeOptions,
      ),
      warnings,
    };
  };

  const toChunk = (
    hit: Hit,
    info: {
      searchTypes: string[];
      hitCount: number;
      rank: number;
      index: number;
      typeRanks: Record<string, number>;
      matchedQuestions?: string[];
    },
  ): Chunk => {
    const metadata = hit.fields.metadata;
    return {
      id: hit.id,
      ...(hit.document === undefined ? {} : { document: hit.document }),
      ...(hit.position === undefined ? {} : { position: hit.position }),
      ...(hit.title === undefined ? {} : { title: hit.title }),
      ...(hit.url === undefined ? {} : { url: hit.url }),
      ...(useContent ? { text: hit.text } : {}),
      ...(typeof metadata === 'string' ? { metadata } : {}),
      ...(info.matchedQuestions ? { matchedQuestions: info.matchedQuestions } : {}),
      searchTypes: info.searchTypes,
      hitCount: info.hitCount,
      originalRank: info.rank,
      originalIndex: info.index,
      typeRanks: info.typeRanks,
      fileDigests: keepDigests ? fileDigestsOf(hit) : [],
      orgs: orgsOf(hit, config.autoFilter.orgFields),
      fields: hit.fields,
    };
  };

  const rerankList = async (list: Chunk[], query: string, content: Map<string, string>) => {
    const trace: PassTrace['rerank'] = { status: 'off', candidates: 0, ms: 0 };
    const withSnippet = (c: Chunk): Chunk => ({
      ...c,
      snippet: contentSnippet(content.get(c.id), query, config.rerank.snippetLength),
    });
    if (list.length === 0) return { chunks: list, trace };
    const candidates = list.slice(0, config.rerank.candidateK);
    const tail = list.slice(config.rerank.candidateK);
    trace.candidates = candidates.length;
    if (!input.rerank) {
      trace.status = 'unconfigured';
      return { chunks: [...candidates.map(withSnippet), ...tail], trace };
    }
    const started = now();
    const response = await input.rerank.rerank({
      query,
      documents: candidates.map((c) => rerankText(c, content.get(c.id), query, config.rerank)),
    });
    trace.ms = now() - started;
    if (response.degraded) {
      trace.status = 'degraded';
      trace.error = response.degraded.message;
      return { chunks: list, trace };
    }
    if (response.ranking.length === 0) {
      trace.status = 'empty';
      return { chunks: [...candidates.map(withSnippet), ...tail], trace };
    }
    trace.status = 'reranked';
    const byIndex = new Map(response.ranking.map((r) => [r.index, r]));
    const annotated = candidates.map((c, i) => {
      const r = byIndex.get(i);
      return r ? { ...withSnippet(c), rerankScore: r.score, rerankRank: r.rank } : c;
    });
    return {
      chunks: [...annotated.sort((x, y) => (y.rerankScore ?? 0) - (x.rerankScore ?? 0)), ...tail],
      trace,
    };
  };

  const perStrategyRerank = async (
    lists: { name: string; hits: StrategyHit[] }[],
    query: string,
    seen: Map<string, Hit>,
    note: Note,
  ) => {
    const started = now();
    const errors: string[] = [];
    const outcomes = await Promise.all(
      lists
        .filter((l) => l.hits.length > 0)
        .map(async (l) => {
          try {
            const content = new Map<string, string>();
            const selected = l.hits.slice(0, config.retrieveTopK);
            const byId = new Map(
              (
                await fetchHits(
                  selected.map((h) => h.id),
                  seen,
                  note,
                )
              ).map((h) => [h.id, h]),
            );
            const chunks = selected.flatMap((h) => {
              const hit = byId.get(h.id);
              if (!hit) return [];
              content.set(hit.id, hit.text);
              return [
                toChunk(hit, {
                  searchTypes: [],
                  hitCount: 0,
                  rank: h.rank,
                  index: h.index,
                  typeRanks: {},
                }),
              ];
            });
            const out = await rerankList(chunks, query, content);
            if (out.trace.error) errors.push(out.trace.error);
            return out.chunks;
          } catch (error) {
            if (error instanceof Error && error.name === 'RerankError') throw error;
            errors.push(messageOf(error));
            return [];
          }
        }),
    );
    const longest = Math.max(0, ...outcomes.map((o) => o.length));
    const interleaved: Chunk[] = [];
    for (let i = 0; i < longest; i++)
      for (const o of outcomes) if (o[i]) interleaved.push(o[i] as Chunk);
    const firstSeen = new Map<string, number>();
    const best = new Map<string, Chunk>();
    interleaved.forEach((c, i) => {
      if (!firstSeen.has(c.id)) firstSeen.set(c.id, i);
      const current = best.get(c.id);
      if (!current || (c.rerankScore ?? 0) >= (current.rerankScore ?? 0)) best.set(c.id, c);
    });
    const merged = [...best.values()]
      .sort(
        (x, y) =>
          (y.rerankScore ?? 0) - (x.rerankScore ?? 0) ||
          (firstSeen.get(x.id) ?? 0) - (firstSeen.get(y.id) ?? 0),
      )
      .slice(0, config.rerank.finalCap);
    return {
      chunks: merged,
      trace: {
        status: (errors.length > 0 ? 'degraded' : 'reranked') as RerankStatus,
        candidates: outcomes.reduce((n, o) => n + o.length, 0),
        ms: now() - started,
        ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
      },
    };
  };

  const pass = async (queries: string[]): Promise<{ chunks: Chunk[]; trace: PassTrace }> => {
    const notices = [...datasetNotices];
    const note: Note = (message) => {
      if (!notices.includes(message)) notices.push(message);
    };
    const detected = await detect(queries, note);
    const explicit = toSet(input.filters);
    const effective = toInput(mergeTyped(explicit, detected.filter ?? {}));
    let result = await runStrategies(queries, portFilters(effective), note);
    let fallback = false;
    if (detected.filter && effective && result.merged.length === 0) {
      result = await runStrategies(queries, portFilters(toInput(explicit)), note);
      fallback = true;
    }

    const selected = result.merged.slice(0, config.retrieveTopK);
    const fetched = await fetchHits(
      selected.map((m) => m.id),
      result.seen,
      note,
    );
    const byId = new Map(fetched.map((h) => [h.id, h]));
    const content = new Map<string, string>();
    const skipped = new Map<string, SkippedDocument>();
    const chunks = selected.flatMap((m): Chunk[] => {
      const hit = byId.get(m.id);
      if (!hit) return [];
      if (useContent && hit.text.trim() === '') {
        const document = hit.title ?? hit.document ?? hit.id;
        skipped.set(document, { document, reason: 'no_text' });
        return [];
      }
      content.set(hit.id, hit.text);
      return [toChunk(hit, m)];
    });

    const boosted = config.queryAwareBoost
      ? prioritize(
          chunks,
          queries,
          effective ?? {},
          config.autoFilter.orgFields,
          config.boostWeights,
          useContent,
        )
      : chunks;
    const maxPerDocument =
      config.maxPerDocument ??
      relaxedCap(boosted, config.diversity.defaultMaxPerDocument, config.diversity);
    const capped = capPerDocument(boosted, maxPerDocument);
    const final = config.duplicateFiles === 'never' ? capped : suppressDuplicateFiles(capped);

    const query = queries[0] ?? '';
    const reranked = !config.rerank.enabled
      ? { chunks: final, trace: { status: 'off' as RerankStatus, candidates: 0, ms: 0 } }
      : config.rerank.perStrategy
        ? await perStrategyRerank(result.baseLists, query, result.seen, note)
        : await rerankList(final, query, content);

    return {
      chunks: reranked.chunks,
      trace: {
        queries,
        hitsPerStrategy: result.hitsPerStrategy,
        merged: result.merged,
        ...(detected.filter ? { detectedFilter: toInput(detected.filter) ?? {} } : {}),
        ...(effective ? { effectiveFilter: effective } : {}),
        autoFilterFallback: fallback,
        ...(detected.error ? { autoFilterError: detected.error } : {}),
        fetched: fetched.length,
        effectiveMaxPerDocument: maxPerDocument,
        chunksBeforeDiversity: boosted.length,
        chunksAfterDiversity: final.length,
        droppedByDiversity: Math.max(0, boosted.length - capped.length),
        droppedAsDuplicateFile: Math.max(0, capped.length - final.length),
        rerank: reranked.trace,
        warnings: [...result.warnings, ...notices],
        ...(skipped.size > 0 ? { skipped: [...skipped.values()] } : {}),
      },
    };
  };

  const queries = input.queries.filter((q) => typeof q === 'string');
  const expansion = await pass(queries);
  const intent = input.userIntent?.trim();
  const union = config.userIntentUnion;
  const runUnion = union.enabled && intent && !(queries.length === 1 && queries[0] === intent);
  if (!runUnion) return { chunks: expansion.chunks, trace: { expansion: expansion.trace } };
  const intentPass = await pass([intent]);
  return {
    chunks: unionMerge(intentPass.chunks, expansion.chunks, union.mode, union.cap, union.rrfK),
    trace: {
      expansion: expansion.trace,
      intent: intentPass.trace,
      union: { mode: union.mode, cap: union.cap, rrfK: union.rrfK },
    },
  };
};
