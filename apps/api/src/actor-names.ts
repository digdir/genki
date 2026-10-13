import type { Principal } from '@genai/contracts';
import type { MiddlewareHandler } from 'hono';
import { actorOf } from './admin.js';
import { appendVersion, type ConfigEntryStore } from './config-store.js';
import { actorNameOf, type Authenticator } from './http.js';

export const actorNameKind = 'actor-name';
const scope = 'platform';

export interface ActorNames {
  remember(principal: Principal, name: string): Promise<void>;
  nameOf(actor: string): Promise<string | undefined>;
  namesOf(actors: string[]): Promise<Map<string, string>>;
}

const createActorNames = (store: ConfigEntryStore): ActorNames => {
  const known = new Map<string, string>();
  const nameOf = async (actor: string) => {
    const cached = known.get(actor);
    if (cached !== undefined) return cached;
    const latest = (await store.history(actorNameKind, scope, actor)).at(-1);
    const name = latest && !latest.deleted ? (latest.spec as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || !name) return undefined;
    known.set(actor, name);
    return name;
  };
  return {
    remember: async (principal, name) => {
      const person = principal.actor ?? principal;
      if (person.kind !== 'employee' && person.kind !== 'operator') return;
      const actor = actorOf(person);
      if ((await nameOf(actor)) === name) return;
      known.set(actor, name);
      await appendVersion(store, {
        kind: actorNameKind,
        scope,
        id: actor,
        spec: { name },
        deleted: false,
        by: actor,
        reason: 'Navn fra innloggingen',
      });
    },
    nameOf,
    namesOf: async (actors) => {
      const out = new Map<string, string>();
      for (const actor of new Set(actors)) {
        const name = await nameOf(actor);
        if (name) out.set(actor, name);
      }
      return out;
    },
  };
};

const shared = new WeakMap<ConfigEntryStore, ActorNames>();

export const actorNames = (store: ConfigEntryStore): ActorNames => {
  const existing = shared.get(store);
  if (existing) return existing;
  const created = createActorNames(store);
  shared.set(store, created);
  return created;
};

export const rememberActorNames =
  (auth: Authenticator, names: ActorNames): MiddlewareHandler =>
  async (c, next) => {
    const name = actorNameOf(c);
    if (name) {
      const principal = await auth.authenticate(c.req.raw).catch(() => undefined);
      if (principal) await names.remember(principal, name).catch(() => undefined);
    }
    await next();
  };
