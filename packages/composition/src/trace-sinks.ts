import type { SecretResolver } from '@genai/kernel';
import {
  EgressGuard,
  TenantSecrets,
  type AllowedHost,
  type EgressOptions,
  type EgressRequest,
} from '@genai/providers-mcp-client';
import type { ConfigEntryStore } from './config-store.js';

/** A tenant's connection to a trace sink is a config entry of this kind (ADR 0040). */
export const traceConnectionKind = 'trace-connection';

export interface TraceSinkSettings {
  host: string;
  publicKey: string;
  secretKey: string;
}

/**
 * The egress path a connection's calls take (ADR 0015): HTTPS, no private or link-local address,
 * no platform host. In development mode a sink on loopback is allowed, as ADR 0040 exempts it.
 */
export const tracingEgress = (options: EgressOptions, devMode = false) =>
  new EgressGuard(
    devMode
      ? {
          ...options,
          platformHosts: (options.platformHosts ?? []).filter(
            (h) => !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h),
          ),
          testOverride: { ...options.testOverride, allowLoopback: true, allowHttp: true },
        }
      : options,
  );

/** The one host a connection's calls may reach. */
export const allowOf = (host: string) => {
  const url = new URL(host);
  return [
    {
      host: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    },
  ];
};

/** A connection's sink settings, also while it is being removed, so its traces can be deleted. */
export const sinkSettingsOf = async (
  configEntries: ConfigEntryStore,
  tenant: string,
  sink: string,
): Promise<TraceSinkSettings | undefined> => {
  const latest = (await configEntries.history(traceConnectionKind, tenant, sink)).at(-1);
  if (!latest || latest.deleted) return undefined;
  const { host, publicKey, secretKey } = latest.spec as TraceSinkSettings;
  return { host, publicKey, secretKey };
};

/** How to reach a connection's sink: its host and keys, the secret resolved only for that host. */
export const traceSinkAccess =
  (deps: { configEntries: ConfigEntryStore; secrets: SecretResolver; egress: EgressGuard }) =>
  async (tenant: string, sink: string) => {
    const settings = await sinkSettingsOf(deps.configEntries, tenant, sink);
    if (!settings) return undefined;
    const secretKey = await new TenantSecrets(deps.secrets).resolveFor(tenant, settings.secretKey, [
      settings.host,
    ]);
    return {
      host: settings.host,
      publicKey: settings.publicKey,
      secretKey,
      fetch: pinnedFetch(deps.egress, allowOf(settings.host)),
    };
  };

const nullBody = new Set([101, 204, 205, 304]);

/**
 * A fetch for an exporter that goes through the guard's request: the connection is pinned to the
 * address the guard checked, with its time and size limits, instead of a second DNS lookup.
 */
export const pinnedFetch =
  (guard: Pick<EgressGuard, 'request'>, allow: AllowedHost[]): typeof fetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const response = await guard.request(
      allow,
      url,
      {
        method: (init?.method ?? 'GET') as EgressRequest['method'],
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      },
      init?.signal ?? undefined,
    );
    return new Response(nullBody.has(response.status) ? null : response.body, {
      status: response.status,
    });
  };
