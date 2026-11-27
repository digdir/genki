import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { usageUnits, type Event, type Principal, type Task, type Usage } from '@genai/contracts';
import { invalidInputProblem } from '@genai/adapter-openai';
import { isAdmittedEntraLogin } from '@genai/composition';
import type { CompiledCapability, DefinitionStore, ServiceDefinition } from '@genai/definitions';
import {
  ALL_GRANT,
  apiKeyDigest,
  boundService,
  LEGACY_KEY_ISSUER,
  type ApiKeyStore,
  type KeyPolicy,
  type StoredApiKey,
  environmentNamePattern,
} from '@genai/identity';
import type { TaskErasure } from '@genai/kernel';
import type { Residency } from '@genai/port-model';
import type { ConnectionRegistry } from '@genai/providers-mcp-client';
import {
  combine,
  directOnly,
  genkiCostCounts,
  genkiSource,
  inNok,
  type AssignedUsageRow,
  type CountingRule,
  type CurrencyRate,
  type Money,
  type UsageReads,
  type UsageSubject,
} from '@genai/port-usage';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant, tenantAccess } from '../access.js';
import { defaultKeyCallsPerMinute, quotaExhausted } from '../rate-limit.js';
import { actorOf, type Admin, type AdminHandler, type AdminOutcome } from '../admin.js';
import {
  originOf,
  trialOrigins,
  priced,
  serviceOrigin,
  type DraftRunner,
  type ModelPrice,
} from '../draft-runner.js';
import { requireRight, rightRefused, type Right } from '../rights.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from '../http.js';
import { failureOf, failureReason } from '../failures.js';
import type { DirectoryEntry } from '../extensions.js';
import type { InboxItem } from '../operator-inbox.js';
import { registerOperatorTenantRoutes } from './operator-tenant-routes.js';
import { failureDetail } from '../run-steps.js';
import type { Lockdown } from '../lockdown.js';
import { erasureOf } from '../timeline.js';
import { t } from '../i18n/index.js';
import { mayGiveTestRunnerKeys, testRunnerRefusedType } from '../test-runner.js';
import { fileInputOf } from '../runtime-documents.js';
import type { ServiceHealth } from '../service-health.js';
import { pausedMessage, type LifecycleView } from '../service-lifecycle.js';
import {
  hidesInternalServices,
  isHiddenService,
  isHiddenTask,
  seeingInternalServices,
  shownKeys,
} from '../internal-services.js';
import { rightBeyondHolder } from '../key-policies.js';
import { timedStep } from '../request-timing.js';

export type TaskChannel = 'api-key' | 'interface' | 'api' | 'playground' | 'batch';

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
  createdBy?: string;
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

  async unadmitted() {
    return [...this.#keys.values()]
      .filter((k) => !k.revokedAt && !k.admittedInLockdown && k.tenant)
      .map((k) => ({ tenant: k.tenant as string, id: k.id, digest: k.digest }));
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

interface TaskFailure {
  code: string;
  reason: string;
  step?: string;
  detail?: string;
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
  taskEnvelopes?(tenant: string, query: { since?: string; limit?: number }): Promise<Task[]>;
  events?(task: string): AsyncIterable<Event>;
  usageEvents?(tasks: string[]): Promise<{ task: string; data: unknown }[]>;
  eventsOfType?(tasks: string[], type: string): Promise<Event[]>;
  erasures?(tenant: string, tasks: string[]): Promise<TaskErasure[]>;
  apiKeys: TenantApiKeys;
  connections: ConnectionRegistry;
  requirementFor(tenant: string, service: string): ServiceRequirement;
  prices?: Record<string, ModelPrice>;
  retentionOf?(capability: CompiledCapability): { payloadDays: number };
  modelResidency?(model: string): Residency | undefined;
  serviceDataLocation?(spec: ServiceDefinition['spec']): Residency | undefined;
  ingestionUsage?(
    tenant: string,
  ): Promise<{ at: string; dataset: string; model: string; usage: Usage }[]>;
  projectTasks?(tenant: string): Promise<{ task: string; project: string; name: string }[]>;
  quota?(tenant: string): Promise<{ usedTokens: number; monthlyTokens: number }>;
  serviceHealth?(tenant: string, service: string): Promise<ServiceHealth | undefined>;
  lifecycle?(tenant: string, service: string): Promise<LifecycleView>;
  names?: { namesOf(actors: string[]): Promise<Map<string, string>> };
  lockdown?: Lockdown;
  traces?: { enabled: boolean; content: boolean };
  qualityWarnings?(tenant: string): Promise<{ service: string; message: string }[]>;
  batchTasks?(tenant: string): Promise<Set<string>>;
  drafts?: DraftRunner;
  gatewayUsage?: UsageReads;
  countingRule?(): CountingRule;
  testRunnerKeys?: boolean;
  isOperator?: (principal: Principal) => boolean;
  directory?(): Promise<DirectoryEntry[]>;
  inbox?(viewer: Principal): Promise<InboxItem[]>;
  now?(): Date;
  newKey?(): string;
  newId?(): string;
}

export const quotaAlertPercent = 80;

export const quotaView = ({
  usedTokens,
  monthlyTokens,
}: {
  usedTokens: number;
  monthlyTokens: number;
}) => {
  const usedPercent = Math.round((usedTokens / monthlyTokens) * 1000) / 10;
  return {
    usedTokens,
    monthlyTokens,
    usedPercent,
    alertPercent: quotaAlertPercent,
    alert: usedTokens * 100 >= quotaAlertPercent * monthlyTokens,
  };
};

const forTenant = (principal: Principal, tenant: string) =>
  principal.kind === 'operator' || principal.tenant === tenant;

const testRunnerRefusal = (
  c: Context,
  allowed: boolean,
  principal: Principal,
  isOperator: ((principal: Principal) => boolean) | undefined,
) => {
  const detail = !allowed
    ? t('problems.testRunnerEnvironmentDetail')
    : mayGiveTestRunnerKeys(principal, isOperator)
      ? undefined
      : t('problems.testRunnerCreatorDetail');
  if (detail === undefined) return undefined;
  return c.json(
    { type: testRunnerRefusedType, title: t('problems.testRunnerRefused'), status: 403, detail },
    403,
    { 'content-type': 'application/problem+json' },
  );
};

const testRunnerMaxDays = 90;

const testRunnerLimitErrors = (expiresInDays: unknown, rate: unknown) => [
  ...(typeof expiresInDays === 'number' &&
  Number.isInteger(expiresInDays) &&
  expiresInDays >= 1 &&
  expiresInDays <= testRunnerMaxDays
    ? []
    : [
        {
          path: 'expiresInDays',
          message: `a test-runner key needs an expiry of 1 to ${testRunnerMaxDays} days`,
        },
      ]),
  ...(callsPerMinute(rate)
    ? []
    : [{ path: 'callsPerMinute', message: 'a test-runner key needs a calls-per-minute limit' }]),
];

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
  environments: key.environments ?? [],
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
  testRunner: key.testRunner === true,
});

export interface KeyViewContext {
  principal: Principal;
  tenant: string;
  names?: { namesOf(actors: string[]): Promise<Map<string, string>> };
  lockdown?: Lockdown;
}

