import type { PortContext } from '@genai/kernel';
import { ToolError, type ToolPort, type ToolSource } from '@genai/port-tools';
import {
  protocolOf,
  type ConnectionProtocol,
  type ConnectionRegistry,
  type ConnectionState,
  type PinnedTool,
} from './registry.js';

export const toolSyncDeadlineMs = 60_000;

export interface SyncResult {
  active: number;
  pending: string[];
}

export interface ConnectionToolSource extends ToolSource {
  sync(tenant: string, id: string, signal?: AbortSignal): Promise<SyncResult>;
  approve(tenant: string, id: string, toolName: string): Promise<void>;
  load(tenant: string): Promise<void>;
}

const same = (a: PinnedTool, b: PinnedTool) =>
  a.description === b.description &&
  JSON.stringify(a.input) === JSON.stringify(b.input) &&
  JSON.stringify(a.call ?? null) === JSON.stringify(b.call ?? null);

export const pinTools = (state: ConnectionState, listed: PinnedTool[]): ConnectionState => {
  const firstSync = state.tools.length === 0 && state.pending.length === 0;
  const active: PinnedTool[] = [];
  const pending: PinnedTool[] = [];
  for (const tool of listed) {
    const current = state.tools.find((t) => t.remoteName === tool.remoteName);
    if (firstSync || (current && same(current, tool))) active.push(tool);
    else {
      if (current) active.push(current);
      pending.push(tool);
    }
  }
  return { ...state, tools: active, pending };
};

export abstract class PinnedToolSource implements ConnectionToolSource {
  abstract readonly protocol: ConnectionProtocol;
  readonly #pinned = new Map<string, ConnectionState>();

  constructor(protected readonly registry: ConnectionRegistry) {}

  protected abstract listTools(state: ConnectionState, signal?: AbortSignal): Promise<PinnedTool[]>;

  protected abstract port(
    state: ConnectionState,
    tool: PinnedTool,
    ctx: PortContext,
    version: string,
  ): ToolPort;

  protected key(tenant: string, id: string) {
    return `${tenant}/${id}`;
  }

  async #state(tenant: string, id: string) {
    const state = await this.registry.get(tenant, id);
    if (!state || protocolOf(state.connection) !== this.protocol)
      throw new ToolError('not_found', `no tool connection ${id}`);
    return state;
  }

  async sync(tenant: string, id: string, signal?: AbortSignal): Promise<SyncResult> {
    const state = await this.#state(tenant, id);
    const next = pinTools(state, await this.listTools(state, signal));
    await this.registry.save(next);
    this.#pinned.set(this.key(tenant, id), next);
    return { active: next.tools.length, pending: next.pending.map((p) => p.name) };
  }

  async approve(tenant: string, id: string, toolName: string): Promise<void> {
    const state = await this.registry.get(tenant, id);
    const proposed = state?.pending.find((p) => p.name === toolName);
    if (!state || !proposed) throw new ToolError('not_found', `no pending change for ${toolName}`);
    const next: ConnectionState = {
      ...state,
      tools: [...state.tools.filter((t) => t.remoteName !== proposed.remoteName), proposed],
      pending: state.pending.filter((p) => p.name !== toolName),
    };
    await this.registry.save(next);
    this.#pinned.set(this.key(tenant, id), next);
  }

  async load(tenant: string): Promise<void> {
    for (const state of await this.registry.list(tenant))
      if (protocolOf(state.connection) === this.protocol)
        this.#pinned.set(this.key(tenant, state.connection.id), state);
  }

  resolve(
    name: string,
    version: string,
    ctx: PortContext,
    owner: string = ctx.tenant,
  ): ToolPort | undefined {
    const dot = name.indexOf('.');
    if (dot <= 0) return undefined;
    const state = this.#pinned.get(this.key(owner, name.slice(0, dot)));
    if (!state || state.connection.tenant !== owner || state.connection.version !== version)
      return undefined;
    const tool = state.tools.find((t) => t.name === name);
    return tool ? this.port(state, tool, ctx, version) : undefined;
  }
}

export class ConnectionToolSources implements ConnectionToolSource {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly sources: PinnedToolSource[],
  ) {}

  async #sourceFor(tenant: string, id: string) {
    const state = await this.registry.get(tenant, id);
    if (!state) throw new ToolError('not_found', `no tool connection ${id}`);
    const source = this.sources.find((s) => s.protocol === protocolOf(state.connection));
    if (!source)
      throw new ToolError('not_found', `no tool source for ${protocolOf(state.connection)}`);
    return source;
  }

  async sync(tenant: string, id: string, signal?: AbortSignal) {
    return (await this.#sourceFor(tenant, id)).sync(tenant, id, signal);
  }

  async approve(tenant: string, id: string, toolName: string) {
    return (await this.#sourceFor(tenant, id)).approve(tenant, id, toolName);
  }

  async load(tenant: string) {
    for (const source of this.sources) await source.load(tenant);
  }

  resolve(name: string, version: string, ctx: PortContext, owner?: string) {
    for (const source of this.sources) {
      const port = source.resolve(name, version, ctx, owner);
      if (port) return port;
    }
    return undefined;
  }
}
