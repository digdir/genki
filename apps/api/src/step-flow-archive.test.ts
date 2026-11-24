import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, files, other, readJson, testService } from './testkit.js';

const person = (subject: string, tenant: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, actions }],
});

const people = {
  eier: person('eier', digdir, ['use-services', 'manage-services']),
  leser: person('leser', digdir, ['use-services']),
  ola: person('ola', other, ['use-services', 'manage-services']),
};

const reason = 'Rydder bort testflyter';

const felles = {
  title: { nb: 'Felles flyt', en: 'Shared flow' },
  summary: { nb: 'Svarer', en: 'Answers' },
};

const flow = (id: string, tenant = digdir, subflow?: string) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant, id, name: `Flyt ${id}` },
  spec: {
    purpose: 'Svarer på spørsmålet',
    steps: subflow
      ? [{ id: 'under', subflow }]
      : [{ id: 'svar', block: 'answer@1', input: { text: '{{input.query}}' } }],
  },
});

const usingFlow = (id: string, flowRef: string, tenant = digdir, internal = false) => {
  const service = testService(id, tenant);
  return {
    ...service,
    spec: {
      ...service.spec,
      strategy: { id: 'step-flow', version: 1, config: { flow: flowRef } },
      ...(internal ? { visibility: 'internal' } : {}),
    },
  };
};

const boot = async () => {
  const booted = await bootPlatform({ people });
  const publish = async (definition: unknown) => {
    const result = await booted.platform.definitions.publish(definition, 'test', 'oppsett', {});
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  };
  const archive = (id: string, as = 'eier', tenant = digdir, withReason = reason) =>
    booted.send(`/tenants/${tenant}/step-flows/${id}`, as, {
      method: 'DELETE',
      ...(withReason ? { reason: withReason } : {}),
    });
  const listed = async (as = 'eier', tenant = digdir) =>
    (
      await readJson<{ data: { id: string }[] }>(
        await booted.send(`/tenants/${tenant}/building-blocks?kind=step_flow`, as),
      )
    ).data.map((b) => b.id);
  const shareRecipe = (id: string) =>
    booted.configEntries.append({
      kind: 'recipe-share',
      scope: digdir,
      id,
      version: 1,
      spec: { flow: id, state: 'shared' },
      deleted: false,
      by: 'operator:test:drift',
      at: '2026-11-19T10:00:00Z',
      reason: 'Deler oppskriften',
    });
  return { ...booted, publish, archive, listed, shareRecipe };
};

