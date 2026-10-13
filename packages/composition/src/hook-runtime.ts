import {
  appliesTo,
  hookInvoker,
  hookPoints,
  sortHooks,
  type HookConfig,
  type HookInvoker,
  type HookSpec,
  type HookVerdict,
  type WebhookHookSender,
} from '@genai/hooks';
import type { InvocationContext, SecretResolver } from '@genai/kernel';
import { EgressGuard } from '@genai/providers-mcp-client';
import { z } from 'zod';
import { platformScope, type ConfigEntry, type ConfigEntryStore } from './config-store.js';
import { SIGNATURE_HEADER, signWebhook } from './webhook-signature.js';

export const hookKind = 'hook';

export type HookSender = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  signal: AbortSignal,
) => Promise<{ status: number; body: string }>;

export const egressHookSender = (): HookSender => {
  const guard = new EgressGuard({
    maxResponseBytes: 64 * 1024,
    timeoutMs: 10_000,
    maxRedirects: 0,
  });
  return async (target, init, signal) => {
    const url = new URL(target);
    const port = url.port ? Number(url.port) : 443;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const response = await guard.request(
      [{ host, port }],
      target,
      { method: 'POST', headers: init.headers, body: init.body },
      signal,
    );
    return { status: response.status, body: response.body };
  };
};

const secretRef = (scope: string, name: string) =>
  scope === platformScope ? `secret://platform/${name}` : `secret://tenant/${scope}/${name}`;

const verdict = z.object({
  decision: z.enum(['allow', 'refuse']).optional(),
  reason: z.string().optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
});

export const webhookHookSender =
  (options: {
    secrets: SecretResolver;
    send: HookSender;
    now?: () => Date;
    newId?: () => string;
  }): WebhookHookSender =>
  async (hook, call, signal) => {
    const now = options.now ?? (() => new Date());
    const at = now();
    const id = (options.newId ?? (() => crypto.randomUUID()))();
    const secret = await options.secrets.resolve(secretRef(hook.scope, hook.handler.secret));
    const body = JSON.stringify({
      id,
      hook: hook.id,
      point: call.point,
      mode: hook.mode,
      at: at.toISOString(),
      tenant: call.tenant,
      ...(call.task ? { task: call.task } : {}),
      ...(call.service ? { service: call.service } : {}),
      payload: call.payload,
    });
    const response = await options.send(
      hook.handler.url,
      {
        headers: {
          'content-type': 'application/json',
          'genai-event': `hook.${call.point}`,
          'genai-delivery': id,
          [SIGNATURE_HEADER]: signWebhook(secret, Math.floor(at.getTime() / 1000), body),
        },
        body,
      },
      signal,
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`the hook answered HTTP ${response.status}`);
    if (response.body.trim() === '') return {};
    const parsed = verdict.safeParse(JSON.parse(response.body));
    if (!parsed.success) throw new Error('the hook answered with an unknown verdict');
    return parsed.data as HookVerdict;
  };

const fromEntry = (entry: ConfigEntry<unknown>): HookConfig => ({
  ...(entry.spec as HookSpec),
  id: entry.scope === platformScope ? entry.id : entry.id.slice(entry.scope.length + 1),
  scope: entry.scope,
});

export const entryId = (scope: string, id: string) =>
  scope === platformScope ? id : `${scope}/${id}`;

export interface HookView extends HookConfig {
  version: number;
  changedBy: string;
  changedAt: string;
}

export const hookDirectory = (store: ConfigEntryStore) => {
  const list = async (scope: string): Promise<HookView[]> =>
    (await store.latest({ kind: hookKind, scope }))
      .filter((e) => !e.deleted)
      .map((e) => ({ ...fromEntry(e), version: e.version, changedBy: e.by, changedAt: e.at }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return {
    list,
    find: async (scope: string, id: string) => (await list(scope)).find((h) => h.id === id),
    forTenant: async (tenant: string): Promise<HookConfig[]> =>
      sortHooks([...(await list(platformScope)), ...(await list(tenant))]),
  };
};

export type HookDirectory = ReturnType<typeof hookDirectory>;

export interface HookRuntime {
  directory: HookDirectory;
  invoke: HookInvoker;
  forContext(ctx: InvocationContext): Promise<HookConfig[]>;
}

export const createHookRuntime = (options: {
  store: ConfigEntryStore;
  secrets: SecretResolver;
  send?: HookSender;
}): HookRuntime => {
  const directory = hookDirectory(options.store);
  const invoke = hookInvoker(
    webhookHookSender({ secrets: options.secrets, send: options.send ?? egressHookSender() }),
  );
  return {
    directory,
    invoke,
    forContext: async (ctx) =>
      (await directory.forTenant(ctx.tenant)).filter((h) =>
        hookPoints.some((point) => appliesTo(h, point, ctx.capability.id)),
      ),
  };
};
