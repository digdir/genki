import { t } from './i18n/index.js';
import type { Principal, TaskStatus } from '@genai/contracts';
import {
  anonymousFeedback,
  basicPiiRedactor,
  candidateOrigins,
  candidateView,
  caseView,
  createEvalService,
  EvalError,
  isCaseType,
  proposeTestCase,
  recordFeedback,
  reviewCandidate,
  type CandidateStore,
  type TestCaseCandidate,
  type EvalRunStore,
  type FeedbackStore,
  type TestSetStore,
} from '@genai/eval';
import {
  defaultPlatformTenant,
  sameHosts,
  secretHosts,
  TenantSecretVault,
} from '@genai/composition';

export {
  InMemoryTenantSecrets,
  TenantSecretVault,
  type TenantSecretStore,
} from '@genai/composition';
import { KernelError, type EventLog, type Kernel } from '@genai/kernel';
import {
  RegistrationError,
  secretTargets,
  validateConnection,
  type ConnectionRegistry,
  type ConnectionToolSource,
  toolSyncDeadlineMs,
  type TenantSecrets,
} from '@genai/providers-mcp-client';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant, supportSessionHeader, tenantAccess } from './access.js';
import { adminKeysOnly } from './tenant-gate.js';
import {
  AdminRefused,
  refusedBy,
  routeOnlyActions,
  type Admin,
  type AdminHandler,
  type AdminOutcome,
} from './admin.js';
import { rightRefused, type Right } from './rights.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';

export interface TrackedTask {
  task: string;
  tenant: string;
  status: string;
  at: string;
}

export interface TaskIndex {
  all(tenant?: string): Promise<TrackedTask[]>;
  running(): Promise<TrackedTask[]>;
  tokensUsed?(tenant: string, since: string): Promise<number>;
}

const taskStatuses: readonly TaskStatus[] = [
  'queued',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
];

const active = (t: TrackedTask) => t.status === 'queued' || t.status === 'running';

export const trackTasks = (inner: EventLog): TaskIndex & { log: EventLog } => {
  const tasks = new Map<string, TrackedTask>();
  const log: EventLog = {
    append: async (event, scope) => {
      const stored = await inner.append(event, scope);
      if (event.type === 'kernel.task.status') {
        const status = (event.data as { status?: string }).status ?? 'unknown';
        tasks.set(event.task, { task: event.task, tenant: scope.tenant, status, at: event.ts });
      }
      return stored;
    },
    read: (task, fromSeq, isLive) => inner.read(task, fromSeq, isLive),
    wake: (task) => inner.wake(task),
  };
  return {
    log,
    running: async () => [...tasks.values()].filter(active),
    all: async (tenant) => [...tasks.values()].filter((t) => !tenant || t.tenant === tenant),
  };
};

export interface DirectoryEntry {
  orgNumber: string;
  name: string;
  status?: 'active' | 'onboarding' | 'paused';
}

export const orgNumberValid = (org: string) => {
  if (!/^\d{9}$/.test(org)) return false;
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(org[i]), 0);
  const rest = 11 - (sum % 11);
  const check = rest === 11 ? 0 : rest;
  return check !== 10 && check === Number(org[8]);
};

export interface TenantDirectoryStore {
  list(): Promise<DirectoryEntry[]>;
  save(entry: DirectoryEntry, by: string): Promise<void>;
}

export class InMemoryTenantDirectoryStore implements TenantDirectoryStore {
  readonly #entries = new Map<string, DirectoryEntry>();

  async list() {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  async save(entry: DirectoryEntry) {
    this.#entries.set(entry.orgNumber, { ...entry });
  }
}

export class TenantDirectory {
  constructor(
    private readonly store: TenantDirectoryStore = new InMemoryTenantDirectoryStore(),
    private readonly known: () => Promise<string[]> = async () => [],
  ) {}

  async add(entry: DirectoryEntry, by: string) {
    await this.store.save(entry, by);
  }

