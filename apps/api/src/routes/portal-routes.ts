import { randomBytes, randomUUID } from 'node:crypto';
import type { Event, Principal, Task, Usage } from '@genai/contracts';
import { invalidInputProblem } from '@genai/adapter-openai';
import { isTrustedEntraLogin } from '@genai/composition';
import type { CompiledCapability, DefinitionStore } from '@genai/definitions';
import {
  ALL_GRANT,
  apiKeyDigest,
  boundService,
  LEGACY_KEY_ISSUER,
  type ApiKeyStore,
  type KeyPolicy,
  type StoredApiKey,
} from '@genai/identity';
import type { ConnectionRegistry } from '@genai/providers-mcp-client';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant, tenantAccess } from '../access.js';
import { defaultKeyCallsPerMinute } from '../rate-limit.js';
import type { Admin, AdminHandler, AdminOutcome } from '../admin.js';
import {
  originOf,
  priced,
  serviceOrigin,
  type DraftRunner,
  type ModelPrice,
} from '../draft-runner.js';
import { requireRight, rightRefused, type Right } from '../rights.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from '../http.js';
import { failureOf, failureReason } from '../failures.js';
import type { ServiceHealth } from '../service-health.js';
import { pausedMessage, type LifecycleView } from '../service-lifecycle.js';

export interface PortalTaskRow {
  task: string;
  tenant: string;
  status: string;
  at: string;
}

export type TenantApiKey = StoredApiKey & {
  prefix?: string;
  lastFour?: string;
  createdAt?: string;
  rotatedFrom?: string;
};

export interface TenantApiKeys {
  list(tenant: string): Promise<TenantApiKey[]>;
  add(key: TenantApiKey): Promise<void>;
  revoke(tenant: string, id: string, at: string): Promise<TenantApiKey | undefined>;
}

export interface TenantKeyPolicy extends KeyPolicy {
  name: string;
  createdAt: string;
}

export interface KeyPolicyStore {
  listPolicies(tenant: string): Promise<TenantKeyPolicy[]>;
  savePolicy(tenant: string, policy: TenantKeyPolicy): Promise<boolean>;
  deletePolicy(tenant: string, id: string): Promise<boolean>;
  setKeyPolicy(tenant: string, keyId: string, policyId: string | undefined): Promise<boolean>;
}

export class InMemoryTenantApiKeys implements TenantApiKeys, ApiKeyStore, KeyPolicyStore {
  readonly #keys = new Map<string, TenantApiKey>();
  readonly #policies = new Map<string, TenantKeyPolicy & { tenant: string }>();

  constructor(private readonly inner?: { add(key: StoredApiKey): void }) {}

