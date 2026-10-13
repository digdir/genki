import type { Principal } from '@genai/contracts';
import {
  preferenceOwner,
  userPreferenceKind,
  userPreferenceReader,
  type UserPreferences,
} from '@genai/composition';
import { writtenStandards, type WrittenStandard } from '@genai/guardrails';
import { isLocale, locales, type Locale } from '@genai/i18n';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant } from './access.js';
import { actorOf } from './admin.js';
import { appendVersion, type ConfigEntry, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { rightsOf } from './rights.js';

export { preferenceOwner, userPreferenceKind, type UserPreferences };

export const userPreferences = (store: ConfigEntryStore) => ({
  ...userPreferenceReader(store),
  save: (tenant: string, principal: Principal, spec: UserPreferences, reason: string) =>
    appendVersion<UserPreferences>(store, {
      kind: userPreferenceKind,
      scope: tenant,
      id: preferenceOwner(principal),
      spec,
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
    }),
});

const problem = (c: Context, status: 400 | 401, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const view = (entry: ConfigEntry<UserPreferences> | undefined) => ({
  writtenStandard: entry?.spec.writtenStandard ?? null,
  language: entry?.spec.language ?? null,
  ...(entry ? { version: entry.version, at: entry.at } : {}),
});

export const userPreferencesModule: PlatformModuleFactory = (deps) => {
  const preferences = userPreferences(deps.configEntries);
  return {
    id: 'user-preferences',
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      mountDeps: MountDeps,
    ) => {
      const path = '/tenants/:tenant/me/preferences';
      const enter = async (c: Context) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, t('problems.notSignedIn')) };
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mountDeps.access, principal, tenant);
        if ('response' in entered) return { response: entered.response };
        return { principal: entered.principal, tenant };
      };

      app.get('/tenants/:tenant/me', async (c) => {
        const guard = await enter(c);
        if (guard.response) return guard.response;
        return c.json({ rights: [...rightsOf(guard.principal, guard.tenant)] });
      });

      app.get(path, async (c) => {
        const guard = await enter(c);
        if (guard.response) return guard.response;
        return c.json(view(await preferences.latest(guard.tenant, guard.principal)));
      });

      app.put(path, async (c) => {
        const guard = await enter(c);
        if (guard.response) return guard.response;
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, reasonTooShort, [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const body = (await c.req.json().catch(() => ({}))) as {
          writtenStandard?: unknown;
          language?: unknown;
        };
        const { writtenStandard, language } = body;
        if (
          writtenStandard !== undefined &&
          writtenStandard !== null &&
          !writtenStandards.some((s) => s === writtenStandard)
        )
          return problem(c, 400, t('problems.invalidWrittenStandard'), [
            { path: 'writtenStandard', message: `one of ${writtenStandards.join(', ')} or null` },
          ]);
        if (language !== undefined && language !== null && !isLocale(language))
          return problem(c, 400, t('problems.invalidLanguage'), [
            { path: 'language', message: `one of ${locales.join(', ')} or null` },
          ]);
        const current = await preferences.of(guard.tenant, guard.principal);
        const next: UserPreferences = { ...current };
        if (writtenStandard === null) delete next.writtenStandard;
        else if (writtenStandard !== undefined)
          next.writtenStandard = writtenStandard as WrittenStandard;
        if (language === null) delete next.language;
        else if (language !== undefined) next.language = language as Locale;
        const saved = await preferences.save(guard.tenant, guard.principal, next, reason);
        return c.json(view(saved));
      });
    },
  };
};
