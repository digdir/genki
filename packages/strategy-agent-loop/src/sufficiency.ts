import { sameLanguageRule } from './prompts.js';
import { json, resolveAliasOrNormalize, structuredEvaluate, type Evaluator } from './structured.js';
import type { Chunk, ChunkRange, Workspace } from './workspace.js';

export const maxSufficiencyRejections = 5;

export const evaluatorSystemPrompt =
  'You are the sufficiency gate for a solver-style RAG agent.\n' +
  'Judge whether the current evidence is sufficient to answer the user query.\n' +
  'Check explicitly for:\n' +
  '- Metric precision mismatches: the query asks for one metric/year/scope, the evidence provides another.\n' +
  '- Scope alignment: the query asks about one entity or document family, the evidence is about another.\n' +
  '- Broad platform ambiguity: when the query can refer to multiple products, APIs, or workflows, prefer ask-clarification over guessing.\n' +
  '- Contradictions: sources disagree on the value or interpretation.\n' +
  'Return JSON with keys: status, reasoning, missing_info, contradiction_detected, suggested_strategy.\n' +
  'When suggested_strategy is ask-clarification, also return clarification_question, optional options, and context_summary.\n' +
  'Allowed status values: sufficient, insufficient, conflicting, off-topic.\n' +
  'Allowed suggested_strategy values: re-search, read-more, ask-clarification, finalize.\n' +
  '\n' +
  `Reasoning / clarification-question language: ${sameLanguageRule}`;

export interface SufficiencyDecision {
  status: string;
  reasoning: string;
  missingInfo: string[];
  contradictionDetected: boolean;
  suggestedStrategy: string;
  clarificationQuestion?: string;
  options?: string[];
  contextSummary?: string;
  degraded?: boolean;
  degradedReason?: string;
  source?: string;
  message?: string;
}

interface Candidate {
  title?: string | null;
  metadata?: string | null;
  headers?: string | null;
  'content-preview'?: string;
}

export interface EvidenceSummary {
  query: string;
  'query-intent': {
    'answer-type': string;
    entity: string | null;
    'year-or-date': string | null;
    metric: string | null;
    'doc-family-preference': string | null;
    'scope-signals': string[];
  };
  'budget-state': {
    'max-search-passes': number;
    'max-read-operations': number;
    'max-read-content-length': number;
  };
  'search-history': unknown[];
  'read-history': unknown[];
  'readable-chunks': (Candidate & Record<string, unknown>)[];
  'latest-search-queries': string[];
  'latest-search-summaries': (Candidate & Record<string, unknown>)[];
  'unread-chunk-ids': string[];
  'unread-range': { 'doc-num': string; 'chunk-range': ChunkRange } | null;
}

const metricAliases: Record<string, string[]> = {
  'utførte årsverk': [
    'utførte årsverk',
    'utførte arsverk',
    'utforte årsverk',
    'utforte arsverk',
    'årsverk',
    'arsverk',
    'fte',
  ],
  'avtalte årsverk': ['avtalte årsverk', 'avtalte arsverk', 'årsverk', 'arsverk', 'fte'],
  årsverk: ['årsverk', 'arsverk', 'fte'],
  ansatte: ['ansatte', 'employees', 'staff'],
  employees: ['employees', 'staff', 'ansatte'],
  fte: ['fte', 'årsverk', 'arsverk'],
};

