import { maxTenantSecretBytes } from '@genai/composition';
import type { Context } from 'hono';
import type { CatalogItem } from './catalog-registry.js';
import { platformScope } from './config-store.js';
import { platformSecretPattern } from './operator-models.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export const platformSecretNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const maxPlatformSecretLength = maxTenantSecretBytes;

export interface PlatformSecretUser {
  kind: string;
  id: string;
}

export interface PlatformSecretView {
  name: string;
  ref: string;
  set: boolean;
  changedAt?: string;
  usedBy: PlatformSecretUser[];
}

const namesIn = (value: unknown, out: Set<string>): Set<string> => {
  if (typeof value === 'string') {
    const name = platformSecretPattern.exec(value)?.[1];
    if (name) out.add(name);
  } else if (Array.isArray(value)) for (const v of value) namesIn(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) namesIn(v, out);
  return out;
};

export const platformSecretsModule: PlatformModuleFactory = (deps) => ({
  id: 'platform-secrets',
  mount: (app, mounted) => {
    const problem = (c: Context, status: 401 | 403, title: string) =>
      c.json({ type: 'about:blank', title, status, errors: [] }, status, {
        'content-type': 'application/problem+json',
      });

    app.get('/operator/secrets', async (c) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized');
      if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
      const stored = new Set((await deps.vault?.names(platformScope)) ?? []);
      const users = new Map<string, PlatformSecretUser[]>();
      for (const item of deps.catalog.list({ scope: platformScope }) as CatalogItem[])
        for (const name of namesIn(item.spec, new Set()))
          users.set(name, [...(users.get(name) ?? []), { kind: item.kind, id: item.id }]);
      const changed = new Map<string, string>();
      for (const entry of await mounted.admin.audit(deps.platformTenant)) {
        if (entry.action !== 'platform.platform-secret.set' || entry.outcome !== 'applied')
          continue;
        const name = entry.target.slice('secret:platform/'.length);
        if ((changed.get(name) ?? '') < entry.at) changed.set(name, entry.at);
      }
      const names = [...new Set([...stored, ...users.keys()])].sort();
      return c.json({
        data: names.map((name): PlatformSecretView => {
          const changedAt = changed.get(name);
          return {
            name,
            ref: `secret://platform/${name}`,
            set: stored.has(name),
            ...(changedAt ? { changedAt } : {}),
            usedBy: (users.get(name) ?? []).sort((a, b) =>
              `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`),
            ),
          };
        }),
      });
    });
  },
});
