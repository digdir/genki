import { describe, expect, it } from 'vitest';
import {
  ToolError,
  ToolRegistry,
  errorResult,
  type ToolResult,
  type ToolSource,
} from '@genai/port-tools';
import { notices, run, steps } from './harness.test-utils.js';
import { checkFlow } from './validate.js';
import { builtinBlocks } from './builtins.js';

interface Call {
  name: string;
  tenant: string;
  input: unknown;
}

const source = (
  handler: (input: unknown) => ToolResult | Promise<ToolResult>,
  calls: Call[] = [],
): ToolSource => ({
  resolve: (name, version, ctx, owner) =>
    name.startsWith('saker.')
      ? {
          definition: () => ({
            name,
            version,
            description: 'Saksarkiv',
            input: { type: 'object' },
            origin: 'mcp',
          }),
          call: async (input) => {
            calls.push({ name, tenant: owner, input });
            if (ctx.signal.aborted) throw new ToolError('cancelled', 'cancelled');
            return handler(input);
          },
        }
      : undefined,
});

const text = (value: string): ToolResult => ({
  parts: [{ mime: 'text/plain', body: { kind: 'text', text: value } }],
});

const registry = (...sources: ToolSource[]) => {
  const tools = new ToolRegistry();
  for (const s of sources) tools.addSource(s);
  return tools;
};

const call = (extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}) =>
  steps('flyt', [
    {
      id: 'sok',
      block: 'tool@1',
      params: {
        source: 'saker',
        tool: 'search',
        arguments: { q: '{{input.query}}', limit: 2 },
        ...params,
      },
      ...extra,
    },
    { id: 'svar', block: 'template@1', input: { text: 'Fant: {{sok.text}} ({{sok.json.count}})' } },
  ]);

const answer = (parts: unknown) =>
  ((parts as { body: { json?: { text?: string } } }[])[0]?.body.json ?? {}).text;

const config = { tools: ['saker.search@1'] };

describe('the tool block', () => {
  it('calls the tool with templated arguments and hands its text and JSON to later steps', async () => {
    const calls: Call[] = [];
    const tools = registry(
      source(
        () => ({
          parts: [
            { mime: 'text/plain', body: { kind: 'text', text: 'to treff' } },
            { mime: 'application/json', body: { kind: 'json', json: { count: 2 } } },
          ],
          sources: [{ id: 'https://saker/1', title: 'Sak 1' }],
        }),
        calls,
      ),
    );

    const { result, events } = await run(
      { flows: [call()], entry: 'flyt@1', tools, config },
      { data: { query: 'tilskudd' } },
    );

    expect(answer(result)).toBe('Fant: to treff (2)');
    expect(calls).toEqual([
      { name: 'saker.search', tenant: '991825827', input: { q: 'tilskudd', limit: 2 } },
    ]);
    const shown = notices(events).find((n) => n.kind === 'external-step');
    expect(shown).toMatchObject({
      origin: 'tool',
      step: 'sok',
      tool: 'saker.search',
      ok: true,
      sources: 1,
      arguments: ['q', 'limit'],
    });
    expect(JSON.stringify(shown)).not.toContain('tilskudd');
  });

  it('refuses a tool the service has not been granted', async () => {
    const calls: Call[] = [];
    const tools = registry(source(() => text('hei'), calls));

    const { result, task } = await run({
      flows: [call()],
      entry: 'flyt@1',
      tools,
      config: { tools: ['saker.other@1'] },
    });

    expect(String(result)).toContain('the service has no tool saker.search');
    expect(task.status).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('follows onError when the tool reports an error', async () => {
    const tools = registry(source(() => errorResult('nede')));

    const stop = await run({ flows: [call()], entry: 'flyt@1', tools, config });
    const skip = await run({
      flows: [call({ onError: 'use-default', default: { text: 'ingen', json: { count: 0 } } })],
      entry: 'flyt@1',
      tools,
      config,
    });

    expect(String(stop.result)).toContain(
      'step sok failed: tool saker.search reported an error: nede',
    );
    expect(answer(skip.result)).toBe('Fant: ingen (0)');
    expect(notices(skip.events).some((n) => n.kind === 'external-step' && n.ok === false)).toBe(
      true,
    );
  });

  it('gives up on a tool that takes longer than the step allows', async () => {
    const tools = registry(source(() => new Promise<ToolResult>(() => undefined)));

    const { result } = await run({
      flows: [call({}, { timeoutMs: 100 })],
      entry: 'flyt@1',
      tools,
      config,
    });

    expect(String(result)).toContain('timed out after 100 ms');
  });

  it('stops a running tool call when the task is cancelled', async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const tools = registry(
      source(async () => {
        started();
        return new Promise<ToolResult>(() => undefined);
      }),
    );
    const { setup, kari } = await import('./harness.test-utils.js');
    const { kernel } = setup({ flows: [call()], entry: 'flyt@1', tools, config });

    const started$ = await kernel.invoke(kari, 'flow', { data: { query: 'x' } });
    await running;
    await kernel.cancel(kari, started$.task);

    await expect(started$.result).rejects.toThrow();
    expect((await kernel.task(kari, started$.task)).status).toBe('cancelled');
  });

  it('checks the arguments of a literal tool step when the flow is published', () => {
    const flow = steps('flyt', [
      { id: 'sok', block: 'tool@1', params: { tool: 'search', arguments: {} } },
    ]);

    expect(checkFlow(flow, builtinBlocks()).map((p) => p.path)).toContain(
      'spec.steps[0].params.source',
    );
  });
});
