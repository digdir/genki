import { agentId } from '../scope.js';
import type { JsonValue, Request, Scenario, StepResult } from '../types.js';

const USER = { 'X-User-Id': 'parity-user' };

const record = (value: JsonValue | string | undefined): Record<string, JsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const conversationIdFrom = (step: StepResult | undefined): string => {
  const body = record(step?.response.body);
  const nested = record(body.conversation);
  const id = body.id ?? body['conversation-id'] ?? body.conversation_id ?? nested.id;
  if (typeof id !== 'string') throw new Error('create returned no conversation id');
  return id;
};

const firstDataset = (step: StepResult | undefined) => {
  const body = record(step?.response.body);
  const list = Array.isArray(body.datasets) ? body.datasets : [];
  const first = record(list[0]);
  const find = (pattern: RegExp) =>
    Object.entries(first).find(([k, v]) => pattern.test(k) && typeof v === 'string')?.[1];
  const tenant = find(/^tenant$/);
  const key = find(/config[-_]?key/);
  if (typeof tenant !== 'string' || typeof key !== 'string')
    throw new Error('no dataset with tenant and config key');
  return { tenant, key };
};

const conversation =
  (method: Request['method'], suffix = '', body?: JsonValue) =>
  (previous: StepResult[]) => ({
    method,
    path: `/api/conversations/${encodeURIComponent(conversationIdFrom(previous[0]))}${suffix}`,
    headers: USER,
    ...(body === undefined ? {} : { body }),
  });

export const restScenarios: Scenario[] = [
  {
    id: 'rest.datasets',
    title: '/api/datasets lists the datasets this key can see',
    steps: [
      {
        name: 'datasets',
        mode: 'exact',
        request: () => ({ method: 'GET', path: '/api/datasets' }),
      },
    ],
  },
  {
    id: 'rest.facets',
    title: '/api/facets returns values and counts for a filter UI',
    needs: ['dataset', 'wave3'],
    steps: [
      {
        name: 'datasets',
        mode: 'exact',
        request: () => ({ method: 'GET', path: '/api/datasets' }),
      },
      {
        name: 'facets',
        mode: 'shape',
        request: (previous) => {
          const { tenant, key } = firstDataset(previous[0]);
          const query = new URLSearchParams({ tenant, 'dataset-config-key': key, fields: 'type' });
          return { method: 'GET', path: `/api/facets?${query}` };
        },
      },
    ],
  },
  {
    id: 'rest.conversations',
    title: 'conversation lifecycle: create, list, read, rename, delete, then gone',
    steps: [
      {
        name: 'create',
        mode: 'exact',
        request: (_, side) => ({
          method: 'POST',
          path: '/api/conversations',
          headers: USER,
          body: { agentId: agentId('agent', side), title: 'Paritet' },
        }),
      },
      {
        name: 'list',
        mode: 'shape',
        request: () => ({ method: 'GET', path: '/api/conversations', headers: USER }),
      },
      { name: 'read', mode: 'exact', request: conversation('GET') },
      {
        name: 'rename',
        mode: 'exact',
        request: conversation('PUT', '', { title: 'Paritet, nytt navn' }),
      },
      { name: 'delete', mode: 'exact', request: conversation('DELETE') },
      { name: 'gone', mode: 'exact', request: conversation('GET') },
    ],
  },
  {
    id: 'rest.conversations-without-user',
    title: 'conversations without X-User-Id are refused',
    steps: [
      {
        name: 'no-user',
        mode: 'exact',
        request: () => ({ method: 'GET', path: '/api/conversations' }),
      },
    ],
  },
  {
    id: 'rest.no-key',
    title: '/api/datasets without a key is refused',
    steps: [
      {
        name: 'no-key',
        mode: 'exact',
        request: () => ({ method: 'GET', path: '/api/datasets', auth: false }),
      },
    ],
  },
];
