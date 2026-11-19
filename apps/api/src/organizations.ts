export interface Organization {
  orgNumber: string;
  name: string;
  source: 'platform' | 'enhetsregisteret';
}

export interface OrganizationLookupOptions {
  tenants(): Promise<{ orgNumber: string; name: string }[]>;
  registryUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const organizationLookup =
  (options: OrganizationLookupOptions) =>
  async (orgNumber: string): Promise<Organization | undefined> => {
    const known = (await options.tenants()).find(
      (t) => t.orgNumber === orgNumber && t.name !== orgNumber,
    );
    if (known) return { orgNumber, name: known.name, source: 'platform' };
    if (!options.registryUrl) return undefined;
    const send = options.fetch ?? fetch;
    try {
      const response = await send(`${options.registryUrl.replace(/\/+$/, '')}/${orgNumber}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { organisasjonsnummer?: unknown; navn?: unknown };
      if (body.organisasjonsnummer !== orgNumber || typeof body.navn !== 'string' || !body.navn)
        return undefined;
      return { orgNumber, name: body.navn, source: 'enhetsregisteret' };
    } catch {
      return undefined;
    }
  };

const hour = 60 * 60 * 1000;

export const cachedOrganizationLookup = (
  lookup: (orgNumber: string) => Promise<Organization | undefined>,
  { foundMs = 24 * hour, missingMs = 10 * 60 * 1000, now = () => Date.now() } = {},
) => {
  const cache = new Map<string, { at: number; value: Organization | undefined }>();
  const pending = new Map<string, Promise<Organization | undefined>>();
  return async (orgNumber: string): Promise<Organization | undefined> => {
    const hit = cache.get(orgNumber);
    if (hit && now() - hit.at < (hit.value ? foundMs : missingMs)) return hit.value;
    const running = pending.get(orgNumber);
    if (running) return running;
    const asked = lookup(orgNumber)
      .then((value) => {
        if (value?.source !== 'platform') cache.set(orgNumber, { at: now(), value });
        return value;
      })
      .finally(() => pending.delete(orgNumber));
    pending.set(orgNumber, asked);
    return asked;
  };
};
