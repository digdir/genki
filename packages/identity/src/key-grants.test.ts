import { describe, expect, it } from 'vitest';
import {
  apiKeyDigest,
  capabilityModes,
  configKeyAllows,
  configKeyGrant,
  InMemoryApiKeys,
  keyReaches,
  keyReachesMode,
  verifyApiKey,
  type StoredApiKey,
} from './api-keys.js';
import { keyGrantPolicy } from './policy.js';

const stored = (extra: Partial<StoredApiKey>): StoredApiKey => ({
  id: 'k',
  name: 'k',
  digest: apiKeyDigest('rag_key'),
  tenant: '991825827',
  scopes: ['query'],
  datasets: [],
  agents: ['*'],
  ...extra,
});

const verified = async (extra: Partial<StoredApiKey>) => {
  const keys = new InMemoryApiKeys();
  keys.add(stored(extra));
  return verifyApiKey(keys, 'rag_key');
};

describe('access policy union', () => {
  it("unions the policy's scopes, datasets, agents, skill graphs and config keys with the key's own", async () => {
    const { principal, grants } = await verified({
      scopes: [],
      agents: ['a__x'],
      skillGraphs: ['builtin/g1'],
      policy: {
        id: 'p',
        scopes: ['query'],
        datasets: ['d1'],
        agents: ['b__y'],
        skillGraphs: ['builtin/g2'],
        allowedConfigKeys: [configKeyGrant('dataset', 'd1')],
      },
    });

    expect(grants.scopes).toEqual(['query']);
    expect(grants.agents.sort()).toEqual(['a__x', 'b__y']);
    expect(grants.skillGraphs.sort()).toEqual(['builtin/g1', 'builtin/g2']);
    expect(grants.allowedConfigKeys).toEqual(['dataset:d1']);
    expect(keyReaches(principal, 'query', { agents: ['b__y'] })).toBe(true);
    expect(keyReaches(principal, 'query', { datasets: ['d1'] })).toBe(true);
  });

  it('treats a key with no grants of its own but a policy as restricted to the policy', async () => {
    const { principal } = await verified({
      agents: [],
      policy: { id: 'p', agents: ['a__x'] },
    });
    expect(keyReaches(principal, 'query', { agents: ['a__x'] })).toBe(true);
    expect(keyReaches(principal, 'query', { agents: ['b__y'] })).toBe(false);
  });
});

describe('skill-graph grants', () => {
  it('reads the modes of a capability from its legacy tool names and its variant', () => {
    expect(
      capabilityModes('991825827/radgiver/faithful', [
        '991825827/radgiver/faithful',
        'builtin.radgiver-agent__agent-rag-graph-faithful',
      ]),
    ).toEqual(['agent-rag-graph-faithful', 'faithful']);
  });

  it('lets an empty skill-graph grant reach every mode', async () => {
    const { principal } = await verified({});
    expect(keyReachesMode(principal, ['anything'])).toBe(true);
  });

  it('matches a namespaced skill-graph grant against the short mode name', async () => {
    const { principal } = await verified({ skillGraphs: ['builtin/agent-rag-graph-faithful'] });
    expect(keyReachesMode(principal, ['agent-rag-graph-faithful'])).toBe(true);
    expect(keyReachesMode(principal, ['agent-rag-graph-bundled'])).toBe(false);
  });

  it('denies invoking a capability whose mode the key does not grant', async () => {
    const { principal } = await verified({ skillGraphs: ['builtin/agent-rag-graph-faithful'] });
    const policy = keyGrantPolicy({ decide: async () => ({ allow: true }) }, (ref) => [
      ref.id,
      `builtin.radgiver-agent__agent-rag-graph-${ref.id.split('/')[2]}`,
    ]);
    const decide = (variant: string) =>
      policy.decide(principal, 'invoke', {
        kind: 'capability',
        id: `991825827/radgiver/${variant}`,
      });

    expect((await decide('faithful')).allow).toBe(true);
    expect(await decide('bundled')).toEqual({
      allow: false,
      reason: 'the API key is not granted this mode',
    });
  });
});

describe('allowed config keys', () => {
  it('allows every config key of a root the key has no grants for', async () => {
    const { principal } = await verified({ allowedConfigKeys: ['runtime:default'] });
    expect(configKeyAllows(principal, 'dataset', ['kudos'])).toBe(true);
  });

  it('allows only the named config keys of a root the key has grants for', async () => {
    const { principal } = await verified({
      allowedConfigKeys: [configKeyGrant('dataset', 'kudos')],
    });
    expect(configKeyAllows(principal, 'dataset', ['digdir/kudos', 'kudos'])).toBe(true);
    expect(configKeyAllows(principal, 'dataset', ['other'])).toBe(false);
  });
});
