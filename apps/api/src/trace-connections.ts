import type { Principal } from '@genai/contracts';
import { residencies } from '@genai/port-model';
import {
  EgressError,
  isLoopbackAddress,
  secretTenant,
  tenantSecretPattern,
  type TenantSecrets,
} from '@genai/providers-mcp-client';
import type { Context } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { rightsOf } from './rights.js';
import { actorOf, AdminRefused, refusedBy, type AdminHandler } from './admin.js';
import { allowOf, traceConnectionKind, tracingEgress } from '@genai/composition';
import { appendVersion, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, problem, reasonTooShort } from './http.js';
import type { TraceDeliveryStore } from '@genai/jobs';
import type { PlatformModuleFactory } from './platform-modules.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const traceConnection = z.strictObject({
  id: slug,
  host: z.url({ protocol: /^https?$/ }).refine((h) => {
    const url = new URL(h);
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  }, 'the host is an address like https://langfuse.example.no, without a path or credentials'),
  publicKey: z.string().min(1).max(200),
  secretKey: z
    .string()
    .regex(tenantSecretPattern, 'must be a secret://tenant/<tenant>/<name> reference'),
  services: z.array(slug).default([]),
  residency: z.enum(residencies).default('global'),
  content: z.boolean().default(false),
  erasureDeclared: z.boolean().default(false),
});
export type TraceConnection = z.output<typeof traceConnection> & {
  /** Removal asked for: its traces are being deleted, and it covers no service any more. */
  removing?: true;
};

export interface TracingOptions {
  /** Digdir's Langfuse. A connection to it gets its residency from an operator. */
  instance?: string;
  /** Operators have confirmed the instance meets ADR 0011's conditions for content. */
  instanceReceivesContent?: boolean;
  /** Development mode: a Langfuse on the developer's own machine may be reached over HTTP. */
  devMode?: boolean;
}

export const traceConnectionActions = [
  'platform.tracing.connection.save',
  'platform.tracing.connection.remove',
  'platform.tracing.connection.residency',
] as const;

const origin = (address: string) => new URL(address).origin;

const errorsOf = (error: z.ZodError) =>
  error.issues
    .map((i) => ({
      ...i,
      message: i.code === 'invalid_type' && i.input === undefined ? 'required' : i.message,
    }))
    .map((i) => ({
      path: ['connection', ...i.path.map(String)].join('.'),
      message: i.message,
    }));