const normalizeText = (text: string | null | undefined) =>
  (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractYears = (text: string | null | undefined) => [
  ...new Set((text ?? '').match(/\b(?:19|20)\d{2}\b/g) ?? []),
];

const queryYear = (q: string) => extractYears(q)[0] ?? null;

const queryMetric = (query: string): string | null => {
  const q = normalizeText(query);
  if (
    q.includes('utførte årsverk') ||
    q.includes('utførte arsverk') ||
    q.includes('utforte årsverk') ||
    q.includes('utforte arsverk')
  )
    return 'utførte årsverk';
  if (q.includes('avtalte årsverk') || q.includes('avtalte arsverk')) return 'avtalte årsverk';
  if (q.includes('årsverk') || q.includes('arsverk')) return 'årsverk';
  if (q.includes('ansatte')) return 'ansatte';
  if (q.includes('employees')) return 'employees';
  if (q.includes('fte')) return 'fte';
  return null;
};

const questionWords = new Set([
  'Hva',
  'Hvem',
  'Hvor',
  'Hvordan',
  'Hvorfor',
  'Når',
  'What',
  'Who',
  'Where',
  'How',
  'Why',
  'When',
  'Compare',
  'Sammenlign',
]);

const queryEntity = (query: string): string | null => {
  const tokens = (query.match(/[A-ZÆØÅ][A-Za-zÆØÅæøå0-9.-]+/g) ?? []).filter(
    (w) => !questionWords.has(w),
  );
  return tokens.length ? tokens.join(' ') : null;
};

const queryAnswerType = (query: string) => {
  const q = normalizeText(query);
  if (['sammenlign', 'compare', 'forskjell', 'difference'].some((t) => q.includes(t)))
    return 'comparison';
  if (
    [
      'hvor mange',
      'how many',
      'antall',
      'what is the number',
      'årsverk',
      'arsverk',
      'employees',
      'ansatte',
      'fte',
    ].some((t) => q.includes(t))
  )
    return 'numeric-fact';
  return 'lookup';
};

const candidateText = (c: Candidate) =>
  normalizeText(
    `${c.title ?? ''} ${c.metadata ?? ''} ${c.headers ?? ''} ${c['content-preview'] ?? ''}`,
  );

const metricTerms = (metric: string | null) => (metric ? (metricAliases[metric] ?? [metric]) : []);

const matchesYear = (c: Candidate, year: string | null) =>
  year === null || candidateText(c).includes(normalizeText(year));
const matchesEntity = (c: Candidate, entity: string | null) => {
  const e = normalizeText(entity);
  return e === '' || candidateText(c).includes(e);
};
const matchesMetric = (c: Candidate, metric: string | null) => {
  const terms = metricTerms(metric);
  const text = candidateText(c);
  return terms.length === 0 || terms.some((t) => text.includes(normalizeText(t)));
};

const precisionMismatch = (c: Candidate, metric: string | null) => {
  const text = candidateText(c);
  if (metric === 'utførte årsverk')
    return (
      text.includes('avtalte årsverk') &&
      !text.includes('utførte årsverk') &&
      !text.includes('utforte arsverk')
    );
  if (metric === 'avtalte årsverk')
    return (
      (text.includes('utførte årsverk') || text.includes('utforte arsverk')) &&
      !text.includes('avtalte årsverk') &&
      !text.includes('avtalte arsverk')
    );
  return false;
};

const extractNumbers = (text: string) => [
  ...new Set(
    (text.match(/\d+/g) ?? [])
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isSafeInteger(n) && n <= 2147483647),
  ),
];

const metricValues = (c: Candidate, year: string | null) => {
  const text = c['content-preview'] ?? c.title ?? '';
  const ignore = new Set(extractYears(text).map(Number));
  return extractNumbers(text).filter(
    (n) => !ignore.has(n) && !(year !== null && n === Number(year)),
  );
};

const comparisonQuery = (query: string, s: EvidenceSummary) =>
  s['query-intent']['answer-type'] === 'comparison' || queryAnswerType(query) === 'comparison';

const comparisonSufficient = (query: string, s: EvidenceSummary, candidates: Candidate[]) => {
  const text = candidates.map(candidateText).join(' ');
  const numbers = [...new Set(candidates.flatMap((c) => metricValues(c, null)))];
  return (
    comparisonQuery(query, s) &&
    ((text.includes('avtalte') && (text.includes('utforte') || text.includes('utførte'))) ||
      numbers.length >= 2) &&
    ['forklaring', 'faktisk arbeid', 'budsjettert', 'planlagt'].some((t) => text.includes(t))
  );
};

const queryHasAny = (query: string, terms: string[]) => {
  const q = normalizeText(query);
  return terms.some((t) => q.includes(normalizeText(t)));
};

const presentOptionLabels = (
  candidates: Candidate[],
  specs: { label: string; aliases: string[] }[],
) => {
  const texts = candidates.map(candidateText);
  return [
    ...new Set(
      specs
        .filter((s) => texts.some((t) => s.aliases.some((a) => t.includes(normalizeText(a)))))
        .map((s) => s.label),
    ),
  ];
};

