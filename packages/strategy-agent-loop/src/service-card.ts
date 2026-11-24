import { norwegianDate } from './prompts.js';
import type { SourceFactsReport } from './source-facts.js';
import type { AgentRetrieval } from './workspace.js';

export interface CardSource {
  name: string;
  inScope: boolean;
  documents?: number;
  years?: { field: string; from: string; to: string };
}

export interface CardFacts {
  sources: CardSource[];
  filterFields: string[];
  complete: boolean;
}

export interface ServiceCard extends CardFacts {
  name: string;
  purpose?: string;
  searchable: boolean;
  languages: readonly string[];
  filtered: boolean;
  today: Date;
}

const languageNames: Record<string, string> = {
  nb: 'Norwegian bokmål',
  nn: 'Norwegian nynorsk',
  en: 'English',
};

export const cardSourcesOf = (facts: SourceFactsReport[]): CardSource[] =>
  facts.map((fact) => {
    const years = (fact.yearField ? (fact.filterValues[fact.yearField] ?? []) : [])
      .map((v) => v.value)
      .filter((v) => /^\d{4}$/.test(v))
      .sort();
    const from = years[0];
    const to = years.at(-1);
    return {
      name: fact.name ?? fact.id,
      inScope: fact.inScope,
      ...(fact.documents === undefined ? {} : { documents: fact.documents }),
      ...(fact.yearField && from && to ? { years: { field: fact.yearField, from, to } } : {}),
    };
  });

export const collectCardFacts = async (
  retrieval: AgentRetrieval,
  signal: AbortSignal,
): Promise<CardFacts> => {
  const [facts, fields] = await Promise.all([
    retrieval.sourceFacts
      ? retrieval.sourceFacts({ newest: 0, maxValues: 50 }, signal).then(
          (found) => ({ ok: true, sources: cardSourcesOf(found) }),
          () => ({ ok: false, sources: [] }),
        )
      : Promise.resolve({ ok: true, sources: [] }),
    retrieval.filterFields(signal).then(
      (found) => ({ ok: true, names: found.map((f) => f.field) }),
      () => ({ ok: false, names: [] as string[] }),
    ),
  ]);
  return { sources: facts.sources, filterFields: fields.names, complete: facts.ok && fields.ok };
};

const sourceLine = (source: CardSource) => {
  if (!source.inScope) return `- ${JSON.stringify(source.name)}: outside the active filters`;
  const parts = [
    source.documents === undefined
      ? 'number of documents unknown'
      : `${source.documents} documents`,
    ...(source.years
      ? [
          source.years.from === source.years.to
            ? `${source.years.field} ${source.years.from}`
            : `${source.years.field} from ${source.years.from} to ${source.years.to}`,
        ]
      : []),
  ];
  return `- ${JSON.stringify(source.name)}: ${parts.join(', ')}`;
};

export const serviceCardText = (card: ServiceCard, forAnswer = false): string => {
  const languages = card.languages.map((l) => languageNames[l] ?? l);
  return [
    'About this service:',
    `You are the service ${JSON.stringify(card.name)}.${card.purpose?.trim() ? ` Its purpose: ${card.purpose.trim()}` : ''}`,
    `When the user says "du", "dere" or "you", they mean this service${card.searchable ? ' and its document collection' : ''}, not this conversation.${card.searchable ? ' A question such as "what is the newest document you have" asks about the collection.' : ''}`,
    ...(card.sources.length
      ? [
          `Its document collection${card.filtered ? ', within the active filters' : ''}:`,
          ...card.sources.map(sourceLine),
        ]
      : []),
    ...(card.filterFields.length && !forAnswer
      ? [
          `Fields the collection can be filtered on: ${card.filterFields.join(', ')}. inspect_filters gives their values.`,
        ]
      : []),
    ...(languages.length ? [`Answer languages: ${languages.join(', ')}.`] : []),
    ...(forAnswer ? [] : [`Today's date is ${norwegianDate(card.today)} (Norwegian time).`]),
  ].join('\n');
};

const cardTtlMs = 5 * 60_000;
const cardCacheSize = 200;

export const cardFactsCache = (now: () => Date) => {
  const entries = new Map<string, { at: number; facts: CardFacts }>();
  return async (key: string, collect: () => Promise<CardFacts>): Promise<CardFacts> => {
    const at = now().getTime();
    const hit = entries.get(key);
    if (hit && at - hit.at < cardTtlMs) return hit.facts;
    const facts = await collect();
    if (facts.complete) {
      if (entries.size >= cardCacheSize) entries.clear();
      entries.set(key, { at, facts });
    }
    return facts;
  };
};
