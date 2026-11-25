import type { BlockReview, Principal } from '@genai/contracts';
import {
  blockFilePaths,
  type BlockDefinition,
  type PublishedVersion,
  type ValidationError,
} from '@genai/definitions';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, routeOnlyActions } from './admin.js';
import { isBlockArchived } from './block-archive.js';
import type { ConfigEntryStore } from './config-store.js';
import { appendVersion, serialized } from './config-store.js';
import { onForTenant, requireFlag } from './feature-flags.js';
import { changeReasonOf, problem } from './http.js';
import { t } from './i18n/index.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const blockShareRequestKind = 'block-share-request';

export const blockShareActions = {
  request: 'platform.block-share.request',
  approve: 'platform.block-share.approve',
  decline: 'platform.block-share.decline',
} as const;

export const blockShareProblems = {
  operatorOnly: 'urn:genai:problem:block-share-operator-only',
  pending: 'urn:genai:problem:block-share-pending',
  notPending: 'urn:genai:problem:block-share-not-pending',
  stale: 'urn:genai:problem:block-share-stale',
  studioOff: 'urn:genai:problem:block-share-studio-off',
} as const;

export type ShareRequestStatus = 'pending' | 'approved' | 'declined';

export interface ShareRequest {
  id: string;
  tenant: string;
  block: string;
  version: number;
  status: ShareRequestStatus;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  decidedBy?: string;
  decidedAt?: string;
  decision?: string;
  sharedVersion?: number;
}

class ApprovalFailed extends Error {
  constructor(
    readonly errors: ValidationError[],
    readonly status: 409 | 422 = 422,
    readonly type?: string,
  ) {
    super(errors[0]?.message ?? 'not approved');
  }
}

const isRequest = (spec: unknown): spec is ShareRequest =>
  typeof spec === 'object' && spec !== null && typeof (spec as ShareRequest).id === 'string';

/** Every request on a block, each in its latest state, newest first. */
const requestsOf = async (store: ConfigEntryStore, tenant: string, block: string) => {
  const latest = new Map<string, ShareRequest>();
  for (const entry of await store.history(blockShareRequestKind, tenant, block))
    if (isRequest(entry.spec)) latest.set(entry.spec.id, entry.spec);
  return [...latest.values()].reverse();
};

/** The review of the newest request on a block, as the block detail shows it. */
export const latestReview = async (
  store: ConfigEntryStore,
  tenant: string,
  block: string,
): Promise<BlockReview | undefined> => {
  const newest = (await requestsOf(store, tenant, block))[0];
  if (!newest) return undefined;
  return {
    status: newest.status,
    version: newest.version,
    at: newest.decidedAt ?? newest.requestedAt,
    ...(newest.decision ? { reason: newest.decision } : {}),
  };
};

const sourcesOf = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).filter(([name]) => name.startsWith(blockFilePaths.sourcePrefix)),
  );

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