export const keyViews = async (keys: TenantApiKey[], context: KeyViewContext) => {
  const showsCreator = requireRight(context.principal, context.tenant, 'manage-services').ok;
  const employees = keys.flatMap((k) =>
    k.createdBy?.startsWith('employee:') ? [k.createdBy] : [],
  );
  const names =
    showsCreator && employees.length > 0 ? await context.names?.namesOf(employees) : undefined;
  const lockdown = context.lockdown;
  return keys
    .map((key) => {
      const name = key.createdBy && names?.get(key.createdBy);
      return {
        ...keyView(key),
        ...(showsCreator
          ? { createdBy: key.createdBy ?? null, ...(name ? { createdByName: name } : {}) }
          : {}),
        ...(lockdown
          ? {
              modelsInLockdown:
                key.admittedInLockdown === true || lockdown.configuredKeys.has(key.digest),
            }
          : {}),
      };
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
};

const optional = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;

const slugOrUndefined = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : undefined;

const callsPerMinute = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6000;

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];

const environmentNames = (value: unknown) => [
  ...new Set(strings(value).filter((v) => environmentNamePattern.test(v))),
];

export const overridable = (value: unknown) =>
  strings(value).filter((v) => /^([a-z][A-Za-z0-9]*)(\.[A-Za-z0-9]+)*(\.\*)?$/.test(v));

export const portalAdminHandlers = (deps: {
  apiKeys: TenantApiKeys;
  policies?: KeyPolicyStore;
  testRunnerKeys?: boolean;
  isOperator?: (principal: Principal) => boolean;
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
      ...(environmentNames(input.environments).length && slugOrUndefined(input.service)
        ? { environments: environmentNames(input.environments) }
        : {}),
      ...(callsPerMinute(input.callsPerMinute) ? { callsPerMinute: input.callsPerMinute } : {}),
      ...(overridable(input.allowedOverrides).length > 0
        ? { allowedOverrides: overridable(input.allowedOverrides) }
        : {}),
      ...(typeof input.prefix === 'string' ? { prefix: input.prefix } : {}),
      ...(typeof input.lastFour === 'string' ? { lastFour: input.lastFour } : {}),
      ...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
      ...(typeof input.expiresAt === 'string' ? { expiresAt: input.expiresAt } : {}),
      createdBy: actorOf(principal.actor ?? principal),
      ...(isAdmittedEntraLogin(principal) ? { admittedInLockdown: true } : {}),
      ...(input.testRunner === true &&
      deps.testRunnerKeys === true &&
      mayGiveTestRunnerKeys(principal, deps.isOperator)
        ? { testRunner: true }
        : {}),
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
          environments: key.environments ?? [],
          allowedOverrides: key.allowedOverrides ?? [],
          callsPerMinute: key.callsPerMinute ?? null,
          expiresAt: key.expiresAt ?? null,
          testRunner: key.testRunner === true,
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
    const policyId = old.policy?.id;
    const policy =
      (policyId &&
        (await deps.policies?.listPolicies(input.tenant))?.find((p) => p.id === policyId)) ||
      old.policy;
    const beyond = rightBeyondHolder(principal, input.tenant, [
      ...(old.scopes ?? []),
      ...(policy?.scopes ?? []),
    ]);
    if (beyond) return refused(target, t('problems.keyBeyondRights', { right: beyond }));
    const kept: TenantApiKey = { ...old };
    delete kept.revokedAt;
    delete kept.lastUsedAt;
    delete kept.admittedInLockdown;
    delete kept.testRunner;
    if (isAdmittedEntraLogin(principal)) kept.admittedInLockdown = true;
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
      createdBy: actorOf(principal.actor ?? principal),
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
  units: Record<string, number>;
  unpricedUnits: Record<string, number>;
}

const empty = (): Tally => ({
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  pricedMicroNok: 0,
  unpricedTokens: 0,
  units: {},
  unpricedUnits: {},
});

const countedUnits = new Set(['input-token', 'output-token', 'cached-input-token', 'request']);

const unitsOf = (usage: Usage) =>
  Object.fromEntries(Object.entries(usageUnits(usage)).filter(([unit]) => !countedUnits.has(unit)));

const sumUnits = (a: Record<string, number>, b: Record<string, number>) => {
  const sum = { ...a };
  for (const [unit, count] of Object.entries(b)) sum[unit] = (sum[unit] ?? 0) + count;
  return sum;
};

const tokensOf = (u: Usage) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0);

export const tallyOf = (usage: Usage, price?: ModelPrice): Tally => {
  const known = usage.costMicroNok !== undefined || price !== undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    requests: usage.requests ?? 0,
    pricedMicroNok: known ? priced(usage, price) : 0,
    unpricedTokens: known ? 0 : tokensOf(usage),
    units: unitsOf(usage),
    unpricedUnits: usage.costMicroNok === undefined ? unitsOf(usage) : {},
  };
};

const minus = (t: Tally): Tally => ({
  inputTokens: 0,
  outputTokens: 0,
  requests: 0,
  pricedMicroNok: -t.pricedMicroNok,
  unpricedTokens: -t.unpricedTokens,
  units: {},
  unpricedUnits: {},
});

export const gatewaySource = 'gateway';

const gatewayTally = (row: AssignedUsageRow, rates: readonly CurrencyRate[]) => {
  const converted = inNok(row.cost, row.start.slice(0, 10), rates);
  const tokens = row.inputTokens + row.outputTokens;
  const nothingPriced = row.requests > 0 && row.unpricedRequests >= row.requests;
  return {
    tally: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      requests: row.requests,
      pricedMicroNok: converted?.micros ?? 0,
      unpricedTokens: converted && !nothingPriced ? 0 : tokens,
      units: {},
      unpricedUnits: {},
    },
    rate: converted?.rate,
  };
};

const subjectKey = (s: UsageSubject | undefined, currency: string) =>
  [s?.kind ?? '', s?.id ?? '', s?.org ?? '', currency].join('\u0000');

export interface GatewayWindow {
  rows: AssignedUsageRow[];
  rates: CurrencyRate[];
}

const add = (a: Tally, b: Tally): Tally => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  requests: a.requests + b.requests,
  pricedMicroNok: a.pricedMicroNok + b.pricedMicroNok,
  unpricedTokens: a.unpricedTokens + b.unpricedTokens,
  units: sumUnits(a.units, b.units),
  unpricedUnits: sumUnits(a.unpricedUnits, b.unpricedUnits),
});

export const usageView = (t: Tally) => {
  const tokens = t.inputTokens + t.outputTokens;
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    requests: t.requests,
    costMicroNok: tokens > 0 && t.unpricedTokens >= tokens ? null : t.pricedMicroNok,
    priced: t.unpricedTokens === 0 && Object.keys(t.unpricedUnits).length === 0,
    unpricedTokens: t.unpricedTokens,
    units: t.units,
    unpricedUnits: t.unpricedUnits,
  };
};

const day = (iso: string) => iso.slice(0, 10);

export const taskSearchWindow = 2000;

export const osloMidnight = (at: Date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const wall = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const offset = wall - Math.floor(at.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1) - offset);
};

const percentile = (sorted: number[], share: number) =>
  sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? 0;

export const latencyOf = (durations: number[]) => {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    runs: sorted.length,
  };
};

const windowLimit = 50_000;
const defaultEnvelopeLimit = 1000;

interface RememberedWindow {
  since: string | undefined;
  limit: number;
  found: Promise<Task[]>;
}