const productScope = [
  { label: 'Altinn Studio', aliases: ['altinn studio', 'studio'] },
  { label: 'Altinn Apps', aliases: ['altinn apps', 'altinn app', 'containerized applications'] },
  {
    label: 'Altinn Formidling',
    aliases: ['altinn formidling', 'formidling', 'broker', 'managed file transfer', 'mft'],
  },
  { label: 'Altinn Melding', aliases: ['altinn melding', 'melding'] },
];
const apiScope = [
  { label: 'Altinn Broker API', aliases: ['broker', 'broker api', 'overgangsløsning', 'bridge'] },
  {
    label: 'Altinn Formidling API',
    aliases: ['altinn formidling', 'formidling', 'managed file transfer', 'mft'],
  },
  { label: 'Altinn Melding API', aliases: ['altinn melding', 'melding'] },
];
const authorizationScope = [
  { label: 'Altinn-apper', aliases: ['altinn apps', 'app', 'apper'] },
  {
    label: 'Altinn-ressurser',
    aliases: ['ressursregister', 'ressurser', 'resource rights register', 'resource rights'],
  },
  {
    label: 'Fullmakter/delegering',
    aliases: ['fullmakt', 'fullmakter', 'deleg', 'tilgangspakke', 'rolle'],
  },
];

const clarificationDecision = (
  question: string,
  options: string[],
  contextSummary: string,
  reasoning: string,
  missingInfo: string[],
): SufficiencyDecision => ({
  status: 'insufficient',
  reasoning,
  missingInfo,
  contradictionDetected: false,
  suggestedStrategy: 'ask-clarification',
  clarificationQuestion: question,
  options,
  contextSummary,
});

const ambiguityClarification = (
  query: string,
  candidates: Candidate[],
): SufficiencyDecision | undefined => {
  const altinn = normalizeText(query).includes('altinn');
  const products = presentOptionLabels(candidates, productScope);
  const apis = presentOptionLabels(candidates, apiScope);
  const auth = presentOptionLabels(candidates, authorizationScope);
  if (altinn && queryHasAny(query, ['api']) && apis.length >= 2)
    return clarificationDecision(
      `Hvilket Altinn 3 API mener du: ${apis.join(', ')}?`,
      apis,
      'Kildene peker mot flere ulike Altinn 3 API-er, og spørsmålet spesifiserer ikke hvilket API du mener.',
      'The evidence spans multiple plausible Altinn 3 APIs for this query.',
      ['Need the relevant Altinn 3 API scope before answering.'],
    );
  if (
    altinn &&
    queryHasAny(query, ['autorisasjon', 'tilgang', 'fullmakt', 'delegering']) &&
    auth.length >= 2
  )
    return clarificationDecision(
      `Mener du autorisasjon for ${auth.join(', ')}?`,
      auth,
      'Altinn 3 har flere autorisasjonsmodeller, og spørsmålet spesifiserer ikke hvilket autorisasjonsområde du mener.',
      'The evidence spans multiple Altinn 3 authorization scopes for this query.',
      ['Need the relevant Altinn 3 authorization scope before answering.'],
    );
  if (
    altinn &&
    queryHasAny(query, [
      'setter jeg opp',
      'sette opp',
      'komme i gang',
      'utvikler',
      'publiser',
      'publisere',
    ]) &&
    products.length >= 2
  )
    return clarificationDecision(
      `Hvilken del av Altinn 3 mener du: ${products.join(', ')}?`,
      products,
      'Kildene peker mot flere ulike deler av Altinn 3, og spørsmålet er fortsatt for bredt til å svare presist.',
      'The evidence spans multiple Altinn 3 products or workflows for this query.',
      ['Need the relevant Altinn 3 product or workflow scope before answering.'],
    );
  return undefined;
};

const knownEntityAliases: [string, string[]][] = [
  ['digdir', ['digdir', 'digitaliseringsdirektoratet']],
  ['altinn', ['altinn']],
];

const mentions = (text: string, aliases: string[]) =>
  aliases.some((a) => text.includes(normalizeText(a)));