export const createBlockReviewsModule =
  (options: { now?: () => Date } = {}): PlatformModuleFactory =>
  (deps) => {
    const store = deps.configEntries;
    const definitions = deps.definitions;
    const now = options.now ?? (() => new Date());
    const writes = serialized();

    const save = (request: ShareRequest, by: string, reason: string) =>
      appendVersion(store, {
        kind: blockShareRequestKind,
        scope: request.tenant,
        id: request.block,
        spec: request,
        deleted: false,
        by,
        reason,
        at: now().toISOString(),
      });

    const allCurrent = async () =>
      (await store.latest({ kind: blockShareRequestKind }))
        .map((entry) => entry.spec)
        .filter(isRequest);

    const findRequest = async (id: string) => (await allCurrent()).find((r) => r.id === id);

    const editionOf = (request: ShareRequest) =>
      definitions.get('Block', request.tenant, request.block, request.version);

    return {
      id: 'block-reviews',
      handlers: routeOnlyActions(Object.values(blockShareActions)),
      mount: (app, mounted: MountDeps) => {
        const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
        const studio = requireFlag(mounted, 'blockStudio');

        const operator = async (c: Context) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, t('problems.unauthorized')) };
          if (principal.kind !== 'operator')
            return {
              response: problem(c, 403, t('problems.blockShareOperatorOnly'), {
                type: blockShareProblems.operatorOnly,
                errors: [{ path: 'principal', message: t('problems.blockShareOperatorOnly') }],
              }),
            };
          return { principal };
        };

        const refused = (c: Context, error: unknown) => {
          if (error instanceof AdminRefused)
            return problem(c, 403, error.message, { errors: error.errors });
          throw error;
        };

        app.post('/tenants/:tenant/blocks/:id/share-requests', studio, async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, t('problems.unauthorized'));
          const tenant = c.req.param('tenant') ?? '';
          const block = c.req.param('id') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-services');
          if ('response' in entered) return entered.response;
          const body = (await c.req.json().catch(() => ({}))) as { version?: unknown };
          const version = body.version;
          if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
            return problem(c, 400, t('problems.invalidRequest'), {
              errors: [
                {
                  path: 'version',
                  message: 'version is the number of a saved edition of the block',
                },
              ],
            });
          const asked = await writes(async () => {
            const edition = await definitions.get('Block', tenant, block, version);
            if (!edition || edition.version !== version)
              return { response: problem(c, 404, t('problems.blockNotFound')) };
            const spec = (edition.definition as BlockDefinition).spec;
            if (spec.tier !== 'code')
              return {
                response: problem(c, 422, t('problems.blockShareNotCode'), {
                  errors: [{ path: 'version', message: t('problems.blockShareNotCode') }],
                }),
              };
            if (spec.sharing === 'everyone')
              return {
                response: problem(c, 422, t('problems.blockShareAlreadyShared'), {
                  errors: [{ path: 'version', message: t('problems.blockShareAlreadyShared') }],
                }),
              };
            if ((await definitions.get('Block', tenant, block))?.version !== version)
              return {
                response: problem(c, 422, t('problems.blockShareNotLatest'), {
                  errors: [{ path: 'version', message: t('problems.blockShareNotLatest') }],
                }),
              };
            if (await isBlockArchived(store, tenant, block, version))
              return { response: problem(c, 404, t('problems.blockNotFound')) };
            if ((await requestsOf(store, tenant, block)).some((r) => r.status === 'pending'))
              return {
                response: problem(c, 409, t('problems.blockSharePending'), {
                  type: blockShareProblems.pending,
                }),
              };
            const reason = reasonOf(c);
            const request: ShareRequest = {
              id: crypto.randomUUID(),
              tenant,
              block,
              version,
              status: 'pending',
              requestedBy: actorOf(entered.principal.actor ?? entered.principal),
              requestedAt: now().toISOString(),
              reason,
            };
            try {
              const done = await mounted.admin.within(
                entered.principal,
                blockShareActions.request,
                { tenant, reason, block, version },
                async () => {
                  await save(request, request.requestedBy, reason);
                  return { value: request, target: `block:${tenant}/${block}@${version}` };
                },
              );
              c.header('genai-task', done.task);
            } catch (error) {
              return { response: refused(c, error) };
            }
            return { request };
          });
          if ('response' in asked) return asked.response;
          const request = asked.request;
          return c.json(
            { id: request.id, status: request.status, version, at: request.requestedAt },
            201,
          );
        });

        app.get('/tenants/:tenant/blocks/:id/share-requests', studio, async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, t('problems.unauthorized'));
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant);
          if ('response' in entered) return entered.response;
          const requests = await requestsOf(store, tenant, c.req.param('id') ?? '');
          return c.json({ data: requests });
        });

        const rowOf = async (request: ShareRequest, names: Map<string, string>) => {
          const edition = await editionOf(request);
          const spec = (edition?.definition as BlockDefinition | undefined)?.spec;
          const files = edition?.files ?? {};
          return {
            ...request,
            tenantName: names.get(request.tenant) ?? request.tenant,
            title: spec?.title ?? {},
            reads: spec?.code?.reads ?? [],
            events: spec?.events ?? [],
            bytes: spec?.code?.bytes ?? 0,
            sha256: spec?.code?.sha256 ?? '',
            sourceFiles: Object.entries(sourcesOf(files)).map(([path, text]) => ({
              path,
              bytes: bytesOf(text),
            })),
          };
        };

        app.get('/operator/block-share-requests', studio, async (c) => {
          const guard = await operator(c);
          if (guard.response) return guard.response;
          const status = c.req.query('status');
          const names = await mounted.admin.tenantNames();
          const requests = (await allCurrent())
            .filter((r) => status === undefined || r.status === status)
            .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
          return c.json({ data: await Promise.all(requests.map((r) => rowOf(r, names))) });
        });

        app.get('/operator/block-share-requests/:rid', studio, async (c) => {
          const guard = await operator(c);
          if (guard.response) return guard.response;
          const request = await findRequest(c.req.param('rid') ?? '');
          if (!request) return problem(c, 404, t('problems.blockShareNotFound'));
          const edition = await editionOf(request);
          const files = edition?.files ?? {};
          return c.json({
            ...(await rowOf(request, await mounted.admin.tenantNames())),
            bundle: files[blockFilePaths.bundle] ?? '',
            sources: sourcesOf(files),
          });
        });

        const decide = (outcome: 'approved' | 'declined') => async (c: Context) => {
          const guard = await operator(c);
          if (guard.response) return guard.response;
          return writes(() => decideOne(c, guard.principal, outcome));
        };

        const decideOne = async (
          c: Context,
          principal: Principal,
          outcome: 'approved' | 'declined',
        ) => {
          const request = await findRequest(c.req.param('rid') ?? '');
          if (!request) return problem(c, 404, t('problems.blockShareNotFound'));
          if (request.status !== 'pending')
            return problem(c, 409, t('problems.blockShareNotPending'), {
              type: blockShareProblems.notPending,
            });
          const reason = reasonOf(c);
          const acting: Principal = { ...principal, tenant: request.tenant };
          const by = actorOf(principal);
          const decided: ShareRequest = {
            ...request,
            status: outcome,
            decidedBy: by,
            decidedAt: now().toISOString(),
            decision: reason,
          };
          try {
            const done = await mounted.admin.within(
              acting,
              outcome === 'approved' ? blockShareActions.approve : blockShareActions.decline,
              { tenant: request.tenant, reason, block: request.block, version: request.version },
              async () => {
                if (outcome === 'declined') {
                  await save(decided, by, reason);
                  return {
                    value: decided,
                    target: `block:${request.tenant}/${request.block}@${request.version}`,
                  };
                }
                if (!(await onForTenant(mounted.flags, request.tenant, 'blockStudio')))
                  throw new ApprovalFailed(
                    [{ path: 'tenant', message: t('problems.blockStudioOffForTenant') }],
                    409,
                    blockShareProblems.studioOff,
                  );
                const edition = await editionOf(request);
                if (!edition)
                  throw new ApprovalFailed([
                    { path: 'version', message: t('problems.blockNotFound') },
                  ]);
                const newest = await definitions.get('Block', request.tenant, request.block);
                if (newest?.version !== request.version)
                  throw new ApprovalFailed(
                    [{ path: 'version', message: t('problems.blockShareStale') }],
                    409,
                    blockShareProblems.stale,
                  );
                if (await isBlockArchived(store, request.tenant, request.block, request.version))
                  throw new ApprovalFailed([
                    { path: 'version', message: t('problems.blockNotFound') },
                  ]);
                const shared = sharedCopy(edition);
                const published = await definitions.publish(
                  shared,
                  by,
                  t('problems.blockShareApproved', { reason }),
                  edition.files,
                  { expectedLatest: request.version },
                );
                if (!published.ok && published.stale)
                  throw new ApprovalFailed(
                    [{ path: 'version', message: t('problems.blockShareStale') }],
                    409,
                    blockShareProblems.stale,
                  );
                if (!published.ok) throw new ApprovalFailed(published.errors);
                const approved = { ...decided, sharedVersion: published.version.version };
                await save(approved, by, reason);
                return {
                  value: approved,
                  target: `block:${request.tenant}/${request.block}@${published.version.version}`,
                };
              },
            );
            c.header('genai-task', done.task);
            const value = done.value;
            return c.json({
              status: value.status,
              ...(value.sharedVersion === undefined ? {} : { version: value.sharedVersion }),
            });
          } catch (error) {
            if (error instanceof ApprovalFailed)
              return error.status === 409
                ? problem(c, 409, error.message, {
                    errors: error.errors,
                    ...(error.type ? { type: error.type } : {}),
                  })
                : problem(c, 422, t('problems.invalidDefinition'), { errors: error.errors });
            return refused(c, error);
          }
        };

        app.post('/operator/block-share-requests/:rid/approve', studio, decide('approved'));
        app.post('/operator/block-share-requests/:rid/decline', studio, decide('declined'));
      },
    };
  };

export const blockReviewsModule = createBlockReviewsModule();

const sharedCopy = (edition: PublishedVersion) => {
  const definition = structuredClone(edition.definition) as BlockDefinition;
  return { ...definition, spec: { ...definition.spec, sharing: 'everyone' as const } };
};
