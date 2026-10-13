import type { ConversationTurn } from './workspace.js';

export type AnswerType = 'numeric-fact' | 'comparison' | 'definition' | 'explanation' | 'lookup';

export interface QueryIntent {
  'answer-type': AnswerType;
  entity: string | null;
  'year-or-date': string | null;
  metric: string | null;
  'doc-family-preference': string | null;
  'scope-signals': string[];
}

const yearPattern = /\b(?:19|20)\d{2}\b/;

export const extractTargetYear = (text: string): string | null =>
  yearPattern.exec(text)?.[0] ?? null;

const historyText = (history: ConversationTurn[]) => history.map((m) => m.text).join(' ');

const inferTargetMetric = (query: string): string | null => {
  const q = query.toLowerCase();
  if (q.includes('årsverk')) return 'årsverk';
  if (q.includes('ansatte')) return 'ansatte';
  if (q.includes('stillinger')) return 'stillinger';
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

const capitalised = /[A-ZÆØÅ][A-Za-zÆØÅæøå0-9.-]+/g;

const inferTargetEntity = (query: string): string | null => {
  const primary = query.split(/(?:\?\s+|(?<!\S)(?:Hvis|If)\b)/, 2)[0] ?? '';
  const words = (primary.match(capitalised) ?? []).filter((w) => !questionWords.has(w));
  return words.length ? words.join(' ') : null;
};

const inferAnswerType = (query: string): AnswerType => {
  const q = query.toLowerCase();
  if (
    ['hvor mange', 'kor mange', 'how many', 'antall', 'hva er tallet', 'what is the number'].some(
      (t) => q.includes(t),
    )
  )
    return 'numeric-fact';
  if (['sammenlign', 'compare', 'forskjell', 'versus', 'vs'].some((t) => q.includes(t)))
    return 'comparison';
  if (
    q.startsWith('hva er') ||
    q.startsWith('what is') ||
    q.includes('definisjon') ||
    q.includes('definition')
  )
    return 'definition';
  if (['hvorfor', 'why', 'hvordan', 'how'].some((t) => q.startsWith(t))) return 'explanation';
  return 'lookup';
};

const inferDocFamilyPreference = (query: string, history: ConversationTurn[]): string | null => {
  const combined = `${query.toLowerCase()} ${historyText(history).toLowerCase()}`;
  if (combined.includes('årsrapport') || combined.includes('annual report')) return 'årsrapport';
  if (combined.includes('tildelingsbrev') || combined.includes('allocation letter'))
    return 'tildelingsbrev';
  if (extractTargetYear(query) && inferTargetMetric(query)) return 'årsrapport';
  return null;
};

const inferScopeSignals = (query: string, history: ConversationTurn[]): string[] => {
  const text = `${query} ${historyText(history)}`;
  const c = text.toLowerCase();
  return [
    ...(extractTargetYear(text) ? ['year-bounded'] : []),
    ...(c.includes('digdir') || c.includes('digitaliseringsdirektoratet')
      ? ['organization-bounded']
      : []),
    ...(c.includes('2022') || c.includes('2021') || c.includes('2020') ? ['time-specific'] : []),
    ...(c.includes('konsern') || c.includes('group') || c.includes('hele virksomheten')
      ? ['group-scope']
      : []),
    ...(['utførte', 'avtalte', 'faste', 'midlertidige'].some((t) => c.includes(t))
      ? ['qualified-metric']
      : []),
  ];
};

export const inferQueryIntent = (query: string, history: ConversationTurn[]): QueryIntent => ({
  'answer-type': inferAnswerType(query),
  entity: inferTargetEntity(query) ?? inferTargetEntity(historyText(history)),
  'year-or-date': extractTargetYear(query) ?? extractTargetYear(historyText(history)),
  metric: inferTargetMetric(query) ?? inferTargetMetric(historyText(history)),
  'doc-family-preference': inferDocFamilyPreference(query, history),
  'scope-signals': inferScopeSignals(query, history),
});

export const normalizeQueryText = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const semanticQueryExpansions: [string, string[]][] = [
  ['årsverk', ['utførte årsverk', 'antall ansatte', 'fte', 'full-time equivalents']],
  ['ansatte', ['bemanning', 'employees', 'staff']],
  ['årsrapport', ['årsmelding', 'annual report']],
  ['årsmelding', ['årsrapport', 'annual report']],
  ['rapport', ['report']],
  ['forskrift', ['regulation']],
  ['veileder', ['guidance']],
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractYears = (text: string) => [
  ...new Set([...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0])),
];

const detectNorwegianQuery = (text: string) => {
  const n = normalizeQueryText(text);
  return (
    /[æøå]/.test(n) ||
    [
      ' hvordan ',
      ' hva ',
      ' hvor ',
      ' hvilke ',
      ' årsverk',
      ' ansatte',
      ' årsmelding',
      ' årsrapport',
    ].some((t) => n.includes(t))
  );
};

export const queryExpansionTerms = (text: string): string[] => {
  const n = normalizeQueryText(text);
  const expansions = semanticQueryExpansions.flatMap(([needle, terms]) =>
    new RegExp(`(?<!\\p{L})${escapeRegex(needle)}(?!\\p{L})`, 'u').test(n) ? terms : [],
  );
  const focus = [
    ...(/\b(hvor mange|antall|how many|number of)\b/.test(n)
      ? ['eksakt tall', 'oppgitt', 'reported figure']
      : []),
    ...(extractYears(n).length ? ['årsrapport', 'annual report'] : []),
    ...(/\b(når|when|date|dato)\b/.test(n) ? ['tidslinje', 'date', 'published'] : []),
  ];
  return [...new Set([...expansions, ...focus])];
};

const joinQueryParts = (...parts: (string | null | undefined)[]) =>
  parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(' ');

export const uniqueNormalizedQueries = (queries: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const n = normalizeQueryText(q);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
};

const intentAwareQueryVariants = (query: string, intent: QueryIntent, extraTerms: string[]) => {
  const { metric, entity } = intent;
  const year = intent['year-or-date'];
  const metricExpansions = queryExpansionTerms(metric ?? query).filter(
    (t) => normalizeQueryText(t) !== normalizeQueryText(metric ?? ''),
  );
  const metricSpecific = metricExpansions[0];
  const disambiguating = metricExpansions[1] ?? extraTerms[0];
  const numericFocus =
    intent['answer-type'] === 'numeric-fact'
      ? detectNorwegianQuery(query)
        ? 'oppgitt tall'
        : 'reported figure'
      : undefined;
  return uniqueNormalizedQueries([
    joinQueryParts(metric, entity, year),
    joinQueryParts(metricSpecific, entity, year),
    joinQueryParts(entity, intent['doc-family-preference'], year, metric),
    joinQueryParts(entity, disambiguating, metric, year),
    joinQueryParts(entity, metric, year, numericFocus),
  ]);
};

export const plannedQueryBatch = (
  query: string,
  history: ConversationTurn[],
  plannerPhrases: string[],
  extraTerms: string[] = [],
): string[] => {
  const generated = intentAwareQueryVariants(query, inferQueryIntent(query, history), extraTerms);
  return uniqueNormalizedQueries([...plannerPhrases, ...generated]).slice(0, 6);
};