const offTopic = (candidates: Candidate[], entity: string | null) => {
  const e = normalizeText(entity);
  const target = knownEntityAliases.find(([k]) => e.includes(k))?.[1] ?? (e ? [e] : undefined);
  const alternates = knownEntityAliases
    .filter(
      ([, aliases]) =>
        !(target && aliases.some((a) => target.some((t) => normalizeText(a) === normalizeText(t)))),
    )
    .flatMap(([, aliases]) => aliases);
  return (
    candidates.length > 0 &&
    target !== undefined &&
    target.length > 0 &&
    !candidates.some((c) => mentions(candidateText(c), target)) &&
    candidates.some((c) => mentions(candidateText(c), alternates))
  );
};

const withStrategy = (
  status: string,
  reasoning: string,
  missingInfo: string[],
  contradiction: boolean,
  strategy: string,
): SufficiencyDecision => ({
  status,
  reasoning,
  missingInfo,
  contradictionDetected: contradiction,
  suggestedStrategy: strategy,
});

const insufficientStrategy = (s: EvidenceSummary) =>
  s['unread-chunk-ids'].length || s['unread-range'] ? 'read-more' : 're-search';

const stopWords = new Set([
  'i',
  'på',
  'en',
  'et',
  'og',
  'er',
  'det',
  'den',
  'de',
  'for',
  'til',
  'av',
  'med',
  'om',
  'fra',
  'som',
  'jeg',
  'vi',
  'du',
  'kan',
  'meg',
  'seg',
  'sin',
  'sitt',
  'the',
  'a',
  'an',
  'is',
  'are',
  'in',
  'on',
  'to',
  'of',
  'with',
  'from',
  'how',
  'what',
  'who',
  'where',
  'when',
  'why',
  'do',
  'does',
  'did',
  'hva',
  'hvem',
  'hvor',
  'hvordan',
  'hvorfor',
  'når',
]);

const topicTerms = (query: string, entity: string | null) => {
  const entityWords = new Set((entity ?? '').split(/\s+/).map(normalizeText));
  return normalizeText(query)
    .split(/\s+/)
    .filter((w) => w !== '' && !stopWords.has(w) && !entityWords.has(w) && w.length >= 3);
};

const addressesQuery = (query: string, entity: string | null, candidates: Candidate[]) => {
  const terms = topicTerms(query, entity);
  if (terms.length < 2) return true;
  const all = candidates.map(candidateText).join(' ');
  return terms.filter((t) => all.includes(t)).length >= Math.ceil(terms.length / 2);
};

