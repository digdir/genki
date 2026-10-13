import { check, checkEqual, skipped, type ContractSuite } from '@genai/plugins';
import { ApiError } from './errors.js';
import { citedIndexes, sourceFor, type Client } from './client.js';
import type { FilterSet, StreamEvent } from './types.js';

export const frontendContractVersion = 'frontend@1';

export interface FrontendContractSubject {
  client: Client;
  service: string;
  question: string;
  dataset?: { tenant: string; key: string; id: string; field: string };
  filter?: FilterSet;
  feedback?: boolean;
  anonymous?: Client;
}

const failsWith = async (run: () => Promise<unknown>, status: number, code?: string) => {
  try {
    await run();
  } catch (error) {
    check(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    checkEqual(error.status, status, 'status');
    if (code) checkEqual(error.code, code, 'code');
    return error;
  }
  throw new Error(`expected status ${status}, but the call succeeded`);
};

const applied = (events: StreamEvent[]) => {
  let text = '';
  for (const e of events) {
    if (e.type === 'retract') text = '';
    else if (e.type === 'text') text += e.text;
  }
  return text;
};

const collect = async (events: AsyncIterable<StreamEvent>) => {
  const all: StreamEvent[] = [];
  for await (const e of events) all.push(e);
  return all;
};

export const frontendContract: ContractSuite<FrontendContractSubject> = {
  contract: frontendContractVersion,
  checks: [
    {
      name: 'lists the service among the models',
      run: async (s) => {
        const services = await s.client.listServices();
        check(
          services.some((m) => m.id === s.service),
          `service ${s.service} is not listed`,
        );
      },
    },
    {
      name: 'answers with text and gives every [N] in it a source with index N',
      run: async (s) => {
        const answer = await s.client.ask({ service: s.service, question: s.question });
        check(answer.text.trim() !== '' || answer.noAnswer, 'the answer is empty');
        for (const n of citedIndexes(answer.text))
          check(sourceFor(answer.sources, n), `[${n}] has no source with index ${n}`);
        for (const source of answer.sources) {
          check(source.title !== '', 'a source has no title');
          check(
            source.excerpts.every((e) => e.chunkId !== ''),
            'an excerpt has no chunk id',
          );
        }
        const indexed = answer.sources.filter((x) => x.index !== undefined && x.documentId);
        checkEqual(
          new Set(indexed.map((x) => x.documentId)).size,
          indexed.length,
          'sources per document',
        );
      },
    },
    {
      name: 'stays stateless without a conversation id',
      run: async (s) => {
        const answer = await s.client.ask({ service: s.service, question: s.question });
        checkEqual(answer.conversationId, undefined, 'conversationId');
      },
    },
    {
      name: 'keeps a conversation: create, continue, read back, rename and delete',
      run: async (s) => {
        const first = await s.client.ask({
          service: s.service,
          question: s.question,
          newConversation: true,
        });
        const id = first.conversationId;
        check(id, 'no conversation id in the response');
        const second = await s.client.ask({
          service: s.service,
          question: s.question,
          conversationId: id,
        });
        checkEqual(second.conversationId, id, 'conversationId on the second turn');
        const stored = await s.client.conversations.get(id);
        const roles = stored.messages.map((m) => m.role);
        check(
          roles.filter((r) => r === 'user').length === 2 &&
            roles.filter((r) => r === 'assistant').length === 2,
          `expected two user and two assistant turns, got ${JSON.stringify(roles)}`,
        );
        const page = await s.client.conversations.list({ pageSize: 100 });
        check(
          page.conversations.some((c) => c.id === id),
          'the conversation is not listed',
        );
        const renamed = await s.client.conversations.update(id, { title: 'Kontrakttest' });
        checkEqual(renamed.topic, 'Kontrakttest', 'title');
        await s.client.conversations.delete(id);
        await failsWith(() => s.client.conversations.get(id), 404);
      },
    },
    {
      name: 'refuses an unknown conversation id with 404 conversation_not_found',
      run: async (s) => {
        await failsWith(
          () =>
            s.client.ask({
              service: s.service,
              question: s.question,
              conversationId: 'finnes-ikke',
            }),
          404,
          'conversation_not_found',
        );
      },
    },
    {
      name: 'streams text that adds up to the answer and ends with done',
      run: async (s) => {
        const events = await collect(s.client.stream({ service: s.service, question: s.question }));
        const last = events.at(-1);
        check(last?.type === 'done', 'the stream did not end with done');
        checkEqual(applied(events), last.answer.text, 'streamed text');
        check(
          !events.some((e) => e.type === 'step'),
          'step events arrived without being asked for',
        );
      },
    },
    {
      name: 'streams step events and keeps the same answer when asked for steps',
      run: async (s) => {
        const events = await collect(
          s.client.stream({ service: s.service, question: s.question }, { steps: true }),
        );
        const last = events.at(-1);
        check(last?.type === 'done', 'the stream did not end with done');
        checkEqual(applied(events), last.answer.text, 'streamed text');
      },
    },
    {
      name: 'refuses a malformed filter with 400 invalid_filters',
      run: async (s) => {
        await failsWith(
          () => s.client.ask({ service: s.service, question: s.question, filters: { fields: [] } }),
          400,
          'invalid_filters',
        );
      },
    },
    {
      name: 'refuses a filter on an undeclared field with a field error',
      run: async (s) => {
        if (!s.dataset) return skipped;
        const error = await failsWith(
          () =>
            s.client.ask({
              service: s.service,
              question: s.question,
              filters: { fields: [{ field: 'finnes_ikke', 'selected-options': ['x'] }] },
            }),
          400,
          'invalid_filters',
        );
        check(error.fieldErrors.length > 0, 'no field errors');
      },
    },
    {
      name: 'answers with a valid filter applied',
      run: async (s) => {
        if (!s.filter) return skipped;
        const answer = await s.client.ask({
          service: s.service,
          question: s.question,
          filters: s.filter,
        });
        check(answer.text.trim() !== '' || answer.noAnswer, 'the answer is empty');
      },
    },
    {
      name: 'lists the dataset filter fields and facet values to build filters from',
      run: async (s) => {
        if (!s.dataset) return skipped;
        const datasets = await s.client.datasets.list();
        check(
          datasets.some((d) => d.id === s.dataset?.id),
          'the dataset is not listed',
        );
        const detail = await s.client.datasets.get(s.dataset.id);
        check(
          detail.filters?.some((f) => f.field === s.dataset?.field),
          `the dataset does not declare ${s.dataset.field}`,
        );
        const facets = await s.client.facets({
          tenant: s.dataset.tenant,
          datasetConfigKey: s.dataset.key,
          fields: [s.dataset.field],
        });
        checkEqual(facets[0]?.field, s.dataset.field, 'facet field');
      },
    },
    {
      name: 'records feedback on an answer through its task id',
      run: async (s) => {
        if (!s.feedback) return skipped;
        const answer = await s.client.ask({ service: s.service, question: s.question });
        check(answer.taskId, 'the answer carries no task id');
        await s.client.feedback({ taskId: answer.taskId, rating: 'up' });
      },
    },
    {
      name: 'refuses a call without credentials with 401',
      run: async (s) => {
        if (!s.anonymous) return skipped;
        await failsWith(() => s.anonymous?.listServices() ?? Promise.resolve(), 401);
      },
    },
  ],
};
