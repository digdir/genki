import { runContract } from '@genai/plugins';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelAdapter } from './adapter.js';
import { modelContract, modelContractTarget } from './contract.js';

const careless: ModelAdapter = {
  protocol: 'careless',
  endpointOptions: z.object({}),
  modelOptions: z.object({}),
  connect: () => ({
    chat: async () => ({
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, requests: 1 },
      servedModel: '',
    }),
    chatStream: async function* () {
      yield { kind: 'delta', text: 'noe' };
    },
  }),
};

describe('model contract', () => {
  it('fails an adapter that answers without calling upstream or mapping errors', async () => {
    const run = await runContract(modelContract, () =>
      modelContractTarget({ adapter: careless, reply: () => ({ status: 200 }) }),
    );
    expect(run.passed).toBe(false);
    const failed = run.results.filter((r) => r.status === 'failed').map((r) => r.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        'chat returns the text, usage and served model, and meters the usage once',
        'chatStream yields deltas that add up to the final result',
        'upstream refusals map to rate_limited, unauthorized and unavailable',
        'an aborted signal fails as cancelled',
      ]),
    );
    expect(failed).not.toContain(
      'a capability the model does not declare fails as unsupported without calling upstream',
    );
  });
});
