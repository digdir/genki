import type { BlockZone } from './blocks.js';

export type BlockFieldType = 'string' | 'number' | 'boolean' | 'date' | 'url' | 'enum' | 'list';

export interface BlockField {
  type: BlockFieldType;
  /** The values of an `enum`. */
  values?: readonly string[];
  /** A list's most elements, or a string's most characters. */
  max?: number;
  /** A list of plain values instead of objects with fields of their own. */
  of?: 'string';
  /** The zones a block reads it in; every zone without it. */
  zones?: readonly BlockZone[];
}

export const blockDataLimits = {
  sources: 50,
  filterFields: 30,
  filterValues: 50,
  threads: 50,
  excerpt: 1_000,
  text: 20_000,
} as const;

/** Every field a declarative or code block may read, by canonical path. */
export const blockFields: Readonly<Record<string, BlockField>> = {
  'question.text': { type: 'string', max: blockDataLimits.text },
  'answer.text': { type: 'string', max: blockDataLimits.text },
  'answer.status': { type: 'enum', values: ['waiting', 'streaming', 'done', 'failed'] },
  'answer.noAnswer': { type: 'boolean' },
  'answer.createdAt': { type: 'date' },
  sources: { type: 'list', max: blockDataLimits.sources },
  'sources.index': { type: 'number' },
  'sources.title': { type: 'string' },
  'sources.url': { type: 'url' },
  'sources.documentType': { type: 'string' },
  'sources.publisher': { type: 'string' },
  'sources.publishedAt': { type: 'date' },
  'sources.excerpt': { type: 'string', max: blockDataLimits.excerpt },
  'filters.corpus': { type: 'string' },
  'filters.fields': { type: 'list', max: blockDataLimits.filterFields },
  'filters.fields.id': { type: 'string' },
  'filters.fields.label': { type: 'string' },
  'filters.fields.values': { type: 'list', of: 'string', max: blockDataLimits.filterValues },
  'thread.title': { type: 'string' },
  threads: { type: 'list', max: blockDataLimits.threads, zones: ['primary', 'secondary'] },
  'threads.title': { type: 'string' },
  'threads.updatedAt': { type: 'date' },
  'threads.current': { type: 'boolean' },
  'service.name': { type: 'string' },
  locale: { type: 'enum', values: ['nb', 'nn', 'en'] },
};

export const blockFieldRoots = [
  'question',
  'answer',
  'sources',
  'filters',
  'thread',
  'threads',
  'service',
  'locale',
] as const;

export const fieldOf = (path: string): BlockField | undefined =>
  Object.hasOwn(blockFields, path) ? blockFields[path] : undefined;

/** A path with an alias in front read as the list path it stands for: `source.title` as `sources.title`. */
export const canonicalPath = (path: string, aliases: ReadonlyMap<string, string>) => {
  const dot = path.indexOf('.');
  const head = dot < 0 ? path : path.slice(0, dot);
  const list = aliases.get(head);
  return list === undefined ? path : `${list}${dot < 0 ? '' : path.slice(dot)}`;
};

export interface BlockSourceData {
  index?: number;
  title?: string;
  url?: string;
  documentType?: string;
  publisher?: string;
  publishedAt?: string;
  excerpt?: string;
}

export interface BlockData {
  question?: { text?: string };
  answer?: {
    text?: string;
    status?: 'waiting' | 'streaming' | 'done' | 'failed';
    noAnswer?: boolean;
    createdAt?: string;
  };
  sources?: BlockSourceData[];
  filters?: { corpus?: string; fields?: { id?: string; label?: string; values?: string[] }[] };
  thread?: { title?: string };
  threads?: { title?: string; updatedAt?: string; current?: boolean }[];
  service?: { name?: string };
  locale?: 'nb' | 'nn' | 'en';
}