describe('archiving a step flow', () => {
  it('archives an unused step flow, audits it with the reason and stops listing it', async () => {
    const { publish, archive, listed, admin } = await boot();
    await publish(flow('gammel-flyt'));
    expect(await listed()).toContain('gammel-flyt');

    const archived = await archive('gammel-flyt');

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ id: 'gammel-flyt', archived: true, version: 1 });
    expect(await listed()).not.toContain('gammel-flyt');
    expect(
      (await admin.audit(digdir)).find((a) => a.action === 'platform.step-flow.archive'),
    ).toMatchObject({
      outcome: 'applied',
      target: 'step-flow:gammel-flyt',
      reason,
      actor: 'employee:test:eier',
    });
  });

  it('refuses with 409 a step flow a published service uses, and names the service', async () => {
    const { publish, archive, listed } = await boot();
    await publish(flow('i-bruk'));
    await publish(usingFlow('svarer', 'i-bruk@1'));

    const refused = await archive('i-bruk');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:step-flow-in-use',
      usedBy: [{ tenant: digdir, service: 'svarer' }],
    });
    expect(await listed()).toContain('i-bruk');
  });

  it('refuses with 409 a step flow an internal service uses, without naming it to an owner', async () => {
    const { publish, archive, listed } = await boot();
    await publish(flow('roykflyt'));
    await publish(usingFlow('smoke', 'roykflyt@1', digdir, true));

    const refused = await archive('roykflyt');
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).not.toContain('smoke');
    expect(JSON.parse(body)).toMatchObject({ usedBy: [], internalServices: 1 });
    expect(await listed()).toContain('roykflyt');
  });

  it('refuses with 409 a step flow a used step flow runs as a subflow', async () => {
    const { publish, archive } = await boot();
    await publish(flow('indre'));
    await publish(flow('ytre', digdir, 'indre@1'));
    await publish(usingFlow('svarer', 'ytre@1'));

    expect((await archive('indre')).status).toBe(409);
  });

  it("refuses with 409 a platform step flow another organisation's service uses", async () => {
    const { publish, archive, shareRecipe } = await boot();
    await publish({ ...flow('felles'), spec: { ...flow('felles').spec, recipe: felles } });
    await shareRecipe('felles');
    await publish(usingFlow('annen', 'felles@1', other));

    const refused = await archive('felles');

    expect(refused.status).toBe(409);
  });

  it("archiving a shared step flow does not name another organisation's services", async () => {
    const { publish, archive, shareRecipe } = await boot();
    await publish({ ...flow('felles'), spec: { ...flow('felles').spec, recipe: felles } });
    await shareRecipe('felles');
    await publish(usingFlow('annen', 'felles@1', other));

    const owner = await archive('felles');
    const body = await owner.text();

    expect(owner.status).toBe(409);
    expect(body).not.toContain(other);
    expect(body).not.toContain('annen');
    expect(JSON.parse(body)).toMatchObject({ usedBy: [], otherOrganisations: 1 });
  });

  it("a step flow is not archived while a service's pinned production version runs it", async () => {
    const { publish, archive, configEntries, platform } = await boot();
    await publish(flow('festet'));
    await publish(usingFlow('svarer', 'festet@1'));
    await configEntries.append({
      kind: 'service-environments',
      scope: digdir,
      id: 'svarer',
      version: 1,
      spec: { environments: { prod: { version: 1 } } },
      deleted: false,
      by: 'employee:test:eier',
      at: '2026-11-19T10:00:00Z',
      reason: 'Fester produksjon',
    });
    const later = await platform.definitions.publish(
      testService('svarer'),
      'test',
      'Bytter til instruksjoner',
      files,
    );
    expect(later.ok).toBe(true);

    const refused = await archive('festet');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ usedBy: [{ tenant: digdir, service: 'svarer' }] });
  });

  it('lets an archived service stop holding on to its step flow', async () => {
    const { publish, archive, send } = await boot();
    await publish(flow('nedlagt'));
    await publish(usingFlow('gammel', 'nedlagt@1'));
    const stopped = await send(`/tenants/${digdir}/services/gammel/lifecycle`, 'eier', {
      method: 'PUT',
      body: { state: 'archived' },
      reason: 'Tjenesten er lagt ned',
    });
    expect(stopped.status).toBe(200);

    expect((await archive('nedlagt')).status).toBe(200);
  });

  it('needs manage-services and a change reason', async () => {
    const { publish, archive, listed } = await boot();
    await publish(flow('flyt'));

    expect((await archive('flyt', 'leser')).status).toBe(403);
    expect((await archive('flyt', 'eier', digdir, '')).status).toBe(400);
    expect(await listed()).toContain('flyt');
  });

  it("cannot archive another organisation's step flow or one that does not exist", async () => {
    const { publish, archive, configEntries } = await boot();
    await publish(flow('egen', other));

    expect((await archive('egen', 'ola', digdir)).status).toBe(404);
    expect((await archive('egen', 'eier')).status).toBe(404);
    expect((await archive('finnes-ikke')).status).toBe(404);
    expect(await configEntries.latest({ kind: 'step-flow-archive' })).toEqual([]);
  });

  it('answers 404 for a step flow already archived', async () => {
    const { publish, archive } = await boot();
    await publish(flow('borte'));
    expect((await archive('borte')).status).toBe(200);

    expect((await archive('borte')).status).toBe(404);
  });

  it('lists the step flow again when someone publishes a new version of it', async () => {
    const { publish, archive, listed } = await boot();
    await publish(flow('tilbake'));
    expect((await archive('tilbake')).status).toBe(200);

    await publish(flow('tilbake'));

    expect(await listed()).toContain('tilbake');
  });
});
