import type { ClientView } from '../../types';

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
