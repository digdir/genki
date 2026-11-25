import type { ClientView } from '../../types';

/**
 * The address people open a published service at: the hostname of a hosted
 * Client for the service, the one for production first. Undefined when the
 * service has no hosted Client, as a new service has until a hostname is
 * added for it.
 */
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
