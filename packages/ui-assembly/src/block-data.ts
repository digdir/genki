import { fieldOf, type BlockData, type BlockSourceData } from '@genai/contracts/block-fields';
import type { BlockState, BlockZone } from '@genai/contracts/blocks';
import type { ThreadRow, Turn } from './api.js';

export interface BlockContext {
  serviceName?: string | undefined;
  locale?: 'nb' | 'nn' | 'en' | undefined;
  threadTitle?: string | undefined;
  threads?: readonly ThreadRow[] | undefined;
  currentThread?: string | undefined;
  corpus?: string | undefined;
  filters?: readonly { id: string; label: string; values: readonly string[] }[] | undefined;
}

const statusOf = (turn: Turn): 'waiting' | 'streaming' | 'done' | 'failed' => {
  const status = turn.answer?.status;
  if (!status) return 'waiting';
  if (status === 'streaming') return 'streaming';
  return status === 'complete' ? 'done' : 'failed';
};

const isoOf = (value: string | number | Date) => new Date(value).toISOString();

const sourceOf = (source: NonNullable<NonNullable<Turn['answer']>['sources']>[number]) => {
  const data: BlockSourceData = { title: source.title };
  if (source.index !== undefined) data.index = source.index;
  if (source.url !== undefined) data.url = source.url;
  if (source.documentType !== undefined) data.documentType = source.documentType;
  if (source.publisher !== undefined) data.publisher = source.publisher;
  if (source.publishedAt !== undefined) data.publishedAt = source.publishedAt;
  const excerpt = source.excerpt ?? source.excerpts[0]?.text;
  if (excerpt !== undefined) data.excerpt = excerpt;
  return data;
};

/** What a ref block in `zone` is given: in `main` its own turn, elsewhere the latest one. */
export const blockData = (
  zone: BlockZone,
  turn: Turn | undefined,
  context: BlockContext,
): BlockData => {
  const data: BlockData = {};
  if (context.locale) data.locale = context.locale;
  if (context.serviceName) data.service = { name: context.serviceName };
  if (context.threadTitle) data.thread = { title: context.threadTitle };
  if (context.corpus || context.filters)
    data.filters = {
      ...(context.corpus ? { corpus: context.corpus } : {}),
      ...(context.filters
        ? {
            fields: context.filters.map((f) => ({
              id: f.id,
              label: f.label,
              values: [...f.values],
            })),
          }
        : {}),
    };
  if (zone !== 'main' && context.threads)
    data.threads = context.threads.map((thread) => ({
      title: thread.title,
      updatedAt: isoOf(thread.updatedAt),
      ...(thread.id === context.currentThread ? { current: true } : {}),
    }));
  if (!turn) return data;
  data.question = { text: turn.question };
  data.answer = {
    status: statusOf(turn),
    ...(turn.answer ? { text: turn.answer.text, createdAt: isoOf(turn.answer.created) } : {}),
    ...(turn.answer?.noAnswer ? { noAnswer: true } : {}),
  };
  if (turn.answer?.sources) data.sources = turn.answer.sources.map(sourceOf);
  return data;
};

type Wanted = Map<string, Wanted>;

const wantedOf = (reads: readonly string[]) => {
  const root: Wanted = new Map();
  for (const path of reads) {
    if (!fieldOf(path)) continue;
    let node = root;
    for (const segment of path.split('.')) {
      const next = node.get(segment) ?? new Map();
      node.set(segment, next);
      node = next;
    }
  }
  return root;
};

const capped = (value: unknown, path: string): unknown => {
  const field = path ? fieldOf(path) : undefined;
  if (typeof value === 'string') return field?.max ? value.slice(0, field.max) : value;
  if (Array.isArray(value))
    return value
      .slice(0, field?.max ?? 0)
      .map((item) => capped(item, item && typeof item === 'object' ? path : `${path}[]`));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, capped(v, path ? `${path}.${key}` : key)]),
    );
  return value;
};

const picked = (value: unknown, path: string, wanted: Wanted): unknown => {
  if (value === undefined) return undefined;
  if (wanted.size === 0) return capped(value, path);
  if (Array.isArray(value))
    return value.slice(0, fieldOf(path)?.max ?? 0).map((item) => picked(item, path, wanted));
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, child] of wanted) {
    const next = picked(
      (value as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
      child,
    );
    if (next !== undefined) out[key] = next;
  }
  return out;
};

/** Only the fields a block reads, with every list and text within the field list's limits. */
export const pickReads = (data: BlockData, reads: readonly string[]): BlockData => {
  const wanted = wantedOf(reads);
  return (wanted.size === 0 ? {} : picked(data, '', wanted)) as BlockData;
};

/** The state the host sets for a block from its turn. */
export const blockState = (turn: Turn | undefined): BlockState => {
  if (!turn) return 'empty';
  const answer = turn.answer;
  if (!answer) return 'loading';
  if (answer.status === 'streaming') return 'partial';
  if (answer.status !== 'complete') return 'error';
  return answer.noAnswer ? 'empty' : 'filled';
};
