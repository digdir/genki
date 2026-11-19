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

export interface ToolStamp {
  at: string;
  by?: string;
}

export interface ConnectionToolSource extends ToolSource {
  sync(tenant: string, id: string, signal?: AbortSignal, at?: string): Promise<SyncResult>;
  approve(tenant: string, id: string, toolName: string, stamp?: ToolStamp): Promise<void>;
  revoke(tenant: string, id: string, toolName: string, stamp?: ToolStamp): Promise<void>;
  load(tenant: string): Promise<void>;
}

const same = (a: PinnedTool, b: PinnedTool) =>
  a.description === b.description &&
  JSON.stringify(a.input) === JSON.stringify(b.input) &&
  JSON.stringify(a.call ?? null) === JSON.stringify(b.call ?? null);

const without = (tool: PinnedTool, ...keys: (keyof PinnedTool)[]): PinnedTool =>
  Object.fromEntries(
    Object.entries(tool).filter(([key]) => !keys.includes(key as keyof PinnedTool)),
  ) as unknown as PinnedTool;

export const pinTools = (
  state: ConnectionState,
  listed: PinnedTool[],
  at = new Date().toISOString(),
): ConnectionState => {
  const firstSync =
    !state.synced && !state.lastSync && state.tools.length === 0 && state.pending.length === 0;
  const active: PinnedTool[] = [];
  const pending: PinnedTool[] = [];
  for (const tool of listed) {
    const current = state.tools.find((t) => t.remoteName === tool.remoteName);
    if (firstSync) active.push({ ...tool, approvedAt: at });
    else if (current && same(current, tool)) active.push(current);
    else {
      if (current) active.push(current);
      const waiting = state.pending.find((p) => p.remoteName === tool.remoteName && same(p, tool));
      pending.push({ ...tool, since: waiting?.since ?? at });
    }
  }
  return { ...state, tools: active, pending, synced: true };
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

  async #update(tenant: string, id: string, change: (state: ConnectionState) => ConnectionState) {
    const next = await this.registry.update(tenant, id, (state) => {
      if (protocolOf(state.connection) !== this.protocol)
        throw new ToolError('not_found', `no tool connection ${id}`);
      return change(state);
    });
    if (!next) throw new ToolError('not_found', `no tool connection ${id}`);
    return next;
  }

  async sync(tenant: string, id: string, signal?: AbortSignal, at?: string): Promise<SyncResult> {
    const listed = await this.listTools(await this.#state(tenant, id), signal);
    const next = await this.#update(tenant, id, (state) => pinTools(state, listed, at));
    this.#pinned.set(this.key(tenant, id), next);
    return { active: next.tools.length, pending: next.pending.map((p) => p.name) };
  }

  async approve(tenant: string, id: string, toolName: string, stamp?: ToolStamp): Promise<void> {
    const next = await this.#update(tenant, id, (state) => {
      const proposed = state.pending.find((p) => p.name === toolName);
      if (!proposed) throw new ToolError('not_found', `no pending change for ${toolName}`);
      const approved: PinnedTool = {
        ...without(proposed, 'since'),
        ...(stamp ? { approvedAt: stamp.at, ...(stamp.by ? { approvedBy: stamp.by } : {}) } : {}),
      };
      return {
        ...state,
        tools: [...state.tools.filter((t) => t.remoteName !== proposed.remoteName), approved],
        pending: state.pending.filter((p) => p.name !== toolName),
        revoked: (state.revoked ?? []).filter((name) => name !== proposed.remoteName),
      };
    });
    this.#pinned.set(this.key(tenant, id), next);
  }

  async revoke(tenant: string, id: string, toolName: string, stamp?: ToolStamp): Promise<void> {
    const next = await this.#update(tenant, id, (state) => {
      const active = state.tools.find((t) => t.name === toolName);
      if (!active) throw new ToolError('not_found', `no approved tool ${toolName}`);
      const tool = without(active, 'approvedAt', 'approvedBy');
      const waiting = state.pending.some((p) => p.remoteName === active.remoteName);
      return {
        ...state,
        tools: state.tools.filter((t) => t.name !== toolName),
        pending: waiting
          ? state.pending
          : [...state.pending, { ...tool, since: stamp?.at ?? new Date().toISOString() }],
        revoked: [...new Set([...(state.revoked ?? []), active.remoteName])],
      };
    });
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

  async sync(tenant: string, id: string, signal?: AbortSignal, at?: string) {
    return (await this.#sourceFor(tenant, id)).sync(tenant, id, signal, at);
  }

  async approve(tenant: string, id: string, toolName: string, stamp?: ToolStamp) {
    return (await this.#sourceFor(tenant, id)).approve(tenant, id, toolName, stamp);
  }

  async revoke(tenant: string, id: string, toolName: string, stamp?: ToolStamp) {
    return (await this.#sourceFor(tenant, id)).revoke(tenant, id, toolName, stamp);
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
