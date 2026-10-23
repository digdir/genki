import type { Event, Part, Principal } from '@genai/contracts';
import { defaultPlatformTenant } from '@genai/composition';
import {
  checkPromptFiles,
  importTenant,
  validateDefinition,
  type DefinitionStore,
  type ImportPlanItem,
  type PluginSchemas,
  type PromptFiles,
  SettingsConflictError,
  type PublishedVersion,
  type SettingsRegistry,
  type ValidationError,
} from '@genai/definitions';
import {
  createKernel,
  KernelError,
  type Capability,
  type EventLog,
  type Kernel,
  type Strategy,
  type TaskStore,
} from '@genai/kernel';
import type { Context } from 'hono';
import { refusedAction, type RightProblem } from './rights.js';
import { serviceHealth, type ServiceModels } from './service-health.js';

export const platformActions = [
  'platform.service.publish',
  'platform.setting.set',
  'platform.setting.pin',
  'platform.default.set',
  'platform.tenant.import',
  'platform.support.open',
  'platform.models.refresh',
  'platform.models.classify',
] as const;

export type PlatformAction = (typeof platformActions)[number];

export interface SupportSession {
  id: string;
  operator: string;
  operatorName?: string;
  tenant: string;
  reason: string;
  openedAt: string;
  expiresAt: string;
  endedAt?: string;
}

export interface AuditEntry {
  task: string;
  tenant: string;
  action: string;
  actor: string;
  onBehalfOf?: string;
  at: string;
  outcome: 'applied' | 'rejected';
  target: string;
  reason: string;
}

export interface AdminRecordStore {
  sessions(): SupportSession[];
  saveSession(session: SupportSession): Promise<void>;
  audit(tenant?: string): Promise<AuditEntry[]>;
  appendAudit(entry: AuditEntry): Promise<void>;
}

export class InMemoryAdminRecords implements AdminRecordStore {
  readonly #sessions = new Map<string, SupportSession>();
  readonly #audit: AuditEntry[] = [];

  sessions() {
    return [...this.#sessions.values()].map((s) => structuredClone(s));
  }

  async saveSession(session: SupportSession) {
    this.#sessions.set(session.id, structuredClone(session));
  }

  async audit(tenant?: string) {
    return this.#audit
      .filter((a) => tenant === undefined || a.tenant === tenant)
      .map((a) => structuredClone(a));
  }

  async appendAudit(entry: AuditEntry) {
    this.#audit.push(structuredClone(entry));
  }
}

export interface ModelSummary {
  id: string;
  residency: string;
  capabilities: string[];
  enabled: boolean;
  price?: { inputPerThousand: number; outputPerThousand: number } | null;
  parameters?: Record<string, unknown>;
  rejectedParameters?: Record<string, string>;
  transport?: { api: string; source: 'configured' | 'learned' | 'default' };
  services?: Record<string, unknown>[];
}

export interface ModelAdmin {
  describe(): ModelSummary[];
  refresh(): Promise<{ discovered: number; failed: { endpoint: string; error: string }[] }>;
  classify(
    id: string,
    classification: {
      residency?: string;
      capabilities?: string[];
      enabled?: boolean;
      parameters?: Record<string, unknown>;
    },
  ): Promise<ModelSummary>;
}

export type AdminResult<T> =
  | { ok: true; value: T; task: string }
  | {
      ok: false;
      errors: ValidationError[];
      task: string;
      conflict?: true;
      problem?: RightProblem;
    };

export const settingsConflictMessage =
  'Innstillingene ble endret et annet sted. Last inn på nytt og prøv igjen.';

export interface AdminOptions {
  store: DefinitionStore;
  plugins: PluginSchemas;
  settings: SettingsRegistry;
  platformTenant?: string;
  log?: EventLog;
  tasks?: TaskStore;
  now?: () => Date;
  newId?: () => string;
  maxSupportMinutes?: number;
  models?: ModelAdmin;
  extensions?: Record<string, AdminHandler>;
  records?: AdminRecordStore;
  tenants?: () => Promise<{ orgNumber: string; name: string }[]>;
}

export type AdminOutcome = Outcome;

export type AdminHandler = (input: ActionInput, principal: Principal) => Promise<Outcome>;

type Outcome = (
  | { ok: true; value: unknown; target: string }
  | {
      ok: false;
      errors: ValidationError[];
      target: string;
      conflict?: true;
      problem?: RightProblem;
    }
) & { audit?: Record<string, unknown> };

export interface ActionInput {
  reason: string;
  tenant: string;
  [key: string]: unknown;
}

export const actorOf = (principal: Principal) =>
  principal.kind === 'workload' && principal.issuer === 'platform'
    ? `platform:${principal.subject}`
    : `${principal.kind}:${principal.issuer}:${principal.subject}`;

export const platformActor = (subject: string, tenant: string): Principal => ({
  kind: 'workload',
  issuer: 'platform',
  subject,
  tenant,
});

export type AdminWork<T> = () => Promise<{
  value: T;
  target: string;
  audit?: Record<string, unknown>;
}>;

export const routeOnly: AdminHandler = async () => ({
  ok: false,
  errors: [{ path: 'action', message: 'this action runs only from its own route' }],
  target: 'action',
});

export const routeOnlyActions = (actions: readonly string[]): Record<string, AdminHandler> =>
  Object.fromEntries(actions.map((action) => [action, routeOnly]));

export class AdminRefused extends Error {
  constructor(
    readonly errors: ValidationError[],
    readonly task: string,
    readonly problem?: RightProblem,
  ) {
    super(errors[0]?.message ?? 'refused');
  }

