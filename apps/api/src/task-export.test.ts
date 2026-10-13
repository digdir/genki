import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Event, Principal, Task } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  platformSettings,
  SettingsRegistry,
  type CompiledCapability,
} from '@genai/definitions';
import { tenantAccess } from './access.js';
import { createAdmin } from './admin.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import type { ModuleDeps, MountDeps } from './platform-modules.js';
import { resultReviews } from './result-reviews.js';
import { taskExportAction, taskExportModule } from './task-export.js';
import { digdir, plugins } from './testkit.js';

const other = '889640782';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services', 'manage-services'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  per: { kind: 'employee', issuer: 'test', subject: 'per', tenant: other },
};

const capabilityId = `${digdir}/svar/default`;

const task: Task = {
  id: 't1',
  tenant: digdir,
  owner: 'kernel',
  status: 'completed',
  principal: { kind: 'employee', id: JSON.stringify(['test', 'kari']) },
  service: {
    capability: { id: capabilityId, version: '4' },
    strategy: { id: 'agent-loop', version: '1' },
    configHash: 'abc',
  },
  result: [{ mime: 'text/plain', body: { kind: 'text', text: 'Fristen er 1. mars.' } }],
  artifacts: [],
  usage: { inputTokens: 10, outputTokens: 5 },
  createdAt: '2026-10-08T10:00:00.000Z',
  endedAt: '2026-10-08T10:00:05.000Z',
};

const event = (seq: number, type: string, data: unknown, audience?: 'audit'): Event => ({
  type,
  v: 1,
  task: 't1',
  seq,
  ts: '2026-10-08T10:00:01.000Z',
  data,
  actor: 'kernel',
  ...(audience ? { audience } : {}),
});

const events: Event[] = [
  event(0, 'kernel.task.input', { input: { data: 'Når er fristen?' } }),
  event(
    1,
    'kernel.resource.used',
    { port: 'knowledge', ref: { kind: 'dataset', id: 'digdir/felles', tenant: digdir } },
    'audit',
  ),
  event(
    2,
    'kernel.resource.used',
    { port: 'model', ref: { kind: 'model', id: 'test/model' } },
    'audit',
  ),
  event(3, 'kernel.notice', {
    kind: 'retrieval',
    queries: ['frist'],
    hits: [{ id: 'c1', document: 'forskrift', position: 0 }],
  }),
  event(4, 'kernel.result', task.result),
];

const compiled = {
  capability: {
    descriptor: { id: capabilityId, version: '4', oversight: { riskClass: 'high' } },
    config: { settings: { 'retention.class': 'transient' } },
  },
  service: { tenant: digdir, id: 'svar', version: 4 },
} as unknown as CompiledCapability;

const unzipNames = (bytes: Uint8Array) => {
  const names: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength)));
    at += 30 + nameLength + size;
  }
  return names;
};

const entry = (bytes: Uint8Array, wanted: string): unknown => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength;
    if (name === wanted)
      return JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + size)));
    at = start + size;
  }
  return undefined;
};

const boot = async () => {
  const settings = new SettingsRegistry(platformSettings);
  const configEntries = new InMemoryConfigEntryStore();
  const deps = { configEntries } as unknown as ModuleDeps;
  const module = taskExportModule(deps);
  const admin = createAdmin({
    store: new InMemoryDefinitionStore(plugins),
    plugins,
    settings,
    extensions: module.handlers ?? {},
  });
  await resultReviews(configEntries).save(
    digdir,
    { task: 't1', edits: [], approved: true },
    people.kari as Principal,
    'Sjekket svaret mot forskriften',
    0,
  );
  const app = new Hono();
  module.mount(app, {
    ...deps,
    admin,
    settings,
    definitions: { capabilities: async () => [compiled] },
    authenticate: async (request: Request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access: tenantAccess(admin),
    task: async (id: string) => (id === task.id ? task : undefined),
    events: async function* () {
      yield* events;
    },
  } as unknown as MountDeps);
  const exportTask = (who: string, tenant = digdir, reason = 'Arkiveres i saken 2026/123') =>
    app.request(`/tenants/${tenant}/tasks/t1/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who}`, ...(reason ? { 'change-reason': reason } : {}) },
    });
  return { admin, exportTask };
};

describe('exporting a task', () => {
  it('downloads the task, events, result, artifacts and provenance as one zip archive', async () => {
    const { exportTask } = await boot();

    const response = await exportTask('kari');
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="task-t1.zip"');
    expect(unzipNames(bytes)).toEqual([
      'manifest.json',
      'task.json',
      'events.json',
      'result.json',
      'artifacts.json',
      'provenance.json',
      'retention.json',
    ]);
    expect(entry(bytes, 'events.json')).toHaveLength(5);
    expect(entry(bytes, 'result.json')).toEqual(task.result);
  });

  it('records the service version, model, sources and approver in the provenance', async () => {
    const { exportTask } = await boot();

    const bytes = new Uint8Array(await (await exportTask('kari')).arrayBuffer());

    expect(entry(bytes, 'provenance.json')).toMatchObject({
      task: 't1',
      service: { capability: { id: capabilityId, version: '4' }, configHash: 'abc' },
      models: [{ kind: 'model', id: 'test/model' }],
      sources: [{ kind: 'dataset', id: 'digdir/felles' }],
      documents: [{ chunkId: 'c1', document: 'forskrift' }],
      approvals: [{ by: 'employee:test:kari', reason: 'Sjekket svaret mot forskriften' }],
    });
    expect(entry(bytes, 'retention.json')).toMatchObject({
      retentionClass: 'transient',
      riskClass: 'high',
      payloadDays: 183,
    });
  });

  it('writes every export to the audit log with who exported it and why', async () => {
    const { admin, exportTask } = await boot();

    const response = await exportTask('kari');

    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: taskExportAction,
      tenant: digdir,
      actor: 'employee:test:kari',
      outcome: 'applied',
      target: 'task:t1',
      reason: 'Arkiveres i saken 2026/123',
    });
    expect(response.headers.get('genai-task')).toBeTruthy();
  });

  it('needs the right to manage services and a reason', async () => {
    const { admin, exportTask } = await boot();

    expect((await exportTask('ola')).status).toBe(403);
    expect((await exportTask('kari', digdir, '')).status).toBe(400);
    expect(await admin.audit(digdir)).toEqual([]);
  });

  it('never exports a task to another tenant', async () => {
    const { exportTask } = await boot();

    expect((await exportTask('per', other)).status).toBe(404);
    expect((await exportTask('per')).status).toBe(404);
  });
});
