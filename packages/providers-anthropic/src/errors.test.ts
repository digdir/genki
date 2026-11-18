import { afterEach, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { ModelRouter } from '@genai/port-model';
import { fakeHttp, testContext, type FakeServer } from '@genai/port-model/testing';
import { anthropicMessages } from './index.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

it("keeps a 5xx answer's status and message on the error for the audit, and gives the caller only that the model is unavailable", async () => {
  const server = await fakeHttp(() => ({
    status: 503,
    json: {
      type: 'error',
      error: { type: 'overloaded_error', message: 'the deployment is overloaded' },
    },
  }));
  servers.push(server);
  const router = new ModelRouter({
    catalog: {
      endpoints: {
        claude: {
          families: { anthropic: '' },
          baseURL: server.url,
          auth: { kind: 'bearer', secret: 'secret://env/test-key' },
        },
      },
      models: [
        {
          id: 'claude/sonnet',
          endpoint: 'claude',
          deployment: 'sonnet',
          residency: 'norway',
          apis: { chat: 'anthropic/messages@1' },
        },
      ],
    },
    adapters: [anthropicMessages],
    secrets: envSecrets({ TEST_KEY: 'key' }),
    maxRetries: 0,
  });
  const port = router.open({ kind: 'model', id: 'claude/sonnet' }, testContext().ctx);
  const error = await port
    .chat({ messages: [{ role: 'user', content: 'Hei' }] })
    .catch((e: unknown) => e);
  expect(error).toMatchObject({
    code: 'unavailable',
    message: 'the model is unavailable',
    provider: { status: 503, body: expect.stringContaining('the deployment is overloaded') },
  });
});
