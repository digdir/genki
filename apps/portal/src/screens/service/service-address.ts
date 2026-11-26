import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import type { ClientView } from '../../types';
import { activeAddress } from './ServiceAddress';

/** The hosted address of a service, production first; undefined when it has none. */
export const serviceAddress = (
  clients: readonly ClientView[],
  service: string,
): string | undefined => {
  const names = clients
    .map((c) => c.definition.spec)
    .filter((spec) => spec.service === service && spec.kind === 'browser' && spec.hosted)
    .flatMap((spec) => spec.hostnames ?? []);
  const name = names.find((n) => (n.environment ?? 'prod') === 'prod') ?? names[0];
  return name ? `https://${name.hostname}/` : undefined;
};

/** The address Åpne tjenesten opens, and whether both lookups answered so none is known. */
export const useServiceAddress = (
  api: ApiClient,
  tenant: string,
  service: string,
  enabled: boolean,
): { address: string | undefined; known: boolean } => {
  const [clients] = useAsync(
    async (signal) =>
      enabled ? api.listClients(tenant, service, signal).catch(() => undefined) : undefined,
    [api, tenant, service, enabled],
    { keepPreviousFor: service },
  );
  const [claimed] = useAsync(
    async (signal) =>
      enabled ? api.serviceHostnames(tenant, service, signal).catch(() => undefined) : undefined,
    [api, tenant, service, enabled],
    { keepPreviousFor: service },
  );
  const address =
    (claimed.status === 'ready' ? activeAddress(claimed.data?.hostnames ?? []) : undefined) ??
    (clients.status === 'ready' ? serviceAddress(clients.data?.clients ?? [], service) : undefined);
  const known =
    enabled &&
    claimed.status === 'ready' &&
    clients.status === 'ready' &&
    claimed.data !== undefined &&
    clients.data !== undefined;
  return { address, known };
};