  get status() {
    return this.problem || this.errors.some((e) => e.path === 'principal') ? 403 : 400;
  }
}

export const refusedBy = (c: Context, error: AdminRefused) =>
  c.json(
    {
      type: 'about:blank',
      title: error.problem?.title ?? error.message,
      status: error.status,
      errors: error.errors,
    },
    error.status,
    { 'content-type': 'application/problem+json' },
  );

const asJson = (value: unknown): Part => ({
  mime: 'application/json',
  body: { kind: 'json', json: value },
});

export const createAdmin = (options: AdminOptions) => {
  const { store, plugins, settings } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const platformTenant = options.platformTenant ?? defaultPlatformTenant;
  const maxSupportMinutes = options.maxSupportMinutes ?? 240;
  const records = options.records ?? new InMemoryAdminRecords();
  const pending = new Map<
    string,
    {
      work?: AdminWork<unknown>;
      then?: (value: unknown) => Promise<void>;
      value?: unknown;
      failed?: { error: unknown };
    }
  >();

  const check = (definition: unknown, files: PromptFiles): ValidationError[] => {
    const validated = validateDefinition(definition, plugins);
    return validated.ok ? checkPromptFiles(validated.definition, files) : validated.errors;
  };

  const platformWide = {
    scope: 'platform',
    supportSession: 'not required: models are platform-wide, not tenant data',
  };
  const notOperator = (principal: Principal, target: string): Outcome | undefined =>
    principal.kind === 'operator'
      ? undefined
      : {
          ok: false,
          errors: [{ path: 'principal', message: 'only operators change models' }],
          target,
          audit: platformWide,
        };
  const modelsOrFail = () => {
    if (!options.models) throw new Error('model administration is not configured');
    return options.models;
  };

  const flushTenant = async (target: string): Promise<Outcome | undefined> => {
    try {
      await settings.flush();
      return undefined;
    } catch (error) {
      if (!(error instanceof SettingsConflictError)) throw error;
      return {
        ok: false,
        errors: [{ path: '', message: settingsConflictMessage }],
        target,
        conflict: true,
      };
    }
  };

  const handlers: Record<
    PlatformAction,
    (input: ActionInput, principal: Principal) => Promise<Outcome>
  > = {
    'platform.service.publish': async (input, principal) => {
      const files = (input.files ?? {}) as PromptFiles;
      const result = await store.publish(input.definition, actorOf(principal), input.reason, files);
      if (!result.ok) return { ok: false, errors: result.errors, target: 'definition' };
      const { kind, metadata } = result.version.definition;
      return {
        ok: true,
        value: result.version,
        target: `${kind}:${metadata.id}@${result.version.version}`,
      };
    },
    'platform.setting.set': async (input) => {
      const key = String(input.key);
      const result = settings.setTenant(input.tenant, key, input.value);
      const conflict = await flushTenant(`setting:${key}`);
      if (conflict) return conflict;
      return result.ok
        ? { ok: true, value: settings.tenant(input.tenant), target: `setting:${key}` }
        : { ...result, target: `setting:${key}` };
    },
    'platform.setting.pin': async (input) => {
      const key = String(input.key);
      const result = settings.pin(input.tenant, key, (input.version ?? null) as number | null);
      const conflict = await flushTenant(`pin:${key}`);
      if (conflict) return conflict;
      return result.ok
        ? { ok: true, value: settings.tenant(input.tenant), target: `pin:${key}` }
        : { ...result, target: `pin:${key}` };
    },
    'platform.default.set': async (input, principal) => {
      const key = String(input.key);
      const result = settings.setDefault(key, input.value, actorOf(principal), input.reason);
      await settings.flush();
      return result.ok
        ? { ok: true, value: result.value, target: `default:${key}@${result.value.version}` }
        : { ...result, target: `default:${key}` };
    },
    'platform.tenant.import': async (input, principal) => {
      const result = await importTenant(input.bundle, store, settings, {
        tenant: input.tenant,
        dryRun: false,
        onConflict: input.onConflict === 'overwrite' ? 'overwrite' : 'skip',
        actor: actorOf(principal),
        reason: input.reason,
        check,
      });
      const conflict = await flushTenant(`tenant:${input.tenant}`);
      if (conflict) return conflict;
      return result.ok
        ? { ok: true, value: result.plan, target: `tenant:${input.tenant}` }
        : { ok: false, errors: result.errors, target: `tenant:${input.tenant}` };
    },
    'platform.support.open': async (input, principal) => {
      const minutes = Number(input.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxSupportMinutes)
        return {
          ok: false,
          errors: [{ path: 'minutes', message: `1 to ${maxSupportMinutes} minutes` }],
          target: 'support',
        };
      const opened = now();
      const session: SupportSession = {
        id: newId(),
        operator: actorOf(principal.actor ?? principal),
        ...(typeof input.operatorName === 'string' && input.operatorName
          ? { operatorName: input.operatorName }
          : {}),
        tenant: input.tenant,
        reason: input.reason,
        openedAt: opened.toISOString(),
        expiresAt: new Date(opened.getTime() + minutes * 60_000).toISOString(),
      };
      await records.saveSession(session);
      return { ok: true, value: session, target: `support:${session.id}` };
    },
    'platform.models.refresh': async (_input, principal) => {
      const refused = notOperator(principal, 'models');
      if (refused) return refused;
      const models = modelsOrFail();
      const before = models.describe().map((m) => m.id);
      const result = await models.refresh();
      const after = models.describe().map((m) => m.id);
      return {
        ok: true,
        value: result,
        target: 'models',
        audit: {
          ...platformWide,
          before: { models: before },
          after: { models: after },
          result,
        },
      };
    },
    'platform.models.classify': async (input, principal) => {
      const id = String(input.id);
      const target = `model:${id}`;
      const refused = notOperator(principal, target);
      if (refused) return refused;
      const models = modelsOrFail();
      const before = models.describe().find((m) => m.id === id);
      if (!before)
        return {
          ok: false,
          errors: [{ path: 'id', message: `no model ${id}` }],
          target,
          audit: platformWide,
        };
      const after = await models.classify(
        id,
        input.classification as Parameters<ModelAdmin['classify']>[1],
      );
      const states = models.describe();
      const services = new Map<string, Record<string, unknown>>();
      for (const c of await store.capabilities()) {
        const model = (c.capability.config as { model?: ServiceModels } | undefined)?.model;
        const uses = [model?.primary, model?.fallback, ...Object.values(model?.roles ?? {})];
        if (!uses.includes(id)) continue;
        const health = serviceHealth(model, states);
        services.set(`${c.service.tenant}/${c.service.id}`, {
          tenant: c.service.tenant,
          id: c.service.id,
          primary: model?.primary === id,
          status: health.status,
          reason: health.reason ?? null,
          warnings: health.warnings,
        });
      }
      return {
        ok: true,
        value: { ...after, services: [...services.values()] },
        target,
        audit: {
          ...platformWide,
          before: {
            residency: before.residency,
            capabilities: before.capabilities,
            enabled: before.enabled,
            parameters: before.parameters ?? {},
          },
          after: {
            residency: after.residency,
            capabilities: after.capabilities,
            enabled: after.enabled,
            parameters: after.parameters ?? {},
          },
        },
      };
    },
  };

  const extensions = options.extensions ?? {};
  const allHandlers: Record<string, AdminHandler> = { ...extensions, ...handlers };
  const allActions = [...platformActions, ...Object.keys(extensions)];

  const guarded = (
    action: string,
    data: ActionInput,
    principal: Principal,
  ): Outcome | undefined => {
    const refusal = refusedAction(principal, action, data.tenant || (principal.tenant ?? ''), data);
    if (!refusal) return undefined;
    if (refusal.kind === 'operator')
      return {
        ok: false,
        errors: [{ path: 'principal', message: 'only operators do this' }],
        target: action,
      };
    return {
      ok: false,
      errors: [
        { path: 'principal', message: refusal.problem.title },
        { path: 'right', message: refusal.right },
      ],
      target: action,
      problem: refusal.problem,
    };
  };

  const inTask =
    (call: NonNullable<ReturnType<typeof pending.get>>, action: string): AdminHandler =>
    async () => {
      try {
        if (!call.work) throw new Error(`no work for ${action}`);
        const done = await call.work();
        call.value = done.value;
        return {
          ok: true,
          value: null,
          target: done.target,
          ...(done.audit ? { audit: done.audit } : {}),
        };
      } catch (error) {
        call.failed = { error };
        return {
          ok: false,
          errors: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
          target: action,
        };
      }
    };

  const strategy: Strategy<{ action: string }> = {
    id: 'platform-admin',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx, input, config) {
      const data = input.data as ActionInput;
      const call = typeof data.call === 'string' ? pending.get(data.call) : undefined;
      const handler = call?.work ? inTask(call, config.action) : allHandlers[config.action];
      if (!handler) throw new Error(`no admin action ${config.action}`);
      let outcome =
        guarded(config.action, data, ctx.principal) ?? (await handler(data, ctx.principal));
      if (call?.then && outcome.ok)
        try {
          await call.then(outcome.value);
        } catch (error) {
          call.failed = { error };
          outcome = {
            ok: false,
            errors: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
            target: outcome.target,
          };
        }
      yield {
        type: outcome.ok ? 'x.platform.change' : 'x.platform.rejected',
        audience: 'audit',
        data: {
          action: config.action,
          tenant: ctx.tenant,
          target: outcome.target,
          reason: data.reason,
          ...(outcome.ok ? {} : { errors: outcome.errors }),
          ...outcome.audit,
        },
      };
      yield {
        type: 'kernel.result',
        data: [
          asJson(
            outcome.ok
              ? { ok: true, value: outcome.value, target: outcome.target }
              : {
                  ok: false,
                  target: outcome.target,
                  errors: outcome.errors,
                  ...(outcome.conflict ? { conflict: true } : {}),
                  ...(outcome.problem ? { problem: outcome.problem } : {}),
                },
          ),
        ],
      };
    },
  };

