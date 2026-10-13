import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin, platformActions, type AdminHandler } from './admin.js';
import { createPlatform, platformModules } from './composition.js';
import { maskinportenClientsModule } from './maskinporten-clients.js';
import { onboardingModule } from './onboarding.js';
import { operatorModelsModule } from './operator-models.js';
import { adminActionRights } from './rights.js';
import { digdir, plugins, settingDefinitions } from './testkit.js';

const resource = 'urn:altinn:resource:digdir-genai-platform';

const person = (subject: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant: digdir,
  authorizedFor: [{ org: digdir, resource, actions }],
});

const ingrid = person('ingrid', ['use-services', 'manage-datasets', 'view-usage']);
const kari = person('kari', ['use-services', 'manage-services', 'manage-datasets', 'view-usage']);
const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'drift' };
const apiKey: Principal = {
  kind: 'agency-system',
  issuer: 'api-key',
  subject: 'nøkkel-1',
  tenant: digdir,
};

const applied: AdminHandler = async () => ({ ok: true, value: 'utført', target: 'test' });

const setup = () => {
  const settings = new SettingsRegistry(settingDefinitions);
  const admin = createAdmin({
    store: new InMemoryDefinitionStore(plugins),
    plugins,
    settings,
    extensions: {
      'platform.pipeline.save': applied,
      'platform.block.decide': applied,
      'platform.proposal.decide': applied,
    },
  });
  const setTopK = (principal: Principal) =>
    admin.setTenantSetting(principal, digdir, 'search.topK', 7, 'Færre treff');
  return { admin, settings, setTopK };
};

const registeredActions = async () => {
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices: {},
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async () => undefined,
    modules: [
      ...platformModules,
      onboardingModule,
      maskinportenClientsModule,
      operatorModelsModule,
    ],
  });
  return [...platformActions, ...Object.keys(platform.extensions)];
};

describe('rights on admin actions', () => {
  it('every admin action has a required right', async () => {
    const actions = await registeredActions();
    expect(actions.filter((action) => !(action in adminActionRights))).toEqual([]);
    expect(Object.keys(adminActionRights).filter((action) => !actions.includes(action))).toEqual(
      [],
    );
  });

  it('a dataset admin calling a service-admin action directly is refused', async () => {
    const { admin, settings, setTopK } = setup();

    const result = await setTopK(ingrid);

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'principal', message: 'Du trenger rettigheten «Administrere tjenester»' },
      ]),
      problem: {
        status: 403,
        title: 'Du trenger rettigheten «Administrere tjenester»',
        errors: [{ path: 'right', message: 'manage-services' }],
      },
    });
    expect(settings.tenant(digdir).values['search.topK']).toBeUndefined();
    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.setting.set',
      outcome: 'rejected',
    });
  });

  it('a dataset admin may run dataset actions but not operator-only ones', async () => {
    const { admin } = setup();
    const input = { tenant: digdir, reason: 'Ny innhenting' };

    expect((await admin.perform(ingrid, 'platform.pipeline.save', input)).ok).toBe(true);
    expect(await admin.perform(kari, 'platform.block.decide', input)).toMatchObject({
      ok: false,
      errors: [{ path: 'principal' }],
    });
  });

  it('approving a level-3 proposal needs Registrere byggeklosser', async () => {
    const { admin } = setup();
    const input = { tenant: digdir, reason: 'Godkjent', id: 'forslag-1', op: 'approve' };

    expect((await admin.perform(kari, 'platform.proposal.decide', input)).ok).toBe(true);
    expect(
      await admin.perform(kari, 'platform.proposal.decide', { ...input, level: 3 }),
    ).toMatchObject({
      ok: false,
      problem: { title: 'Du trenger rettigheten «Registrere byggeklosser»' },
    });
  });

  it('an operator keeps access', async () => {
    const { settings, setTopK } = setup();

    expect((await setTopK({ ...operator, tenant: digdir, actor: operator })).ok).toBe(true);
    expect(settings.tenant(digdir).values['search.topK']).toBe(7);
  });

  it('an API key bound to the tenant keeps access', async () => {
    const { settings, setTopK } = setup();

    expect((await setTopK(apiKey)).ok).toBe(true);
    expect(settings.tenant(digdir).values['search.topK']).toBe(7);
  });

  it('a service admin keeps access', async () => {
    const { setTopK } = setup();

    expect((await setTopK(kari)).ok).toBe(true);
  });
});
