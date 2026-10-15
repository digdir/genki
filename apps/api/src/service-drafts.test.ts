import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { createPlatform } from './composition.js';
import { draftOutdatedType, mergeThreeWay, type DraftConflict } from './service-drafts.js';
import { trustedEntraScope } from './lockdown.js';
import { digdir, principals, settingDefinitions } from './testkit.js';

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: 'fake/gpt', residency: 'global' },
  },
};

const reader: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'reader',
  tenant: digdir,
  authorizedFor: [{ org: digdir, actions: ['use-services'] }],
};

type Spec = typeof service.spec & { settings?: Record<string, unknown> };

const entra: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'entra',
  tenant: digdir,
  scopes: [trustedEntraScope],
};

const boot = async (lockdown = false) => {
  const settings = new SettingsRegistry(settingDefinitions);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'http://127.0.0.1:9/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          {
            id: 'fake/gpt',
            endpoint: 'fake',
            deployment: 'gpt',
            residency: 'norway',
            capabilities: ['stream'],
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    settings,
    definitions: (p) => new InMemoryDefinitionStore({ ...p, settings: settingDefinitions }),
    policy: { decide: async () => ({ allow: true }) },
    ...(lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.slice(7) ?? '';
      const principal = token === 'reader' ? reader : token === 'entra' ? entra : principals[token];
      return principal ? { principal } : undefined;
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      caller: platform.caller,
      admin,
      drafts: platform.serviceDrafts,
      lockdown,
    },
  });
  platform.mount(app, admin);
  const send = async (method: string, path: string, body?: unknown, as = 'kari') => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${as}`,
        'change-reason': 'testendring',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const writer = lockdown ? 'entra' : 'kari';
  const publish = (spec: Partial<Spec>, draftRevision?: number) =>
    send(
      'POST',
      '/definitions',
      {
        definition: { ...service, spec: { ...service.spec, ...spec } },
        files: {},
        ...(draftRevision === undefined ? {} : { draftRevision }),
      },
      writer,
    );
  const draftPath = `/tenants/${digdir}/services/svar/draft`;
  const saveDraft = (spec: Partial<Spec>, revision?: number) =>
    send(
      'PUT',
      draftPath,
      {
        definition: { ...service, spec: { ...service.spec, ...spec } },
        files: {},
        ...(revision === undefined ? {} : { revision }),
      },
      writer,
    );
  const draft = async () => (await send('GET', draftPath)).body;
  const latest = async () =>
    (
      (await send('GET', `/tenants/${digdir}/definitions/services/svar`)).body.latest as {
        version: number;
        definition: { spec: Spec };
      }
    ).definition.spec;
  expect((await publish({})).status).toBe(201);
  return { send, publish, saveDraft, draft, latest, draftPath };
};

const specOf = (draft: Record<string, unknown>) => (draft.definition as { spec: Spec }).spec;

describe('service drafts and newer published versions', () => {
  it('records the version a draft was started from and the latest published version', async () => {
    const env = await boot();
    expect((await env.saveDraft({ purpose: 'Svarer grundig' })).status).toBe(200);
    expect(await env.draft()).toMatchObject({ baseVersion: 1, latestVersion: 1 });
  });

  it('a setting saved after a draft was started survives publishing the draft', async () => {
    const env = await boot();
    await env.saveDraft({ purpose: 'Svarer grundig' });
    expect((await env.publish({ settings: { 'search.topK': 5 } })).status).toBe(201);

    const followed = await env.draft();
    expect(followed).toMatchObject({ baseVersion: 2, latestVersion: 2 });
    expect(specOf(followed)).toMatchObject({
      purpose: 'Svarer grundig',
      settings: { 'search.topK': 5 },
    });

    const published = await env.publish(specOf(followed), followed.revision as number);
    expect(published.status).toBe(201);
    expect(await env.latest()).toMatchObject({
      purpose: 'Svarer grundig',
      settings: { 'search.topK': 5 },
    });
  });

  it('refuses to publish a draft that would undo a newer published change, and lists the paths', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ purpose: 'Svarer presist', settings: { 'search.topK': 5 } });
    const stale = await env.draft();
    expect(stale.baseVersion).toBe(1);

    const refused = await env.publish({ purpose: 'Svarer grundig' }, saved.body.revision as number);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      type: draftOutdatedType,
      title: 'Utkastet bygger på en eldre versjon',
      baseVersion: 1,
      latestVersion: 2,
    });
    expect((refused.body.errors as { path: string }[]).map((e) => e.path).sort()).toEqual([
      'spec.purpose',
      'spec.settings.search.topK',
    ]);
    expect((await env.latest()).purpose).toBe('Svarer presist');
  });

  it('rebases a draft: takes published changes it did not touch, keeps its own and lists conflicts', async () => {
    const env = await boot();
    await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ purpose: 'Svarer presist', settings: { 'search.topK': 5 } });

    const rebased = await env.send('POST', `${env.draftPath}/rebase`, {});
    expect(rebased.status).toBe(200);
    const draft = rebased.body.draft as Record<string, unknown>;
    expect(draft).toMatchObject({ baseVersion: 2, latestVersion: 2 });
    expect(specOf(draft)).toMatchObject({
      purpose: 'Svarer grundig',
      settings: { 'search.topK': 5 },
    });
    expect(rebased.body.conflicts).toEqual([
      { path: 'spec.purpose', published: 'Svarer presist', draft: 'Svarer grundig' },
    ]);

    const published = await env.publish(specOf(draft), draft.revision as number);
    expect(published.status).toBe(201);
    expect(await env.latest()).toMatchObject({
      purpose: 'Svarer grundig',
      settings: { 'search.topK': 5 },
    });
  });

  it('a rebase on open with onlyIfClean applies a draft without conflicts onto the latest version', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ settings: { 'search.topK': 5 } }, saved.body.revision as number);
    expect(await env.draft()).toMatchObject({ baseVersion: 1, latestVersion: 2 });
    const stale = await env.send('POST', `${env.draftPath}/rebase`, { onlyIfClean: true });
    expect(stale.body).toMatchObject({ applied: true, conflicts: [] });
    expect(await env.draft()).toMatchObject({ baseVersion: 2, latestVersion: 2 });
  });

  it('a rebase with onlyIfClean leaves a conflicting draft untouched and lists the conflicts', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ purpose: 'Svarer presist' });
    const result = await env.send('POST', `${env.draftPath}/rebase`, { onlyIfClean: true });
    expect(result.body).toMatchObject({
      applied: false,
      conflicts: [{ path: 'spec.purpose', published: 'Svarer presist', draft: 'Svarer grundig' }],
    });
    expect(await env.draft()).toMatchObject({
      baseVersion: 1,
      latestVersion: 2,
      revision: saved.body.revision,
    });
  });

  it('a rebase without a draft is not found', async () => {
    const env = await boot();
    expect((await env.send('POST', `${env.draftPath}/rebase`, {})).status).toBe(404);
  });
});

describe('opening a draft with rebase=clean', () => {
  it('opening a behind draft without conflicts returns it rebased onto the latest version', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ settings: { 'search.topK': 5 } }, saved.body.revision as number);

    const opened = await env.send('GET', `${env.draftPath}?rebase=clean`);

    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      baseVersion: 2,
      latestVersion: 2,
      behind: false,
      conflicts: [],
      rebasedFrom: 1,
    });
    expect(specOf(opened.body)).toMatchObject({
      purpose: 'Svarer grundig',
      settings: { 'search.topK': 5 },
    });
    expect(await env.draft()).toMatchObject({ baseVersion: 2, revision: opened.body.revision });
  });

  it('opening a behind draft with conflicts leaves it untouched and returns the conflicts to choose from', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ purpose: 'Svarer presist' });

    const opened = await env.send('GET', `${env.draftPath}?rebase=clean`);

    expect(opened.body).toMatchObject({
      revision: saved.body.revision,
      baseVersion: 1,
      latestVersion: 2,
      behind: true,
      conflicts: [{ path: 'spec.purpose', published: 'Svarer presist', draft: 'Svarer grundig' }],
    });
    expect(opened.body.rebasedFrom).toBeUndefined();
  });

  it('opening a draft that is up to date changes nothing', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });

    const opened = await env.send('GET', `${env.draftPath}?rebase=clean`);

    expect(opened.body).toMatchObject({
      revision: saved.body.revision,
      behind: false,
      conflicts: [],
    });
  });

  it('opening a behind draft without manage-services does not rebase it and says it is behind', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ settings: { 'search.topK': 5 } }, saved.body.revision as number);

    const opened = await env.send('GET', `${env.draftPath}?rebase=clean`, undefined, 'reader');

    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ revision: saved.body.revision, behind: true });
    expect(await env.draft()).toMatchObject({ baseVersion: 1, revision: saved.body.revision });
  });

  it('does not write a draft on GET for a read-only person in lockdown', async () => {
    const env = await boot(true);
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ settings: { 'search.topK': 5 } }, saved.body.revision as number);

    const opened = await env.send('GET', `${env.draftPath}?rebase=clean`);

    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ revision: saved.body.revision, behind: true });
    expect(await env.draft()).toMatchObject({ baseVersion: 1, revision: saved.body.revision });
  });

  it('rebases a draft on GET for a trusted Entra login in lockdown', async () => {
    const env = await boot(true);
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ settings: { 'search.topK': 5 } }, saved.body.revision as number);

    const opened = await env.send('GET', `${env.draftPath}?rebase=clean`, undefined, 'entra');

    expect(opened.body).toMatchObject({ baseVersion: 2, behind: false, rebasedFrom: 1 });
  });

  it('opening without rebase=clean returns the stored draft as before', async () => {
    const env = await boot();
    const saved = await env.saveDraft({ purpose: 'Svarer grundig' });
    await env.publish({ settings: { 'search.topK': 5 } }, saved.body.revision as number);

    const opened = await env.draft();

    expect(opened).toMatchObject({ baseVersion: 1, latestVersion: 2 });
    expect(opened.behind).toBeUndefined();
  });
});

describe('three-way merge of a draft', () => {
  it('keeps nested changes from both sides and reports a value changed on both', () => {
    const conflicts: DraftConflict[] = [];
    const merged = mergeThreeWay(
      { spec: { a: 1, b: 1, c: { x: 1 } } },
      { spec: { a: 2, b: 1, c: { x: 1, y: 1 } } },
      { spec: { a: 3, b: 2, c: { x: 2 } } },
      conflicts,
    );
    expect(merged).toEqual({ spec: { a: 2, b: 2, c: { x: 2, y: 1 } } });
    expect(conflicts).toEqual([{ path: 'spec.a', published: 3, draft: 2 }]);
  });

  it('drops a key the draft removed when the published side left it alone', () => {
    const conflicts: DraftConflict[] = [];
    expect(mergeThreeWay({ a: 1, b: 1 }, { b: 1 }, { a: 1, b: 2 }, conflicts)).toEqual({ b: 2 });
    expect(conflicts).toEqual([]);
  });
});
