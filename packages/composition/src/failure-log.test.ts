import { describe, expect, it } from 'vitest';
import { ModelError, type ModelPort } from '@genai/port-model';
import { loggedModels } from './failure-log.js';

const failing = (error: unknown) => ({
  open: (_ref: unknown, _ctx: unknown): ModelPort =>
    ({
      chat: async () => {
        throw error;
      },
    }) as unknown as ModelPort,
});

const logged = async (error: unknown) => {
  const lines: Record<string, unknown>[] = [];
  const router = loggedModels(
    failing(error),
    (_msg, fields) => lines.push(fields),
    async () => 'svc',
  );
  await expect(
    router.open({ id: 'm' } as never, { task: 't', tenant: 'org' } as never).chat({} as never),
  ).rejects.toBe(error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return lines[0];
};

describe('model call failures in the API log', () => {
  it('logs why the provider refused a request it found malformed', async () => {
    const line = await logged(new ModelError('bad_request', 'Invalid schema for function x'));
    expect(line).toMatchObject({ code: 'bad_request', reason: 'Invalid schema for function x' });
  });

  it('cuts the provider reason to 300 characters', async () => {
    const line = await logged(new ModelError('bad_request', 'x'.repeat(1000)));
    expect(String(line?.reason)).toHaveLength(300);
  });

  it('leaves out the message of other model errors, which may quote content', async () => {
    const line = await logged(
      new ModelError('content_filtered', 'filtered: the user wrote secret'),
    );
    expect(line).toMatchObject({ code: 'content_filtered' });
    expect(line).not.toHaveProperty('reason');
  });
});
