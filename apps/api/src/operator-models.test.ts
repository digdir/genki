import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { platformModules } from './composition.js';
import { operatorModelsModule } from './operator-models.js';
import { bootPlatform, digdir, files, readJson as json, testService } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const endpoint = {
  id: 'sigma2',
  protocol: 'openai-chat',
  baseURL: 'https://llm.sigma2.test/v1',
  auth: { kind: 'bearer', secret: 'secret://platform/sigma2-key' },
};

const boot = (knowledge?: unknown) =>
  bootPlatform({
    people,
    modules: [...platformModules, operatorModelsModule],
    ...(knowledge ? { knowledge } : {}),
  });

const reason = 'Norsk åpen modell for alle';

describe('platform models for operators', () => {
  it('adds an endpoint and a model on it that tenants do not see before it is released', async () => {
    const { send } = await boot();

    const secret = await send('/operator/secrets/sigma2-key', 'drift', {
      method: 'PUT',
      body: { value: 'hemmelig' },
      reason,
    });
    const added = await send('/operator/model-endpoints', 'drift', { body: endpoint, reason });
    const model = await send('/operator/models/sigma2/norallm-7b', 'drift', {
      method: 'PUT',
      body: {
        endpoint: 'sigma2',
        deployment: 'NorAllm-7B',
        residency: 'norway',
        capabilities: ['stream'],
        enabled: true,
      },
      reason,
    });
    const listed = await json<{
      data: { kind: string; scope: string; spec: Record<string, unknown> }[];
    }>(await send('/operator/catalog/entries?kind=model-endpoint', 'drift'));
    const visible = await json<{ data: { id: string }[] }>(await send('/models', 'kari'));

    expect(secret.status).toBe(200);
    expect(JSON.stringify(await secret.json())).not.toContain('hemmelig');
    expect(added.status).toBe(201);
    expect(model.status).toBe(200);
    expect(await model.json()).toMatchObject({
      id: 'sigma2/norallm-7b',
      enabled: true,
      spec: { release: 'candidate' },
    });
    expect(listed.data.find((e) => e.spec.baseURL === endpoint.baseURL)).toMatchObject({
      scope: 'platform',
      spec: { protocol: 'openai-chat', auth: { secret: 'secret://platform/sigma2-key' } },
    });
    expect(visible.data.map((m) => m.id)).not.toContain('sigma2/norallm-7b');
  });

  it('refuses tenants, plain HTTP, tenant secrets and missing reasons', async () => {
    const { send } = await boot();

    expect(
      (await send('/operator/model-endpoints', 'kari', { body: endpoint, reason })).status,
    ).toBe(403);
    expect(
      (
        await send('/operator/model-endpoints', 'drift', {
          body: { ...endpoint, baseURL: 'http://llm.sigma2.test/v1' },
          reason,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send('/operator/model-endpoints', 'drift', {
          body: { ...endpoint, auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/x` } },
          reason,
        })
      ).status,
    ).toBe(400);
    expect((await send('/operator/model-endpoints', 'drift', { body: endpoint })).status).toBe(400);
    expect(
      (await send('/operator/secrets/x', 'kari', { method: 'PUT', body: { value: 'v' }, reason }))
        .status,
    ).toBe(403);
  });

  it('refuses to remove an endpoint whose models services use, and removes an unused one', async () => {
    const { send, platform, admin } = await boot();
    await send('/operator/model-endpoints', 'drift', { body: endpoint, reason });
    await send('/operator/models/sigma2/norallm-7b', 'drift', {
      method: 'PUT',
      body: {
        endpoint: 'sigma2',
        deployment: 'norallm-7b',
        residency: 'norway',
        capabilities: ['stream'],
      },
      reason,
    });
    const candidate = platform.catalog.get('model', 'sigma2/norallm-7b');
    await admin.perform(
      { ...(people.drift as Principal), tenant: digdir },
      'platform.catalog.publish',
      {
        kind: 'model',
        id: 'sigma2/norallm-7b',
        spec: candidate?.spec,
        scope: 'platform',
        tenant: digdir,
        reason,
        release: true,
      },
    );
    const service = testService('veileder');
    await platform.definitions.publish(
      {
        ...service,
        spec: { ...service.spec, model: { primary: 'sigma2/norallm-7b', residency: 'norway' } },
      },
      'test',
      'test',
      files,
    );

    const inUse = await send('/operator/model-endpoints/sigma2', 'drift', {
      method: 'DELETE',
      reason,
    });
    const fake = await send('/operator/model-endpoints/fake', 'drift', {
      method: 'DELETE',
      reason,
    });

    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({
      services: [{ service: 'veileder', tenant: digdir, tenantName: digdir }],
    });
    expect(fake.status).toBe(204);
  });

  it('a price override shows in /models and in the prices usage cost reads', async () => {
    const { send, platform } = await boot();

    const priced = await send('/operator/models/fake/gpt/price', 'drift', {
      method: 'PUT',
      body: { inputPerThousand: 0.01, outputPerThousand: 0.04 },
      reason: 'Ny avtale med leverandøren',
    });
    const models = await json<{ data: { id: string; price: unknown }[] }>(
      await send('/models', 'kari'),
    );

    expect(priced.status).toBe(200);
    expect(models.data.find((m) => m.id === 'fake/gpt')?.price).toEqual({
      inputPerThousand: 0.01,
      outputPerThousand: 0.04,
    });
    expect(platform.prices['fake/gpt']).toEqual({
      inputPerThousand: 0.01,
      outputPerThousand: 0.04,
    });
    expect(
      (
        await send('/operator/models/fake/gpt/price', 'drift', {
          method: 'PUT',
          body: { inputPerThousand: -1, outputPerThousand: 0 },
          reason,
        })
      ).status,
    ).toBe(400);
  });
});

describe('search engines for operators', () => {
  const knowledge = {
    endpoints: {
      sok: {
        engine: 'typesense',
        baseURL: 'https://sok.example.no',
        auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
      },
      ledig: {
        engine: 'typesense',
        baseURL: 'https://ledig.example.no',
        auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
      },
    },
    datasets: [
      {
        id: 'veiledere',
        name: 'Veiledere',
        endpoint: 'sok',
        residency: 'norway',
        options: {
          collections: { docs: 'docs', chunks: 'chunks' },
          profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
        },
      },
    ],
  };

  it('refuses to delete a search engine datasets use, and deletes an unused one', async () => {
    const { send } = await bootPlatform({ people, knowledge });

    const used = await send('/operator/knowledge/endpoints/sok', 'drift', {
      method: 'DELETE',
      reason,
    });
    const unused = await send('/operator/knowledge/endpoints/ledig', 'drift', {
      method: 'DELETE',
      reason,
    });
    const byTenant = await send('/operator/knowledge/endpoints/ledig', 'kari', {
      method: 'DELETE',
      reason,
    });

    expect(used.status).toBe(409);
    expect(await used.json()).toMatchObject({
      datasets: [{ dataset: 'veiledere', name: 'Veiledere', tenant: digdir }],
    });
    expect(unused.status).toBe(204);
    expect(byTenant.status).toBe(403);
  });
});