  async ensure(entry: DirectoryEntry, by: string) {
    if ((await this.store.list()).some((e) => e.orgNumber === entry.orgNumber)) return false;
    await this.store.save(entry, by);
    return true;
  }

  async list(): Promise<DirectoryEntry[]> {
    const all = new Map((await this.store.list()).map((e) => [e.orgNumber, e]));
    for (const org of await this.known())
      if (!all.has(org)) all.set(org, { orgNumber: org, name: org, status: 'active' });
    return [...all.values()].sort((a, b) => a.orgNumber.localeCompare(b.orgNumber));
  }
}

export interface ToolAdminDeps {
  connections: ConnectionRegistry;
  source: ConnectionToolSource;
  secrets: TenantSecrets;
  onToolsChanged: (tenant: string) => Promise<void>;
}

const forTenant = (principal: Principal, tenant: string) =>
  principal.kind === 'operator'
    ? principal.actor !== undefined && principal.tenant === tenant
    : principal.tenant === tenant ||
      (principal.authorizedFor?.some((a) => a.org === tenant) ?? false);

const refused = (target: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path: 'principal', message }],
  target,
});

export const testCaseActions = ['platform.testcase.propose', 'platform.testcase.review'];

export const adminExtensions = (deps: {
  tools: ToolAdminDeps;
  directory: TenantDirectory;
}): Record<string, AdminHandler> => ({
  ...routeOnlyActions(testCaseActions),
  'platform.tenant.create': async (input, principal) => {
    const org = String(input.orgNumber ?? '');
    const target = `tenant:${org}`;
    if (principal.kind !== 'operator') return refused(target, 'only operators create tenants');
    if (!orgNumberValid(org))
      return {
        ok: false,
        errors: [{ path: 'orgNumber', message: 'not a valid organisation number' }],
        target,
      };
    const name = String(input.name ?? '').trim() || org;
    await deps.directory.add(
      { orgNumber: org, name, status: 'onboarding' },
      `${principal.issuer}:${principal.subject}`,
    );
    return {
      ok: true,
      value: { orgNumber: org, name, status: 'onboarding' },
      target,
      audit: { scope: 'platform' },
    };
  },
  'platform.tools.register': async (input, principal) => {
    const tenant = input.tenant;
    const given = (input.connection ?? {}) as Record<string, unknown>;
    const connection =
      principal.kind === 'operator' || given.writes === undefined
        ? given
        : { ...given, writes: false };
    const target = `tool-connection:${tenant}/${String(connection.id ?? '')}`;
    if (!forTenant(principal, tenant))
      return refused(target, 'only the tenant or an operator registers tools');
    try {
      const candidate = validateConnection({ ...connection, tenant });
      const outside = candidate.auth
        ? await deps.tools.secrets.outside(tenant, candidate.auth.secret, secretTargets(candidate))
        : [];
      if (outside.length > 0)
        return {
          ok: false,
          errors: [
            {
              path: 'connection.auth.secret',
              message: t('blocks.secretNotForHosts', {
                secret: candidate.auth?.secret.split('/').pop() ?? '',
                hosts: outside.join(', '),
              }),
            },
          ],
          target,
        };
      const registered = await deps.tools.connections.register({ ...connection, tenant });
      await deps.tools.source.load(tenant);
      return {
        ok: true,
        value: { id: registered.id, endpoint: registered.endpoint, version: registered.version },
        target,
        audit: {
          after: {
            endpoint: registered.endpoint,
            allow: registered.allow,
            version: registered.version,
            ...(registered.protocol ? { protocol: registered.protocol } : {}),
            ...(registered.operations ? { operations: registered.operations } : {}),
            ...(registered.writes === undefined ? {} : { writes: registered.writes }),
          },
        },
      };
    } catch (error) {
      if (error instanceof RegistrationError)
        return { ok: false, errors: [{ path: 'connection', message: error.message }], target };
      throw error;
    }
  },
  'platform.tools.sync': async (input, principal) => {
    const tenant = input.tenant;
    const id = String(input.id);
    const target = `tool-connection:${tenant}/${id}`;
    if (!forTenant(principal, tenant))
      return refused(target, 'only the tenant or an operator syncs tools');
    try {
      const result = await deps.tools.source.sync(
        tenant,
        id,
        AbortSignal.timeout(toolSyncDeadlineMs),
      );
      await deps.tools.source.load(tenant);
      await deps.tools.onToolsChanged(tenant);
      return { ok: true, value: result, target, audit: { result } };
    } catch (error) {
      return {
        ok: false,
        errors: [{ path: 'id', message: error instanceof Error ? error.message : String(error) }],
        target,
      };
    }
  },
  'platform.tools.approve': async (input, principal) => {
    const tenant = input.tenant;
    const id = String(input.id);
    const tool = String(input.tool);
    const target = `tool:${tenant}/${tool}`;
    if (!forTenant(principal, tenant))
      return refused(target, 'only the tenant or an operator approves tool changes');
    try {
      await deps.tools.source.approve(tenant, id, tool);
      await deps.tools.source.load(tenant);
      await deps.tools.onToolsChanged(tenant);
      return { ok: true, value: { approved: tool }, target };
    } catch (error) {
      return {
        ok: false,
        errors: [{ path: 'tool', message: error instanceof Error ? error.message : String(error) }],
        target,
      };
    }
  },
  'platform.platform-secret.set': async (input, principal) => {
    const name = String(input.name ?? '');
    const target = `secret:platform/${name}`;
    if (principal.kind !== 'operator')
      return refused(target, 'only operators set platform secrets');
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name))
      return { ok: false, errors: [{ path: 'name', message: 'not a valid secret name' }], target };
    return {
      ok: true,
      value: { ref: `secret://platform/${name}` },
      target,
      audit: { scope: 'platform', name },
    };
  },
  'platform.secrets.set': async (input, principal) => {
    const name = String(input.name ?? '');
    const target = `secret:${input.tenant}/${name}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'only the tenant or an operator sets its secrets');
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name))
      return { ok: false, errors: [{ path: 'name', message: 'not a valid secret name' }], target };
    const allowedHosts = Array.isArray(input.allowedHosts) ? input.allowedHosts : undefined;
    return {
      ok: true,
      value: { ref: TenantSecretVault.ref(input.tenant, name) },
      target,
      audit: { name, ...(allowedHosts ? { allowedHosts } : {}) },
    };
  },
  'platform.secrets.hosts': async (input, principal) => {
    const name = String(input.name ?? '');
    const target = `secret:${input.tenant}/${name}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'only the tenant or an operator sets its secrets');
    const allowedHosts = Array.isArray(input.allowedHosts) ? input.allowedHosts : [];
    return {
      ok: true,
      value: { ref: TenantSecretVault.ref(input.tenant, name), allowedHosts },
      target,
      audit: { name, before: input.before ?? null, after: allowedHosts },
    };
  },
  'platform.secrets.delete': async (input, principal) => {
    const name = String(input.name ?? '');
    const target = `secret:${input.tenant}/${name}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'only the tenant or an operator removes its secrets');
    return { ok: true, value: { removed: name }, target, audit: { name } };
  },
});

export interface EvalDeps {
  kernel: Kernel;
  evalCapability: string;
  testSets: TestSetStore;
  runs: EvalRunStore;
  feedback: FeedbackStore;
  candidates: CandidateStore;
  quotaExhausted?: (tenant: string) => Promise<boolean>;
}

export interface ExtensionRouteDeps {
  admin: Admin;
  authenticate(request: Request): Promise<Principal | undefined>;
  vault: TenantSecretVault;
  connections: ConnectionRegistry;
  directory: TenantDirectory;
  tasks: () => Promise<TrackedTask[]>;
  allTasks?: () => Promise<TrackedTask[]>;
  catalogSkips: string[];
  eval: EvalDeps;
  platformTenant?: string;
}

const param = (c: Context, name: string) => c.req.param(name) ?? '';

const withoutPeople = (candidate: TestCaseCandidate) => {
  const shown: Partial<TestCaseCandidate> = { ...candidate };
  delete shown.proposedBy;
  delete shown.reviewedBy;
  return shown;
};

const textOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const mountExtensions = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: ExtensionRouteDeps,
) => {
  const who = async (c: Context) => deps.authenticate(c.req.raw);
  const adminKeys = adminKeysOnly(deps.authenticate);
  app.use('/testcase-candidates/*', adminKeys);
  app.use('/eval-runs/*', adminKeys);
  app.use('/eval-tasks/*', adminKeys);
  const access = tenantAccess(deps.admin);
  const sessionTenant = (c: Context) => {
    const id = c.req.header(supportSessionHeader);
    return id ? deps.admin.supportSessions().find((s) => s.id === id)?.tenant : undefined;
  };
  const actingFor = (c: Context, principal: Principal) => {
    if (principal.kind !== 'operator') return principal;
    const tenant = sessionTenant(c);
    return tenant ? (access(principal, tenant, c.req.raw) ?? principal) : principal;
  };
  const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
  const evalService = createEvalService({
    kernel: deps.eval.kernel,
    evalCapability: deps.eval.evalCapability,
    testSets: deps.eval.testSets,
    runs: deps.eval.runs,
  });

  const inTask = async <T>(
    c: Context,
    principal: Principal,
    action: string,
    data: Record<string, unknown> & { tenant: string },
    target: (value: T) => string,
    work: () => Promise<T>,
  ) => {
    const done = await deps.admin.within(
      principal,
      action,
      { ...data, reason: reasonOf(c) },
      async () => {
        const value = await work();
        return { value, target: target(value) };
      },
    );
    c.header('genai-task', done.task);
    return done.value;
  };

  const performed = async (
    c: Context,
    principal: Principal,
    action: string,
    data: Record<string, unknown> & { tenant: string },
    then?: () => Promise<void>,
  ) => {
    const reason = reasonOf(c);
    if (!isReasonLongEnough(reason))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const input = { ...data, reason };
    const result = then
      ? await deps.admin.performThen(principal, action, input, then)
      : await deps.admin.perform(principal, action, input);
    c.header('genai-task', result.task);
    if (result.ok) return c.json(result.value as object, 200);
    if (result.problem) return rightRefused(c, result.problem);
    const forbidden = result.errors.some((e) => e.path === 'principal');
    return problem(
      c,
      forbidden ? 403 : 400,
      forbidden ? 'Forbidden' : 'Invalid request',
      result.errors,
    );
  };

  const hostsProblem = (c: Context, invalid: string) =>
    problem(c, 400, 'Invalid request', [
      {
        path: 'allowedHosts',
        message: invalid
          ? t('blocks.secretHostInvalid', { host: invalid })
          : t('blocks.secretHostsRequired'),
      },
    ]);

  const applied = async (
    c: Context,
    principal: Principal,
    action: string,
    data: Record<string, unknown> & { tenant: string },
    then?: () => Promise<void>,
    right: Right | null = 'manage-services',
  ) => {
    const entered = enterTenant(c, access, principal, data.tenant, right ?? undefined);
    if ('response' in entered) return entered.response;
    return performed(c, entered.principal, action, data, then);
  };

  app.get('/tenants/:tenant/tool-connections', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const entered = enterTenant(c, access, principal, param(c, 'tenant'));
    if ('response' in entered) return entered.response;
    const tenant = param(c, 'tenant');
    const states = await deps.connections.list(tenant);
    return c.json({
      data: states.map((s) => ({
        id: s.connection.id,
        name: s.connection.name,
        protocol: s.connection.protocol ?? 'mcp',
        endpoint: s.connection.endpoint,
        version: s.connection.version,
        tools: s.tools.map((t) => t.name),
      })),
    });
  });
  app.post('/tenants/:tenant/tool-connections', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return applied(c, principal, 'platform.tools.register', {
      tenant: param(c, 'tenant'),
      connection: body,
    });
  });
  app.post('/tenants/:tenant/tool-connections/:id/sync', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    return applied(c, principal, 'platform.tools.sync', {
      tenant: param(c, 'tenant'),
      id: param(c, 'id'),
    });
  });
  app.post('/tenants/:tenant/tool-connections/:id/approve', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const body = (await c.req.json().catch(() => ({}))) as { tool?: string };
    return applied(c, principal, 'platform.tools.approve', {
      tenant: param(c, 'tenant'),
      id: param(c, 'id'),
      tool: body.tool ?? '',
    });
  });
  app.put('/tenants/:tenant/secrets/:name', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const tenant = param(c, 'tenant');
    const name = param(c, 'name');
    const body = (await c.req.json().catch(() => ({}))) as {
      value?: unknown;
      allowedHosts?: unknown;
    };
    if (typeof body.value !== 'string' || body.value.length === 0)
      return problem(c, 400, 'Invalid request', [
        { path: 'value', message: 'a value is required' },
      ]);
    const value = body.value;
    const entered = enterTenant(c, access, principal, tenant);
    if ('response' in entered) return entered.response;
    const exists = (await deps.vault.names(tenant)).includes(name);
    const parsed = body.allowedHosts === undefined ? undefined : secretHosts(body.allowedHosts);
    if (parsed && !parsed.ok) return hostsProblem(c, parsed.invalid);
    if (!parsed && !exists) return hostsProblem(c, '');
    const hosts = parsed?.ok ? parsed.hosts : undefined;
    const hostsChange =
      exists && hosts !== undefined && !sameHosts(hosts, await deps.vault.hosts(tenant, name));
    return performed(
      c,
      entered.principal,
      'platform.secrets.set',
      { tenant, name, ...(hosts ? { allowedHosts: hosts } : {}), hostsChange },
      async () => {
        await deps.vault.set(tenant, name, value, hosts);
      },
    );
  });

  app.put('/tenants/:tenant/secrets/:name/hosts', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const tenant = param(c, 'tenant');
    const name = param(c, 'name');
    const entered = enterTenant(c, access, principal, tenant, 'manage-services');
    if ('response' in entered) return entered.response;
    const body = (await c.req.json().catch(() => ({}))) as { allowedHosts?: unknown };
    const parsed = secretHosts(body.allowedHosts);
    if (!parsed.ok) return hostsProblem(c, parsed.invalid);
    if (!(await deps.vault.names(tenant)).includes(name))
      return problem(c, 404, 'Not found', [
        { path: 'name', message: t('blocks.secretNotFound', { name }) },
      ]);
    const before = await deps.vault.hosts(tenant, name);
    return performed(
      c,
      entered.principal,
      'platform.secrets.hosts',
      { tenant, name, allowedHosts: parsed.hosts, before: before ?? null },
      async () => {
        await deps.vault.setHosts(tenant, name, parsed.hosts);
      },
    );
  });

  app.put('/operator/secrets/:name', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
    const name = param(c, 'name');
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof body.value !== 'string' || body.value.length === 0)
      return problem(c, 400, 'Invalid request', [
        { path: 'value', message: 'a value is required' },
      ]);
    const acting = { ...principal, tenant: deps.platformTenant ?? defaultPlatformTenant };
    const value = body.value;
    return performed(
      c,
      acting,
      'platform.platform-secret.set',
      { tenant: acting.tenant, name },
      async () => {
        await deps.vault.set('platform', name, value);
      },
    );
  });

  app.post('/operator/tenants', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
    const body = (await c.req.json().catch(() => ({}))) as { orgNumber?: string; name?: string };
    const acting = { ...principal, tenant: deps.platformTenant ?? defaultPlatformTenant };
    return performed(c, acting, 'platform.tenant.create', {
      tenant: body.orgNumber ?? '',
      orgNumber: body.orgNumber ?? '',
      name: body.name ?? '',
    });
  });
  app.get('/operator/catalog', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
    return c.json({ skipped: deps.catalogSkips });
  });
  app.get('/operator/tasks', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
    const status = c.req.query('status');
    if (status === undefined || status === 'running') return c.json({ data: await deps.tasks() });
    if (!taskStatuses.includes(status as TaskStatus) || !deps.allTasks)
      return problem(c, 400, 'Invalid request', [
        { path: 'status', message: `status is one of ${taskStatuses.join(', ')}` },
      ]);
    return c.json({ data: (await deps.allTasks()).filter((task) => task.status === status) });
  });

  const evalGuard = async (c: Context, tenant: string, right?: Right) => {
    const principal = await who(c);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    return enterTenant(c, access, principal, tenant, right);
  };
  app.get('/tenants/:tenant/test-sets', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant);
    if ('response' in guard) return guard.response;
    return c.json({ data: await deps.eval.testSets.list(tenant, c.req.query('service')) });
  });
  app.get('/tenants/:tenant/eval-runs', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant);
    if ('response' in guard) return guard.response;
    const service = c.req.query('service');
    const runs = await deps.eval.runs.list({ tenant, ...(service ? { service } : {}) });
    return c.json({ data: runs.map((s) => s.run) });
  });
  app.post('/tenants/:tenant/eval-runs', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant, 'manage-services');
    if ('response' in guard) return guard.response;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (await deps.eval.quotaExhausted?.(tenant))
      return problem(c, 409, t('runs.quotaExhaustedTitle'), [
        { path: 'quota', message: t('runs.quotaExhaustedDetail') },
      ]);
    const missing = evalRunFields.filter(([field, valid]) => !valid(body[field]));
    if (missing.length > 0)
      return problem(
        c,
        400,
        'Invalid request',
        missing.map(([field]) => ({ path: field, message: 'required' })),
      );
    try {
      const status = await evalService.startRun(guard.principal, {
        ...(body as object),
        tenant,
      } as Parameters<typeof evalService.startRun>[1]);
      return c.json(status, 202);
    } catch (error) {
      return evalProblem(c, error);
    }
  });
  app.get('/eval-tasks/:task', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    try {
      return c.json(await evalService.status(actingFor(c, principal), param(c, 'task')));
    } catch (error) {
      return evalProblem(c, error);
    }
  });
  app.get('/eval-runs/compare', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    try {
      return c.json(
        await evalService.compare(
          actingFor(c, principal),
          c.req.query('baseline') ?? '',
          c.req.query('candidate') ?? '',
          c.req.query('metric') ?? '',
        ),
      );
    } catch (error) {
      return evalProblem(c, error);
    }
  });
  app.get('/eval-runs/:id', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    try {
      return c.json(await evalService.getRun(actingFor(c, principal), param(c, 'id')));
    } catch (error) {
      return evalProblem(c, error);
    }
  });
  app.get('/tenants/:tenant/feedback', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant);
    if ('response' in guard) return guard.response;
    const service = c.req.query('service');
    const records = await deps.eval.feedback.list(tenant);
    if (!service) return c.json({ data: anonymousFeedback(records) });
    const prefix = `${tenant}/${service}/`;
    const kept = [];
    for (const record of records) {
      if (record.capability !== undefined) {
        if (record.capability.startsWith(prefix)) kept.push(record);
        continue;
      }
      try {
        const task = await deps.eval.kernel.task(guard.principal, record.task);
        if (task.service.capability.id.startsWith(prefix)) kept.push(record);
      } catch {
        continue;
      }
    }
    return c.json({ data: anonymousFeedback(kept) });
  });

  const feedbackFrom = async (
    c: Context,
    principal: Principal,
    task: string,
    body: Record<string, unknown>,
  ) => {
    const rating = body.rating;
    if (rating !== 'up' && rating !== 'down')
      return problem(c, 400, 'Invalid request', [
        { path: 'rating', message: 'rating is up or down' },
      ]);
    try {
      const record = await recordFeedback(
        { kernel: deps.eval.kernel, store: deps.eval.feedback },
        principal,
        {
          task,
          rating,
          ...(typeof body.comment === 'string' && body.comment.trim()
            ? { comment: body.comment.trim() }
            : {}),
          ...(Array.isArray(body.reasons)
            ? {
                reasons: body.reasons
                  .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
                  .map((r) => r.trim())
                  .slice(0, 10),
              }
            : {}),
        },
      );
      return c.json({ ok: true, task: record.task }, 201);
    } catch (error) {
      if (
        error instanceof KernelError &&
        (error.code === 'not_found' || error.code === 'forbidden')
      )
        return principal.kind === 'agency-system'
          ? problem(c, 403, 'Feedback is not available for this run', [
              {
                path: 'task',
                message:
                  'A run made with an API key takes feedback only from the key that made it. This key did not make this run.',
              },
            ])
          : problem(c, 404, 'Not found');
      return evalProblem(c, error);
    }
  };
  app.post('/tasks/:task/feedback', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return feedbackFrom(c, principal, param(c, 'task'), body);
  });
  app.post('/api/feedback', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Invalid or missing API key');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.task !== 'string' || !body.task)
      return problem(c, 400, 'Invalid request', [
        { path: 'task', message: 'the answer task is required to record feedback' },
      ]);
    return feedbackFrom(c, principal, body.task, body);
  });
  app.post('/tenants/:tenant/testcase-candidates', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant, 'manage-services');
    if ('response' in guard) return guard.response;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const named = body.testSet ?? body.targetTestSet;
    const targetTestSet = typeof named === 'string' && named ? named : undefined;
    if (targetTestSet && !(await deps.eval.testSets.get(tenant, targetTestSet)))
      return problem(c, 400, 'Invalid request', [
        {
          path: 'testSet',
          message: `Testsettet «${targetTestSet}» finnes ikke. Opprett testsettet før du foreslår testtilfeller til det.`,
        },
      ]);
    const question = textOf(body.question) ?? textOf(body.input);
    if (!question)
      return problem(c, 400, 'Invalid request', [
        { path: 'question', message: 'the question is required' },
      ]);
    const answer = textOf(body.answer) ?? textOf(body.expected);
    try {
      const saved = await inTask(
        c,
        guard.principal,
        'platform.testcase.propose',
        { tenant },
        (candidate: TestCaseCandidate) => `testcase-candidate:${candidate.id}`,
        async () => {
          const candidate = await proposeTestCase(
            { store: deps.eval.candidates, redactor: basicPiiRedactor },
            {
              ...(body as object),
              tenant,
              question,
              ...(answer ? { answer } : {}),
              ...(textOf(body.task) ? { task: String(body.task) } : {}),
              proposedBy: `${guard.principal.issuer}:${guard.principal.subject}`,
            } as Parameters<typeof proposeTestCase>[1],
          );
          const origin = candidateOrigins.find((o) => o === body.origin);
          if (!targetTestSet && !origin) return candidate;
          const tagged = {
            ...candidate,
            ...(targetTestSet ? { targetTestSet } : {}),
            ...(origin ? { origin } : {}),
          };
          await deps.eval.candidates.save(tagged);
          return tagged;
        },
      );
      return c.json(withoutPeople(saved), 201);
    } catch (error) {
      return evalProblem(c, error);
    }
  });
  app.post('/testcase-candidates/:id/review', async (c) => {
    const principal = await who(c);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const id = param(c, 'id');
    const candidate = await deps.eval.candidates.get(id);
    if (!candidate) return problem(c, 404, 'Not found');
    const entered = enterTenant(c, access, principal, candidate.tenant, 'manage-services');
    if ('response' in entered) return entered.response;
    const acting = entered.principal;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const proposedFor = (candidate as { targetTestSet?: unknown }).targetTestSet;
    const testSet =
      typeof body.testSet === 'string' && body.testSet
        ? body.testSet
        : typeof proposedFor === 'string' && proposedFor
          ? proposedFor
          : undefined;
    try {
      const reviewed = await inTask(
        c,
        acting,
        'platform.testcase.review',
        { tenant: candidate.tenant, candidate: id },
        () => `testcase-candidate:${id}`,
        () =>
          reviewCandidate({ store: deps.eval.candidates, testSets: deps.eval.testSets }, {
            ...(body as object),
            ...(testSet ? { testSet } : {}),
            candidate: id,
            reviewer: `${acting.issuer}:${acting.subject}`,
          } as Parameters<typeof reviewCandidate>[1]),
      );
      return c.json(withoutPeople(reviewed));
    } catch (error) {
      return evalProblem(c, error);
    }
  });
  app.get('/tenants/:tenant/testcase-candidates', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant);
    if ('response' in guard) return guard.response;
    const service = c.req.query('service');
    const data = (await deps.eval.candidates.list(tenant))
      .filter((candidate) => !service || candidate.service === service)
      .flatMap((candidate) => candidateView(candidate) ?? []);
    return c.json({ data });
  });
  app.post('/tenants/:tenant/testcase-candidates/:id/review', async (c) => {
    const tenant = param(c, 'tenant');
    const guard = await evalGuard(c, tenant, 'manage-services');
    if ('response' in guard) return guard.response;
    const candidate = await deps.eval.candidates.get(param(c, 'id'));
    if (!candidate || candidate.tenant !== tenant) return problem(c, 404, 'Not found');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.decision !== 'accept' && body.decision !== 'reject')
      return problem(c, 400, 'Invalid request', [
        { path: 'decision', message: 'decision is accept or reject' },
      ]);
    if (body.type !== undefined && !isCaseType(body.type))
      return problem(c, 400, 'Invalid request', [
        { path: 'type', message: 'type is criteria, exact or must_reject' },
      ]);
    const testSet = textOf(body.testSet) ?? candidate.targetTestSet;
    const expected = textOf(body.expected);
    try {
      const decision = body.decision;
      const reviewed = await inTask(
        c,
        guard.principal,
        'platform.testcase.review',
        { tenant, candidate: candidate.id, decision },
        () => `testcase-candidate:${candidate.id}`,
        () =>
          reviewCandidate(
            { store: deps.eval.candidates, testSets: deps.eval.testSets },
            {
              candidate: candidate.id,
              decision,
              reviewer: `${guard.principal.issuer}:${guard.principal.subject}`,
              ...(testSet ? { testSet } : {}),
              ...(expected ? { referenceAnswer: expected } : {}),
              ...(isCaseType(body.type) ? { type: body.type } : {}),
              ...(textOf(body.reason) ? { reason: String(body.reason) } : {}),
            },
          ),
      );
      const view = candidateView(reviewed);
      if (!reviewed.testSet) return c.json(view);
      const set = await deps.eval.testSets.get(
        tenant,
        reviewed.testSet.id,
        reviewed.testSet.version,
      );
      const added = set?.spec.cases.find((x) => x.id === reviewed.testSet?.case);
      return c.json({ ...view, ...(added ? { case: caseView(added) } : {}) });
    } catch (error) {
      return evalProblem(c, error);
    }
  });
};

const isRecordWith = (key: string) => (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)[key] === 'string';

const evalRunFields: [string, (value: unknown) => boolean][] = [
  ['capability', (value) => typeof value === 'string' && value !== ''],
  ['testSet', isRecordWith('id')],
  ['evaluators', (value) => Array.isArray(value) && value.every((e) => typeof e === 'string')],
  ['provenance', (value) => isRecordWith('commit')(value) && isRecordWith('data')(value)],
];

const evalProblem = (c: Context, error: unknown) => {
  if (error instanceof AdminRefused) return refusedBy(c, error);
  if (error instanceof Error && error.name === 'EvalAccessError')
    return problem(c, 404, 'Not found');
  if (error instanceof EvalError)
    return problem(c, 400, 'Invalid request', [{ path: '', message: error.message }]);
  throw error;
};
