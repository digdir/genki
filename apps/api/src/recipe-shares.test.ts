import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, files, testService } from './testkit.js';

const other = '974760673';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: other,
    authorizedFor: [{ org: other }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
};

const reason = 'Oppskriften passer for alle';
const flows = join(import.meta.dirname, '..', 'config', 'local', 'flows');
const shippedRecipe = () =>
  parseYaml(readFileSync(join(flows, 'answer-briefly-with-sources.yaml'), 'utf8')) as {
    spec: Record<string, unknown>;
  };

const serviceUsing = (
  settings: Record<string, unknown>,
  flow = 'answer-briefly-with-sources@1',
) => {
  const base = testService('saksbehandling', other);
  return {
    ...base,
    spec: {
      ...base.spec,
      variants: [
        'default',
        {
          id: 'kort',
          title: { nb: 'Kort svar', en: 'Short answer' },
          strategy: { id: 'step-flow', version: 1, config: { flow, settings } },
        },
      ],
    },
  };
};

const boot = async () => {
  const booted = await bootPlatform({ people });
  const registered = await booted.send('/operator/tenants', 'drift', {
    body: { orgNumber: other, name: 'Brønnøysundregistrene' },
    reason: 'Registrerer testetaten',
  });
  expect(registered.status).toBe(200);
  const published = await booted.platform.definitions.publish(
    shippedRecipe(),
    'kari',
    'Oppskrift',
    {},
  );
  expect(published.ok).toBe(true);
  const recipes = async (who: string) =>
    (
      (await (
        await booted.send(`/tenants/${who === 'ola' ? other : digdir}/step-flows/recipes`, who)
      ).json()) as {
        recipes: { ref: string; origin: string; shared?: boolean; version: number }[];
      }
    ).recipes;
  const share = (method: 'PUT' | 'DELETE', who = 'drift', withReason = reason) =>
    booted.send('/operator/recipes/shares/answer-briefly-with-sources', who, {
      method,
      ...(withReason ? { reason: withReason } : {}),
    });
  return { ...booted, recipes, share };
};

describe('recipes shared across organisations', () => {
  it('an unshared recipe is invisible to other organisations', async () => {
    const { recipes, platform } = await boot();

    expect(await recipes('ola')).toEqual([]);
    const refused = await platform.definitions.publish(
      serviceUsing({}),
      'ola',
      'Ny variant',
      files,
    );
    expect(refused.ok ? [] : refused.errors.map((e) => e.message)).toContain(
      'no published step flow answer-briefly-with-sources@1',
    );
  });

  it('sharing is an audited operator action with a change reason', async () => {
    const { share, admin } = await boot();

    expect((await share('PUT', 'kari')).status).toBe(403);
    expect((await share('PUT', 'drift', '')).status).toBe(400);
    const shared = await share('PUT');

    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ flow: 'answer-briefly-with-sources', shared: true });
    const audit = (await admin.audit(digdir)).filter((a) =>
      a.action.startsWith('platform.recipe.'),
    );
    expect(audit.map((a) => [a.action, a.outcome, a.target, a.actor, a.reason])).toEqual([
      [
        'platform.recipe.share',
        'applied',
        'recipe-share:answer-briefly-with-sources',
        'operator:test:drift',
        reason,
      ],
    ]);
    expect(audit[0]?.task).toBe(shared.headers.get('genai-task'));
  });

  it('another organisation can use a shared recipe, listed after its own and marked as shared', async () => {
    const { share, recipes, platform } = await boot();
    await share('PUT');

    expect((await recipes('ola')).map((r) => [r.ref, r.origin])).toEqual([
      ['answer-briefly-with-sources@1', 'shared'],
    ]);
    expect((await recipes('kari')).map((r) => [r.ref, r.origin, r.shared])).toEqual([
      ['answer-briefly-with-sources@1', 'own', true],
    ]);
    const published = await platform.definitions.publish(
      serviceUsing({ answerLength: 'short' }),
      'ola',
      'Ny variant',
      files,
    );
    expect(published.ok ? [] : published.errors).toEqual([]);
    const refused = await platform.definitions.publish(
      serviceUsing({ answerLength: 'very short' }),
      'ola',
      'Feil innstilling',
      files,
    );
    expect(refused.ok).toBe(false);
  });

  it('a service pins the recipe version it was published with', async () => {
    const { share, recipes, platform, send } = await boot();
    await share('PUT');
    await platform.definitions.publish(serviceUsing({}), 'ola', 'Ny variant', files);
    const changed = shippedRecipe();
    changed.spec.purpose = 'En nyere versjon av oppskriften';
    await platform.definitions.publish(changed, 'kari', 'Ny versjon', {});

    const stored = await platform.definitions.get('Service', other, 'saksbehandling');
    expect(JSON.stringify(stored?.definition)).toContain('answer-briefly-with-sources@1');
    expect((await recipes('ola')).map((r) => r.ref)).toEqual(['answer-briefly-with-sources@2']);
    const pinned = await send(
      `/tenants/${other}/step-flows/recipes/answer-briefly-with-sources/versions/1`,
      'ola',
    );
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({
      recipe: { ref: 'answer-briefly-with-sources@1', origin: 'shared' },
    });
  });

  it('after unsharing, other organisations cannot start using the recipe', async () => {
    const { share, recipes, platform, admin } = await boot();
    await share('PUT');
    await share('DELETE');

    expect(await recipes('ola')).toEqual([]);
    expect(
      (await platform.definitions.publish(serviceUsing({}), 'ola', 'Ny variant', files)).ok,
    ).toBe(false);
    expect((await admin.audit(digdir)).map((a) => a.action)).toContain('platform.recipe.unshare');
  });

  it('an organisation cannot read a recipe version that was never shared with it', async () => {
    const { send } = await boot();

    const res = await send(
      `/tenants/${other}/step-flows/recipes/answer-briefly-with-sources/versions/1`,
      'ola',
    );
    expect(res.status).toBe(404);
  });
});
