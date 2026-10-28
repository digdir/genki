import type { Principal } from '@genai/contracts';
import {
  rightsToApprove,
  type AssistantProposal,
  type ConnectorMapping,
  type ConnectorSource,
  type PlatformChangeStatus,
  type ProposalPermission,
  type ProposalTest,
} from '@genai/strategy-builder';
import type { Context, Env, Hono, Schema } from 'hono';
import { actorNames } from './actor-names.js';
import { actorOf, type Admin, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, serialized, type ConfigEntry } from './config-store.js';
import type { ModuleDeps, MountDeps, PlatformModuleFactory } from './platform-modules.js';
import {
  carriesAltinnActions,
  requireRight,
  rightLabels,
  rightRefused,
  rightsOf,
  type Right,
} from './rights.js';
import { enterTenant } from './access.js';
import { actorNameOf, changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { connectOnApproval, connectorMappingKind, type ConnectorLink } from './connectors.js';

export { connectorMappingKind };
export const proposalKind = 'catalog-proposal';

export type ProposalState = 'pending' | 'sent_for_approval' | 'approved' | 'rejected';
export type StoredLevel = 2 | 3 | 4;

export interface ChangedBy {
  by: string;
  byName?: string;
  at: string;
  reason: string;
}

export interface ProposalItem {
  id: string;
  kind: 'dataset' | 'tool';
  name: string;
  description: string;
  publisher: { type: 'own'; name: string };
  version: string;
  dataLocation: null;
  capabilities: string[];
  permissions: ProposalPermission[];
  contractTests: ProposalTest[];
}

export interface CatalogProposal {
  id: string;
  title?: string;
  level: StoredLevel;
  createdBy: 'assistant';
  requestedBy?: string;
  requestedByName?: string;
  forService: { id: string; name: string };
  createdAt: string;
  ask?: string;
  detail?: string;
  item?: ProposalItem;
  mapping?: ConnectorMapping[];
  source?: ConnectorSource;
  permissions: ProposalPermission[];
  tests: ProposalTest[];
  quality?: string;
  state: ProposalState;
  platformChange?: {
    summary: string;
    caseId: string;
    status: PlatformChangeStatus;
    rejectionReason?: string;
  };
  decision?: ChangedBy;
}

export interface OperatorProposal extends CatalogProposal {
  tenant: string;
}

export interface ProposalDecision {
  proposal: CatalogProposal;
  changedBy: ChangedBy;
}

export interface ConnectorMappingSpec {
  service: string;
  proposal: string;
  name: string;
  mapping: ConnectorMapping[];
  permissions: ProposalPermission[];
  connector?: ConnectorLink;
}

export type DecisionOp = 'approve' | 'reject' | 'send-for-approval';

export interface ProposalsOptions {
  now?: () => Date;
  newId?: () => string;
}

const operatorStatuses = ['under_review', 'planned', 'rejected'] as const;

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'byggekloss';

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const actorName = (principal: Principal) => actorOf(principal.actor ?? principal);
const forTenant = (principal: Principal, tenant: string) =>
  principal.kind === 'operator' || principal.tenant === tenant;

const itemFor = (proposal: AssistantProposal, tenant: string): ProposalItem | undefined =>
  proposal.level === 2 || proposal.level === 3
    ? {
        id: slugOf(proposal.title),
        kind: proposal.level === 2 ? 'dataset' : 'tool',
        name: proposal.title,
        description: proposal.detail,
        publisher: { type: 'own', name: tenant },
        version: '1',
        dataLocation: null,
        capabilities: [],
        permissions: proposal.permissions ?? [],
        contractTests: proposal.tests ?? [],
      }
    : undefined;

const optionalName = (name: string | undefined) => (name ? { requestedByName: name } : {});

export const endpointOf = (proposal: CatalogProposal) =>
  proposal.permissions.find((p) => p.type === 'network' && /^https?:\/\//.test(p.value))?.value;

export const createProposalsModule =
  (options: ProposalsOptions = {}): PlatformModuleFactory =>
  (deps: ModuleDeps) => {
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? (() => crypto.randomUUID());
    const writes = serialized();

    const current = async (tenant: string, id: string) => {
      const found = (await deps.configEntries.history(proposalKind, tenant, id)).at(-1);
      return found && !found.deleted ? (found as ConfigEntry<CatalogProposal>) : undefined;
    };

    const save = (tenant: string, proposal: CatalogProposal, by: string, reason: string) =>
      appendVersion<CatalogProposal>(deps.configEntries, {
        kind: proposalKind,
        scope: tenant,
        id: proposal.id,
        spec: proposal,
        deleted: false,
        by,
        reason,
      });

    const nextCaseId = async () => {
      const year = now().getFullYear();
      const prefix = `KI-${year}-`;
      const taken = (await deps.configEntries.latest({ kind: proposalKind }))
        .map((e) => (e.spec as CatalogProposal).platformChange?.caseId ?? '')
        .filter((c) => c.startsWith(prefix))
        .map((c) => Number(c.slice(prefix.length)))
        .filter(Number.isFinite);
      return `${prefix}${String(Math.max(0, ...taken) + 1).padStart(4, '0')}`;
    };

    const handlers: Record<string, AdminHandler> = {
      'platform.proposal.create': (input, principal) =>
        writes(async () => {
          const { tenant, reason } = input;
          const target = `catalog-proposal:${tenant}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant stores its proposals');
          const proposal = input.proposal as AssistantProposal;
          const forService = input.forService as { id: string; name: string };
          if (proposal.level === 1)
            return failed(target, 'level', 'level 1 proposals are never stored');
          const id = newId();
          const item = itemFor(proposal, tenant);
          const stored: CatalogProposal = {
            id,
            title: proposal.title,
            level: proposal.level,
            createdBy: 'assistant',
            requestedBy: actorName(principal),
            ...((principal.actor ?? principal).name
              ? { requestedByName: (principal.actor ?? principal).name }
              : {}),
            forService,
            createdAt: now().toISOString(),
            ...(typeof input.ask === 'string' && input.ask.trim() ? { ask: input.ask.trim() } : {}),
            ...(proposal.detail ? { detail: proposal.detail } : {}),
            ...(item ? { item } : {}),
            ...(proposal.mapping ? { mapping: proposal.mapping } : {}),
            ...(proposal.source ? { source: proposal.source } : {}),
            permissions: proposal.permissions ?? [],
            tests: proposal.tests ?? [],
            ...(proposal.quality ? { quality: proposal.quality } : {}),
            state: 'pending',
            ...(proposal.level === 4
              ? {
                  platformChange: {
                    summary: proposal.platformChange?.summary ?? proposal.title,
                    caseId: await nextCaseId(),
                    status: 'sent' as const,
                  },
                }
              : {}),
          };
          await save(tenant, stored, actorName(principal), reason);
          return {
            ok: true,
            value: stored,
            target: `${target}/${id}`,
            audit: { after: { level: stored.level, state: stored.state } },
          };
        }),

      'platform.proposal.decide': (input, principal) =>
        writes(async () => {
          const { tenant, reason } = input;
          const id = String(input.id);
          const op = input.op as DecisionOp;
          const target = `catalog-proposal:${tenant}/${id}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant decides its proposals');
          if (!isReasonLongEnough(reason)) return failed(target, 'reason', reasonTooShort);
          const found = await current(tenant, id);
          if (!found) return failed(target, 'proposal', `no proposal ${id}`);
          const proposal = found.spec;
          if (proposal.level === 4)
            return failed(target, 'status', 'Digdir decides platform changes');
          if (
            op === 'approve' &&
            proposal.level === 3 &&
            carriesAltinnActions(principal) &&
            !rightsOf(principal, tenant).has('register-building-blocks')
          )
            return failed(
              target,
              'principal',
              `Du trenger rettigheten «${rightLabels['register-building-blocks']}»`,
            );
          const open =
            op === 'send-for-approval'
              ? proposal.state === 'pending'
              : proposal.state === 'pending' || proposal.state === 'sent_for_approval';
          if (!open) return failed(target, 'status', `the proposal is ${proposal.state}`);
          const by = actorName(principal);
          const changedBy: ChangedBy = { by, at: now().toISOString(), reason: reason.trim() };
          const contractTests = (input.contractTests as ProposalTest[] | undefined) ?? undefined;
          const connector = input.connector as ConnectorLink | undefined;
          const next: CatalogProposal = {
            ...proposal,
            state:
              op === 'approve' ? 'approved' : op === 'reject' ? 'rejected' : 'sent_for_approval',
            decision: changedBy,
            ...(contractTests
              ? {
                  tests: contractTests,
                  ...(proposal.item ? { item: { ...proposal.item, contractTests } } : {}),
                }
              : {}),
          };
          if (op === 'approve' && proposal.level === 2)
            await appendVersion<ConnectorMappingSpec>(deps.configEntries, {
              kind: connectorMappingKind,
              scope: tenant,
              id: `${proposal.forService.id}.${proposal.id}`,
              spec: {
                service: proposal.forService.id,
                proposal: proposal.id,
                name: proposal.item?.name ?? proposal.forService.name,
                mapping: proposal.mapping ?? [],
                permissions: proposal.permissions,
                ...(connector ? { connector } : {}),
              },
              deleted: false,
              by,
              reason: changedBy.reason,
            });
          await save(tenant, next, by, changedBy.reason);
          return {
            ok: true,
            value: { proposal: next, changedBy } satisfies ProposalDecision,
            target,
            audit: {
              before: { state: proposal.state },
              after: {
                state: next.state,
                ...(connector
                  ? {
                      connector: {
                        host: connector.connection.host,
                        port: connector.connection.port,
                        database: connector.connection.database,
                        tls: connector.connection.tls,
                      },
                    }
                  : {}),
              },
            },
          };
        }),

      'platform.proposal.status': (input, principal) =>
        writes(async () => {
          const { tenant, reason } = input;
          const id = String(input.id);
          const status = input.status as PlatformChangeStatus;
          const target = `catalog-proposal:${tenant}/${id}`;
          if (principal.kind !== 'operator')
            return failed(target, 'principal', 'only operators move platform changes');
          if (!isReasonLongEnough(reason)) return failed(target, 'reason', reasonTooShort);
          const found = await current(tenant, id);
          if (!found || found.spec.level !== 4 || !found.spec.platformChange)
            return failed(target, 'proposal', `no platform change ${id}`);
          const proposal = found.spec;
          const was = proposal.platformChange?.status ?? 'sent';
          if (was === 'planned' || was === 'rejected')
            return failed(target, 'status', `the platform change is already ${was}`);
          const changedBy: ChangedBy = {
            by: actorName(principal),
            ...(typeof input.byName === 'string' && input.byName ? { byName: input.byName } : {}),
            at: now().toISOString(),
            reason: reason.trim(),
          };
          const next: CatalogProposal = {
            ...proposal,
            state:
              status === 'planned'
                ? 'approved'
                : status === 'rejected'
                  ? 'rejected'
                  : proposal.state,
            platformChange: {
              summary: proposal.platformChange?.summary ?? '',
              caseId:
                typeof input.caseId === 'string' && input.caseId.trim()
                  ? input.caseId.trim()
                  : (proposal.platformChange?.caseId ?? ''),
              status,
              ...(status === 'rejected' ? { rejectionReason: changedBy.reason } : {}),
            },
            decision: changedBy,
          };
          await save(tenant, next, changedBy.by, changedBy.reason);
          return {
            ok: true,
            value: { proposal: next, changedBy } satisfies ProposalDecision,
            target,
            audit: { before: { status: was }, after: { status } },
          };
        }),
    };

    return {
      id: 'proposals',
      handlers,
      mount: (app, mountDeps) => mountRoutes(app, mountDeps.admin, mountDeps, current),
    };
  };

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  title: string,
  errors: unknown[] = [],
  extra: Record<string, unknown> = {},
) =>
  c.json({ type: 'about:blank', title, status, errors, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

const queueStatus = (proposal: CatalogProposal) =>
  proposal.state === 'approved' || proposal.state === 'rejected' ? proposal.state : 'pending';

const mountRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  admin: Admin,
  deps: MountDeps,
  current: (tenant: string, id: string) => Promise<ConfigEntry<CatalogProposal> | undefined>,
) => {
  const body = async (c: Context) =>
    (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reasonOf = (c: Context) => (changeReasonOf(c) ?? '').trim();

  const member = async (c: Context, right?: Right) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    const tenant = c.req.param('tenant') ?? '';
    const entered = enterTenant(c, deps.access, principal, tenant, right);
    if ('response' in entered) return { response: entered.response };
    return { principal: entered.principal, tenant };
  };

  const operator = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
    return { principal };
  };

  const needsReason = (c: Context, reason: string) =>
    !isReasonLongEnough(reason)
      ? problem(c, 400, 'Invalid request', [{ path: 'change-reason', message: reasonTooShort }])
      : undefined;

  const perform = async (
    c: Context,
    principal: Principal,
    action: string,
    data: Record<string, unknown> & { tenant: string; reason: string },
  ) => {
    const result = await admin.perform(principal, action, data);
    c.header('genai-task', result.task);
    if (result.ok) return c.json(result.value as object, 200);
    const paths = new Set(result.errors.map((e) => e.path));
    if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
    if (paths.has('proposal')) return problem(c, 404, 'Not found', result.errors);
    if (paths.has('status')) return problem(c, 409, 'Conflict', result.errors);
    return problem(c, 400, 'Invalid request', result.errors);
  };

  const list = async (scope?: string) =>
    (await deps.configEntries.latest({ kind: proposalKind, ...(scope ? { scope } : {}) }))
      .filter((e) => !e.deleted)
      .map((e) => ({ tenant: e.scope, proposal: e.spec as CatalogProposal }))
      .sort((a, b) => b.proposal.createdAt.localeCompare(a.proposal.createdAt));

  const base = '/tenants/:tenant/proposals';

  app.get(base, async (c) => {
    const guard = await member(c, 'use-services');
    if (guard.response) return guard.response;
    const level = c.req.query('level');
    const state = c.req.query('state');
    const data = (await list(guard.tenant))
      .map((p) => p.proposal)
      .filter((p) => (!level || String(p.level) === level) && (!state || p.state === state));
    return c.json({ data });
  });

  app.get(`${base}/:pid`, async (c) => {
    const guard = await member(c, 'use-services');
    if (guard.response) return guard.response;
    const found = await current(guard.tenant, c.req.param('pid') ?? '');
    if (!found) return problem(c, 404, 'Not found');
    return c.json(found.spec);
  });

  const register = async (
    c: Context,
    tenant: string,
    proposal: CatalogProposal,
    reason: string,
  ) => {
    const endpoint = endpointOf(proposal);
    if (!proposal.item || !endpoint)
      return {
        response: problem(c, 422, 'Forslaget mangler adressen til byggeklossen', [
          { path: 'permissions', message: 'a network permission with the endpoint URL is needed' },
        ]),
      };
    const headers = new Headers(c.req.raw.headers);
    for (const name of ['content-length', 'change-reason']) headers.delete(name);
    headers.set('content-type', 'application/json');
    headers.set('change-reason', encodeURIComponent(reason));
    const response = await app.request(`/tenants/${tenant}/building-blocks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'mcp',
        name: proposal.item.name,
        id: proposal.item.id,
        endpoint,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      contractTests?: ProposalTest[];
    };
    if (response.status !== 201)
      return {
        response: c.json(result, response.status as 400 | 403 | 422, {
          'content-type': 'application/problem+json',
        }),
      };
    return { contractTests: result.contractTests ?? [] };
  };

  const decide = (op: DecisionOp) => async (c: Context) => {
    const guard = await member(c, op === 'send-for-approval' ? 'use-services' : 'manage-services');
    if (guard.response) return guard.response;
    const input = await body(c);
    const reason = reasonOf(c);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    const pid = c.req.param('pid') ?? '';
    const found = await current(guard.tenant, pid);
    if (!found) return problem(c, 404, 'Not found');
    const proposal = found.spec;
    if (proposal.level === 4)
      return problem(c, 409, 'Conflict', [
        { path: 'status', message: 'Digdir decides platform changes' },
      ]);
    let contractTests: ProposalTest[] | undefined;
    let connected:
      | { link: ConnectorLink; rollback: () => Promise<void>; firstSync: () => Promise<void> }
      | undefined;
    if (op === 'approve') {
      if (proposal.state !== 'pending' && proposal.state !== 'sent_for_approval')
        return problem(c, 409, 'Conflict', [
          { path: 'status', message: `the proposal is ${proposal.state}` },
        ]);
      for (const right of rightsToApprove[proposal.level]) {
        const check = requireRight(guard.principal, guard.tenant, right as Right);
        if (!check.ok) return rightRefused(c, check.problem);
      }
      if (proposal.level === 3) {
        const registered = await register(c, guard.tenant, proposal, reason);
        if (registered.response) return registered.response;
        contractTests = registered.contractTests;
      }
      if (proposal.level === 2) {
        const result = await connectOnApproval(
          c,
          app,
          deps,
          guard.tenant,
          proposal,
          input,
          reason,
          guard.principal,
        );
        if ('response' in result) return result.response;
        connected = result;
      }
    }
    const response = await perform(c, guard.principal, 'platform.proposal.decide', {
      tenant: guard.tenant,
      reason,
      id: pid,
      op,
      level: proposal.level,
      ...(contractTests ? { contractTests } : {}),
      ...(connected ? { connector: connected.link } : {}),
    });
    if (connected && response.status !== 200) await connected.rollback();
    else if (connected) await connected.firstSync();
    return response;
  };

  app.post(`${base}/:pid/approve`, decide('approve'));
  app.post(`${base}/:pid/reject`, decide('reject'));
  app.post(`${base}/:pid/send-for-approval`, decide('send-for-approval'));

  app.get('/operator/proposals', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const level = c.req.query('level');
    const status = c.req.query('status');
    const names = await admin.tenantNames();
    const found = await Promise.all(
      (await list()).map(async ({ tenant, proposal }) => ({
        tenant,
        proposal,
        requester:
          proposal.requestedBy ??
          (await deps.configEntries.history(proposalKind, tenant, proposal.id)).at(0)?.by,
      })),
    );
    const people = await actorNames(deps.configEntries).namesOf(
      found.flatMap(({ requester }) => (requester ? [requester] : [])),
    );
    const data = found
      .map(({ tenant, proposal, requester }) => ({
        ...proposal,
        ...(proposal.requestedByName || !requester ? {} : optionalName(people.get(requester))),
        tenant,
        tenantName: names.get(tenant) ?? tenant,
        title: proposal.title ?? proposal.item?.name ?? proposal.platformChange?.summary ?? '',
        summary: proposal.platformChange?.summary ?? proposal.item?.description ?? '',
        status: queueStatus(proposal),
        ...(proposal.platformChange?.caseId ? { caseId: proposal.platformChange.caseId } : {}),
      }))
      .filter(
        (p) =>
          (!level || String(p.level) === level) &&
          (!status || p.status === status || p.platformChange?.status === status),
      );
    return c.json({ data });
  });

  app.post('/operator/proposals/:pid/decision', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const input = await body(c);
    const reason = reasonOf(c);
    if (typeof input.approve !== 'boolean')
      return problem(c, 400, 'Invalid request', [
        { path: 'approve', message: 'approve must be true or false' },
      ]);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    const pid = c.req.param('pid') ?? '';
    const found = (await list()).find((p) => p.proposal.id === pid);
    if (!found) return problem(c, 404, 'Not found');
    return perform(
      c,
      { ...guard.principal, tenant: deps.platformTenant },
      'platform.proposal.status',
      {
        tenant: found.tenant,
        reason,
        id: pid,
        status: input.approve ? 'planned' : 'rejected',
        ...(typeof input.caseId === 'string' ? { caseId: input.caseId } : {}),
        byName: actorNameOf(c),
      },
    );
  });

  app.post('/operator/proposals/:pid/status', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const input = await body(c);
    const reason = reasonOf(c);
    const status = input.status as (typeof operatorStatuses)[number];
    if (!operatorStatuses.includes(status))
      return problem(c, 400, 'Invalid request', [
        { path: 'status', message: `must be one of ${operatorStatuses.join(', ')}` },
      ]);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    const pid = c.req.param('pid') ?? '';
    const found = (await list()).find((p) => p.proposal.id === pid);
    if (!found) return problem(c, 404, 'Not found');
    return perform(
      c,
      { ...guard.principal, tenant: deps.platformTenant },
      'platform.proposal.status',
      {
        tenant: found.tenant,
        reason,
        id: pid,
        status,
        byName: actorNameOf(c),
      },
    );
  });
};

export const storeProposal = async (
  admin: Admin,
  principal: Principal,
  tenant: string,
  forService: { id: string; name: string },
  proposal: AssistantProposal,
  ask?: string,
) => {
  const result = await admin.perform<CatalogProposal>(principal, 'platform.proposal.create', {
    tenant,
    reason: 'Foreslått av byggeassistenten',
    proposal,
    forService,
    ...(ask ? { ask } : {}),
  });
  return result.ok ? result.value : undefined;
};

export const proposalsModule: PlatformModuleFactory = createProposalsModule();
