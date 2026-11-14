import {
  filterSet,
  HttpError,
  NotAsked,
  shortTitle,
  sourceFromWire,
  type AnswerData,
  type AssistantApi,
  type AssistantProfile,
  type CorpusProfile,
  type FieldSpec,
  type ThreadRow,
  type Turn,
} from '@genai/ui-assembly';
import {
  datasetsOfDefinition,
  modelRowsFromDefinition,
  type DatasetFilter,
  type ModelRow,
} from '@genai/ui-blocks/builder';
import type { ApiClient } from '../../../api';
import type {
  PlaygroundHistoryTurn,
  PlaygroundOptions,
  PlaygroundResult,
  PlaygroundSetup,
  PlaygroundSource,
  PlaygroundStreamEvent,
} from '../../../api/playground';
import { withDraftService } from '../../../components/playground/PlaygroundPanel';
import type { Problem } from '../../../types';
import { initialSetup } from '../../../data/playground';
import { loadDatasetFilters } from './datasetFilters';
import {
  draftServiceOf,
  playgroundDefinition,
  type DraftSource,
  type RunProblem,
} from './draftService';

type AskParams = Parameters<AssistantApi['ask']>[0];
type AskEvent = AssistantApi['ask'] extends (...args: never[]) => AsyncGenerator<infer E>
  ? E
  : never;
type Source = Extract<AskEvent, { type: 'done' }>['answer']['sources'][number];
type FilterSet = NonNullable<AskParams['filters']>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const variantsOf = (spec: Record<string, unknown>): unknown[] =>
  Array.isArray(spec.variants) && spec.variants.length ? spec.variants : ['default'];

