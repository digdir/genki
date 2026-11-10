import {
  HttpError,
  shortTitle,
  sourceFromWire,
  type AnswerData,
  type AssistantApi,
  type FieldSpec,
  type ThreadRow,
  type Turn,
} from '@genai/ui-assembly';
import { modelRowsFromDefinition, type ModelRow } from '@genai/ui-blocks/builder';
import type { ApiClient } from '../../../api';
import type {
  PlaygroundHistoryTurn,
  PlaygroundResult,
  PlaygroundSetup,
  PlaygroundSource,
  PlaygroundStreamEvent,
} from '../../../api/playground';
import { withDraftService } from '../../../components/playground/PlaygroundPanel';
import { initialSetup } from '../../../data/playground';
import { draftServiceOf, type DraftSource } from './draftService';

type AskEvent = AssistantApi['ask'] extends (...args: never[]) => AsyncGenerator<infer E>
  ? E
  : never;
type Source = Extract<AskEvent, { type: 'done' }>['answer']['sources'][number];
type FilterSet = NonNullable<Parameters<AssistantApi['ask']>[0]['filters']>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The draft with the reader's filter added to every variant's own, so it narrows and never widens. */
export const narrowedDefinition = (definition: Record<string, unknown>, filters: FilterSet) => {
  const spec = record(definition.spec);
  const variants =
    Array.isArray(spec.variants) && spec.variants.length ? spec.variants : ['default'];
  return {
    ...definition,
    spec: {
      ...spec,
      variants: variants.map((variant) => {
        const own = typeof variant === 'string' ? { id: variant } : record(variant);
        const fixed = record(own.filters).fields;
        return {
          ...own,
          filters: { fields: [...(Array.isArray(fixed) ? fixed : []), ...filters.fields] },
        };
      }),
    },
  };
};

/** The playground's sources, one per excerpt, as the answer's documents with their excerpts. */
export const sourcesOf = (sources: readonly PlaygroundSource[]): Source[] => {
  const documents = new Map<string, Source>();
  sources.forEach((source, at) => {
    const key = source.document ?? source.url ?? source.title ?? `source-${at}`;
    const found = documents.get(key) ?? {
      title: source.title ?? '',
      ...(source.url ? { url: source.url } : {}),
      ...(source.document ? { documentId: source.document } : {}),
      excerpts: [],
    };
    found.excerpts.push({
      chunkId: source.chunkId,
      text: source.text ?? source.excerpt ?? '',
      ...(source.position !== undefined ? { position: source.position } : {}),
    });
    documents.set(key, found);
  });
  return [...documents.values()];
};

const answerTextOf = (result: PlaygroundResult) =>
  result.clarification?.question ?? result.text ?? '';