export const evaluateSufficiencyHeuristically = (
  query: string,
  s: EvidenceSummary,
): SufficiencyDecision => {
  const intent = s['query-intent'];
  const candidates: Candidate[] = s['readable-chunks'].length
    ? s['readable-chunks']
    : s['latest-search-summaries'];
  const entity = intent.entity ?? queryEntity(query);
  const year = intent['year-or-date'] ?? queryYear(query);
  const metric = intent.metric ?? queryMetric(query);
  const answerType = intent['answer-type'];
  const entityMatched = candidates.filter((c) => matchesEntity(c, entity));
  const metricMatched = entityMatched.filter((c) => matchesMetric(c, metric));
  const yearMatched = metricMatched.filter((c) => matchesYear(c, year));
  const mismatches = entityMatched.filter((c) => precisionMismatch(c, metric));
  const numeric = answerType === 'numeric-fact' || answerType === 'comparison' || metric !== null;
  const values = numeric ? [...new Set(yearMatched.flatMap((c) => metricValues(c, year)))] : [];
  const allYears = [...new Set(candidates.flatMap((c) => extractYears(candidateText(c))))];
  const strategy = insufficientStrategy(s);
  const clarification = numeric ? undefined : ambiguityClarification(query, candidates);
  const forEntity = entity ? ` for ${entity}` : '';
  const forMetric = metric ? ` for "${metric}"` : '';
  const inYear = year ? ` in ${year}` : '';

  if (comparisonSufficient(query, s, candidates))
    return withStrategy(
      'sufficient',
      'The current evidence appears sufficient to answer the requested comparison.',
      [],
      false,
      'finalize',
    );
  if (candidates.length === 0)
    return withStrategy(
      'insufficient',
      'No readable evidence has been gathered yet.',
      ['Need readable evidence before answering.'],
      false,
      strategy,
    );
  if (offTopic(candidates, entity))
    return withStrategy(
      'off-topic',
      `The current evidence does not align with the requested scope${forEntity}.`,
      [`Need evidence that directly matches the requested scope${forEntity}.`],
      false,
      're-search',
    );
  if (clarification) return clarification;
  if (year && yearMatched.length === 0 && metricMatched.length > 0 && allYears.length > 0)
    return withStrategy(
      'insufficient',
      `The evidence mentions the right topic, but not the requested time period ${year}.`,
      [`Need evidence for ${year}${metric ? ` and metric "${metric}"` : ''}.`],
      false,
      're-search',
    );
  if (metric && mismatches.length > 0 && yearMatched.length === 0)
    return withStrategy(
      'insufficient',
      `The evidence mentions a related metric, but not the requested metric "${metric}".`,
      [`Need an exact match for metric "${metric}".`],
      false,
      strategy,
    );
  if (numeric && values.length > 1)
    return withStrategy(
      'conflicting',
      `The evidence contains conflicting values${forMetric}${inYear}: ${values.join(', ')}.`,
      [`Need a canonical or scope-disambiguated value${forMetric}${inYear}.`],
      true,
      strategy,
    );
  if (answerType === 'numeric-fact' && metric && values.length === 0)
    return withStrategy(
      'insufficient',
      'The evidence is on-topic, but it does not yet provide the requested concrete value.',
      [`Need the exact reported value${forMetric}${inYear}.`],
      false,
      strategy,
    );
  if (!numeric && !addressesQuery(query, entity, candidates))
    return withStrategy(
      'insufficient',
      'The evidence mentions the right entity but does not appear to address the specific question.',
      ['Need evidence that directly addresses the question topic.'],
      false,
      strategy,
    );
  return withStrategy(
    'sufficient',
    'The current evidence appears sufficient to answer the query.',
    [],
    false,
    'finalize',
  );
};

const statusAliases = { enough: 'sufficient', conflict: 'conflicting' };
const strategyAliases = { stop: 'finalize', 'answer-with-uncertainty': 'finalize' };

const nonEmpty = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

export const normalizeDecision = (
  raw: Record<string, unknown> | SufficiencyDecision,
): SufficiencyDecision => {
  const d = raw as Record<string, unknown>;
  const question = nonEmpty(
    d.clarificationQuestion ?? d['clarification-question'] ?? d.clarification_question,
  );
  const options = Array.isArray(d.options)
    ? d.options.filter((o): o is string => typeof o === 'string' && o !== '')
    : [];
  const context = nonEmpty(d.contextSummary ?? d['context-summary'] ?? d.context_summary);
  const missing = d.missingInfo ?? d['missing-info'] ?? d.missing_info;
  return {
    status: resolveAliasOrNormalize(d.status, statusAliases) ?? '',
    reasoning:
      typeof d.reasoning === 'string' && d.reasoning
        ? d.reasoning
        : 'No sufficiency reasoning captured.',
    missingInfo: Array.isArray(missing) ? missing.map(String) : [],
    contradictionDetected: Boolean(
      d.contradictionDetected ??
      d['contradiction-detected?'] ??
      d.contradiction_detected ??
      d['contradiction_detected?'],
    ),
    suggestedStrategy:
      resolveAliasOrNormalize(
        d.suggestedStrategy ?? d['suggested-strategy'] ?? d.suggested_strategy ?? 're-search',
        strategyAliases,
      ) ?? 're-search',
    ...(question ? { clarificationQuestion: question } : {}),
    ...(options.length ? { options } : {}),
    ...(context ? { contextSummary: context } : {}),
  };
};

export const heuristicDecision = (query: string, s: EvidenceSummary): SufficiencyDecision => ({
  ...normalizeDecision(evaluateSufficiencyHeuristically(query, s)),
  degraded: true,
  degradedReason: 'heuristic-fallback',
});

export const buildEvaluatorPrompt = (query: string, s: EvidenceSummary) =>
  `User query:\n${query}\n\nEvidence summary JSON:\n${json(s)}\n\nReturn only JSON.`;

