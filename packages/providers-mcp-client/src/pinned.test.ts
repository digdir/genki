import type { ToolPort } from '@genai/port-tools';
import { describe, expect, it } from 'vitest';
import { PinnedToolSource } from './pinned.js';
import { InMemoryConnections, type ConnectionState, type PinnedTool } from './registry.js';

const tenant = '991825827';

const tool = (remoteName: string, description = 'Slår opp'): PinnedTool => ({
  remoteName,
  name: `saker.${remoteName}`,
  description,
  input: { type: 'object' },
});

class ScriptedSource extends PinnedToolSource {
  readonly protocol = 'mcp' as const;
  listed: PinnedTool[] = [tool('lookup')];
  hold: Promise<void> | undefined;

  protected async listTools(): Promise<PinnedTool[]> {
    const listed = this.listed;
    await this.hold;
    return listed;
  }

  protected port(_state: ConnectionState, _tool: PinnedTool): ToolPort {
    return {} as ToolPort;
  }
}

class RacingConnections extends InMemoryConnections {
  afterRead: (() => Promise<void>) | undefined;

  override async get(tenant: string, id: string) {
    const state = await super.get(tenant, id);
    const after = this.afterRead;
    this.afterRead = undefined;
    await after?.();
    return state;
  }
}

const connected = async () => {
  const registry = new RacingConnections();
  await registry.register({
    id: 'saker',
    tenant,
    name: 'Saker',
    endpoint: 'https://saker.example.no/mcp',
    version: '1',
    allow: [{ host: 'saker.example.no' }],
  });
  const source = new ScriptedSource(registry);
  await source.sync(tenant, 'saker');
  return { registry, source };
};

describe('pinned tools', () => {
  it('keeps a tool revoked when a sync that started before the revoke finishes after it', async () => {
    const { registry, source } = await connected();
    let release: () => void = () => undefined;
    source.hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const syncing = source.sync(tenant, 'saker');
    await source.revoke(tenant, 'saker', 'saker.lookup');
    release();
    await syncing;

    const state = await registry.get(tenant, 'saker');
    expect(state?.tools).toEqual([]);
    expect(state?.pending.map((p) => p.name)).toEqual(['saker.lookup']);
  });

  it("keeps a tool revoked when the revoke lands between a sync's read and its write", async () => {
    const { registry, source } = await connected();
    registry.afterRead = () => source.revoke(tenant, 'saker', 'saker.lookup');

    await source.sync(tenant, 'saker');

    const state = await registry.get(tenant, 'saker');
    expect(state?.tools).toEqual([]);
    expect(state?.revoked).toEqual(['lookup']);
  });

  it('never approves a revoked tool on its own when the server stops listing it and lists it again', async () => {
    const { registry, source } = await connected();
    await source.revoke(tenant, 'saker', 'saker.lookup');

    source.listed = [];
    await source.sync(tenant, 'saker');
    source.listed = [tool('lookup', 'Slår opp, endret')];
    await source.sync(tenant, 'saker');

    const state = await registry.get(tenant, 'saker');
    expect(state?.tools).toEqual([]);
    expect(state?.pending.map((p) => p.name)).toEqual(['saker.lookup']);
    expect(state?.revoked).toEqual(['lookup']);
  });

  it('approves the tools of the very first sync, and only those', async () => {
    const { registry, source } = await connected();
    source.listed = [tool('lookup'), tool('search')];

    await source.sync(tenant, 'saker');

    const state = await registry.get(tenant, 'saker');
    expect(state?.tools.map((t) => t.name)).toEqual(['saker.lookup']);
    expect(state?.pending.map((p) => p.name)).toEqual(['saker.search']);
  });
});