  async list(tenant: string) {
    return [...this.#keys.values()]
      .filter((k) => k.tenant === tenant)
      .map((k) => structuredClone(this.#withPolicy(k)));
  }

  async add(key: TenantApiKey) {
    this.#keys.set(key.id, structuredClone(key));
    this.inner?.add(this.#withPolicy(key));
  }

  async revoke(tenant: string, id: string, at: string) {
    const found = this.#keys.get(id);
    if (!found || found.tenant !== tenant) return undefined;
    const revoked = { ...found, revokedAt: found.revokedAt ?? at };
    this.#keys.set(id, revoked);
    this.inner?.add(this.#withPolicy(revoked));
    return structuredClone(this.#withPolicy(revoked));
  }

  async findByDigest(digest: string) {
    const found = [...this.#keys.values()].find((k) => k.digest === digest);
    return found && structuredClone(this.#withPolicy(found));
  }

  async listPolicies(tenant: string) {
    return [...this.#policies.values()]
      .filter((p) => p.tenant === tenant)
      .map(({ tenant: _tenant, ...policy }) => structuredClone(policy));
  }

  async savePolicy(tenant: string, policy: TenantKeyPolicy) {
    const existing = this.#policies.get(policy.id);
    if (existing && existing.tenant !== tenant) return false;
    this.#policies.set(policy.id, { ...structuredClone(policy), tenant });
    return true;
  }

  async deletePolicy(tenant: string, id: string) {
    if (this.#policies.get(id)?.tenant !== tenant) return false;
    this.#policies.delete(id);
    for (const key of this.#keys.values()) if (key.policy?.id === id) delete key.policy;
    return true;
  }

  async setKeyPolicy(tenant: string, keyId: string, policyId: string | undefined) {
    const key = this.#keys.get(keyId);
    if (!key || key.tenant !== tenant) return false;
    const policy = policyId === undefined ? undefined : this.#policies.get(policyId);
    if (policyId !== undefined && policy?.tenant !== tenant) return false;
    if (policy) key.policy = { id: policy.id };
    else delete key.policy;
    this.inner?.add(this.#withPolicy(key));
    return true;
  }

  #withPolicy(key: TenantApiKey): TenantApiKey {
    const current = key.policy && this.#policies.get(key.policy.id);
    if (!current) return key;
    const policy: KeyPolicy = {
      id: current.id,
      ...(current.scopes ? { scopes: current.scopes } : {}),
      ...(current.datasets ? { datasets: current.datasets } : {}),
      ...(current.agents ? { agents: current.agents } : {}),
      ...(current.skillGraphs ? { skillGraphs: current.skillGraphs } : {}),
      ...(current.allowedConfigKeys ? { allowedConfigKeys: current.allowedConfigKeys } : {}),
    };
    return { ...key, policy };
  }

  async touch(id: string, at: Date) {
    const found = this.#keys.get(id);
    if (found) found.lastUsedAt = at.toISOString();
  }
}

export interface ServiceRequirement {
  resource: string;
  action: string;
  scope?: string;
}

export interface PortalRouteDeps {
  admin: Admin;
  authenticate(request: Request): Promise<Principal | undefined>;
  definitions: DefinitionStore;
  tasks(tenant?: string): PortalTaskRow[] | Promise<PortalTaskRow[]>;
  task(id: string): Promise<Task | undefined>;
  events?(task: string): AsyncIterable<Event>;
  apiKeys: TenantApiKeys;
  connections: ConnectionRegistry;
  requirementFor(tenant: string, service: string): ServiceRequirement;
  prices?: Record<string, ModelPrice>;
  ingestionUsage?(
    tenant: string,
  ): Promise<{ at: string; dataset: string; model: string; usage: Usage }[]>;
  projectTasks?(tenant: string): Promise<{ task: string; project: string; name: string }[]>;
  serviceHealth?(tenant: string, service: string): Promise<ServiceHealth | undefined>;
  lifecycle?(tenant: string, service: string): Promise<LifecycleView>;
  names?: { namesOf(actors: string[]): Promise<Map<string, string>> };
  traces?: { enabled: boolean; content: boolean };
  qualityWarnings?(tenant: string): Promise<{ service: string; message: string }[]>;
  drafts?: DraftRunner;
  now?(): Date;
  newKey?(): string;
  newId?(): string;
}

const forTenant = (principal: Principal, tenant: string) =>
  principal.kind === 'operator' || principal.tenant === tenant;

const refused = (target: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path: 'principal', message }],
  target,
});

export const keyView = (key: TenantApiKey) => ({
  id: key.id,
  name: key.name,
  service: boundService(key) ?? null,
  client: key.clientId ?? null,
  lastUsedAt: key.lastUsedAt ?? null,
  policy: key.policy?.id ?? null,
  rotatedFrom: key.rotatedFrom ?? null,
  prefix: key.prefix ?? null,
  lastFour: key.lastFour ?? null,
  scopes: key.scopes,
  datasets: key.datasets.filter((d) => d !== ALL_GRANT),
  agents: key.agents.filter((a) => !a.startsWith('service:') && a !== ALL_GRANT),
  callsPerMinute: key.callsPerMinute ?? defaultKeyCallsPerMinute,
  allowedOverrides: key.allowedOverrides ?? [],
  createdAt: key.createdAt ?? null,
  expiresAt: key.expiresAt ?? null,
  revokedAt: key.revokedAt ?? null,
});

const optional = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;

const slugOrUndefined = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : undefined;

const callsPerMinute = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6000;

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];

export const overridable = (value: unknown) =>
  strings(value).filter((v) => /^([a-z][A-Za-z0-9]*)(\.[A-Za-z0-9]+)*(\.\*)?$/.test(v));

export const portalAdminHandlers = (deps: {
  apiKeys: TenantApiKeys;
}): Record<string, AdminHandler> => ({
  'platform.apikeys.create': async (input, principal) => {
    const target = `api-key:${input.tenant}/${String(input.id ?? '')}`;
    if (principal.kind === 'operator' || principal.tenant !== input.tenant)
      return refused(target, 'only the tenant creates its keys');
    const name = String(input.name ?? '').trim();
    if (!name)
      return { ok: false, errors: [{ path: 'name', message: 'a name is required' }], target };
    if (typeof input.digest !== 'string' || !/^[0-9a-f]{64}$/.test(input.digest))
      return { ok: false, errors: [{ path: 'digest', message: 'not a key digest' }], target };
    const key: TenantApiKey = {
      id: String(input.id),
      name,
      digest: input.digest,
      tenant: input.tenant,
      scopes: ['query'],
      datasets: strings(input.datasets),
      agents: strings(input.agents),
      ...optional('service', slugOrUndefined(input.service)),
      ...optional('clientId', slugOrUndefined(input.clientId)),
      ...(callsPerMinute(input.callsPerMinute) ? { callsPerMinute: input.callsPerMinute } : {}),
      ...(overridable(input.allowedOverrides).length > 0
        ? { allowedOverrides: overridable(input.allowedOverrides) }
        : {}),
      ...(typeof input.prefix === 'string' ? { prefix: input.prefix } : {}),
      ...(typeof input.lastFour === 'string' ? { lastFour: input.lastFour } : {}),
      ...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
      ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
      ...(isTrustedEntraLogin(principal) ? { admittedInLockdown: true } : {}),
    };
    await deps.apiKeys.add(key);
    return {
      ok: true,
      value: keyView(key),
      target,
      audit: {
        after: {
          name: key.name,
          datasets: key.datasets,
          agents: key.agents,
          service: key.service ?? null,
          client: key.clientId ?? null,
          allowedOverrides: key.allowedOverrides ?? [],
          callsPerMinute: key.callsPerMinute ?? null,
          expiresAt: key.expiresAt ?? null,
        },
      },
    };
  },
  'platform.apikeys.rotate': async (input, principal) => {
    const id = String(input.id ?? '');
    const target = `api-key:${input.tenant}/${id}`;
    if (principal.kind === 'operator' || principal.tenant !== input.tenant)
      return refused(target, 'only the tenant rotates its keys');
    const old = (await deps.apiKeys.list(input.tenant)).find((k) => k.id === id);
    if (!old || old.revokedAt)
      return { ok: false, errors: [{ path: 'id', message: 'no active key with that id' }], target };
    if (typeof input.digest !== 'string' || !/^[0-9a-f]{64}$/.test(input.digest))
      return { ok: false, errors: [{ path: 'digest', message: 'not a key digest' }], target };
    const kept: TenantApiKey = { ...old };
    delete kept.revokedAt;
    delete kept.lastUsedAt;
    delete kept.admittedInLockdown;
    if (isTrustedEntraLogin(principal)) kept.admittedInLockdown = true;
    if (Array.isArray(input.allowedOverrides)) {
      const chosen = overridable(input.allowedOverrides);
      if (chosen.length > 0) kept.allowedOverrides = chosen;
      else delete kept.allowedOverrides;
    }
    const fresh: TenantApiKey = {
      ...kept,
      id: String(input.newId),
      digest: input.digest,
      rotatedFrom: old.id,
      ...(typeof input.prefix === 'string' ? { prefix: input.prefix } : {}),
      ...(typeof input.lastFour === 'string' ? { lastFour: input.lastFour } : {}),
      ...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
    };
    await deps.apiKeys.add(fresh);
    await deps.apiKeys.revoke(input.tenant, old.id, String(input.createdAt ?? input.at));
    return {
      ok: true,
      value: keyView(fresh),
      target,
      audit: { after: { replacedBy: fresh.id } },
    };
  },
  'platform.apikeys.revoke': async (input, principal) => {
    const id = String(input.id ?? '');
    const target = `api-key:${input.tenant}/${id}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'only the tenant or an operator revokes its keys');
    const revoked = await deps.apiKeys.revoke(input.tenant, id, String(input.at));
    if (!revoked) return { ok: false, errors: [{ path: 'id', message: 'no such key' }], target };
    return {
      ok: true,
      value: keyView(revoked),
      target,
      audit: { after: { revokedAt: revoked.revokedAt } },
    };
  },
});

interface Tally {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  pricedMicroNok: number;
  unpricedTokens: number;
}

const empty = (): Tally => ({
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  pricedMicroNok: 0,
  unpricedTokens: 0,
});

const tokensOf = (u: Usage) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0);

export const tallyOf = (usage: Usage, price?: ModelPrice): Tally => {
  const known = usage.costMicroNok !== undefined || price !== undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    requests: usage.requests ?? 0,
    pricedMicroNok: known ? priced(usage, price) : 0,
    unpricedTokens: known ? 0 : tokensOf(usage),
  };
};

const add = (a: Tally, b: Tally): Tally => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  requests: a.requests + b.requests,
  pricedMicroNok: a.pricedMicroNok + b.pricedMicroNok,
  unpricedTokens: a.unpricedTokens + b.unpricedTokens,
});

export const usageView = (t: Tally) => {
  const tokens = t.inputTokens + t.outputTokens;
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    requests: t.requests,
    costMicroNok: tokens > 0 && t.unpricedTokens >= tokens ? null : t.pricedMicroNok,
    priced: t.unpricedTokens === 0,
    unpricedTokens: t.unpricedTokens,
  };
};

const day = (iso: string) => iso.slice(0, 10);

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const registerPortalRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: PortalRouteDeps,
) => {
  const now = deps.now ?? (() => new Date());
  const newKey = deps.newKey ?? (() => `gp_${randomBytes(24).toString('base64url')}`);
  const newId = deps.newId ?? (() => randomUUID());

  const access = tenantAccess(deps.admin);
  const guard = async (
    c: Context,
    right?: Right,
  ): Promise<{ principal: Principal; tenant: string } | Response> => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const tenant = c.req.param('tenant') ?? '';
    const entered = enterTenant(c, access, principal, tenant, right);
    if ('response' in entered) return entered.response;
    return { principal: entered.principal, tenant };
  };

  const capabilitiesOf = async (tenant: string) =>
    (await deps.definitions.capabilities()).filter((c) => c.service.tenant === tenant);

  const serviceOf = (caps: CompiledCapability[], capabilityId: string) =>
    caps.find((c) => c.capability.descriptor.id === capabilityId)?.service.id ?? capabilityId;

  const tenantTasks = async (
    tenant: string,
    keep: (row: PortalTaskRow) => boolean = () => true,
  ) => {
    const rows = (await deps.tasks(tenant)).filter((t) => t.tenant === tenant && keep(t));
    const tasks = await Promise.all(rows.map((r) => deps.task(r.task)));
    return tasks.filter(
      (t): t is Task =>
        t !== undefined &&
        (t.tenant === tenant || t.owner === tenant) &&
        originOf(t.service.capability.id) === serviceOrigin,
    );
  };

  const taskBase = (caps: CompiledCapability[], t: Task) => ({
    id: t.id,
    status: t.status,
    service: serviceOf(caps, t.service.capability.id),
    capability: t.service.capability.id,
    version: Number(t.service.capability.version) || null,
    createdAt: t.createdAt,
    endedAt: t.endedAt ?? null,
  });

  const modelUsage = async (task: string) => {
    const out: { model: string; usage: Usage }[] = [];
    if (!deps.events) return out;
    for await (const event of deps.events(task)) {
      if (event.type !== 'kernel.usage') continue;
      const data = event.data as { usage?: Usage; model?: { id?: string } };
      if (data.usage) out.push({ model: data.model?.id ?? 'ukjent', usage: data.usage });
    }
    return out;
  };

  const taskTally = async (t: Task) => {
    const models = await modelUsage(t.id);
    if (models.length === 0) return { tally: tallyOf(t.usage), models };
    const tally = models.map((m) => tallyOf(m.usage, deps.prices?.[m.model])).reduce(add, empty());
    return {
      tally: { ...tally, requests: Math.max(tally.requests, t.usage.requests ?? 0) },
      models,
    };
  };

  const taskRow = async (caps: CompiledCapability[], t: Task) => ({
    ...taskBase(caps, t),
    usage: usageView((await taskTally(t)).tally),
  });

  const weekMs = 7 * 86_400_000;

  const channelsOf = (spec: Record<string, unknown>) => {
    const exposure = (spec.exposure ?? {}) as Record<string, unknown>;
    const triggers = (Array.isArray(spec.triggers) ? spec.triggers : []) as { kind?: unknown }[];
    const has = (kind: string) => triggers.some((x) => x.kind === kind);
    return [
      ...(exposure.chat === true ? ['chatOwn'] : []),
      ...(exposure.rest === true ? ['api'] : []),
      ...(exposure.mcp === true ? ['mcp'] : []),
      ...(exposure.openai === true ? ['openai'] : []),
      ...(exposure.a2a === true ? ['a2a'] : []),
      ...((spec.batch as { enabled?: unknown } | undefined)?.enabled === true ? ['batch'] : []),
      ...(has('document-arrives') ? ['fileTrigger'] : []),
      ...(has('queue-message') ? ['queue'] : []),
      ...(has('schedule') ? ['schedule'] : []),
    ];
  };

  const runsThisWeek = async (tenant: string) => {
    const since = new Date(now().getTime() - weekMs).toISOString();
    const recent = await tenantTasks(tenant, (row) => row.at >= since);
    const caps = await capabilitiesOf(tenant);
    const counts = new Map<string, number>();
    for (const t of recent) {
      if (t.createdAt < since) continue;
      const service = serviceOf(caps, t.service.capability.id);
      counts.set(service, (counts.get(service) ?? 0) + 1);
    }
    return counts;
  };

  const serviceSummaries = async (tenant: string, withArchived = false) => {
    const list = (await deps.definitions.list(tenant)).filter((d) => d.kind === 'Service');
    const counts = await runsThisWeek(tenant);
    const found = await Promise.all(list.map((d) => deps.definitions.get('Service', tenant, d.id)));
    const people = await deps.names?.namesOf(found.flatMap((f) => (f ? [f.publishedBy] : [])));
    const rows = await Promise.all(
      list.map(async (d, i) => {
        const latest = found[i];
        const metadata = (latest?.definition.metadata ?? {}) as { name?: string };
        const spec = (latest?.definition.spec ?? {}) as Record<string, unknown>;
        const output = (spec.output ?? {}) as { kind?: unknown };
        const health = await deps.serviceHealth?.(tenant, d.id);
        const lifecycle = (await deps.lifecycle?.(tenant, d.id)) ?? { state: 'active' as const };
        const by = latest ? people?.get(latest.publishedBy) : undefined;
        return {
          id: d.id,
          name: metadata.name ?? d.id,
          purpose: typeof spec.purpose === 'string' ? spec.purpose : '',
          outputKind: typeof output.kind === 'string' ? output.kind : 'answer',
          channels: channelsOf(spec),
          latestVersion: latest?.version ?? null,
          status: lifecycle.state === 'paused' ? 'paused' : (health?.status ?? 'active'),
          statusReason:
            lifecycle.state === 'paused' ? pausedMessage(lifecycle) : (health?.reason ?? null),
          lifecycle: lifecycle.state,
          warnings: health?.warnings ?? [],
          updatedAt: latest?.publishedAt ?? null,
          updatedBy: latest?.publishedBy ?? null,
          ...(by ? { updatedByName: by } : {}),
          runsThisWeek: counts.get(d.id) ?? 0,
        };
      }),
    );
    return rows
      .filter((r) => withArchived || r.lifecycle !== 'archived')
      .sort((a, b) => b.runsThisWeek - a.runsThisWeek || a.name.localeCompare(b.name, 'nb'));
  };

  const excerptOf = (text: string) => {
    const document = /^Dokument: (.+)$/m.exec(text)?.[1];
    const plain = (document ?? text).replace(/\s+/g, ' ').trim();
    return plain.length > 90 ? `${plain.slice(0, 89)}…` : plain;
  };

  const inputTextOf = async (task: string) => {
    if (!deps.events) return '';
    for await (const event of deps.events(task)) {
      if (event.type !== 'kernel.task.input') continue;
      const input = ((event.data as { input?: unknown }).input ?? {}) as {
        data?: { query?: unknown };
        parts?: { mime: string; body: { kind: string; text?: string } }[];
      };
      if (typeof input.data?.query === 'string') return input.data.query;
      return (input.parts ?? [])
        .flatMap((p) => (p.body.kind === 'text' && p.body.text ? [p.body.text] : []))
        .join('');
    }
    return '';
  };

  const refOf = (id: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(id);
      return Array.isArray(parsed) ? parsed.map(String) : ['', id];
    } catch {
      return ['', id];
    }
  };

  const keyNames = async (tenant: string) =>
    new Map((await deps.apiKeys.list(tenant)).map((k) => [k.id, k.name]));

  const taskActors = async (tasks: Task[], tenant: string) => {
    const refs = tasks.map((t) => {
      const [issuer = '', subject = ''] = refOf(t.principal.id);
      return { task: t.id, kind: t.principal.kind, issuer, subject };
    });
    const keys = refs.some((r) => r.issuer === LEGACY_KEY_ISSUER)
      ? await keyNames(tenant)
      : new Map<string, string>();
    const people = await deps.names?.namesOf(
      refs.filter((r) => r.kind === 'employee').map((r) => `${r.kind}:${r.issuer}:${r.subject}`),
    );
    return new Map(
      refs.map((r) => {
        const person = people?.get(`${r.kind}:${r.issuer}:${r.subject}`);
        const key = keys.get(r.subject);
        const actor =
          r.issuer === LEGACY_KEY_ISSUER
            ? { kind: 'api-key' as const, ...(key ? { name: key } : {}) }
            : r.kind === 'employee'
              ? { kind: 'person' as const, ...(person ? { name: person } : {}) }
              : { kind: 'system' as const };
        return [r.task, actor] as const;
      }),
    );
  };

  const taskViews = async (
    tenant: string,
    caps: CompiledCapability[],
    tasks: Task[],
    withInput: boolean,
  ) => {
    const actors = await taskActors(tasks, tenant);
    const names = new Map<string, string>();
    for (const id of new Set(tasks.map((t) => serviceOf(caps, t.service.capability.id))))
      names.set(
        id,
        (
          (await deps.definitions.get('Service', tenant, id))?.definition.metadata as
            { name?: string } | undefined
        )?.name ?? id,
      );
    return Promise.all(
      tasks.map(async (t) => {
        const base = taskBase(caps, t);
        const excerpt = withInput ? excerptOf(await inputTextOf(t.id)) : '';
        return {
          ...(await taskRow(caps, t)),
          serviceName: names.get(base.service) ?? base.service,
          ...(excerpt ? { excerpt } : {}),
          actor: actors.get(t.id) ?? { kind: 'system' as const },
        };
      }),
    );
  };

  const usageOver = async (tenant: string, from: Date, to: Date, project?: string) => {
    const caps = await capabilitiesOf(tenant);
    const projectOf = new Map(
      ((await deps.projectTasks?.(tenant)) ?? []).map((p) => [p.task, p] as const),
    );
    const projectNames = new Map([...projectOf.values()].map((p) => [p.project, p.name]));
    const everyCap = await deps.definitions.capabilities();
    const titles = new Map<string, string>();
    const within = (iso: string) => {
      const at = new Date(iso).getTime();
      return at >= from.getTime() && at <= to.getTime();
    };
    const tasks = (await tenantTasks(tenant)).filter(
      (t) =>
        within(t.createdAt) && (project === undefined || projectOf.get(t.id)?.project === project),
    );
    let totals = empty();
    const daily = new Map<string, Tally>();
    const byService = new Map<string, Tally>();
    const byModel = new Map<string, Tally>();
    const byDataset = new Map<string, Tally>();
    const byProject = new Map<string, Tally>();
    const dailyService = new Map<string, Map<string, Tally>>();
    const dailyModel = new Map<string, Map<string, Tally>>();
    const runs = new Map<string, number>();
    const bump = (map: Map<string, Tally>, key: string, tally: Tally) =>
      map.set(key, add(map.get(key) ?? empty(), tally));
    const bumpOn = (
      nested: Map<string, Map<string, Tally>>,
      date: string,
      key: string,
      tally: Tally,
    ) => {
      const inner = nested.get(date) ?? new Map<string, Tally>();
      nested.set(date, inner);
      bump(inner, key, tally);
    };
    const count = (key: string) => runs.set(key, (runs.get(key) ?? 0) + 1);
    for (const t of tasks) {
      const { tally, models } = await taskTally(t);
      const date = day(t.createdAt);
      totals = add(totals, tally);
      bump(daily, date, tally);
      const service = serviceOf(caps, t.service.capability.id);
      bumpOn(dailyService, date, service, tally);
      count('');
      count(`service|${service}`);
      count(`day|${date}|${service}`);
      const found = everyCap.find((c) => c.capability.descriptor.id === t.service.capability.id);
      const title = found?.serviceName ?? found?.capability.descriptor.title;
      if (title && !titles.has(service)) titles.set(service, title);
      bump(byService, service, tally);
      const inProject = projectOf.get(t.id);
      if (inProject) {
        bump(byProject, inProject.project, tally);
        count(`project|${inProject.project}`);
      }
      for (const m of models) {
        const used = tallyOf(m.usage, deps.prices?.[m.model]);
        bump(byModel, m.model, used);
        bumpOn(dailyModel, date, m.model, used);
      }
    }
    let ingestion = empty();
    for (const run of project === undefined ? ((await deps.ingestionUsage?.(tenant)) ?? []) : []) {
      if (!within(run.at)) continue;
      const tally = tallyOf(run.usage, deps.prices?.[run.model]);
      ingestion = add(ingestion, tally);
      totals = add(totals, tally);
      bump(daily, day(run.at), tally);
      bump(byModel, run.model, tally);
      bumpOn(dailyModel, day(run.at), run.model, tally);
      bump(byDataset, run.dataset, tally);
    }
    const views = (map: Map<string, Tally> | undefined, runsOf?: (key: string) => number) =>
      Object.fromEntries(
        [...(map ?? [])].map(([key, tally]) => [
          key,
          { ...usageView(tally), ...(runsOf ? { runs: runsOf(key) } : {}) },
        ]),
      );
    const days = [];
    for (
      let at = new Date(day(from.toISOString()));
      at <= to;
      at = new Date(at.getTime() + 86_400_000)
    ) {
      const d = day(at.toISOString());
      days.push({
        date: d,
        usage: usageView(daily.get(d) ?? empty()),
        byService: views(dailyService.get(d), (s) => runs.get(`day|${d}|${s}`) ?? 0),
        byModel: views(dailyModel.get(d)),
      });
    }
    const rows = <K extends string>(map: Map<string, Tally>, key: K) =>
      [...map]
        .sort((a, b) => b[1].inputTokens - a[1].inputTokens)
        .map(
          ([id, tally]) =>
            ({ [key]: id, usage: usageView(tally) }) as Record<K, string> & {
              usage: ReturnType<typeof usageView>;
            },
        );
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      priced: totals.unpricedTokens === 0,
      totals: { ...usageView(totals), runs: runs.get('') ?? 0 },
      daily: days,
      byService: rows(byService, 'service').map((r) => ({
        ...r,
        usage: { ...r.usage, runs: runs.get(`service|${r.service}`) ?? 0 },
        ...(titles.has(r.service) ? { title: titles.get(r.service) } : {}),
      })),
      byModel: rows(byModel, 'model'),
      byProject: rows(byProject, 'project').map((r) => ({
        ...r,
        usage: { ...r.usage, runs: runs.get(`project|${r.project}`) ?? 0 },
        name: projectNames.get(r.project) ?? r.project,
      })),
      ...(project === undefined ? {} : { project }),
      ingestion: { usage: usageView(ingestion), byDataset: rows(byDataset, 'dataset') },
    };
  };

  app.get('/tenants/:tenant/overview', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const caps = await capabilitiesOf(g.tenant);
    const services = (await serviceSummaries(g.tenant)).map((s) => ({
      id: s.id,
      name: s.name,
      latestVersion: s.latestVersion,
      status: s.status,
      statusReason: s.statusReason,
      warnings: s.warnings,
      runsThisWeek: s.runsThisWeek,
    }));
    const tasks = (await tenantTasks(g.tenant)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    const start = now();
    const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const usage = await usageOver(g.tenant, month, start);
    const connections = await deps.connections.list(g.tenant);
    const dayAgo = start.getTime() - 86_400_000;
    return c.json({
      services,
      recentTasks: await Promise.all(tasks.slice(0, 5).map((t) => taskRow(caps, t))),
      usageThisMonth: usage.totals,
      qualityWarnings: (await deps.qualityWarnings?.(g.tenant)) ?? [],
      review: {
        pendingToolChanges: connections.reduce((n, s) => n + s.pending.length, 0),
        failedTasksLastDay: tasks.filter(
          (t) => t.status === 'failed' && new Date(t.createdAt).getTime() >= dayAgo,
        ).length,
      },
    });
  });

  app.get('/shared-services', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const shared = (await deps.definitions.capabilities()).filter(
      (c) => c.capability.descriptor.availableTo === '*',
    );
    const services = new Map<string, Record<string, unknown>>();
    for (const cap of shared) {
      const key = `${cap.service.tenant}/${cap.service.id}`;
      const entry = services.get(key) ?? (await describeService(cap));
      (entry.variants as unknown[]).push({
        id: cap.variant,
        publicName: cap.publicName,
        aliases: cap.aliases,
      });
      services.set(key, entry);
    }
    return c.json({ data: [...services.values()] });
  });

  const describeService = async (cap: CompiledCapability) => {
    const found = await deps.definitions.get('Service', cap.service.tenant, cap.service.id);
    const spec = (found?.definition.spec ?? {}) as {
      purpose?: string;
      exposure?: Record<string, boolean>;
      model?: { primary?: string; residency?: string };
      riskClass?: string;
    };
    return {
      tenant: cap.service.tenant,
      id: cap.service.id,
      name: cap.serviceName ?? cap.capability.descriptor.title,
      purpose: spec.purpose ?? cap.capability.descriptor.description,
      version: found?.version ?? null,
      riskClass: spec.riskClass ?? null,
      residency: spec.model?.residency ?? null,
      model: spec.model?.primary ?? null,
      exposure: Object.entries(spec.exposure ?? {})
        .filter(([, on]) => on)
        .map(([k]) => k),
      variants: [] as unknown[],
    };
  };

  app.get('/tenants/:tenant/access', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const caps = await capabilitiesOf(g.tenant);
    const seen = new Set<string>();
    const services = caps.flatMap((cap) => {
      if (seen.has(cap.service.id)) return [];
      seen.add(cap.service.id);
      return [
        {
          id: cap.service.id,
          name: cap.serviceName ?? cap.capability.descriptor.title,
          publicName: cap.publicName,
          requirement: deps.requirementFor(g.tenant, cap.service.id),
        },
      ];
    });
    const keys = (await deps.apiKeys.list(g.tenant))
      .map(keyView)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return c.json({ services, keys });
  });

  const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';

  const perform = async (
    c: Context,
    action: string,
    data: Record<string, unknown> & { tenant: string },
  ) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return { ok: false as const, response: g };
    const principal = g.principal;
    const result = await deps.admin.perform(principal, action, { ...data, reason: reasonOf(c) });
    c.header('genai-task', result.task);
    if (result.ok) return { ok: true as const, value: result.value };
    if (result.problem) return { ok: false as const, response: rightRefused(c, result.problem) };
    const forbidden = result.errors.some((e) => e.path === 'principal');
    if (!forbidden && result.errors.some((e) => e.path === 'id'))
      return { ok: false as const, response: problem(c, 404, 'Not found', result.errors) };
    return {
      ok: false as const,
      response: problem(
        c,
        forbidden ? 403 : 400,
        forbidden ? 'Forbidden' : 'Invalid request',
        result.errors,
      ),
    };
  };

  app.post('/tenants/:tenant/api-keys', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind === 'operator')
      return access(principal, c.req.param('tenant') ?? '', c.req.raw)
        ? problem(c, 403, 'API-nøkler lages av virksomheten selv')
        : problem(c, 404, 'Not found');
    const tenant = c.req.param('tenant') ?? '';
    if (!isReasonLongEnough(reasonOf(c)))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      datasets?: unknown;
      agents?: unknown;
      allowedOverrides?: unknown;
      expiresInDays?: unknown;
      callsPerMinute?: unknown;
    };
    const days =
      typeof body.expiresInDays === 'number' && body.expiresInDays > 0
        ? body.expiresInDays
        : undefined;
    const key = newKey();
    const created = now();
    const datasets = strings(body.datasets);
    const agents = strings(body.agents);
    const everything = datasets.length === 0 && agents.length === 0;
    const outcome = await perform(c, 'platform.apikeys.create', {
      tenant,
      id: newId(),
      name: typeof body.name === 'string' ? body.name : '',
      datasets: everything ? [ALL_GRANT] : datasets,
      agents: everything ? [ALL_GRANT] : agents,
      ...(callsPerMinute(body.callsPerMinute) ? { callsPerMinute: body.callsPerMinute } : {}),
      allowedOverrides: overridable(body.allowedOverrides),
      digest: apiKeyDigest(key),
      prefix: key.slice(0, 7),
      lastFour: key.slice(-4),
      createdAt: created.toISOString(),
      ...(days ? { expiresAt: new Date(created.getTime() + days * 86_400_000).toISOString() } : {}),
    });
    if (!outcome.ok) return outcome.response;
    return c.json({ key, apiKey: outcome.value }, 201);
  });

  app.post('/tenants/:tenant/api-keys/:id/revoke', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (!isReasonLongEnough(reasonOf(c)))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const outcome = await perform(c, 'platform.apikeys.revoke', {
      tenant: c.req.param('tenant') ?? '',
      id: c.req.param('id') ?? '',
      at: now().toISOString(),
    });
    if (!outcome.ok) return outcome.response;
    return c.json(outcome.value);
  });

  const monthlyUsage = new Map<
    string,
    { at: number; totals: Promise<ReturnType<typeof usageView>> }
  >();
  const monthlyUsageTtlMs = 30_000;

  app.get('/operator/usage', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind !== 'operator') return problem(c, 403, 'Only operators list tenants');
    const tenants = [
      ...new Set(
        (c.req.query('tenants') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => /^\d{9}$/.test(t)),
      ),
    ].slice(0, 200);
    const to = now();
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    const data = await Promise.all(
      tenants.map(async (orgNumber) => {
        const key = `${orgNumber}:${from.toISOString()}`;
        const cached = monthlyUsage.get(key);
        if (cached && to.getTime() - cached.at < monthlyUsageTtlMs)
          return { orgNumber, usage: await cached.totals };
        const totals = usageOver(orgNumber, from, to).then((u) => u.totals);
        monthlyUsage.set(key, { at: to.getTime(), totals });
        totals.catch(() => monthlyUsage.delete(key));
        return { orgNumber, usage: await totals };
      }),
    );
    return c.json({ from: from.toISOString(), to: to.toISOString(), data });
  });

  app.get('/tenants/:tenant/usage', async (c) => {
    const g = await guard(c, 'view-usage');
    if (g instanceof Response) return g;
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 366);
    const to = now();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const project = c.req.query('project')?.trim() || undefined;
    return c.json(await usageOver(g.tenant, new Date(day(from.toISOString())), to, project));
  });

  app.get('/tenants/:tenant/tasks', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const caps = await capabilitiesOf(g.tenant);
    const status = c.req.query('status');
    const service = c.req.query('service');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
    const tasks = await tenantTasks(
      g.tenant,
      (row) => (!status || row.status === status) && (!from || row.at >= from),
    );
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const rows = tasks
      .map((t) => taskBase(caps, t))
      .filter((r) => !status || r.status === status)
      .filter((r) => !service || r.service === service)
      .filter((r) => !from || r.createdAt >= from)
      .filter((r) => !to || r.createdAt <= to)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const data = await taskViews(
      g.tenant,
      caps,
      rows.slice(0, limit).map((r) => byId.get(r.id) as Task),
      requireRight(g.principal, g.tenant, 'manage-services').ok,
    );
    return c.json({ data, total: rows.length });
  });

  app.get('/tenants/:tenant/tasks/mine', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const caps = await capabilitiesOf(g.tenant);
    const status = c.req.query('status');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    const self = JSON.stringify([g.principal.issuer, g.principal.subject]);
    const own = (await tenantTasks(g.tenant))
      .filter((t) => t.principal.id === self && (!status || t.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    const data = await Promise.all(
      own.map(async (t) => {
        const events: Event[] = [];
        if (t.status === 'failed' && deps.events)
          for await (const e of deps.events(t.id)) if (e.type === 'kernel.error') events.push(e);
        const failure = failureOf(events);
        const title = caps.find((x) => x.capability.descriptor.id === t.service.capability.id)
          ?.capability.descriptor.title;
        return {
          ...taskBase(caps, t),
          ...(title ? { serviceName: title } : {}),
          ...(failure
            ? {
                failure: {
                  code: failure.code,
                  reason: failureReason(failure),
                  ...(failure.step ? { step: failure.step } : {}),
                },
              }
            : {}),
        };
      }),
    );
    return c.json({ data });
  });

  app.get('/tenants/:tenant/tasks/:task', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const found = await deps.task(c.req.param('task') ?? '');
    if (
      !found ||
      (found.tenant !== g.tenant && found.owner !== g.tenant) ||
      originOf(found.service.capability.id) !== serviceOrigin
    )
      return problem(c, 404, 'Not found');
    const [view] = await taskViews(
      g.tenant,
      await capabilitiesOf(g.tenant),
      [found],
      requireRight(g.principal, g.tenant, 'manage-services').ok,
    );
    return c.json(view);
  });

  app.get('/tenants/:tenant/services', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    return c.json({ data: await serviceSummaries(g.tenant, true) });
  });

  app.get('/tenants/:tenant/integrations', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const states = await deps.connections.list(g.tenant);
    return c.json({
      connections: states.map((s) => ({
        id: s.connection.id,
        name: s.connection.name,
        endpoint: s.connection.endpoint,
        version: s.connection.version,
        allow: s.connection.allow,
        auth: s.connection.auth
          ? {
              kind: s.connection.auth.kind,
              secret: s.connection.auth.secret.slice(s.connection.auth.secret.lastIndexOf('/') + 1),
            }
          : null,
        tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
        pending: s.pending.map((t) => ({ name: t.name, description: t.description })),
      })),
      traces: deps.traces ?? { enabled: false, content: false },
    });
  });

  app.post('/tenants/:tenant/definitions/input-fields', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    if (!deps.drafts) return problem(c, 404, 'Not found');
    const body = (await c.req.json().catch(() => undefined)) as
      { definition?: unknown } | undefined;
    if (body?.definition === undefined)
      return problem(c, 400, 'Invalid request', [{ path: 'definition', message: 'required' }]);
    return c.json({
      fields: await deps.drafts.inputFields(g.principal, g.tenant, body.definition),
    });
  });

  app.post('/tenants/:tenant/definitions/test-run', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    if (!deps.drafts) return problem(c, 404, 'Not found');
    const body = (await c.req.json().catch(() => undefined)) as
      | {
          definition?: unknown;
          files?: unknown;
          query?: unknown;
          input?: unknown;
          variant?: unknown;
        }
      | undefined;
    const query = typeof body?.query === 'string' ? body.query.trim() : '';
    const form =
      typeof body?.input === 'object' && body.input !== null && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : undefined;
    const files = body?.files ?? {};
    const invalid = [
      ...(body?.definition === undefined ? [{ path: 'definition', message: 'required' }] : []),
      ...(query || form ? [] : [{ path: 'query', message: 'required' }]),
      ...(body?.input === undefined || form
        ? []
        : [{ path: 'input', message: 'must be an object' }]),
      ...(typeof files === 'object' &&
      files !== null &&
      Object.values(files).every((v) => typeof v === 'string')
        ? []
        : [{ path: 'files', message: 'files must map prompt paths to text' }]),
      ...(body?.variant === undefined || typeof body.variant === 'string'
        ? []
        : [{ path: 'variant', message: '`variant` must be a variant id.' }]),
    ];
    if (invalid.length) return problem(c, 400, 'Invalid request', invalid);
    const result = await deps.drafts.run({
      principal: g.principal,
      tenant: g.tenant,
      definition: body?.definition,
      files: files as Record<string, string>,
      parts: query ? [{ kind: 'text', text: query }] : [],
      origin: 'builder',
      input: form ?? {},
      ...(typeof body?.variant === 'string' ? { variant: body.variant } : {}),
    });
    if (result.task) c.header('genai-task', result.task);
    if (!result.ok && result.status === 400)
      return c.json(invalidInputProblem(result.errors), 400, {
        'content-type': 'application/problem+json',
      });
    if (result.ok)
      return c.json(
        { ok: true, task: result.task, answer: result.answer, parts: result.parts },
        200,
      );
    return c.json(
      {
        type: 'about:blank',
        title:
          result.status === 422
            ? 'Invalid definition'
            : result.code
              ? failureReason({ code: result.code, ...(result.step ? { step: result.step } : {}) })
              : 'Test run failed',
        status: result.status,
        ...(result.code ? { code: result.code } : {}),
        ...(result.step ? { step: result.step } : {}),
        ...(result.task ? { runId: result.task } : {}),
        errors: result.errors,
      },
      result.status,
      { 'content-type': 'application/problem+json' },
    );
  });
};