/** The draft with the reader's filter added to each variant's own: it narrows, never widens. */
export const narrowedDefinition = (definition: Record<string, unknown>, filters: FilterSet) => {
  const spec = record(definition.spec);
  return {
    ...definition,
    spec: {
      ...spec,
      variants: variantsOf(spec).map((variant) => {
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

/** The draft searching only the one of its datasets the reader chose, if it is one of them. */
export const definitionFor = (definition: Record<string, unknown>, dataset: string) => {
  const spec = record(definition.spec);
  const knowledge = record(spec.knowledge);
  const all = Array.isArray(knowledge.datasets) ? knowledge.datasets : [];
  const chosen = all.filter((d) => {
    const id = String(record(d).dataset ?? '');
    return id.slice(id.lastIndexOf('/') + 1) === dataset;
  });
  if (chosen.length === 0 || chosen.length === all.length) return definition;
  return { ...definition, spec: { ...spec, knowledge: { ...knowledge, datasets: chosen } } };
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

/** A failed request in the assistant's terms, so its status says what went wrong. */
const asHttpError = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && !(error instanceof HttpError)
    ? new HttpError(status, error instanceof Error ? error.message : String(status))
    : error;
};

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
  /** The playground's name in the reader's language, for a run with no draft. */
  name?: string | undefined;
  /** Why the thread's answer failed, or without a thread why the draft was refused; or nothing. */
  onProblem?: ((problem: RunProblem | undefined, thread?: string) => void) | undefined;
  /**
   * The profile the assistant is drawn with, read at each call: `profileOf(layout, own)`, so the
   * fields, the collections' names and a kept answer's links are in its words too.
   */
  profile?: (() => AssistantProfile | undefined) | undefined;
  now?: () => number;
}

/** An `AssistantApi` for a draft: each question a playground run, the threads this visit's. */
export const createDraftApi = ({
  api,
  tenant,
  source,
  name,
  onProblem,
  profile,
  now = () => Date.now(),
}: DraftApiOptions): AssistantApi => {
  const service = draftServiceOf(source());
  // A layout's collections are JSON: only its own keys are read.
  const corpusProfile = (key: string | undefined): CorpusProfile | undefined => {
    const corpora = profile?.()?.corpora;
    return key && corpora && Object.hasOwn(corpora, key) ? corpora[key] : undefined;
  };
  let options: Promise<PlaygroundOptions> | undefined;
  // A failed call is not kept, so the next question asks again.
  const optionsOnce = () =>
    (options ??= api.playground.options(tenant).catch((error: unknown) => {
      options = undefined;
      throw error;
    }));
  const filters = new Map<string, Promise<readonly DatasetFilter[]>>();
  const filtersOnce = (dataset: string) => {
    const found = filters.get(dataset) ?? loadDatasetFilters(api, dataset).catch(() => [] as const);
    filters.set(dataset, found);
    return found;
  };

  const setupFor = async (draft: DraftSource | undefined): Promise<PlaygroundSetup> => {
    const loaded = await optionsOnce();
    const definition = draft?.definition;
    if (!definition) return initialSetup(loaded, 'free');
    const files = draft.files;
    const own = { definition, ...(files ? { files } : {}) };
    const setup = initialSetup(withDraftService(loaded, service, own), 'service', service);
    return { ...setup, service: { id: service, version: 'draft', ...own } };
  };

  /** What the try view runs, as a definition: the draft, or the playground's setup as one. */
  const definitionNow = async (): Promise<Record<string, unknown>> => {
    const draft = source();
    if (draft?.definition) return draft.definition;
    const [setup, loaded] = await Promise.all([setupFor(draft), optionsOnce()]);
    return playgroundDefinition(loaded, setup, tenant, name);
  };

  const rowsOf = async (): Promise<ModelRow[]> => {
    const definition = await definitionNow();
    const ids = datasetsOfDefinition(definition);
    const found = await Promise.all(ids.map(filtersOnce));
    const byId = new Map(ids.map((id, at) => [id, found[at]]));
    return modelRowsFromDefinition(definition, (id) => byId.get(id));
  };

  const threads = new Map<string, Kept>();
  let minted = 0;
  let asks = 0;

  // Every variant's row lists the same datasets: the first row's are the draft's.
  const datasetsOf = async () => (await rowsOf())[0]?._datasets ?? [];
  const datasetOf = async (key: string) =>
    (await datasetsOf()).find((d) => (d['dataset-config-key'] ?? d.id) === key);

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

    // The draft's own datasets: it searches no other. Named in the profile's words where it has them.
    loadCorpora: async () => {
      const [own, loaded] = await Promise.all([datasetsOf(), optionsOnce()]);
      return own.flatMap((d) => {
        const key = d['dataset-config-key'] ?? d.id;
        if (!key) return [];
        const named = loaded.datasets.find((o) => o.id === `${d.tenant}/${key}` || o.id === key);
        const words = corpusProfile(key);
        return [
          {
            key,
            label: words?.label || named?.name || key,
            ...(words?.description ? { description: words.description } : {}),
          },
        ];
      });
    },

    // The fields the dataset declares, as the frontend contract reads them: the profile's choice and
    // words where it has them, and whether a field's values are integers as the dataset says.
    loadFields: async (dataset): Promise<readonly FieldSpec[]> => {
      const offered = ((await datasetOf(dataset))?.filters ?? []).filter((f) =>
        f.kinds?.includes('multiselect'),
      );
      const chosen = corpusProfile(dataset)?.fields;
      if (chosen)
        return chosen.flatMap((f) => {
          const declared = offered.find((o) => o.field === f.id);
          if (!declared) return [];
          return f.integer === undefined && declared['value-type'] === 'integer'
            ? [{ ...f, integer: true }]
            : [f];
        });
      return offered.map((f) => ({
        id: f.field,
        label: f.field,
        ...(f['value-type'] === 'integer' ? { integer: true } : {}),
      }));
    },

    // One call per field, narrowed by the other fields only: counts «given the others».
    loadFacets: async (selection, dataset, fields) => {
      const found = await datasetOf(dataset);
      return Promise.all(
        fields.map(async (field) => {
          const others = Object.fromEntries(
            Object.entries(selection).filter(([id]) => id !== field.id),
          );
          const filter = filterSet(others, fields);
          const query = new URLSearchParams({
            tenant: found?.tenant || tenant,
            'dataset-config-key': dataset,
            fields: field.id,
            ...(filter ? { filter: JSON.stringify(filter) } : {}),
          });
          const body = (await api.getJson(`/api/facets?${query.toString()}`)) as {
            fields?: { field: string; options: { value: string | number; count: number }[] }[];
          };
          const options = (body.fields?.find((f) => f.field === field.id)?.options ?? []).map(
            (o) => ({ value: String(o.value), count: o.count }),
          );
          return {
            id: field.id,
            label: field.label,
            ...(field.heading ? { heading: field.heading } : {}),
            ...(field.kind ? { kind: field.kind } : {}),
            options,
          };
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
      // The thread is kept, and named to the assistant, once the playground takes the run: a run
      // it refuses leaves no thread behind, only its reason.
      let accepted = false;
      const asking = (asks += 1);
      // A refusal is the draft's, so only the latest question asked in any thread says one.
      const refuse = (problem: RunProblem, title: string) => {
        if (asks === asking) onProblem?.(problem);
        return new NotAsked(title);
      };
      onProblem?.(undefined);
      if (params.conversationId) onProblem?.(undefined, params.conversationId);
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
      const setup = await setupFor(source());
      const draft = setup.service?.definition as Record<string, unknown> | undefined;
      const variant = params.model.startsWith(`${service}__`)
        ? params.model.slice(service.length + 2)
        : undefined;
      const chosen = draft && params.dataset ? definitionFor(draft, params.dataset.key) : draft;
      const narrowed =
        chosen && params.filters ? narrowedDefinition(chosen, params.filters) : chosen;
      const run =
        narrowed && setup.service
          ? {
              ...setup,
              service: { ...setup.service, ...(variant ? { variant } : {}), definition: narrowed },
            }
          : setup;
      const asked = now();
      const seen = new Set<string>();
      let answer: AnswerData | undefined;
      for await (const event of queued<PlaygroundStreamEvent>((push) =>
        api.playground
          .runStream(
            tenant,
            {
              setup: run,
              input: { text: params.question },
              ...(history.length ? { history } : {}),
            },
            push,
            params.signal,
          )
          .catch((error: unknown) => {
            // Refused before it started, with the platform's reason: what the draft lacks, a
            // block the playground may not use, or a spent quota.
            const status = (error as { status?: unknown } | null)?.status;
            const problem = (error as { problem?: Problem } | null)?.problem;
            if (!accepted && typeof status === 'number' && status < 500 && problem?.title)
              throw refuse(
                {
                  title: problem.title,
                  ...(problem.detail ? { detail: problem.detail } : {}),
                  errors: problem.errors ?? [],
                },
                problem.title,
              );
            throw asHttpError(error);
          }),
      )) {
        if (params.signal.aborted) break;
        if ('setup' in event && event.setup === 'compareWith') continue;
        if (!accepted && event.event !== 'failed' && event.event !== 'done') {
          accepted = true;
          threads.set(id, kept);
          if (!params.conversationId) yield { type: 'conversation', conversationId: id };
        }
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
        } else if (event.event === 'failed') {
          // The host says why in its own words, which the assistant's failure cannot carry.
          const { title, detail, errors = [] } = event.problem;
          const problem = { title, ...(detail ? { detail } : {}), errors };
          if (!accepted) throw refuse(problem, title);
          onProblem?.(problem, id);
          throw new HttpError(event.problem.status, title);
        } else if (event.event === 'result') {
          const sources = sourcesOf(event.result.sources);
          const text = answerTextOf(event.result);
          const noAnswer = event.result.noAnswer === true;
          // Kept with the collection's links, so the thread opened again links as the answer did.
          const corpus = corpusProfile(params.dataset?.key);
          answer = {
            text,
            status: 'complete',
            sources: sources.map((s, at) => sourceFromWire(s, corpus, at)),
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
      // A stopped or answerless run fails the turn, so it is not left streaming.
      if (params.signal.aborted) throw new DOMException('The question was stopped', 'AbortError');
      if (!answer) throw new Error('the run ended without an answer');
      kept.turns.push({
        id: `${id}-${kept.turns.length + 1}`,
        question: params.question,
        askedAt: asked,
        answer,
      });
    },
  };
};
