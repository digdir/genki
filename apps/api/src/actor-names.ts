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

const unknownForMs = 5 * 60 * 1000;

const createActorNames = (store: ConfigEntryStore, now: () => number): ActorNames => {
  const known = new Map<string, string>();
  const unknown = new Map<string, number>();
  const nameOf = async (actor: string) => {
    const cached = known.get(actor);
    if (cached !== undefined) return cached;
    const missedAt = unknown.get(actor);
    if (missedAt !== undefined && now() - missedAt < unknownForMs) return undefined;
    const latest = (await store.history(actorNameKind, scope, actor)).at(-1);
    const name = latest && !latest.deleted ? (latest.spec as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || !name) {
      unknown.set(actor, now());
      return undefined;
    }
    known.set(actor, name);
    unknown.delete(actor);
    return name;
  };
  return {
    remember: async (principal, name) => {
      const person = principal.actor ?? principal;
      if (person.kind !== 'employee' && person.kind !== 'operator') return;
      const actor = actorOf(person);
      if ((await nameOf(actor)) === name) return;
      known.set(actor, name);
      unknown.delete(actor);
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
      const unique = [...new Set(actors)];
      const found = await Promise.all(unique.map(nameOf));
      return new Map(unique.flatMap((actor, i) => (found[i] ? [[actor, found[i]] as const] : [])));
    },
  };
};

const shared = new WeakMap<ConfigEntryStore, ActorNames>();

export const actorNames = (store: ConfigEntryStore, now = () => Date.now()): ActorNames => {
  const existing = shared.get(store);
  if (existing) return existing;
  const created = createActorNames(store, now);
  shared.set(store, created);
  return created;
};

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+$/.test(value);

/** The token's own name wins; an email standing in for a name gives way to the sign-in name. */
export const personNameOf = (principal: Principal, header: string | undefined) => {
  const person = principal.actor ?? principal;
  const claimed = person.name;
  if (claimed && !looksLikeEmail(claimed)) return claimed;
  if (header && !looksLikeEmail(header)) return header;
  return claimed ?? header;
};

export const rememberActorNames =
  (auth: Authenticator, names: ActorNames): MiddlewareHandler =>
  async (c, next) => {
    const header = actorNameOf(c);
    if (header) {
      const principal = await auth.authenticate(c.req.raw).catch(() => undefined);
      const name = principal ? personNameOf(principal, header) : undefined;
      if (principal && name) await names.remember(principal, name).catch(() => undefined);
    }
    await next();
  };
