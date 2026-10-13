import { afterEach, describe, expect, it } from 'vitest';
import { textPart, type Principal } from '@genai/contracts';
import { InMemoryDefinitionStore } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createPlatform } from './composition.js';
import { failureLoggingEventLog } from './failure-log.js';

const digdir = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir };

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const question = 'Hemmelig spørsmål om Ola Nordmann';

describe('the API log', () => {
  it('logs a failed model call and the failed run with ids and codes, never the content', async () => {
    const model = await fakeHttp(() => ({
      status: 400,
      json: { error: { message: 'deployment not found' } },
    }));
    servers.push(model);
    const lines: { msg: string; fields: Record<string, unknown> }[] = [];
    const platform = await createPlatform({
      catalogs: {
        models: {
          endpoints: {
            fake: {
              protocol: 'openai-chat',
              baseURL: `${model.url}/v1`,
              auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
            },
          },
          models: [
            {
              id: 'fake/gpt',
              endpoint: 'fake',
              deployment: 'gpt',
              residency: 'norway',
              capabilities: ['stream'],
            },
          ],
        },
        knowledge: { endpoints: {}, datasets: [] },
        rerank: { endpoints: {}, rerankers: [] },
      },
      secrets: envSecrets({ FAKE_KEY: 'k' }),
      definitions: (plugins) => new InMemoryDefinitionStore(plugins),
      policy: { decide: async () => ({ allow: true }) },
      authenticate: async () => undefined,
      logger: (msg, fields) => lines.push({ msg, fields }),
    });
    const published = await platform.definitions.publish(
      {
        apiVersion: 'genai/v1',
        kind: 'Service',
        metadata: { tenant: digdir, id: 'svar', name: 'Svar' },
        spec: {
          purpose: 'Svarer kort',
          riskClass: 'minimal',
          input: { accepts: ['text/plain'] },
          output: { kind: 'answer' },
          strategy: { id: 'single-call', version: 1, config: { instructions: 'prompts/svar.md' } },
          model: { primary: 'fake/gpt', residency: 'global' },
          exposure: { rest: true },
        },
      },
      'test',
      'first',
      { 'prompts/svar.md': 'Svar kort.' },
    );
    expect(published.ok).toBe(true);
    const capability = (await platform.definitions.capabilities())[0]?.capability.descriptor.id;

    const run = await platform.kernel.invoke(kari, capability ?? '', {
      data: { query: question },
      parts: [textPart(question)],
    });
    await expect(run.result).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lines).toEqual([
      {
        msg: 'model call failed',
        fields: {
          task: run.task,
          tenant: digdir,
          capability,
          model: 'fake/gpt',
          error: 'ModelError',
          code: 'bad_request',
        },
      },
      {
        msg: 'task failed',
        fields: {
          task: run.task,
          tenant: digdir,
          capability,
          models: ['fake/gpt'],
          code: 'strategy_error',
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('Nordmann');
  });
});

describe('the API log in local debugging', () => {
  it('includes the error message only when asked to', async () => {
    const lines: Record<string, unknown>[] = [];
    const inner = {
      append: async (event: unknown) => event,
      read: async function* () {},
      wake: () => undefined,
    } as unknown as Parameters<typeof failureLoggingEventLog>[0];
    const failed = {
      task: 't1',
      type: 'kernel.error',
      audience: 'audit',
      data: { code: 'strategy_error', message: 'step dokumenter failed' },
    } as unknown as Parameters<Parameters<typeof failureLoggingEventLog>[0]['append']>[0];
    const capabilityOf = async () => undefined;

    await failureLoggingEventLog(inner, (_m, f) => lines.push(f), capabilityOf).append(failed, {
      tenant: digdir,
    } as never);
    await failureLoggingEventLog(inner, (_m, f) => lines.push(f), capabilityOf, {
      messages: true,
    }).append(failed, { tenant: digdir } as never);

    expect(lines[0]).not.toHaveProperty('message');
    expect(lines[1]).toMatchObject({ message: 'step dokumenter failed' });
  });
});
