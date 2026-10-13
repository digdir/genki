import { describe, expect, it } from 'vitest';
import { resolveCatalog } from './catalogs.js';

const raw = {
  endpoints: {
    listing: { protocol: 'openai-chat', baseURL: '${OPENAI_URL}' },
    claude: {
      protocol: 'anthropic-messages',
      baseURL: '${CLAUDE_URL}',
      discovery: { source: 'azure-deployments', from: 'listing' },
    },
  },
  models: [{ id: 'pinned', endpoint: 'listing', deployment: '${PINNED}' }],
};

describe('catalog loading', () => {
  it('fills placeholders from the environment', () => {
    const { catalog, skipped } = resolveCatalog(raw, 'models', {
      OPENAI_URL: 'https://a.example',
      CLAUDE_URL: 'https://b.example',
      PINNED: 'gpt-4o',
    });

    expect(skipped).toEqual([]);
    expect(catalog).toMatchObject({
      endpoints: {
        listing: { baseURL: 'https://a.example' },
        claude: { baseURL: 'https://b.example' },
      },
      models: [{ deployment: 'gpt-4o' }],
    });
  });

  it('skips an unset endpoint, an endpoint that lists through it, and the models that depend on them', () => {
    const { catalog, skipped } = resolveCatalog(raw, 'models', { CLAUDE_URL: 'https://b.example' });

    expect(skipped).toEqual(['endpoint listing', 'endpoint claude', 'models pinned']);
    expect(catalog).toMatchObject({ endpoints: {}, models: [] });
  });
});