export const traceConnections = (
  deps: {
    configEntries: ConfigEntryStore;
    tenantSecrets?: TenantSecrets;
    egress: ReturnType<typeof tracingEgress>;
    deliveries?: Pick<TraceDeliveryStore, 'markPending' | 'outstanding'>;
    now?: () => Date;
  },
  options: TracingOptions,
) => {
  const onInstance = (host: string) =>
    options.instance !== undefined && origin(host) === origin(options.instance);

  const outstanding = async (tenant: string, id: string) =>
    deps.deliveries ? deps.deliveries.outstanding(tenant, id) : 0;

  const drop = (tenant: string, connection: TraceConnection, by: string, reason: string) =>
    appendVersion<TraceConnection>(deps.configEntries, {
      kind: traceConnectionKind,
      scope: tenant,
      id: connection.id,
      spec: connection,
      deleted: true,
      by,
      reason,
    });

  /** A connection being removed is gone once every trace sent through it is deleted. */
  const list = async (tenant: string) => {
    const kept: TraceConnection[] = [];
    for (const entry of await deps.configEntries.latest({
      kind: traceConnectionKind,
      scope: tenant,
    })) {
      if (entry.deleted) continue;
      const connection = entry.spec as TraceConnection;
      if (connection.removing && (await outstanding(tenant, connection.id)) === 0) {
        await drop(
          tenant,
          connection,
          'platform:trace-deletes',
          'Every trace it received is deleted',
        ).catch(async (error: unknown) => {
          // Another read finished the removal first.
          const history = await deps.configEntries.history(
            traceConnectionKind,
            tenant,
            connection.id,
          );
          if (!history.at(-1)?.deleted) throw error;
        });
        continue;
      }
      kept.push(connection);
    }
    return kept.sort((a, b) => a.id.localeCompare(b.id));
  };

  const find = async (tenant: string, id: string) => (await list(tenant)).find((c) => c.id === id);

  /** The connection that covers a service, if any: a service is covered by at most one. */
  const coveringService = async (tenant: string, service: string) =>
    (await list(tenant)).find((c) => !c.removing && c.services.includes(service));

  const loopback = async (host: string) => {
    const name = new URL(host).hostname.replace(/^\[|\]$/g, '');
    return name === 'localhost' || isLoopbackAddress(name);
  };

  /** The secret is the tenant's own and set for the connection's host. */
  const secretProblems = async (
    tenant: string,
    next: Pick<TraceConnection, 'secretKey' | 'host'>,
  ) => {
    if (secretTenant(next.secretKey) !== tenant)
      return [{ path: 'connection.secretKey', message: 'the secret belongs to another tenant' }];
    const outside = deps.tenantSecrets
      ? await deps.tenantSecrets.outside(tenant, next.secretKey, [next.host])
      : [];
    return outside.length > 0
      ? [
          {
            path: 'connection.secretKey',
            message: `the secret is not set for ${outside.join(', ')}`,
          },
        ]
      : [];
  };

  const hostProblem = async (host: string) => {
    const url = new URL(host);
    // A trailing dot names the same host, so Digdir's Langfuse would not be recognised by it.
    if (url.hostname.endsWith('.')) return 'the host name ends with a dot';
    if (url.protocol !== 'https:' && !(options.devMode && (await loopback(host))))
      return 'the host must use HTTPS';
    try {
      await deps.egress.address(url.hostname);
      return undefined;
    } catch (error) {
      return error instanceof EgressError ? error.message : String(error);
    }
  };

  const check = async (tenant: string, connection: TraceConnection) => {
    if (!deps.tenantSecrets) throw new Error('no tenant secrets');
    const key = await deps.tenantSecrets.resolveFor(tenant, connection.secretKey, [
      connection.host,
    ]);
    const response = await deps.egress.request(
      allowOf(connection.host),
      new URL('/api/public/projects', connection.host).toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Basic ${Buffer.from(`${connection.publicKey}:${key}`).toString('base64')}`,
        },
        timeoutMs: 10_000,
        maxResponseBytes: 100_000,
      },
    );
    if (response.status < 200 || response.status >= 300)
      return { ok: false as const, status: response.status };
    const projects = z
      .object({ data: z.array(z.object({ id: z.string(), name: z.string() })).min(1) })
      .safeParse(JSON.parse(response.body));
    return projects.success
      ? { ok: true as const, project: projects.data.data[0] as { id: string; name: string } }
      : { ok: false as const, status: response.status };
  };

  const save: AdminHandler = async (input, principal) => {
    const tenant = String(input.tenant ?? '');
    const parsed = traceConnection.safeParse(input.connection);
    const target = `trace-connection:${tenant}/${String((input.connection as { id?: unknown })?.id ?? '')}`;
    if (!parsed.success) return { ok: false, errors: errorsOf(parsed.error), target };
    const next = parsed.data;
    const before = await find(tenant, next.id);
    const errors: { path: string; message: string }[] = await secretProblems(tenant, next);
    if (before?.removing)
      errors.push({ path: 'connection.id', message: `the connection ${next.id} is being removed` });
    // Deletes go to the connection's host and project, so those stay while deletes are owed there.
    // A new secret for the same project is fine.
    if (
      before &&
      (before.host !== next.host || before.publicKey !== next.publicKey) &&
      (await outstanding(tenant, next.id)) > 0
    )
      errors.push({
        path: 'connection.host',
        message: `the connection ${next.id} still has traces to delete where it points now`,
      });
    const hostRefused = await hostProblem(next.host);
    if (hostRefused) errors.push({ path: 'connection.host', message: hostRefused });
    for (const service of next.services) {
      const covering = await coveringService(tenant, service);
      if (covering && covering.id !== next.id)
        errors.push({
          path: 'connection.services',
          message: `${service} is already covered by the connection ${covering.id}`,
        });
    }
    const instance = onInstance(next.host);
    const residencyGiven =
      typeof input.connection === 'object' &&
      input.connection !== null &&
      'residency' in input.connection;
    const residency = instance
      ? before && onInstance(before.host)
        ? before.residency
        : 'global'
      : next.residency;
    if (instance && residencyGiven && next.residency !== residency)
      errors.push({
        path: 'connection.residency',
        message: "an operator sets the residency of a connection to Digdir's Langfuse",
      });
    const receivesContent = instance
      ? options.instanceReceivesContent === true
      : next.erasureDeclared || (options.devMode === true && (await loopback(next.host)));
    if (next.content && options.instance === undefined && !options.devMode)
      errors.push({
        path: 'connection.content',
        message:
          "content needs LANGFUSE_BASE_URL, so Digdir's Langfuse is never taken for an agency's own",
      });
    else if (next.content && !receivesContent)
      errors.push({
        path: 'connection.content',
        message: instance
          ? "Digdir's Langfuse does not receive content until operators confirm it deletes what genki deletes and keeps raw files at most 7 days"
          : 'content needs the declaration that the Langfuse deletes what genki deletes and keeps raw files at most 7 days',
      });
    if (errors.length > 0) return { ok: false, errors, target };
    const spec: TraceConnection = { ...next, residency };
    const saved = await appendVersion<TraceConnection>(deps.configEntries, {
      kind: traceConnectionKind,
      scope: tenant,
      id: spec.id,
      spec,
      deleted: false,
      by: actorOf(principal),
      reason: String(input.reason ?? ''),
    });
    return { ok: true, value: saved.spec, target, audit: { before: before ?? null, after: spec } };
  };

  const remove: AdminHandler = async (input, principal) => {
    const tenant = String(input.tenant ?? '');
    const id = String(input.id ?? '');
    const target = `trace-connection:${tenant}/${id}`;
    const before = await find(tenant, id);
    if (!before)
      return { ok: false, errors: [{ path: 'id', message: `no connection ${id}` }], target };
    const reason = String(input.reason ?? '');
    // Removing first, so a batch about to be sent sees it and is held back; then everything
    // already recorded is queued for deletion.
    const removing: TraceConnection = { ...before, services: [], removing: true };
    await appendVersion<TraceConnection>(deps.configEntries, {
      kind: traceConnectionKind,
      scope: tenant,
      id,
      spec: removing,
      deleted: false,
      by: actorOf(principal),
      reason,
    });
    await deps.deliveries?.markPending(
      tenant,
      { sink: id },
      (deps.now?.() ?? new Date()).toISOString(),
    );
    if ((await outstanding(tenant, id)) === 0) {
      await drop(tenant, removing, actorOf(principal), reason);
      return { ok: true, value: { removed: id }, target, audit: { before } };
    }
    return { ok: true, value: { removing: id }, target, audit: { before, after: removing } };
  };

  const setResidency: AdminHandler = async (input, principal) => {
    const tenant = String(input.tenant ?? '');
    const id = String(input.id ?? '');
    const target = `trace-connection:${tenant}/${id}`;
    if (principal.kind !== 'operator')
      return { ok: false, errors: [{ path: 'principal', message: 'operators only' }], target };
    const residency = z.enum(residencies).safeParse(input.residency);
    if (!residency.success)
      return {
        ok: false,
        errors: [{ path: 'residency', message: 'norway, eu or global' }],
        target,
      };
    const before = await find(tenant, id);
    if (!before)
      return { ok: false, errors: [{ path: 'id', message: `no connection ${id}` }], target };
    if (!onInstance(before.host))
      return {
        ok: false,
        errors: [{ path: 'id', message: 'the tenant declares the residency of its own Langfuse' }],
        target,
      };
    const spec = { ...before, residency: residency.data };
    await appendVersion<TraceConnection>(deps.configEntries, {
      kind: traceConnectionKind,
      scope: tenant,
      id,
      spec,
      deleted: false,
      by: actorOf(principal),
      reason: String(input.reason ?? ''),
    });
    return { ok: true, value: spec, target, audit: { before, after: spec } };
  };

  return {
    list,
    find,
    coveringService,
    onInstance,
    check,
    save,
    remove,
    setResidency,
    secretProblems,
  };
};

export type TraceConnections = ReturnType<typeof traceConnections>;

/** A connection as it is saved now, also while it is being removed. */
export const connectionOf = async (configEntries: ConfigEntryStore, tenant: string, id: string) =>
  (await configEntries.latest({ kind: traceConnectionKind, scope: tenant }))
    .filter((e) => !e.deleted)
    .map((e) => e.spec as TraceConnection)
    .find((c) => c.id === id);

/**
 * Records a batch's traces as sent to a connection before the batch goes out, so a trace is
 * never in a sink without genki knowing to delete it. Nothing goes to a connection that is being
 * removed or is gone: what was just recorded is queued for deletion, or settled, since it was
 * never sent.
 */
export const deliveryGate =
  (deps: {
    configEntries: ConfigEntryStore;
    deliveries: Pick<TraceDeliveryStore, 'record' | 'markPending' | 'settle'>;
    tenant: string;
    sink: string;
    /** Where the run's exporter sends: deletes go where the connection points now. */
    opened?: Pick<TraceConnection, 'host' | 'publicKey'>;
    now: () => string;
  }) =>
  async (traces: { trace: string; task: string }[]) => {
    const live = async () => {
      const current = await connectionOf(deps.configEntries, deps.tenant, deps.sink);
      if (!current) return 'gone';
      if (current.removing) return 'removing';
      // Moved to another host or project since the run opened: its traces could not be deleted.
      const moved =
        deps.opened &&
        (current.host !== deps.opened.host || current.publicKey !== deps.opened.publicKey);
      return moved ? 'moved' : 'live';
    };
    if ((await live()) !== 'live') return false;
    const sent = traces.map((t) => ({ tenant: deps.tenant, sink: deps.sink, ...t }));
    await deps.deliveries.record(sent, deps.now());
    const after = await live();
    if (after === 'live') return true;
    if (after === 'removing')
      await deps.deliveries.markPending(deps.tenant, { sink: deps.sink }, deps.now());
    else if (after === 'gone' || after === 'moved')
      for (const s of sent)
        await deps.deliveries.settle(
          { ...s, state: 'sent', attempts: 0, updatedAt: deps.now() },
          { deleted: true },
          deps.now(),
        );
    return false;
  };

/** Every connection that covers a service: more than one means the service is sent nowhere. */
export const connectionsCovering = async (
  configEntries: ConfigEntryStore,
  tenant: string,
  service: string,
) =>
  (await configEntries.latest({ kind: traceConnectionKind, scope: tenant }))
    .filter((e) => !e.deleted)
    .map((e) => e.spec as TraceConnection)
    .filter((c) => !c.removing && c.services.includes(service))
    .sort((a, b) => a.id.localeCompare(b.id));

/** A judge in a connection's project, refused with why when genki cannot use it (ADR 0040). */
export interface SinkJudge {
  /** The evaluator and its metric. */
  id: string;
  name: string;
  /** provider/model, absent when the judge falls back to a default model. */
  model?: string;
  version: string;
  dataType: string;
  fields: { variable: string; source: string; jsonPath?: string }[];
  refused?: { reason: string; field?: string; message: string };
  /** The judge as it was read, which a run scores with. */
  snapshot: unknown;
}

/** Where an eval run's case traces go: opened for a run, closed (flushed) when it ends. */
export interface TraceSinks {
  /**
   * beforeSend sees each batch's traces before it goes out, and false drops the batch. Text goes
   * only to a connection that receives content, and then only the fields named.
   */
  open(
    run: string,
    tenant: string,
    connection: TraceConnection,
    beforeSend?: (traces: { trace: string; task: string }[]) => Promise<boolean>,
    fields?: string[],
  ): void;
  /** The judges of the connection's project that can score an eval run. */
  judges?(tenant: string, connection: TraceConnection): Promise<SinkJudge[]>;
  /** Whether a judge building block is one of the connection's judges. */
  judgeOf?(connection: string, block: string): boolean;
  /** Whether a run's judge identity, or an evaluator, is a sink's judge. */
  isSinkJudge?(judge: string): boolean;
  /** Where the sink shows a run as an experiment. */
  experimentUrl?(
    tenant: string,
    connection: TraceConnection,
    run: string,
  ): Promise<string | undefined>;
  /** The content fields the judges read. */
  fieldsOf?(judges: SinkJudge[]): string[];
  /** Flushes the run's sink and answers the case tasks whose traces went there. */
  close(run: string): Promise<string[]>;
  /** The id the sink knows a case task's trace by. */
  traceIdOf(task: string): string;
}

/** A connection as a tenant reads it: the secret's reference, never its value. */
const view = (connections: TraceConnections) => (c: TraceConnection) => ({
  ...c,
  instance: connections.onInstance(c.host),
  residencySetBy: connections.onInstance(c.host) ? ('operator' as const) : ('tenant' as const),
});

export const traceConnectionsModule: PlatformModuleFactory = (deps) => {
  const options = deps.tracing ?? {};
  const connections = traceConnections(
    {
      configEntries: deps.configEntries,
      ...(deps.tenantSecrets ? { tenantSecrets: deps.tenantSecrets } : {}),
      ...(deps.traceDeliveries ? { deliveries: deps.traceDeliveries } : {}),
      egress: tracingEgress(deps.egressOptions ?? {}, options.devMode),
    },
    options,
  );
  const shown = view(connections);
  return {
    id: 'trace-connections',
    handlers: {
      'platform.tracing.connection.save': connections.save,
      'platform.tracing.connection.remove': connections.remove,
      'platform.tracing.connection.residency': connections.setResidency,
    },
    mount: (app, mountDeps) => {
      const member = async (c: Context) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mountDeps.access, principal, tenant);
        if ('response' in entered) return { response: entered.response };
        // The entered principal: an operator outside a support session has no more than members.
        return { principal: entered.principal, tenant };
      };
      const reasonOf = (c: Context) => (changeReasonOf(c) ?? '').trim();
      const perform = async (
        c: Context,
        principal: Principal,
        tenant: string,
        action: (typeof traceConnectionActions)[number],
        input: Record<string, unknown>,
      ) => {
        const reason = reasonOf(c);
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', {
            errors: [{ path: 'change-reason', message: reasonTooShort }],
          });
        const result = await mountDeps.admin.perform<TraceConnection>(
          { ...principal, tenant },
          action,
          { tenant, reason, ...input },
        );
        c.header('genai-task', result.task);
        if (!result.ok)
          return refusedBy(c, new AdminRefused(result.errors, result.task, result.problem));
        return c.json(result.value);
      };

      app.get('/tenants/:tenant/tracing/connections', async (c) => {
        const guard = await member(c);
        if ('response' in guard) return guard.response;
        return c.json({ data: (await connections.list(guard.tenant)).map(shown) });
      });

      app.put('/tenants/:tenant/tracing/connections/:id', async (c) => {
        const guard = await member(c);
        if ('response' in guard) return guard.response;
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        const connection = { ...body, id: c.req.param('id') };
        // Checked before the admin task starts, so a key typed in clear never enters its input.
        const parsed = traceConnection.safeParse(connection);
        if (!parsed.success)
          return problem(c, 400, 'Invalid request', { errors: errorsOf(parsed.error) });
        const secret = await connections.secretProblems(guard.tenant, parsed.data);
        if (secret.length > 0) return problem(c, 400, 'Invalid request', { errors: secret });
        return perform(c, guard.principal, guard.tenant, 'platform.tracing.connection.save', {
          connection,
        });
      });

      app.delete('/tenants/:tenant/tracing/connections/:id', async (c) => {
        const guard = await member(c);
        if ('response' in guard) return guard.response;
        // Only someone who may change connections learns that one does not exist.
        if (
          rightsOf(guard.principal, guard.tenant).has('manage-services') &&
          !(await connections.find(guard.tenant, c.req.param('id') ?? ''))
        )
          return problem(c, 404, 'Not found');
        return perform(c, guard.principal, guard.tenant, 'platform.tracing.connection.remove', {
          id: c.req.param('id'),
        });
      });

      app.post('/tenants/:tenant/tracing/connections/:id/check', async (c) => {
        const guard = await member(c);
        if ('response' in guard) return guard.response;
        const found = await connections.find(guard.tenant, c.req.param('id') ?? '');
        if (!found) return problem(c, 404, 'Not found');
        try {
          const checked = await connections.check(guard.tenant, found);
          return checked.ok
            ? c.json({ ok: true, project: checked.project })
            : problem(c, 422, 'Langfuse refused the keys', {
                errors: [{ path: 'host', message: `HTTP ${checked.status}` }],
              });
        } catch (error) {
          return problem(c, 422, 'Langfuse could not be reached', {
            errors: [
              { path: 'host', message: error instanceof Error ? error.message : String(error) },
            ],
          });
        }
      });

      app.put('/operator/tracing/connections/:tenant/:id/residency', async (c) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Unauthorized');
        if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        return perform(
          c,
          principal,
          c.req.param('tenant') ?? '',
          'platform.tracing.connection.residency',
          { id: c.req.param('id'), residency: body.residency },
        );
      });
    },
  };
};