/** Turns callbacks into events a generator yields, in order, ending or failing with the run. */
const queued = async function* <E>(run: (push: (event: E) => void) => Promise<void>) {
  const waiting: E[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: unknown;
  run((event) => {
    waiting.push(event);
    wake?.();
  }).then(
    () => {
      ended = true;
      wake?.();
    },
    (error: unknown) => {
      failure = error ?? new Error('the run failed');
      ended = true;
      wake?.();
    },
  );
  for (;;) {
    const next = waiting.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    if (ended) {
      if (failure) throw failure;
      return;
    }
    await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
  }
};

interface Kept {
  title: string;
  created: number;
  turns: Turn[];
}

export interface DraftApiOptions {
  api: ApiClient;
  tenant: string;
  /** The draft as it is now, read at each question. */
  source: () => DraftSource | undefined;
  now?: () => number;
}

/**
 * An `AssistantApi` for a draft: each question is a playground run of it with the turns so far
 * as history, and the threads are this visit's only, since a draft has no stored conversations.
 */
export const createDraftApi = ({
  api,
  tenant,
  source,
  now = () => Date.now(),
}: DraftApiOptions): AssistantApi => {
  const service = draftServiceOf(source());
  let options: ReturnType<ApiClient['playground']['options']> | undefined;
  const optionsOnce = () => (options ??= api.playground.options(tenant));

  const setupFor = async (draft: DraftSource | undefined): Promise<PlaygroundSetup> => {
    const loaded = await optionsOnce();
    const definition = draft?.definition;
    if (!definition) return initialSetup(loaded, 'free');
    const files = draft.files;
    const own = { definition, ...(files ? { files } : {}) };
    const setup = initialSetup(withDraftService(loaded, service, own), 'service', service);
    return { ...setup, service: { id: service, version: 'draft', ...own } };
  };

  /** The draft's `/v1/models` rows; for the playground's setup, one row for what it searches. */
  const rowsOf = async (): Promise<ModelRow[]> => {
    const draft = source();
    if (draft?.definition) return modelRowsFromDefinition(draft.definition);
    const setup = await setupFor(draft);
    return modelRowsFromDefinition({
      metadata: { id: service, name: setup.service?.id ?? service, tenant },
      spec: {
        output: { kind: setup.output === 'fields' ? 'fields' : 'answer' },
        knowledge: { datasets: setup.datasets.map((dataset) => ({ dataset })) },
      },
    });
  };

  const threads = new Map<string, Kept>();
  let minted = 0;

  const datasetOf = async (key: string) =>
    (await rowsOf())
      .flatMap((row) => row._datasets ?? [])
      .find((d) => (d['dataset-config-key'] ?? d.id) === key);

  return {
    loadModels: rowsOf,

    loadThreads: async (): Promise<ThreadRow[]> =>
      [...threads.entries()]
        .map(([id, kept]) => ({ id, title: kept.title, updatedAt: kept.created, service }))
        .reverse(),

    loadThread: async (id) => {
      const kept = threads.get(id);
      if (!kept) throw new HttpError(404, 'conversation not found in this visit');
      return { title: kept.title, turns: kept.turns };
    },

    loadCorpora: async () =>
      (await api.listDatasets()).map((d) => ({
        key: d.id,
        label: d.name,
        ...(d.description ? { description: d.description } : {}),
      })),

    // The draft's own filter fields, as its definition declares them.
    loadFields: async (dataset): Promise<readonly FieldSpec[]> =>
      ((await datasetOf(dataset))?.filters ?? [])
        .filter((f) => f.kinds?.includes('multiselect'))
        .map((f) => ({ id: f.field, label: f.field })),

    // One call per field, narrowed by the other fields only: each count is «given the others».
    loadFacets: async (selection, dataset, fields) => {
      const found = await datasetOf(dataset);
      return Promise.all(
        fields.map(async (field) => {
          const others = fields
            .filter((f) => f.id !== field.id && (selection[f.id]?.length ?? 0) > 0)
            .map((f) => ({
              field: f.id,
              type: 'multiselect',
              'value-type': 'string',
              'selected-options': [...(selection[f.id] ?? [])],
            }));
          const query = new URLSearchParams({
            tenant: found?.tenant || tenant,
            'dataset-config-key': dataset,
            fields: field.id,
            ...(others.length ? { filter: JSON.stringify({ fields: others }) } : {}),
          });
          const body = (await api.getJson(`/api/facets?${query.toString()}`)) as {
            fields?: { field: string; options: { value: string | number; count: number }[] }[];
          };
          const options = (body.fields?.find((f) => f.field === field.id)?.options ?? []).map(
            (o) => ({ value: String(o.value), count: o.count }),
          );
          return { id: field.id, label: field.label, options };
        }),
      );
    },

    loadAbout: async () => undefined,

    ask: async function* (params) {
      const id = params.conversationId ?? `draft-${(minted += 1)}`;
      const kept = threads.get(id) ?? {
        title: shortTitle(params.question),
        created: now(),
        turns: [],
      };
      threads.set(id, kept);
      if (!params.conversationId) yield { type: 'conversation', conversationId: id };
      const history: PlaygroundHistoryTurn[] = kept.turns
        .flatMap((turn): PlaygroundHistoryTurn[] =>
          turn.answer?.text
            ? [
                { role: 'user', text: turn.question },
                { role: 'assistant', text: turn.answer.text },
              ]
            : [],
        )
        .slice(-20);
      const draft = source();
      const base = await setupFor(draft);
      const definition = base.service?.definition as Record<string, unknown> | undefined;
      const setup =
        params.filters && definition && base.service
          ? {
              ...base,
              service: {
                ...base.service,
                definition: narrowedDefinition(definition, params.filters),
              },
            }
          : base;
      const asked = now();
      const seen = new Set<string>();
      let answer: AnswerData | undefined;
      for await (const event of queued<PlaygroundStreamEvent>((push) =>
        api.playground.runStream(
          tenant,
          { setup, input: { text: params.question }, ...(history.length ? { history } : {}) },
          push,
          params.signal,
        ),
      )) {
        if ('setup' in event && event.setup === 'compareWith') continue;
        if (event.event === 'delta')
          yield event.channel === 'answer'
            ? { type: 'text', text: event.text }
            : { type: 'reasoning', text: event.text };
        else if (event.event === 'retract') yield { type: 'retract' };
        else if (event.event === 'step' && !seen.has(event.step.id)) {
          seen.add(event.step.id);
          const { title, iteration } = event.step;
          yield {
            type: 'step',
            step: {
              event: 'step',
              label: title,
              ...(iteration === undefined ? {} : { iteration }),
            },
          } satisfies AskEvent;
        } else if (event.event === 'failed')
          throw new HttpError(event.problem.status, event.problem.title);
        else if (event.event === 'result') {
          const sources = sourcesOf(event.result.sources);
          const text = answerTextOf(event.result);
          const noAnswer = event.result.noAnswer === true;
          answer = {
            text,
            status: 'complete',
            sources: sources.map((s, at) => sourceFromWire(s, undefined, at)),
            noAnswer,
            created: now(),
          };
          yield {
            type: 'done',
            answer: {
              id: event.result.runId,
              text,
              conversationId: id,
              sources,
              citations: [],
              noAnswer,
            },
          };
        }
      }
      if (answer)
        kept.turns.push({
          id: `${id}-${kept.turns.length + 1}`,
          question: params.question,
          askedAt: asked,
          answer,
        });
    },
  };
};