  const capabilities: Capability[] = allActions.map((action) => ({
    descriptor: {
      id: action,
      version: '1',
      tenant: platformTenant,
      availableTo: '*',
      title: action,
      description: `Platform administration: ${action}`,
      input: {},
      interaction: ['unary'],
      accepts: ['application/json'],
      produces: ['application/json'],
      emits: ['x.platform.change', 'x.platform.rejected'],
      oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: '' },
    },
    strategy: { id: 'platform-admin', version: '1' },
    config: { action },
    grants: [],
  }));

  const kernel: Kernel = createKernel({
    strategies: [strategy as Strategy],
    capabilities,
    ports: {},
    policy: {
      decide: async (principal, action, resource) => {
        if (action !== 'invoke') return { allow: true };
        if (resource.id === 'platform.default.set' && principal.kind !== 'operator')
          return { allow: false, reason: 'only operators change platform defaults' };
        return { allow: true };
      },
    },
    ...(options.log ? { log: options.log } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    now,
    newId,
  });

  const run = async <T>(
    principal: Principal,
    action: string,
    data: ActionInput,
  ): Promise<AdminResult<T>> => {
    const started = await kernel.invoke(principal, action, { data });
    const parts = await started.result;
    const body = parts[0]?.body;
    const result = (body?.kind === 'json' ? body.json : { ok: false, errors: [] }) as
      | { ok: true; value: T; target?: string }
      | {
          ok: false;
          errors: ValidationError[];
          conflict?: true;
          problem?: RightProblem;
          target?: string;
        };
    const actor = principal.actor ?? principal;
    await records.appendAudit({
      task: started.task,
      tenant: principal.tenant ?? platformTenant,
      action,
      actor: actorOf(actor),
      ...(principal.actor ? { onBehalfOf: principal.tenant } : {}),
      at: now().toISOString(),
      outcome: result.ok ? 'applied' : 'rejected',
      target: result.target || action,
      reason: data.reason,
    });
    return { ...result, task: started.task };
  };

  const within = async <T>(
    principal: Principal,
    action: string,
    data: ActionInput,
    work: AdminWork<T>,
  ): Promise<{ value: T; task: string }> => {
    const call = crypto.randomUUID();
    const entry: NonNullable<ReturnType<typeof pending.get>> = { work };
    pending.set(call, entry);
    try {
      const result = await run<T>(principal, action, { ...data, call });
      if (entry.failed) throw entry.failed.error;
      if (!result.ok) throw new AdminRefused(result.errors, result.task, result.problem);
      return { value: entry.value as T, task: result.task };
    } finally {
      pending.delete(call);
    }
  };

  const performThen = async <T>(
    principal: Principal,
    action: string,
    data: ActionInput,
    then: (value: T) => Promise<void>,
  ): Promise<AdminResult<T>> => {
    const call = crypto.randomUUID();
    const entry: NonNullable<ReturnType<typeof pending.get>> = {
      then: then as (value: unknown) => Promise<void>,
    };
    pending.set(call, entry);
    try {
      const result = await run<T>(principal, action, { ...data, call });
      if (entry.failed) throw entry.failed.error;
      return result;
    } finally {
      pending.delete(call);
    }
  };

  const supportSession = (id: string | undefined, operator: Principal, tenant: string) => {
    if (!id) return undefined;
    const session = records.sessions().find((s) => s.id === id);
    if (
      !session ||
      session.endedAt ||
      session.tenant !== tenant ||
      session.operator !== actorOf(operator)
    )
      return undefined;
    return new Date(session.expiresAt).getTime() > now().getTime() ? session : undefined;
  };

  const auditReader: Principal = { kind: 'operator', issuer: 'platform', subject: 'audit-reader' };

  return {
    kernel,
    perform: <T>(principal: Principal, action: string, data: ActionInput) =>
      run<T>(principal, action, data),
    performThen,
    within,
    publish: (
      principal: Principal,
      input: { definition: unknown; files: PromptFiles; reason: string },
    ) =>
      run<PublishedVersion>(principal, 'platform.service.publish', {
        ...input,
        tenant: principal.tenant ?? '',
      }),
    setTenantSetting: (
      principal: Principal,
      tenant: string,
      key: string,
      value: unknown,
      reason: string,
    ) => run(principal, 'platform.setting.set', { tenant, key, value: value ?? null, reason }),
    pin: (
      principal: Principal,
      tenant: string,
      key: string,
      version: number | null,
      reason: string,
    ) => run(principal, 'platform.setting.pin', { tenant, key, version, reason }),
    setDefault: (principal: Principal, key: string, value: unknown, reason: string) =>
      run(
        principal.tenant ? principal : { ...principal, tenant: platformTenant },
        'platform.default.set',
        {
          tenant: platformTenant,
          key,
          value,
          reason,
        },
      ),
    importTenant: (
      principal: Principal,
      tenant: string,
      bundle: unknown,
      onConflict: string,
      reason: string,
    ) =>
      run<ImportPlanItem[]>(principal, 'platform.tenant.import', {
        tenant,
        bundle,
        onConflict,
        reason,
      }),
    refreshModels: (principal: Principal, reason: string) =>
      run<Awaited<ReturnType<ModelAdmin['refresh']>>>(
        { ...principal, tenant: platformTenant },
        'platform.models.refresh',
        { tenant: platformTenant, reason },
      ),
    classifyModel: (
      principal: Principal,
      id: string,
      classification: Parameters<ModelAdmin['classify']>[1],
      reason: string,
    ) =>
      run<ModelSummary>({ ...principal, tenant: platformTenant }, 'platform.models.classify', {
        tenant: platformTenant,
        id,
        classification,
        reason,
      }),
    openSupportSession: (
      operator: Principal,
      tenant: string,
      reason: string,
      minutes: number,
      operatorName?: string,
    ) =>
      run<SupportSession>({ ...operator, tenant, actor: operator }, 'platform.support.open', {
        tenant,
        reason,
        minutes,
        ...(operatorName ? { operatorName } : {}),
      }),
    supportSession,
    tenantNames: async () =>
      new Map((await (options.tenants?.() ?? [])).map((t) => [t.orgNumber, t.name])),
    supportSessions: () => records.sessions(),
    endSupport: async (id: string, at: Date) => {
      const session = records.sessions().find((s) => s.id === id);
      if (!session) return undefined;
      const ended = { ...session, endedAt: session.endedAt ?? at.toISOString() };
      await records.saveSession(ended);
      return ended;
    },
    extendSupport: async (id: string, minutes: number, at: Date) => {
      const session = records.sessions().find((s) => s.id === id);
      if (!session || session.endedAt || new Date(session.expiresAt) <= at) return undefined;
      const extended = {
        ...session,
        expiresAt: new Date(new Date(session.expiresAt).getTime() + minutes * 60_000).toISOString(),
      };
      await records.saveSession(extended);
      return extended;
    },
    check,
    audit: (tenant?: string) => records.audit(tenant),
    events: async (task: string): Promise<Event[]> => {
      const events: Event[] = [];
      try {
        for await (const e of await kernel.events(auditReader, task, { audience: 'audit' }))
          events.push(e);
      } catch (error) {
        if (error instanceof KernelError && error.code === 'not_found') return [];
        throw error;
      }
      return events;
    },
    task: async (task: string) => {
      try {
        return await kernel.task(auditReader, task);
      } catch (error) {
        if (error instanceof KernelError && error.code === 'not_found') return undefined;
        throw error;
      }
    },
  };
};

export type Admin = ReturnType<typeof createAdmin>;
