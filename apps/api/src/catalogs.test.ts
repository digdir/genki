import { describe, expect, it } from 'vitest';
import { resolveCatalog } from './catalogs.js';

const raw = {
  endpoints: {
    listing: { baseURL: '${OPENAI_URL}', families: { openai: '' } },
    claude: {
      baseURL: '${CLAUDE_URL}',
      families: { anthropic: '' },
      discovery: [{ source: 'azure-deployments', from: 'listing' }],
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

  it('drops a family whose base is not set, with the rules and models bound to it, and keeps the connection', () => {
    const { catalog, skipped } = resolveCatalog(
      {
        endpoints: {
          foundry: {
            baseURL: '${OPENAI_URL}',
            families: { openai: '', anthropic: '${CLAUDE_URL}' },
            discovery: [
              { source: 'azure-deployments', apis: { chat: 'openai/chat-completions@1' } },
              { source: 'azure-deployments', apis: { chat: 'anthropic/messages@1' } },
            ],
          },
        },
        models: [
          { id: 'gpt', endpoint: 'foundry', deployment: 'gpt' },
          {
            id: 'claude',
            endpoint: 'foundry',
            deployment: 'claude',
            apis: { chat: 'anthropic/messages@1' },
          },
        ],
      },
      'models',
      { OPENAI_URL: 'https://a.example/openai/v1' },
    );

    expect(skipped).toEqual(['endpoint foundry family anthropic', 'models claude']);
    expect(catalog).toMatchObject({
      endpoints: {
        foundry: {
          families: { openai: '' },
          discovery: [{ apis: { chat: 'openai/chat-completions@1' } }],
        },
      },
      models: [{ id: 'gpt' }],
    });
  });
});