type ModelUsage = { model: string; usage: Usage };

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
  const dataLocationOf = (definition: { kind: string; spec: unknown }) =>
    definition.kind === 'Service'
      ? (deps.serviceDataLocation?.(definition.spec as ServiceDefinition['spec']) ?? null)
      : null;

  const envelopeMemo = new AsyncLocalStorage<Map<string, RememberedWindow[]>>();
  app.use('/tenants/:tenant/*', (_c, next) => envelopeMemo.run(new Map(), next));
  const envelopes = async (
    tenant: string,
    query: { since?: string; limit?: number },
  ): Promise<Task[]> => {
    const read = deps.taskEnvelopes as NonNullable<PortalRouteDeps['taskEnvelopes']>;
    const memo = envelopeMemo.getStore();
    if (!memo) return read(tenant, query);
    const limit = query.limit ?? defaultEnvelopeLimit;
    const known = memo.get(tenant) ?? [];
    const same = known.find((w) => w.since === query.since && w.limit === limit);
    if (same) return (await same.found).slice();
    const since = query.since;
    if (since !== undefined)
      for (const wider of known) {
        if (wider.since === undefined || wider.since > since) continue;
        const found = await wider.found;
        if (found.length < wider.limit)
          return found.filter((t) => t.createdAt >= since).slice(0, limit);
      }
    const found = read(tenant, query);
    memo.set(tenant, [...known, { since, limit, found }]);
    return (await found).slice();
  };

  const access = tenantAccess;
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

  const serviceOf = (caps: CompiledCapability[], capabilityId: string) => {
    const unpinned = capabilityId.replace(/@\d+$/, '');
    return caps.find((c) => c.capability.descriptor.id === unpinned)?.service.id ?? capabilityId;
  };

  const environmentOf = (t: Task) =>
    t.service.environment ?? (/@\d+$/.test(t.service.capability.id) ? null : 'prod');

  const withoutHiddenServiceKeys = async (tenant: string) =>
    shownKeys(deps.definitions, tenant, await deps.apiKeys.list(tenant));

  const splitHiddenTasks = async (tasks: Task[]) => {
    const hidden = await Promise.all(tasks.map((t) => isHiddenTask(deps.definitions, t)));
    return {
      shown: tasks.filter((_, i) => !hidden[i]),
      hidden: tasks.filter((_, i) => hidden[i]),
    };
  };
  const withoutHiddenTasks = async (tasks: Task[]) => (await splitHiddenTasks(tasks)).shown;

  const tasksOf = async (
    tenant: string,
    keep: (row: PortalTaskRow) => boolean,
    fromService: boolean,
  ) => {
    const tasks = deps.taskEnvelopes
      ? (await envelopes(tenant, {})).filter((t) =>
          keep({ task: t.id, tenant: t.tenant, status: t.status, at: t.endedAt ?? t.createdAt }),
        )
      : await Promise.all(
          (await deps.tasks(tenant))
            .filter((t) => t.tenant === tenant && keep(t))
            .map((r) => deps.task(r.task)),
        );
    return withoutHiddenTasks(
      tasks.filter(
        (t): t is Task =>
          t !== undefined &&
          (t.tenant === tenant || t.owner === tenant) &&
          (originOf(t.service.capability.id) === serviceOrigin) === fromService,
      ),
    );
  };
  const tenantTasks = (tenant: string, keep: (row: PortalTaskRow) => boolean = () => true) =>
    tasksOf(tenant, keep, true);
  const playgroundRuns = async (tenant: string, keep: (row: PortalTaskRow) => boolean) =>
    (await tasksOf(tenant, keep, false)).filter((t) =>
      trialOrigins.includes(originOf(t.service.capability.id)),
    );
  const tasksSince = async (tenant: string, since: string | undefined, fromService: boolean) => {
    const found = deps.taskEnvelopes
      ? await envelopes(tenant, since ? { since, limit: windowLimit } : {})
      : await tasksOf(tenant, (row) => since === undefined || row.at >= since, fromService);
    return withoutHiddenTasks(
      found.filter(
        (t) =>
          (t.tenant === tenant || t.owner === tenant) &&
          (since === undefined || t.createdAt >= since) &&
          (originOf(t.service.capability.id) === serviceOrigin) === fromService,
      ),
    );
  };
  const tenantTestRunsSince = async (tenant: string, since: string) =>
    (await tasksSince(tenant, since, false)).filter(
      (t) => originOf(t.service.capability.id) !== 'assistant',
    );

  const taskBase = (caps: CompiledCapability[], t: Task) => ({
    id: t.id,
    status: t.status,
    service: serviceOf(caps, t.service.capability.id),
    capability: t.service.capability.id,
    version: Number(t.service.capability.version) || null,
    environment: environmentOf(t),
    createdAt: t.createdAt,
    endedAt: t.endedAt ?? null,
  });

  const usageByTask = async (tasks: string[]) => {
    const out = new Map<string, ModelUsage[]>();
    const collect = (task: string, raw: unknown) => {
      const data = (raw ?? {}) as { usage?: Usage; model?: { id?: string } };
      if (!data.usage) return;
      const list = out.get(task) ?? [];
      list.push({ model: data.model?.id ?? 'ukjent', usage: data.usage });
      out.set(task, list);
    };
    if (deps.usageEvents) {
      for (const e of await deps.usageEvents(tasks)) collect(e.task, e.data);
    } else if (deps.events) {
      for (const task of tasks)
        for await (const event of deps.events(task))
          if (event.type === 'kernel.usage') collect(task, event.data);
    }
    return out;
  };

  const taskTally = (t: Task, models: ModelUsage[] = []) => {
    if (models.length === 0) return { tally: tallyOf(t.usage), models };
    const tally = models.map((m) => tallyOf(m.usage, deps.prices?.[m.model])).reduce(add, empty());
    return {
      tally: { ...tally, requests: Math.max(tally.requests, t.usage.requests ?? 0) },
      models,
    };
  };

  const taskRow = (caps: CompiledCapability[], t: Task, models?: ModelUsage[]) => ({
    ...taskBase(caps, t),
    usage: usageView(taskTally(t, models).tally),
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
    const [recent, caps] = await Promise.all([
      tasksSince(tenant, since, true),
      capabilitiesOf(tenant),
    ]);
    const counts = new Map<string, number>();
    for (const t of recent) {
      const service = serviceOf(caps, t.service.capability.id);
      counts.set(service, (counts.get(service) ?? 0) + 1);
    }
    return counts;
  };

  const serviceSummaries = async (tenant: string, withArchived = false) => {
    const [listed, counts] = await Promise.all([
      deps.definitions.list(tenant),
      runsThisWeek(tenant),
    ]);
    const list = listed.filter((d) => d.kind === 'Service');
    const found = await Promise.all(list.map((d) => deps.definitions.get('Service', tenant, d.id)));
    const people = await deps.names?.namesOf(found.flatMap((f) => (f ? [f.publishedBy] : [])));
    const rows = await Promise.all(
      list.map(async (d, i) => {
        const latest = found[i];
        const metadata = (latest?.definition.metadata ?? {}) as { name?: string };
        const spec = (latest?.definition.spec ?? {}) as Record<string, unknown>;
        const output = (spec.output ?? {}) as { kind?: unknown };
        const primary = (spec.model as { primary?: unknown } | undefined)?.primary;
        const [health, state] = await Promise.all([
          deps.serviceHealth?.(tenant, d.id),
          deps.lifecycle?.(tenant, d.id),
        ]);
        const lifecycle = state ?? { state: 'active' as const };
        const by = latest ? people?.get(latest.publishedBy) : undefined;
        return {
          id: d.id,
          name: metadata.name ?? d.id,
          purpose: typeof spec.purpose === 'string' ? spec.purpose : '',
          outputKind: typeof output.kind === 'string' ? output.kind : 'answer',
          channels: channelsOf(spec),
          model:
            typeof primary === 'string'
              ? { id: primary, residency: deps.modelResidency?.(primary) ?? null }
              : null,
          dataLocation: latest ? dataLocationOf(latest.definition) : null,
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

  const inputText = (event: Event) => {
    const input = ((event.data as { input?: unknown }).input ?? {}) as {
      data?: { query?: unknown };
      parts?: { mime: string; body: { kind: string; text?: string } }[];
    };
    if (typeof input.data?.query === 'string') return input.data.query;
    return (input.parts ?? [])
      .flatMap((p) => (p.body.kind === 'text' && p.body.text ? [p.body.text] : []))
      .join('');
  };

  const inputTexts = async (tasks: string[]) => {
    const out = new Map<string, string>();
    const keep = (event: Event) => {
      if (!out.has(event.task)) out.set(event.task, inputText(event));
    };
    if (deps.eventsOfType) {
      for (const event of await deps.eventsOfType(tasks, 'kernel.task.input')) keep(event);
    } else if (deps.events) {
      const events = deps.events;
      await Promise.all(
        tasks.map(async (task) => {
          for await (const event of events(task))
            if (event.type === 'kernel.task.input') return keep(event);
        }),
      );
    }
    return out;
  };

  const refOf = (id: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(id);
      return Array.isArray(parsed) ? parsed.map(String) : ['', id];
    } catch {
      return ['', id];
    }
  };

  const keysOf = async (tenant: string) =>
    new Map((await deps.apiKeys.list(tenant)).map((k) => [k.id, k]));

  const actorIdOf = (t: Task, tenant: string) => {
    if (t.principal.tenant !== tenant) return undefined;
    const [issuer = '', subject = ''] = refOf(t.principal.id);
    if (issuer === LEGACY_KEY_ISSUER) return `api-key:${subject}`;
    return t.principal.kind === 'employee' ? `employee:${issuer}:${subject}` : undefined;
  };

  const frontendOf = (t: Task, tenant: string) =>
    t.principal.tenant === tenant ? t.service.frontend : undefined;

  const startedByCaller = (t: Task, principal: Principal, tenant: string) =>
    t.principal.tenant === tenant &&
    t.principal.id === JSON.stringify([principal.issuer, principal.subject]);

  const maybeBatch = (t: Task) =>
    t.entryPoint === undefined &&
    t.parent === undefined &&
    originOf(t.service.capability.id) === serviceOrigin;

  const taskChannels = async (tasks: Task[], tenant: string, keys: Map<string, TenantApiKey>) => {
    const batch = tasks.some(maybeBatch)
      ? ((await deps.batchTasks?.(tenant)) ?? new Set<string>())
      : new Set<string>();
    return new Map(
      tasks.map((t) => {
        const [issuer = '', subject = ''] = refOf(t.principal.id);
        const channel: TaskChannel | null = trialOrigins.includes(originOf(t.service.capability.id))
          ? 'playground'
          : issuer === LEGACY_KEY_ISSUER
            ? keys.get(subject)?.clientId
              ? 'interface'
              : 'api-key'
            : batch.has(t.id)
              ? 'batch'
              : frontendOf(t, tenant) !== undefined
                ? 'interface'
                : t.entryPoint !== undefined
                  ? 'api'
                  : null;
        return [t.id, channel] as const;
      }),
    );
  };

  const taskActors = async (tasks: Task[], tenant: string, keyed: Map<string, TenantApiKey>) => {
    const refs = tasks.map((t) => {
      const [issuer = '', subject = ''] = refOf(t.principal.id);
      return { task: t.id, kind: t.principal.kind, issuer, subject, id: actorIdOf(t, tenant) };
    });
    const keys = new Map([...keyed].map(([id, k]) => [id, k.name]));
    const people = await deps.names?.namesOf(
      refs.filter((r) => r.kind === 'employee').map((r) => `${r.kind}:${r.issuer}:${r.subject}`),
    );
    return new Map(
      refs.map((r) => {
        const person = people?.get(`${r.kind}:${r.issuer}:${r.subject}`);
        const key = keys.get(r.subject);
        const id = r.id ? { id: r.id } : {};
        const actor =
          r.issuer === LEGACY_KEY_ISSUER
            ? { kind: 'api-key' as const, ...id, ...(key ? { name: key } : {}) }
            : r.kind === 'employee'
              ? { kind: 'person' as const, ...id, ...(person ? { name: person } : {}) }
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
    withUsage: boolean,
  ) => {
    const keys = tasks.some((t) => refOf(t.principal.id)[0] === LEGACY_KEY_ISSUER)
      ? await keysOf(tenant)
      : new Map<string, TenantApiKey>();
    const [actors, channels, usage, inputs, erased] = await Promise.all([
      taskActors(tasks, tenant, keys),
      taskChannels(tasks, tenant, keys),
      withUsage ? usageByTask(tasks.map((t) => t.id)) : new Map<string, ModelUsage[]>(),
      withInput ? inputTexts(tasks.map((t) => t.id)) : new Map<string, string>(),
      deps.erasures?.(
        tenant,
        tasks.map((t) => t.id),
      ) ?? [],
    ]);
    const erasures = new Map(erased.map((e) => [e.task, erasureOf(e)]));
    const names = new Map(
      await Promise.all(
        [...new Set(tasks.map((t) => serviceOf(caps, t.service.capability.id)))].map(
          async (id) =>
            [
              id,
              (
                (await deps.definitions.get('Service', tenant, id))?.definition.metadata as
                  { name?: string } | undefined
              )?.name ?? id,
            ] as const,
        ),
      ),
    );
    return tasks.map((t) => {
      const base = taskBase(caps, t);
      const erasure = erasures.get(t.id);
      const excerpt = withInput && !erasure ? excerptOf(inputs.get(t.id) ?? '') : '';
      return {
        ...(withUsage ? taskRow(caps, t, usage.get(t.id)) : base),
        serviceName: names.get(base.service) ?? base.service,
        ...(excerpt ? { excerpt } : {}),
        ...(erasure ? { erasure } : {}),
        actor: actors.get(t.id) ?? { kind: 'system' as const },
        channel: channels.get(t.id) ?? null,
        ...(frontendOf(t, tenant) ? { frontend: frontendOf(t, tenant) } : {}),
      };
    });
  };

  const searchTasks = async (
    tenant: string,
    candidates: Task[],
    needle: string,
    withInput: boolean,
  ) => {
    const byRun = candidates.filter((t) => t.id.toLowerCase().includes(needle));
    const rest = candidates.filter((t) => !t.id.toLowerCase().includes(needle));
    const [inputs, erased] = withInput
      ? await Promise.all([
          inputTexts(rest.map((t) => t.id)),
          deps.erasures?.(
            tenant,
            rest.map((t) => t.id),
          ) ?? [],
        ])
      : [new Map<string, string>(), []];
    const gone = new Set(erased.map((e) => e.task));
    const byQuestion = new Set(
      rest
        .filter((t) => !gone.has(t.id) && (inputs.get(t.id) ?? '').toLowerCase().includes(needle))
        .map((t) => t.id),
    );
    const found = new Set([...byRun.map((t) => t.id), ...byQuestion]);
    return candidates.filter((t) => found.has(t.id)).map((t) => ({ id: t.id }));
  };

  const failuresOf = async (tasks: string[]) => {
    const errors = new Map<string, Event[]>();
    const keep = (event: Event) =>
      errors.set(event.task, [...(errors.get(event.task) ?? []), event]);
    if (tasks.length === 0) return new Map<string, TaskFailure>();
    const read = (event: Event) => event.type === 'kernel.error' || event.type === 'kernel.notice';
    if (deps.eventsOfType) {
      for (const type of ['kernel.error', 'kernel.notice'])
        for (const event of await deps.eventsOfType(tasks, type)) keep(event);
    } else if (deps.events) {
      const events = deps.events;
      await Promise.all(
        tasks.map(async (task) => {
          for await (const event of events(task)) if (read(event)) keep(event);
        }),
      );
    }
    const out = new Map<string, TaskFailure>();
    for (const [task, found] of errors) {
      const failure = failureOf(found);
      const detail = failure ? failureDetail(found, failure.code) : undefined;
      if (failure)
        out.set(task, {
          code: failure.code,
          reason: failureReason(failure),
          ...(failure.step ? { step: failure.step } : {}),
          ...(detail ? { detail } : {}),
        });
    }
    return out;
  };

  const gatewayWindow = async (tenants: string[], from: Date, to: Date): Promise<GatewayWindow> => {
    if (!deps.gatewayUsage) return { rows: [], rates: [] };
    const [rows, rates] = await Promise.all([
      deps.gatewayUsage.tenantRows(tenants, from, new Date(to.getTime() + 1)),
      deps.gatewayUsage.rates(),
    ]);
    return { rows, rates };
  };

  const usageOver = async (
    tenant: string,
    from: Date,
    to: Date,
    project?: string,
    preloaded?: Promise<GatewayWindow>,
    environment?: string,
  ) => {
    const scoped = project !== undefined || environment !== undefined;
    const withGateway = deps.gatewayUsage !== undefined;
    const gatewayRead =
      withGateway && !scoped ? (preloaded ?? gatewayWindow([tenant], from, to)) : undefined;
    const counting = gatewayRead && deps.countingRule ? deps.countingRule() : directOnly;
    const [all, projectTasks] = await Promise.all([
      deps.definitions.capabilities(),
      deps.projectTasks?.(tenant),
    ]);
    const caps = all.filter((c) => c.service.tenant === tenant);
    const projectOf = new Map((projectTasks ?? []).map((p) => [p.task, p] as const));
    const projectNames = new Map([...projectOf.values()].map((p) => [p.project, p.name]));
    const everyCap = new Map(all.map((c) => [c.capability.descriptor.id, c] as const));
    const titles = new Map<string, string>();
    const within = (iso: string) => {
      const at = new Date(iso).getTime();
      return at >= from.getTime() && at <= to.getTime();
    };
    const since = from.toISOString();
    const [{ shown: tasks, hidden: internalRuns }, testRuns] = await timedStep('usageTasks', () =>
      Promise.all([
        seeingInternalServices(() => tasksSince(tenant, since, true))
          .then((found) =>
            found.filter(
              (t) =>
                within(t.createdAt) &&
                (project === undefined || projectOf.get(t.id)?.project === project) &&
                (environment === undefined || environmentOf(t) === environment),
            ),
          )
          .then(splitHiddenTasks),
        !scoped
          ? tenantTestRunsSince(tenant, since).then((found) =>
              found.filter((t) => within(t.createdAt)),
            )
          : Promise.resolve([]),
      ]),
    );
    const usage = await timedStep('usageEvents', () =>
      usageByTask([...tasks, ...internalRuns, ...testRuns].map((t) => t.id)),
    );
    let totals = empty();
    const daily = new Map<string, Tally>();
    const byService = new Map<string, Tally>();
    const byModel = new Map<string, Tally>();
    const byDataset = new Map<string, Tally>();
    const byProject = new Map<string, Tally>();
    const byEnvironment = new Map<string, Tally>();
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
    const durations = new Map<string, number[]>();
    const dailyDurations = new Map<string, number[]>();
    const failedRuns = new Map<string, number>();
    const count = (key: string, failed = false) => {
      runs.set(key, (runs.get(key) ?? 0) + 1);
      if (failed) failedRuns.set(key, (failedRuns.get(key) ?? 0) + 1);
    };
    const tallied = (key: string) => ({
      runs: runs.get(key) ?? 0,
      failedRequests: failedRuns.get(key) ?? 0,
    });
    const replaceCost = (date: string, model: string, used: Tally) => {
      if (genkiCostCounts(model, counting)) return;
      totals = add(totals, minus(used));
      bump(daily, date, minus(used));
      bump(byModel, model, minus(used));
      bumpOn(dailyModel, date, model, minus(used));
    };
    for (const t of tasks) {
      const { tally, models } = taskTally(t, usage.get(t.id));
      const date = day(t.createdAt);
      totals = add(totals, tally);
      bump(daily, date, tally);
      const service = serviceOf(caps, t.service.capability.id);
      bumpOn(dailyService, date, service, tally);
      const failed = t.status === 'failed';
      count('', failed);
      count(`service|${service}`, failed);
      count(`day|${date}|${service}`, failed);
      const found = everyCap.get(t.service.capability.id.replace(/@\d+$/, ''));
      const title = found?.serviceName ?? found?.capability.descriptor.title;
      if (title && !titles.has(service)) titles.set(service, title);
      bump(byService, service, tally);
      const took = t.endedAt ? Date.parse(t.endedAt) - Date.parse(t.createdAt) : Number.NaN;
      if (Number.isFinite(took) && took >= 0) {
        durations.set(service, [...(durations.get(service) ?? []), took]);
        const onDay = `${date}|${service}`;
        dailyDurations.set(onDay, [...(dailyDurations.get(onDay) ?? []), took]);
      }
      const ranIn = environmentOf(t);
      if (ranIn !== null) {
        bump(byEnvironment, ranIn, tally);
        count(`environment|${ranIn}`, failed);
      }
      const inProject = projectOf.get(t.id);
      if (inProject) {
        bump(byProject, inProject.project, tally);
        count(`project|${inProject.project}`, failed);
      }
      for (const m of models) {
        const used = tallyOf(m.usage, deps.prices?.[m.model]);
        bump(byModel, m.model, used);
        bumpOn(dailyModel, date, m.model, used);
        replaceCost(date, m.model, used);
      }
    }
    let testing = empty();
    const byOrigin = new Map<string, Tally>();
    const dailyTesting = new Map<string, Tally>();
    const dailyIngestion = new Map<string, Tally>();
    for (const t of testRuns) {
      const { tally, models } = taskTally(t, usage.get(t.id));
      testing = add(testing, tally);
      bump(dailyTesting, day(t.createdAt), tally);
      totals = add(totals, tally);
      bump(daily, day(t.createdAt), tally);
      bump(byOrigin, originOf(t.service.capability.id), tally);
      for (const m of models) {
        const used = tallyOf(m.usage, deps.prices?.[m.model]);
        bump(byModel, m.model, used);
        bumpOn(dailyModel, day(t.createdAt), m.model, used);
        replaceCost(day(t.createdAt), m.model, used);
      }
    }
    let internal = empty();
    const dailyInternal = new Map<string, Tally>();
    for (const t of internalRuns) {
      const { tally, models } = taskTally(t, usage.get(t.id));
      const date = day(t.createdAt);
      internal = add(internal, tally);
      bump(dailyInternal, date, tally);
      totals = add(totals, tally);
      bump(daily, date, tally);
      count('', t.status === 'failed');
      count('internal', t.status === 'failed');
      count(`internal|${date}`, t.status === 'failed');
      for (const m of models) {
        const used = tallyOf(m.usage, deps.prices?.[m.model]);
        bump(byModel, m.model, used);
        bumpOn(dailyModel, date, m.model, used);
        replaceCost(date, m.model, used);
      }
    }
    let ingestion = empty();
    for (const run of scoped ? [] : ((await deps.ingestionUsage?.(tenant)) ?? [])) {
      if (!within(run.at)) continue;
      const tally = tallyOf(run.usage, deps.prices?.[run.model]);
      ingestion = add(ingestion, tally);
      bump(dailyIngestion, day(run.at), tally);
      totals = add(totals, tally);
      bump(daily, day(run.at), tally);
      bump(byModel, run.model, tally);
      bumpOn(dailyModel, day(run.at), run.model, tally);
      bump(byDataset, run.dataset, tally);
      replaceCost(day(run.at), run.model, tally);
    }
    const genkiTotals = totals;
    const genkiDaily = new Map(daily);
    const gatewayByModel = new Map<string, Tally>();
    const gatewayDaily = new Map<string, Tally>();
    let gatewayTotals = empty();
    const bySubject = new Map<
      string,
      { subject?: UsageSubject; tally: Tally; cost: Money; rate?: CurrencyRate }
    >();
    const gateway = gatewayRead ? await timedStep('gateway', () => gatewayRead) : undefined;
    for (const row of combine(gateway?.rows ?? [], counting) as AssignedUsageRow[]) {
      const { tally, rate } = gatewayTally(row, gateway?.rates ?? []);
      const date = day(row.start);
      gatewayTotals = add(gatewayTotals, tally);
      totals = add(totals, tally);
      bump(daily, date, tally);
      bump(gatewayDaily, date, tally);
      bump(gatewayByModel, row.model ?? '', tally);
      const key = subjectKey(row.subject, row.cost.currency);
      const entry = bySubject.get(key) ?? {
        ...(row.subject ? { subject: row.subject } : {}),
        tally: empty(),
        cost: { currency: row.cost.currency, micros: 0 },
      };
      entry.tally = add(entry.tally, tally);
      entry.cost.micros += row.cost.micros;
      if (rate && (!entry.rate || rate.day > entry.rate.day)) entry.rate = rate;
      bySubject.set(key, entry);
    }
    const sources = (genki: Tally, outside: Tally) =>
      withGateway
        ? {
            bySource: [
              { source: genkiSource, usage: usageView(genki) },
              { source: gatewaySource, usage: usageView(outside) },
            ],
          }
        : {};
    const views = (
      map: Map<string, Tally> | undefined,
      runsOf?: (key: string) => Record<string, unknown>,
    ) =>
      Object.fromEntries(
        [...(map ?? [])].map(([key, tally]) => [
          key,
          { ...usageView(tally), ...(runsOf ? runsOf(key) : {}) },
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
        usage: {
          ...usageView(daily.get(d) ?? empty()),
          ...sources(genkiDaily.get(d) ?? empty(), gatewayDaily.get(d) ?? empty()),
        },
        byService: views(dailyService.get(d), (s) => ({
          ...tallied(`day|${d}|${s}`),
          latency: latencyOf(dailyDurations.get(`${d}|${s}`) ?? []),
        })),
        byModel: views(dailyModel.get(d)),
        testing: usageView(dailyTesting.get(d) ?? empty()),
        ingestion: usageView(dailyIngestion.get(d) ?? empty()),
        internal: {
          ...usageView(dailyInternal.get(d) ?? empty()),
          ...tallied(`internal|${d}`),
        },
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
    const unpricedModels = [
      ...new Set(
        [...byModel, ...gatewayByModel]
          .filter(([id, tally]) => id && !usageView(tally).priced)
          .map(([id]) => id),
      ),
    ].sort();
    const totalsView = usageView(totals);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      priced: totalsView.priced,
      totals: {
        ...totalsView,
        unpricedModels,
        ...tallied(''),
        ...sources(genkiTotals, gatewayTotals),
      },
      daily: days,
      byService: rows(byService, 'service').map((r) => ({
        ...r,
        usage: { ...r.usage, ...tallied(`service|${r.service}`) },
        latency: latencyOf(durations.get(r.service) ?? []),
        ...(titles.has(r.service) ? { title: titles.get(r.service) } : {}),
      })),
      byModel: withGateway
        ? [
            ...rows(byModel, 'model').map((r) => ({ ...r, source: genkiSource })),
            ...rows(gatewayByModel, 'model').map((r) => ({ ...r, source: gatewaySource })),
          ]
        : rows(byModel, 'model'),
      ...(withGateway
        ? {
            bySubject: [...bySubject.values()]
              .sort((a, b) => b.tally.inputTokens - a.tally.inputTokens)
              .map((entry) => ({
                subject: entry.subject ?? null,
                usage: usageView(entry.tally),
                cost: entry.cost,
                rate: entry.rate?.nokPerUnit ?? null,
                rateDay: entry.rate?.day ?? null,
              })),
          }
        : {}),
      byProject: rows(byProject, 'project').map((r) => ({
        ...r,
        usage: { ...r.usage, ...tallied(`project|${r.project}`) },
        name: projectNames.get(r.project) ?? r.project,
      })),
      byEnvironment: rows(byEnvironment, 'environment').map((r) => ({
        ...r,
        usage: { ...r.usage, ...tallied(`environment|${r.environment}`) },
      })),
      ...(project === undefined ? {} : { project }),
      ...(environment === undefined ? {} : { environment }),
      ingestion: { usage: usageView(ingestion), byDataset: rows(byDataset, 'dataset') },
      testing: { usage: usageView(testing), byOrigin: rows(byOrigin, 'origin') },
      internal: { usage: { ...usageView(internal), ...tallied('internal') } },
    };
  };

  const monthlyUsage = new Map<
    string,
    { at: number; totals: Promise<ReturnType<typeof usageView>> }
  >();
  const monthlyUsageTtlMs = 30_000;
  const monthlyUsageKey = (tenant: string, from: Date) =>
    `${hidesInternalServices()}:${tenant}:${from.toISOString()}`;
  const freshMonthTotals = (tenant: string, from: Date, to: Date) => {
    const cached = monthlyUsage.get(monthlyUsageKey(tenant, from));
    return cached && to.getTime() - cached.at < monthlyUsageTtlMs ? cached.totals : undefined;
  };
  const monthTotals = (
    tenant: string,
    from: Date,
    to: Date,
    preloaded?: Promise<GatewayWindow>,
  ) => {
    const cached = freshMonthTotals(tenant, from, to);
    if (cached) return cached;
    const key = monthlyUsageKey(tenant, from);
    const totals = usageOver(tenant, from, to, undefined, preloaded).then((u) => u.totals);
    monthlyUsage.set(key, { at: to.getTime(), totals });
    totals.catch(() => {
      if (monthlyUsage.get(key)?.totals === totals) monthlyUsage.delete(key);
    });
    return totals;
  };

  app.get('/tenants/:tenant/overview', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const start = now();
    const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const dayAgo = new Date(start.getTime() - 86_400_000).toISOString();
    const weekAgo = new Date(start.getTime() - weekMs).toISOString();
    const monthStart = month.toISOString();
    const seesUsage = requireRight(g.principal, g.tenant, 'view-usage').ok;
    const windowRead = timedStep('tasks', () =>
      tasksSince(g.tenant, monthStart < weekAgo ? monthStart : weekAgo, true),
    );
    const [window, caps, summaries, latest, usage, connections, qualityWarnings] =
      await Promise.all([
        windowRead,
        capabilitiesOf(g.tenant),
        timedStep('services', () => serviceSummaries(g.tenant)),
        windowRead.then((found) =>
          found.length >= 5 ? found.slice() : tasksSince(g.tenant, undefined, true),
        ),
        seesUsage ? timedStep('usage', () => monthTotals(g.tenant, month, start)) : undefined,
        timedStep('connections', () => deps.connections.list(g.tenant)),
        timedStep('qualityWarnings', async () => deps.qualityWarnings?.(g.tenant)),
      ]);
    const services = summaries.map((s) => ({
      id: s.id,
      name: s.name,
      latestVersion: s.latestVersion,
      status: s.status,
      statusReason: s.statusReason,
      warnings: s.warnings,
      runsThisWeek: s.runsThisWeek,
    }));
    const recent = latest.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    const recentUsage = seesUsage
      ? await timedStep('recentUsage', () => usageByTask(recent.map((t) => t.id)))
      : undefined;
    return c.json({
      services,
      recentTasks: recent.map((t) =>
        recentUsage ? taskRow(caps, t, recentUsage.get(t.id)) : taskBase(caps, t),
      ),
      ...(usage ? { usageThisMonth: usage } : {}),
      qualityWarnings: qualityWarnings ?? [],
      review: {
        pendingToolChanges: connections.reduce((n, s) => n + s.pending.length, 0),
        failedTasksLastDay: window.filter((t) => t.createdAt >= dayAgo && t.status === 'failed')
          .length,
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
      languages?: string[];
      guardrails?: { language?: { mode?: string } };
      settings?: Record<string, unknown>;
    };
    const retention = deps.retentionOf?.(cap);
    const cost = spec.model?.primary
      ? await costPerThousandRuns(cap, spec.model.primary)
      : undefined;
    return {
      tenant: cap.service.tenant,
      id: cap.service.id,
      name: cap.serviceName ?? cap.capability.descriptor.title,
      purpose: spec.purpose ?? cap.capability.descriptor.description,
      version: found?.version ?? null,
      riskClass: spec.riskClass ?? null,
      residency: spec.model?.residency ?? null,
      dataLocation: found ? dataLocationOf(found.definition) : null,
      model: spec.model?.primary ?? null,
      exposure: Object.entries(spec.exposure ?? {})
        .filter(([, on]) => on)
        .map(([k]) => k),
      ...(retention ? { storage: { keepsText: true, logDays: retention.payloadDays } } : {}),
      languages: { in: spec.languages ?? ['nb', 'en'], out: answerLanguageOf(spec) },
      ...(cost ? { estimatedCostPerThousandRuns: cost } : {}),
      variants: [] as unknown[],
    };
  };

  const answerLanguageOf = (spec: {
    guardrails?: { language?: { mode?: string } };
    settings?: Record<string, unknown>;
  }) => {
    const mode = spec.guardrails?.language?.mode;
    if (mode) return mode;
    const standard = spec.settings?.['answers.writtenStandard'];
    return standard === 'bokmal' ? 'nb' : standard === 'nynorsk' ? 'nn' : 'same';
  };

  const recentOwnerRuns = new Map<string, { at: number; runs: Promise<(Task | undefined)[]> }>();
  const ownerRuns = (owner: string) => {
    const cached = recentOwnerRuns.get(owner);
    if (cached && now().getTime() - cached.at < 60_000) return cached.runs;
    const since = new Date(now().getTime() - 30 * 86_400_000).toISOString();
    const runs = deps.taskEnvelopes
      ? deps.taskEnvelopes(owner, { since, limit: 1000 })
      : Promise.resolve(deps.tasks(owner)).then((rows) =>
          Promise.all(rows.filter((r) => r.at >= since).map((r) => deps.task(r.task))),
        );
    recentOwnerRuns.set(owner, { at: now().getTime(), runs });
    runs.catch(() => recentOwnerRuns.delete(owner));
    return runs;
  };

  const minRunsForCostEstimate = 20;
  const twoSignificantDigits = (value: number) =>
    value <= 0 ? 0 : Math.round(Number(value.toPrecision(2)));

  const costPerThousandRuns = async (cap: CompiledCapability, model: string) => {
    const price = deps.prices?.[model];
    if (!price) return undefined;
    const runs = (await ownerRuns(cap.service.tenant)).filter(
      (t): t is Task =>
        t !== undefined &&
        t.status === 'completed' &&
        t.service.capability.id.replace(/@\d+$/, '') === cap.capability.descriptor.id,
    );
    if (runs.length < minRunsForCostEstimate) return undefined;
    const total = runs.reduce((sum, t) => sum + priced(t.usage, price), 0);
    return {
      microNok: twoSignificantDigits((total / runs.length) * 1000),
      basis: t('services.costBasisRecentRuns'),
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
    const keys = await keyViews(await withoutHiddenServiceKeys(g.tenant), {
      principal: g.principal,
      tenant: g.tenant,
      ...(deps.names ? { names: deps.names } : {}),
      ...(deps.lockdown ? { lockdown: deps.lockdown } : {}),
    });
    return c.json({
      services,
      keys,
      testRunnerKeys:
        deps.testRunnerKeys === true &&
        mayGiveTestRunnerKeys(g.principal, deps.isOperator) &&
        g.principal.kind !== 'operator' &&
        g.principal.tenant === g.tenant,
    });
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
    const tenant = c.req.param('tenant') ?? '';
    if (principal.kind === 'operator') {
      // An operator who is also one of the organisation's own people (a trusted
      // Entra login in its platform organisation, ADR 0033) acts as that person.
      const acting = access(principal, tenant, c.req.raw);
      if (!acting) return problem(c, 404, 'Not found');
      if (acting.kind === 'operator')
        return problem(c, 403, 'API-nøkler lages av virksomheten selv');
    }
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
      testRunner?: unknown;
    };
    if (body.testRunner === true) {
      const member = await guard(c, 'manage-services');
      if (member instanceof Response) return member;
      const refused = testRunnerRefusal(
        c,
        deps.testRunnerKeys === true,
        member.principal,
        deps.isOperator,
      );
      if (refused) return refused;
      const limits = testRunnerLimitErrors(body.expiresInDays, body.callsPerMinute);
      if (limits.length > 0) return problem(c, 400, 'Invalid request', limits);
    }
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
      ...(body.testRunner === true ? { testRunner: true } : {}),
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
    const uncached = tenants.filter((orgNumber) => !freshMonthTotals(orgNumber, from, to));
    const gatewayRows =
      deps.gatewayUsage && uncached.length > 0 ? gatewayWindow(uncached, from, to) : undefined;
    gatewayRows?.catch(() => undefined);
    const data = await Promise.all(
      tenants.map(async (orgNumber) => {
        const own = uncached.includes(orgNumber)
          ? gatewayRows?.then((w) => ({
              rows: w.rows.filter((r) => r.tenant === orgNumber),
              rates: w.rates,
            }))
          : undefined;
        return { orgNumber, usage: await monthTotals(orgNumber, from, to, own) };
      }),
    );
    return c.json({ from: from.toISOString(), to: to.toISOString(), data });
  });

  app.get('/operator/usage/unassigned', async (c) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind !== 'operator')
      return problem(c, 403, 'Only operators read unassigned usage');
    const to = now();
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    const data = deps.gatewayUsage
      ? await deps.gatewayUsage.unassignedRows(from, new Date(to.getTime() + 1))
      : [];
    return c.json({ from: from.toISOString(), to: to.toISOString(), data });
  });

  app.get('/tenants/:tenant/usage', async (c) => {
    const g = await guard(c, 'view-usage');
    if (g instanceof Response) return g;
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 366);
    const to = now();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    const project = c.req.query('project')?.trim() || undefined;
    const environment = c.req.query('environment')?.trim() || undefined;
    const [usage, quota] = await Promise.all([
      usageOver(g.tenant, new Date(day(from.toISOString())), to, project, undefined, environment),
      deps.quota?.(g.tenant),
    ]);
    return c.json({ ...usage, ...(quota ? { quota: quotaView(quota) } : {}) });
  });

  app.get('/tenants/:tenant/tasks', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const caps = await capabilitiesOf(g.tenant);
    const status = c.req.query('status');
    const service = c.req.query('service');
    const environment = c.req.query('environment');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
    const offset = Math.min(
      Math.max(Math.trunc(Number(c.req.query('offset') ?? 0)) || 0, 0),
      100_000,
    );
    const needle = c.req.query('q')?.trim().toLowerCase().slice(0, 200) || undefined;
    const actor = c.req.query('actor')?.trim() || undefined;
    if (actor !== undefined && (actor.length > 300 || !/^(me$|employee:|api-key:)/.test(actor)))
      return problem(c, 400, 'Invalid request', [
        { path: 'actor', message: 'actor is me, or an actor id from a run row' },
      ]);
    const frontend = c.req.query('frontend')?.trim() || undefined;
    if (frontend !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(frontend))
      return problem(c, 400, 'Invalid request', [
        { path: 'frontend', message: 'frontend is the id of a registered frontend' },
      ]);
    const byFrontend = (t: Task | undefined) =>
      !frontend || (t !== undefined && frontendOf(t, g.tenant) === frontend);
    const byActor = (t: Task | undefined) =>
      !actor ||
      (t !== undefined &&
        (actor === 'me'
          ? startedByCaller(t, g.principal, g.tenant)
          : actorIdOf(t, g.tenant) === actor));
    const keep = (row: PortalTaskRow) =>
      (!status || row.status === status) && (!from || row.at >= from);
    const tasks = await timedStep('tasks', () =>
      c.req.query('origin') === 'playground'
        ? playgroundRuns(g.tenant, keep)
        : tenantTasks(g.tenant, keep),
    );
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const rows = tasks
      .map((t) => taskBase(caps, t))
      .filter((r) => !status || r.status === status)
      .filter((r) => !service || r.service === service)
      .filter((r) => !environment || r.environment === environment)
      .filter((r) => !from || r.createdAt >= from)
      .filter((r) => !to || r.createdAt <= to)
      .filter((r) => byActor(byId.get(r.id)))
      .filter((r) => byFrontend(byId.get(r.id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const matching = needle
      ? await searchTasks(
          g.tenant,
          rows.slice(0, taskSearchWindow).map((r) => byId.get(r.id) as Task),
          needle,
          requireRight(g.principal, g.tenant, 'manage-services').ok,
        )
      : rows;
    const shown = matching.slice(offset, offset + limit).map((r) => byId.get(r.id) as Task);
    const [views, failures] = await timedStep('views', () =>
      Promise.all([
        taskViews(
          g.tenant,
          caps,
          shown,
          requireRight(g.principal, g.tenant, 'manage-services').ok,
          requireRight(g.principal, g.tenant, 'view-usage').ok,
        ),
        failuresOf(shown.filter((t) => t.status === 'failed').map((t) => t.id)),
      ]),
    );
    const data = views.map((view) => {
      const failure = failures.get(view.id);
      return failure ? { ...view, failure } : view;
    });
    return c.json({
      data,
      total: matching.length,
      offset,
      limit,
      ...(needle ? { q: needle, searched: Math.min(rows.length, taskSearchWindow) } : {}),
    });
  });

  app.get('/tenants/:tenant/service-failures', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const asked = c.req.query('from');
    const from = asked && !Number.isNaN(Date.parse(asked)) ? new Date(asked) : osloMidnight(now());
    const since = from.toISOString();
    const caps = await capabilitiesOf(g.tenant);
    const failedTasks = (
      await tenantTasks(g.tenant, (row) => row.status === 'failed' && row.at >= since)
    ).filter((t) => t.status === 'failed' && t.createdAt >= since);
    const failures = await failuresOf(failedTasks.map((t) => t.id));
    const byService = new Map<string, Map<string, { reason: string; count: number }>>();
    const failedBy = new Map<string, number>();
    for (const t of failedTasks) {
      const service = serviceOf(caps, t.service.capability.id);
      failedBy.set(service, (failedBy.get(service) ?? 0) + 1);
      const failure = failures.get(t.id);
      const code = failure?.code ?? 'unknown';
      const causes = byService.get(service) ?? new Map<string, { reason: string; count: number }>();
      const known = causes.get(code);
      causes.set(code, {
        reason: known?.reason ?? failure?.reason ?? '',
        count: (known?.count ?? 0) + 1,
      });
      byService.set(service, causes);
    }
    const data = [...byService]
      .map(([service, causes]) => ({
        service,
        failed: failedBy.get(service) ?? 0,
        causes: [...causes]
          .map(([code, cause]) => ({ code, reason: cause.reason, count: cause.count }))
          .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      }))
      .sort((a, b) => b.failed - a.failed || a.service.localeCompare(b.service));
    return c.json({ from: since, data });
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
    const failures = await failuresOf(own.filter((t) => t.status === 'failed').map((t) => t.id));
    const data = own.map((t) => {
      const failure = failures.get(t.id);
      const title = caps.find((x) => x.capability.descriptor.id === t.service.capability.id)
        ?.capability.descriptor.title;
      return {
        ...taskBase(caps, t),
        ...(title ? { serviceName: title } : {}),
        ...(failure ? { failure } : {}),
      };
    });
    return c.json({ data });
  });

  app.get('/tenants/:tenant/tasks/:task', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const found = await deps.task(c.req.param('task') ?? '');
    if (
      !found ||
      (found.tenant !== g.tenant && found.owner !== g.tenant) ||
      ![serviceOrigin, ...trialOrigins].includes(originOf(found.service.capability.id))
    )
      return problem(c, 404, 'Not found');
    const [[view], failures] = await Promise.all([
      taskViews(
        g.tenant,
        await capabilitiesOf(g.tenant),
        [found],
        requireRight(g.principal, g.tenant, 'manage-services').ok,
        requireRight(g.principal, g.tenant, 'view-usage').ok,
      ),
      failuresOf(found.status === 'failed' ? [found.id] : []),
    ]);
    const failure = failures.get(found.id);
    return c.json(view && failure ? { ...view, failure } : view);
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
      files: fileInputOf(body.definition),
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
      origin: 'trial',
      input: form ?? {},
      ...(typeof body?.variant === 'string' ? { variant: body.variant } : {}),
    });
    if (result.task) c.header('genai-task', result.task);
    if (!result.ok && result.status === 400)
      return c.json(invalidInputProblem(result.errors), 400, {
        'content-type': 'application/problem+json',
      });
    if (!result.ok && result.quota) return quotaExhausted(c, result.quota);
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

  registerOperatorTenantRoutes(app, {
    authenticate: deps.authenticate,
    now,
    startOfToday: () => osloMidnight(now()),
    ...(deps.directory ? { directory: deps.directory } : {}),
    ...(deps.inbox ? { inbox: deps.inbox } : {}),
    ...(deps.quota ? { quota: deps.quota } : {}),
    monthCost: async (tenant, from, to) => {
      const totals = await monthTotals(tenant, from, to);
      return { costMicroNok: totals.costMicroNok, priced: totals.priced };
    },
    services: async (tenant) => {
      const services = (await deps.definitions.list(tenant)).filter((d) => d.kind === 'Service');
      const hidden = await Promise.all(
        services.map((d) => isHiddenService(deps.definitions, tenant, d.id)),
      );
      const listed = services.filter((_, i) => !hidden[i]);
      const states = await Promise.all(
        listed.map(async (d) => (await deps.lifecycle?.(tenant, d.id))?.state ?? 'active'),
      );
      const kept = states.filter((state) => state !== 'archived');
      return { total: kept.length, inUse: kept.filter((state) => state !== 'paused').length };
    },
    failedSince: async (tenant, since) =>
      (await tasksSince(tenant, since, true)).filter(
        (t) => t.status === 'failed' && (t.owner ?? t.tenant) === tenant,
      ),
    failures: failuresOf,
    serviceOf: async (tenant, task) => {
      const caps = await capabilitiesOf(tenant);
      const id = serviceOf(caps, task.service.capability.id);
      const found = caps.find((cap) => cap.service.id === id);
      return { id, name: found?.serviceName ?? found?.capability.descriptor.title ?? id };
    },
    audit: (tenant) => deps.admin.audit(tenant),
    namesOf: async (actors) => (await deps.names?.namesOf(actors)) ?? new Map(),
  });
};
