import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { bootPlatform, digdir, readJson } from './testkit.js';

const classifyYaml = `
id: example/classify@1
operation: classify
status: described
summary: A made-up classification API.
api:
  family: openai
  version: 2026-10-01
request:
  method: POST
  path: /classifications
  body:
    model: $deployment
    text: $input.text
input:
  object:
    text: text
output:
  object:
    label: plain
wire:
  request:
    object:
      model: plain
      text: text
  response:
    object:
      label: plain
result:
  label: $response.label
usage:
  requests: 1
stream: none
`;

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
};

const reason = 'Rydder bort testtyper';

const boot = async () => {
  const booted = await bootPlatform({
    people,
    descriptors: descriptorRegistry([...loadDescriptors().list(), parseDescriptor(classifyYaml)]),
  });
  const { send, configEntries } = booted;
  const { environment } = await readJson<{ environment: string }>(
    await send('/operator/operation-kinds', 'drift'),
  );
  const leftOver = (kind: string) =>
    configEntries.append({
      kind: 'operation-maturity',
      scope: environment,
      id: kind,
      version: 1,
      spec: { maturity: 'test' },
      deleted: false,
      by: 'operator:test:drift',
      at: '2026-11-19T10:00:00Z',
      reason: 'Prøvde en ny type',
    });
  const remove = (kind: string, as = 'drift', withReason = reason) =>
    send(`/operator/operation-kinds/${kind}`, as, {
      method: 'DELETE',
      ...(withReason ? { reason: withReason } : {}),
    });
  const listed = async () =>
    (
      await readJson<{ data: { kind: string }[] }>(await send('/operator/operation-kinds', 'drift'))
    ).data.map((k) => k.kind);
  return { ...booted, leftOver, remove, listed };
};

describe('deleting an operation kind', () => {
  it('deletes a kind no descriptor describes, audits it with the reason and stops listing it', async () => {
    const { leftOver, remove, listed, admin } = await boot();
    await leftOver('compose');
    expect(await listed()).toContain('compose');

    const removed = await remove('compose');

    expect(removed.status).toBe(204);
    expect(await listed()).not.toContain('compose');
    expect(
      (await admin.audit()).find((a) => a.action === 'platform.operations.kind.delete'),
    ).toMatchObject({
      outcome: 'applied',
      target: 'operation-kind:compose',
      actor: 'operator:test:drift',
      reason,
    });
  });

  it('refuses with 409 a kind a descriptor still describes, and names the descriptor', async () => {
    const { remove, listed } = await boot();

    const refused = await remove('classify');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:operation-kind-in-use',
      usedBy: [{ kind: 'descriptor', id: 'example/classify@1' }],
    });
    expect(await listed()).toContain('classify');
  });

  it('refuses with 409 a built-in kind', async () => {
    const { remove } = await boot();

    const refused = await remove('chat');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:operation-kind-built-in',
    });
  });

  it('is for operators only and needs a change reason', async () => {
    const { leftOver, remove, listed } = await boot();
    await leftOver('compose');

    expect((await remove('compose', 'kari')).status).toBe(403);
    expect((await remove('compose', 'drift', '')).status).toBe(400);
    expect(await listed()).toContain('compose');
  });

  it('answers 404 for a kind that is not listed', async () => {
    const { leftOver, remove } = await boot();
    await leftOver('compose');
    expect((await remove('compose')).status).toBe(204);

    expect((await remove('compose')).status).toBe(404);
    expect((await remove('finnes-ikke')).status).toBe(404);
  });
});
