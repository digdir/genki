import type { Principal } from '@genai/contracts';
import { uploadPrefix } from '@genai/ingest';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, routeOnlyActions } from './admin.js';
import { catalogSecretRef, type CatalogItem } from './catalog-registry.js';
import { platformScope } from './config-store.js';
import { datasetReaders } from './dataset-readers.js';
import { endpointSourceEngine, endpointSourceId, endpointSourceSecret } from './endpoint-source.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { PlatformModule, PlatformModuleFactory } from './platform-modules.js';

export const datasetInUseType = 'urn:genai:problem:dataset-in-use';
export const datasetRunOpenType = 'urn:genai:problem:dataset-run-open';

export interface DatasetDeleteResult {
  deleted: string;
  removed: {
    catalogEntry: true;
    pipelines: string[];
    uploads: string[];
    generations: string[];
    endpoint?: string;
    secret?: string;
  };
  kept: {
    knowledgeRecords: boolean;
    generations: string[];
  };
}

type Problem = { path: string; message: string };

class DeleteRefused extends Error {
  constructor(readonly errors: Problem[]) {
    super('the dataset could not be removed');
  }
}

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: Problem[],
  type = 'about:blank',
) =>
  c.json({ type, title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const datasetDeleteModule: PlatformModuleFactory = (deps): PlatformModule => ({
  id: 'dataset-delete',
  handlers: routeOnlyActions(['platform.dataset.delete']),
  mount: (app, mounted) => {
    const readersOf = (dataset: string) =>
      datasetReaders(
        {
          definitions: deps.definitions,
          configEntries: deps.configEntries,
          resolve: (id) => deps.knowledge.resolve(id),
        },
        dataset,
      );

    const openRuns = (scope: string, dataset: string) => deps.ingestion.openRuns(scope, dataset);

    const endpointSourceOf = (scope: string, item: CatalogItem) => {
      if (scope === platformScope) return undefined;
      const local = item.id.slice(scope.length + 1);
      const name = endpointSourceId(local);
      const id = deps.catalog.qualify(scope, name);
      if (item.spec.endpoint !== name && item.spec.endpoint !== id) return undefined;
      const connection = deps.catalog.get('knowledge-endpoint', id);
      if (connection?.scope !== scope || connection.spec.engine !== endpointSourceEngine)
        return undefined;
      const secret = endpointSourceSecret(local);
      const auth = connection.spec.auth as { secret?: string } | undefined;
      return {
        name,
        secret: auth?.secret === catalogSecretRef(scope, secret) ? secret : undefined,
      };
    };

    const removeEndpointSource = async (
      scope: string,
      item: CatalogItem,
      by: string,
      reason: string,
    ) => {
      const source = endpointSourceOf(scope, item);
      if (!source) return {};
      const removed = await deps.catalog.remove({
        kind: 'knowledge-endpoint',
        scope,
        id: source.name,
        by,
        reason,
      });
      if (!removed.ok) return {};
      if (!source.secret || !deps.vault) return { endpoint: source.name };
      await deps.vault.delete(scope, source.secret);
      return { endpoint: source.name, secret: source.secret };
    };

    const remove = async (c: Context, principal: Principal, scope: string, item: CatalogItem) => {
      const reason = changeReasonOf(c)?.trim() ?? '';
      if (!isReasonLongEnough(reason))
        return problem(c, 400, 'Invalid request', [
          { path: 'change-reason', message: reasonTooShort },
        ]);
      const readers = await readersOf(item.id);
      if (readers.length > 0) {
        const own = readers.filter((r) => scope === platformScope || r.tenant === scope);
        const others = readers.length - own.length;
        return problem(
          c,
          409,
          t('problems.datasetInUseTitle'),
          [
            ...own.map((r) => ({
              path: 'usedBy',
              message: t('problems.datasetReadBy', { kind: r.kind, tenant: r.tenant, id: r.id }),
            })),
            ...(others > 0
              ? [{ path: 'usedBy', message: t('problems.datasetReadByOthers', { count: others }) }]
              : []),
          ],
          datasetInUseType,
        );
      }
      const by = actorOf(principal.actor ?? principal);
      const release = await deps.ingestion.hold(item.id, by, reason);
      if (!release)
        return problem(
          c,
          409,
          t('problems.datasetInUseTitle'),
          [{ path: 'id', message: t('problems.datasetDeleting') }],
          datasetInUseType,
        );
      try {
        const running = await openRuns(scope, item.id);
        if (running.length > 0)
          return problem(
            c,
            409,
            t('problems.datasetRunOpenTitle'),
            running.map((run) => ({
              path: 'executions',
              message: t('problems.datasetRunOpen', { run }),
            })),
            datasetRunOpenType,
          );
        const done = await mounted.admin.within(
          principal,
          'platform.dataset.delete',
          {
            tenant: scope === platformScope ? deps.platformTenant : scope,
            scope,
            reason,
            id: item.id,
          },
          () => work(by, scope, item, reason),
        );
        c.header('genai-task', done.task);
        return c.json(done.value);
      } catch (error) {
        if (error instanceof DeleteRefused)
          return problem(c, 409, t('problems.datasetInUseTitle'), error.errors, datasetInUseType);
        throw error;
      } finally {
        await release();
      }
    };

    const work = async (by: string, scope: string, item: CatalogItem, reason: string) => {
      const tenant = scope === platformScope ? deps.platformTenant : scope;
      const onKnowledgeServer = deps.catalog.datasetOnKnowledgeServer(item.id);
      const route =
        !onKnowledgeServer && deps.writers.supports(item.id)
          ? deps.writers.open(item.id, { signal: new AbortController().signal })
          : undefined;
      const wrote = new Map<string, boolean>();
      let active: string | undefined;
      const dropped: string[] = [];
      const failed: string[] = [];
      if (route) {
        for (const pipeline of await deps.ingestion.pipelineIdsEver(scope, item.id))
          for (const run of await deps.ingestion.executions(item.id, pipeline)) {
            const generation = run.report?.generation ?? run.id;
            wrote.set(generation, wrote.get(generation) || (run.report?.stored ?? 0) > 0);
          }
        active = await route.writer.active(route.dataset).catch(() => undefined);
        if (active && wrote.has(active)) wrote.set(active, true);
        for (const generation of wrote.keys())
          if (generation !== active) {
            await route.writer.drop(route.dataset, generation, { force: true });
            if (wrote.get(generation)) dropped.push(generation);
          }
      }
      const uploads: string[] = [];
      if (scope !== platformScope) {
        const prefix = uploadPrefix(item.id, tenant);
        for (const blob of await deps.blobs.list(tenant, prefix)) {
          await deps.blobs.delete({ tenant, path: blob.path });
          uploads.push(blob.path.slice(prefix.length));
        }
      }
      const pipelines = await deps.ingestion.list(scope, item.id);
      for (const pipeline of pipelines) {
        const result = await deps.ingestion.remove({
          scope,
          dataset: item.id,
          id: pipeline.id,
          by,
          reason,
        });
        if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
      }
      const removed = await deps.catalog.remove({
        kind: 'dataset',
        scope,
        id: item.id,
        by,
        reason,
      });
      if (!removed.ok) throw new DeleteRefused(removed.errors);
      const source = await removeEndpointSource(scope, item, by, reason);
      if (route && active) {
        const served = active;
        if (wrote.has(served))
          await route.writer.drop(route.dataset, served, { force: true }).then(
            () => dropped.push(served),
            () => failed.push(served),
          );
        else failed.push(served);
      }
      const value: DatasetDeleteResult = {
        deleted: item.id,
        removed: {
          catalogEntry: true,
          pipelines: pipelines.map((p) => p.id),
          uploads,
          generations: dropped,
          ...source,
        },
        kept: { knowledgeRecords: onKnowledgeServer, generations: failed },
      };
      return {
        value,
        target: `dataset:${item.id}`,
        audit: { removed: value.removed, kept: value.kept },
      };
    };

    app.delete('/tenants/:tenant/datasets/:id', async (c) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized', []);
      const tenant = c.req.param('tenant') ?? '';
      const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-datasets');
      if ('response' in entered) return entered.response;
      const item = deps.catalog.get(
        'dataset',
        deps.catalog.qualify(tenant, c.req.param('id') ?? ''),
      );
      if (!item || item.scope !== tenant) return problem(c, 404, 'Not found', []);
      return remove(c, entered.principal, tenant, item);
    });

    app.delete('/operator/datasets/:id', async (c) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized', []);
      if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden', []);
      const item = deps.catalog.get('dataset', c.req.param('id') ?? '');
      if (!item || item.scope !== platformScope) return problem(c, 404, 'Not found', []);
      return remove(c, { ...principal, tenant: deps.platformTenant }, platformScope, item);
    });
  },
});