export const evaluateSufficiency = (
  query: string,
  s: EvidenceSummary,
  llm: Evaluator | undefined,
  signal: AbortSignal,
): Promise<SufficiencyDecision> =>
  llm
    ? structuredEvaluate({
        llm,
        system: evaluatorSystemPrompt,
        user: buildEvaluatorPrompt(query, s),
        normalize: (parsed) => ({ ...normalizeDecision(parsed), degraded: false }),
        fallback: () => heuristicDecision(query, s),
        signal,
      })
    : Promise.resolve(heuristicDecision(query, s));

const preview = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}...` : text;

export const buildEvidenceSummary = (w: Workspace, query: string): EvidenceSummary => {
  const intent = w.queryIntent;
  const byPriority = (a: { c: Chunk }, b: { c: Chunk }) =>
    -(a.c.score ?? 0) + (b.c.score ?? 0) ||
    -(a.c.hitCount ?? 0) + (b.c.hitCount ?? 0) ||
    -(a.c.rank ?? 0) + (b.c.rank ?? 0);
  const readable = w
    .workspaceChunks()
    .map((c, i) => ({ c, i }))
    .sort((a, b) => byPriority(a, b) || b.i - a.i)
    .slice(0, 8)
    .sort((a, b) => byPriority(a, b) || a.i - b.i)
    .map(({ c }) => ({
      'chunk-id': c.chunkId,
      'doc-num': c.document ?? null,
      'chunk-index': c.position ?? null,
      title: c.title ?? null,
      metadata: c.headers?.length ? JSON.stringify(c.headers) : null,
      'content-preview': preview(c.content, 500),
      ...(c.matchedQuestions?.length ? { 'matched-questions': c.matchedQuestions } : {}),
    }));
  const latest = w.searches.at(-1);
  const readIds = new Set(w.reads.flatMap((r) => r.returnedChunkIds));
  const latestSummaries = latest?.summaries ?? [];
  const unread = latestSummaries.filter((s) => !readIds.has(s['chunk-id']));
  const rangeAnchor = unread.find(
    (s) =>
      s['doc-num'] !== null &&
      s['chunk-index'] !== null &&
      (s['total-chunks'] === null || s['total-chunks'] > 1),
  );
  const pick = (s: (typeof latestSummaries)[number]) => ({
    'chunk-id': s['chunk-id'],
    'doc-num': s['doc-num'],
    'chunk-index': s['chunk-index'],
    title: s.title,
    headers: s.headers,
    'content-length': s['content-length'],
  });
  return {
    query,
    'query-intent': {
      'answer-type': intent?.['answer-type'] ?? queryAnswerType(query),
      entity: intent?.entity ?? queryEntity(query),
      'year-or-date': intent?.['year-or-date'] ?? queryYear(query),
      metric: intent?.metric ?? queryMetric(query),
      'doc-family-preference': intent?.['doc-family-preference'] ?? null,
      'scope-signals': intent?.['scope-signals'] ?? [],
    },
    'budget-state': {
      'max-search-passes': w.limits.searches,
      'max-read-operations': w.limits.reads,
      'max-read-content-length': w.limits.readChars,
    },
    'search-history': w.searches.map((e) => ({
      queries: e.queries,
      'result-count': e.resultCount,
      'new-count': e.newCount,
      'fallback?': e.fallback,
      'chunk-summaries': e.summaries.map((s) => ({
        ...pick(s),
        ...(s['matched-questions']?.length ? { 'matched-questions': s['matched-questions'] } : {}),
      })),
    })),
    'read-history': w.reads.map((r) => ({
      mode: r.mode,
      ...(r.chunkIds ? { 'chunk-ids': r.chunkIds } : {}),
      ...(r.document === undefined ? {} : { 'doc-num': r.document }),
      ...(r.chunkRange ? { 'chunk-range': r.chunkRange } : {}),
      'returned-count': r.returnedCount,
      'content-length': r.contentLength,
    })),
    'readable-chunks': readable,
    'latest-search-queries': latest?.queries ?? [],
    'latest-search-summaries': latestSummaries.map(pick),
    'unread-chunk-ids': unread.slice(0, 3).map((s) => s['chunk-id']),
    'unread-range': rangeAnchor
      ? {
          'doc-num': rangeAnchor['doc-num'] as string,
          'chunk-range': {
            from: Math.max(0, (rangeAnchor['chunk-index'] as number) - 1),
            to:
              rangeAnchor['total-chunks'] === null
                ? (rangeAnchor['chunk-index'] as number) + 1
                : Math.min(
                    rangeAnchor['total-chunks'] - 1,
                    (rangeAnchor['chunk-index'] as number) + 1,
                  ),
          },
        }
      : null,
  };
};

const missingSuffix = (d: SufficiencyDecision) =>
  d.missingInfo.length ? ` Missing info: ${d.missingInfo.join('; ')}.` : '';

const readMoreSuggestions = (s: EvidenceSummary | undefined) =>
  (s?.['unread-chunk-ids'].length
    ? ` Suggested next call: read_chunks ${json({ chunk_ids: s['unread-chunk-ids'] })}.`
    : '') +
  (s?.['unread-range']
    ? ` Or expand local context with read_chunks ${json({ doc_num: s['unread-range']['doc-num'], chunk_range: s['unread-range']['chunk-range'] })}.`
    : '');

const ednSeq = (xs: string[]) => `(${xs.map((x) => JSON.stringify(x)).join(' ')})`;

export const formatReadMoreHint = (d: SufficiencyDecision, s: EvidenceSummary | undefined) =>
  `[SYSTEM: Sufficiency gate rejected the current evidence. ${d.reasoning}${missingSuffix(d)} Read more from the current result set before searching again.${readMoreSuggestions(s)}]`;

export const formatFinalizeHint = (d: SufficiencyDecision) =>
  `[SYSTEM: Sufficiency gate passed. ${d.reasoning} Do not search or read more. Use generate_response now to finalize the answer from the evidence already in the workspace.]`;

export const formatClarificationHint = (d: SufficiencyDecision) =>
  `[SYSTEM: Sufficiency gate rejected the evidence because the query is still ambiguous or off-topic. ${d.reasoning}${missingSuffix(d)} Ask the user a concise clarification question instead of continuing to search.]`;

export const formatFinalizeWithUncertaintyHint = (d: SufficiencyDecision) =>
  `[SYSTEM: Sufficiency gate cannot resolve the remaining gap within budget. ${d.reasoning}${missingSuffix(d)} Finalize with an explicit uncertainty or conflict explanation rather than continuing to search.]`;

export const formatGroundingHint = (d: SufficiencyDecision) =>
  `[SYSTEM: Grounding gate rejected the answer. ${d.reasoning} Do one of two things: (1) cite the specific retrieved chunks that support each claim, using their [N] markers; or (2) state plainly that the knowledge base does not cover this question. Do NOT answer from prior knowledge or memory — an uncited answer is indistinguishable to the reader from a sourced one.]`;

export const groundingDecision = (w: Workspace): SufficiencyDecision | undefined => {
  const cv = w.citationValidation;
  if (!cv || cv.grounded) return undefined;
  return {
    status: 'insufficient',
    source: 'grounding-gate',
    suggestedStrategy: 'grounding',
    reasoning: `The generated answer cites no retrieved source (${cv.totalReferences} reference(s), ${cv.validIndices.length} valid), so nothing in it is traceable to the knowledge base.`,
    missingInfo: ['a citation to a retrieved chunk supporting the answer'],
    contradictionDetected: false,
  };
};

export const enforceSufficiencyLimit = (
  w: Workspace,
  d: SufficiencyDecision,
): SufficiencyDecision =>
  d.status !== 'sufficient' && w.countSufficiencyRejections() >= maxSufficiencyRejections - 1
    ? {
        ...d,
        suggestedStrategy: 'finalize',
        reasoning: `${d.reasoning} Reached the sufficiency retry limit; finalize with the best supported uncertainty or conflict explanation.`,
      }
    : d;

export const gateSystemHint = (
  query: string,
  d: SufficiencyDecision,
  s: EvidenceSummary | undefined,
): string => {
  switch (d.suggestedStrategy) {
    case 'read-more':
      return formatReadMoreHint(d, s);
    case 'ask-clarification':
      return formatClarificationHint(d);
    case 'grounding':
      return formatGroundingHint(d);
    case 'finalize':
      return d.status === 'sufficient'
        ? formatFinalizeHint(d)
        : formatFinalizeWithUncertaintyHint(d);
    case 're-search':
      return (
        `[SYSTEM: Sufficiency gate rejected the current evidence. ${d.reasoning}${missingSuffix(d)}` +
        (s?.['latest-search-queries'].length
          ? ` Avoid repeating the latest queries verbatim: ${ednSeq(s['latest-search-queries'])}.`
          : '') +
        ' Start a more targeted search and then read the new hits before finalizing.]'
      );
    default:
      return `[SYSTEM: Sufficiency gate rejected the current evidence for query ${JSON.stringify(query)}. ${d.reasoning}]`;
  }
};

export const responseValidationHint = (
  query: string,
  d: SufficiencyDecision,
  s: EvidenceSummary | undefined,
): string => {
  switch (d.suggestedStrategy) {
    case 'read-more':
      return `[SYSTEM: Response validation rejected the draft answer. ${d.reasoning}${missingSuffix(d)} Read more from the current result set before generating again.${readMoreSuggestions(s)}]`;
    case 'ask-clarification':
      return `[SYSTEM: Response validation rejected the draft answer because the query is still ambiguous or off-topic. ${d.reasoning}${missingSuffix(d)} Ask the user a concise clarification question instead of generating another answer.]`;
    case 'finalize':
      return d.status === 'sufficient'
        ? `[SYSTEM: Response validation passed. ${d.reasoning} Finalize the answer without more search or reading.]`
        : `[SYSTEM: Response validation found unresolved gaps that cannot be closed within budget. ${d.reasoning}${missingSuffix(d)} Finalize with an explicit uncertainty or conflict explanation.]`;
    case 're-search':
      return (
        `[SYSTEM: Response validation rejected the draft answer. ${d.reasoning}${missingSuffix(d)}` +
        (s?.['latest-search-queries'].length
          ? ` Avoid repeating the latest queries verbatim: ${ednSeq(s['latest-search-queries'])}.`
          : '') +
        ' Start a more targeted search, read the new hits, and then generate again.]'
      );
    default:
      return `[SYSTEM: Response validation rejected the draft answer for query ${JSON.stringify(query)}. ${d.reasoning}]`;
  }
};

export interface ClarificationRequest {
  question: string;
  options: string[] | null;
  'context-summary': string;
}

export const clarificationRequest = (d: SufficiencyDecision): ClarificationRequest => ({
  question:
    d.clarificationQuestion ??
    (d.missingInfo[0] !== undefined
      ? `I need one clarification before I continue: ${d.missingInfo[0]}`
      : undefined) ??
    (d.reasoning || 'Can you clarify what you mean?'),
  options: d.options?.length ? d.options : null,
  'context-summary': d.contextSummary ?? (d.reasoning || 'The current request is still ambiguous.'),
});

export const shadowGateDecision = (w: Workspace): SufficiencyDecision | undefined => {
  const d = w.shadowDecisions.at(-1);
  if (!d || (d.status !== 'sufficient' && d.status !== 'insufficient')) return undefined;
  return {
    source: 'shadow-read-signals',
    status: d.status,
    reasoning: `Aggregated read signals: ${d.reasonCode || 'unknown'}`,
    missingInfo: d.missingClaims,
    contradictionDetected: d.contradictions.length > 0,
    suggestedStrategy: d.suggestedStrategy,
    message: 'Shadow read-signal aggregation',
  };
};

export const confidentReadSignalFinalize = (w: Workspace) => {
  const shadow = w.shadowDecisions.at(-1);
  const last = w.lastReadSignal;
  return (
    shadow?.status === 'sufficient' &&
    last?.status === 'support-found' &&
    last.scopeAssessment === 'aligned' &&
    !last.degraded &&
    (last.evaluationMode === 'llm' || last.evaluationMode === 'degraded-fallback') &&
    w.openGaps.length === 0 &&
    w.contradictions.length === 0
  );
};

export const shouldRunResponseValidation = (w: Workspace) => {
  const answerType = w.queryIntent?.['answer-type'];
  return (
    answerType === 'comparison' || answerType === 'explanation' || !confidentReadSignalFinalize(w)
  );
};
