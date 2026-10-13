import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PortContext } from '@genai/kernel';
import type { Usage } from '@genai/contracts';
import { parseToolRef, textOf, ToolError, ToolRegistry, toolRef, type ToolPort } from './index.js';

const context = (signal = new AbortController().signal) => {
  const metered: Usage[] = [];
  const ctx: PortContext = {
    tenant: '991825827',
    principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
    task: 't1',
    signal,
    meter: async (usage) => {
      metered.push(usage);
    },
  };
  return { ctx, metered };
};

const klarsprak = {
  name: 'digdir.klarsprak',
  version: '2.3',
  description: 'Skriv om til klarspråk',
  input: z.strictObject({ text: z.string().min(1) }),
  run: async ({ text }: { text: string }) => ({
    parts: [{ mime: 'text/plain', body: { kind: 'text' as const, text: `Klart: ${text}` } }],
    sources: [{ id: 'sprakradet-sjekkliste', title: 'Klarspråkssjekklista' }],
  }),
};

describe('tool registry', () => {
  it('opens a built-in tool by name@version and describes its input as JSON schema', async () => {
    const { ctx, metered } = context();
    const port = new ToolRegistry()
      .register(klarsprak)
      .open(toolRef('digdir.klarsprak', '2.3'), ctx);

    expect(port.definition()).toMatchObject({
      name: 'digdir.klarsprak',
      version: '2.3',
      origin: 'builtin',
      input: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1 } },
        required: ['text'],
      },
    });
    const result = await port.call({ text: 'vanskelig' });
    expect(textOf(result)).toBe('Klart: vanskelig');
    expect(result.sources).toEqual([
      { id: 'sprakradet-sjekkliste', title: 'Klarspråkssjekklista' },
    ]);
    expect(metered).toEqual([{ requests: 1 }]);
  });

  it('answers invalid input with an error result instead of running or metering the tool', async () => {
    const { ctx, metered } = context();
    const port = new ToolRegistry()
      .register(klarsprak)
      .open(toolRef('digdir.klarsprak', '2.3'), ctx);

    const result = await port.call({ text: '', extra: 1 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Invalid input for digdir.klarsprak: /);
    expect(metered).toEqual([]);
  });

  it('refuses unknown tools, unknown versions and malformed references', () => {
    const registry = new ToolRegistry().register(klarsprak);
    const { ctx } = context();

    expect(() => registry.open(toolRef('digdir.klarsprak', '2.4'), ctx)).toThrow(
      /no tool digdir.klarsprak@2.4/,
    );
    expect(() => registry.open({ kind: 'tool', id: 'rag' }, ctx)).toThrow(ToolError);
    expect(() => registry.open({ kind: 'model', id: 'rag@1' }, ctx)).toThrow(/not a tool/);
    expect(() => registry.register(klarsprak)).toThrow(/already registered/);
    expect(parseToolRef('rag@1')).toEqual({ name: 'rag', version: '1' });
  });

  it('wraps a crashing tool and reports a cancelled task as cancelled', async () => {
    const registry = new ToolRegistry().register({
      ...klarsprak,
      run: async () => {
        throw new TypeError('boom');
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry.open(toolRef('digdir.klarsprak', '2.3'), context().ctx).call({ text: 'x' }),
    ).rejects.toMatchObject({
      code: 'failed',
    });
    await expect(
      registry
        .open(toolRef('digdir.klarsprak', '2.3'), context(controller.signal).ctx)
        .call({ text: 'x' }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('resolves tools it does not hold from added sources, after its own built-ins', async () => {
    const remote: ToolPort = {
      definition: () => ({
        name: 'remote',
        version: '1',
        description: 'MCP tool',
        input: {},
        origin: 'mcp',
      }),
      call: async () => ({ parts: [] }),
    };
    const registry = new ToolRegistry().register(klarsprak).addSource({
      resolve: (name, version) => (name === 'remote' && version === '1' ? remote : undefined),
    });

    expect(registry.open(toolRef('remote', '1'), context().ctx).definition().origin).toBe('mcp');
    expect(
      registry.open(toolRef('digdir.klarsprak', '2.3'), context().ctx).definition().origin,
    ).toBe('builtin');
    expect(registry.refs()).toEqual(['digdir.klarsprak@2.3']);
  });
});

describe('tool sources', () => {
  it('resolve a shared service tool against the owner of the grant, not the calling tenant', () => {
    const asked: { tenant: string; owner: string }[] = [];
    const registry = new ToolRegistry().addSource({
      resolve: (_name, _version, ctx, owner) => {
        asked.push({ tenant: ctx.tenant, owner });
        return undefined;
      },
    });
    const ctx: PortContext = {
      tenant: '111222333',
      principal: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: '111222333' },
      task: 't1',
      signal: new AbortController().signal,
      meter: async () => undefined,
    };

    expect(() => registry.open(toolRef('crm.lookup', '1', '991825827'), ctx)).toThrow(ToolError);
    expect(() => registry.open(toolRef('crm.lookup', '1'), ctx)).toThrow(ToolError);

    expect(asked).toEqual([
      { tenant: '111222333', owner: '991825827' },
      { tenant: '111222333', owner: '111222333' },
    ]);
  });
});
