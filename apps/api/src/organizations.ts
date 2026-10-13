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
    const known = (await options.tenants()).find((t) => t.orgNumber === orgNumber);
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
