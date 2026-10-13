import { randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import {
  enrichmentWriterOf,
  proposalsToRows,
  proposedChunkIds,
  proposeQuestions,
  verifyEnrichment,
  type EnrichmentWriter,
} from '@genai/ingest';
import type { PortContext } from '@genai/kernel';
import type { DatasetConfig, KnowledgePort } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import type { Context } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import type { CatalogItem } from './catalog-registry.js';
import { changeReasonOf } from './http.js';
import type { ModuleDeps, PlatformModule, PlatformModuleFactory } from './platform-modules.js';

type Status = 400 | 401 | 404 | 409 | 422 | 502;

const problem = (
  c: Context,
  status: Status,
  title: string,
  errors?: { path: string; message: string }[],
) =>
  c.json({ type: 'about:blank', title, status, ...(errors ? { errors } : {}) }, status, {
    'content-type': 'application/problem+json',
  });

const chunk = z.strictObject({
  chunkId: z.string().min(1).max(200),
  docNum: z.string().max(200).optional(),
  content: z.string().min(1).max(100_000),
  title: z.string().max(1000).optional(),
  url: z.string().max(2000).optional(),
});

export const proposeBody = z.strictObject({
  model: z.string().min(1),
  chunks: z.array(chunk).min(1).max(50),
  questionCount: z.number().int().min(1).max(20).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const proposal = z.strictObject({
  chunkId: z.string().min(1).max(200),
  docNum: z.string().max(200).optional(),
  questions: z.array(z.string().max(1000)).max(50),
  provenance: z
    .strictObject({
      model: z.string().max(200).optional(),
      promptHash: z.string().max(64).optional(),
      generatedAtMs: z.number().int().nonnegative().optional(),
      questionCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const applyBody = z.strictObject({
  proposals: z.array(proposal).min(1).max(500),
  dryRun: z.boolean().default(false),
});

export const verifyBody = z.strictObject({
  chunkId: z.string().min(1).max(200),
  query: z.string().min(1).max(2000),
  profile: z.string().min(1).default('questions'),
  baselineProfile: z.string().min(1).nullable().default('content'),
  limit: z.number().int().min(1).max(100).default(20),
  evalGatePass: z.boolean().optional(),
});

export const revertBody = z.strictObject({
  chunkId: z.string().min(1).max(200),
  promptHash: z.string().min(1).max(64).optional(),
});

export interface EnrichmentResolvers {
  writerFor?(deps: ModuleDeps, dataset: string): { dataset: DatasetConfig; writer: unknown };
  knowledgeFor?(deps: ModuleDeps, dataset: string, ctx: PortContext): KnowledgePort;
  modelFor?(deps: ModuleDeps, model: string, ctx: PortContext): ModelPort;
}

const issues = (error: z.ZodError) =>
  error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

export const createDatasetEnrichmentModule =
  (resolvers: EnrichmentResolvers = {}): PlatformModuleFactory =>
  (deps): PlatformModule => {
    const writerFor =
      resolvers.writerFor ??
      ((d: ModuleDeps, dataset: string) => {
        const route = d.writers.open(dataset, { signal: AbortSignal.timeout(60_000) });
        return { dataset: route.dataset, writer: route.writer };
      });
    const knowledgeFor =
      resolvers.knowledgeFor ??
      ((d: ModuleDeps, dataset: string, ctx: PortContext) =>
        d.knowledge.open({ kind: 'dataset', id: dataset, tenant: ctx.tenant }, ctx));
    const modelFor =
      resolvers.modelFor ??
      ((d: ModuleDeps, model: string, ctx: PortContext) =>
        d.models.open(
          {
            kind: 'model',
            id: model,
            ...(ctx.tenant === d.platformTenant ? {} : { tenant: ctx.tenant }),
          },
          ctx,
        ));
    const contextFor = (principal: Principal, tenant: string): PortContext => ({
      tenant,
      principal,
      task: `enrichment:${randomUUID()}`,
      signal: AbortSignal.timeout(5 * 60_000),
      meter: async () => undefined,
    });
    return {
      id: 'dataset-enrichment',
      handlers: routeOnlyActions([
        'platform.dataset.enrichment.apply',
        'platform.dataset.enrichment.revert',
      ]),
      mount: (app, mounted) => {
        const guard = async (
          c: Context,
        ): Promise<
          { response: Response } | { principal: Principal; tenant: string; item: CatalogItem }
        > => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-datasets');
          if ('response' in entered) return entered;
          const item = deps.catalog.get(
            'dataset',
            deps.catalog.qualify(tenant, c.req.param('id') ?? ''),
          );
          if (!item || item.scope !== tenant) return { response: problem(c, 404, 'Not found') };
          return { principal: entered.principal, tenant, item };
        };
        const parsed = async <T>(c: Context, schema: z.ZodType<T>) => {
          const raw = (await c.req.json().catch(() => undefined)) as unknown;
          const result = schema.safeParse(raw ?? {});
          return result.success
            ? { value: result.data }
            : { response: problem(c, 422, 'Invalid request', issues(result.error)) };
        };
        const store = (
          item: CatalogItem,
        ): { dataset: DatasetConfig; writer: EnrichmentWriter } | undefined => {
          try {
            const route = writerFor(deps, item.id);
            const writer = enrichmentWriterOf(route.writer);
            return writer ? { dataset: route.dataset, writer } : undefined;
          } catch {
            return undefined;
          }
        };
        const inTask = async <T>(
          c: Context,
          g: { principal: Principal; tenant: string; item: CatalogItem },
          action: string,
          work: () => Promise<{ value: T; audit: Record<string, unknown> }>,
        ) => {
          const done = await mounted.admin.within(
            g.principal,
            action,
            { tenant: g.tenant, reason: changeReasonOf(c)?.trim() ?? '' },
            async () => {
              const { value, audit } = await work();
              return { value, target: `dataset:${g.item.id}/enrichment`, audit };
            },
          );
          c.header('genai-task', done.task);
          return done.value;
        };
        const base = '/tenants/:tenant/datasets/:id/enrichment/hypothetical-questions';

        app.post(`${base}/proposals`, async (c) => {
          const g = await guard(c);
          if ('response' in g) return g.response;
          const body = await parsed(c, proposeBody);
          if ('response' in body) return body.response;
          const ctx = contextFor(g.principal, g.tenant);
          try {
            const model = modelFor(deps, body.value.model, ctx);
            const proposals = [];
            for (const chunk of body.value.chunks)
              proposals.push(
                await proposeQuestions(model, chunk, {
                  ...(body.value.questionCount === undefined
                    ? {}
                    : { questionCount: body.value.questionCount }),
                  ...(body.value.temperature === undefined
                    ? {}
                    : { temperature: body.value.temperature }),
                }),
              );
            return c.json({ proposals });
          } catch (error) {
            return problem(c, 502, 'The model could not propose questions', [
              { path: 'model', message: error instanceof Error ? error.message : String(error) },
            ]);
          }
        });

        app.post(`${base}/apply`, async (c) => {
          const g = await guard(c);
          if ('response' in g) return g.response;
          const body = await parsed(c, applyBody);
          if ('response' in body) return body.response;
          const proposals = body.value.proposals.map((p) => ({
            chunkId: p.chunkId,
            questions: p.questions,
            ...(p.docNum === undefined ? {} : { docNum: p.docNum }),
            ...(p.provenance === undefined
              ? {}
              : {
                  provenance: Object.fromEntries(
                    Object.entries(p.provenance).filter(([, v]) => v !== undefined),
                  ),
                }),
          }));
          const rows = proposalsToRows(proposals);
          const chunkIds = proposedChunkIds(proposals);
          if (body.value.dryRun) return c.json({ applied: rows.length, chunkIds, rows });
          if (rows.length === 0) return c.json({ applied: 0, chunkIds: [] });
          const target = store(g.item);
          if (!target)
            return problem(c, 409, 'The search engine of the dataset has no store for enrichment');
          try {
            const applied = await inTask(c, g, 'platform.dataset.enrichment.apply', async () => {
              const count = await target.writer.replaceQuestions(target.dataset, rows, chunkIds);
              return { value: count, audit: { chunks: chunkIds, applied: count } };
            });
            return c.json({ applied, chunkIds });
          } catch (error) {
            if (error instanceof AdminRefused) return refusedBy(c, error);
            return problem(c, 502, 'The questions could not be stored', [
              {
                path: 'proposals',
                message: error instanceof Error ? error.message : String(error),
              },
            ]);
          }
        });

        app.post(`${base}/verify`, async (c) => {
          const g = await guard(c);
          if ('response' in g) return g.response;
          const body = await parsed(c, verifyBody);
          if ('response' in body) return body.response;
          const knowledge = knowledgeFor(deps, g.item.id, contextFor(g.principal, g.tenant));
          const profiles = knowledge.info().profiles;
          for (const profile of [body.value.profile, body.value.baselineProfile])
            if (profile && !profiles.includes(profile))
              return problem(
                c,
                409,
                `The dataset has no search profile for the enrichment ${profile}`,
              );
          return c.json(
            await verifyEnrichment((request) => knowledge.search(request), {
              chunkId: body.value.chunkId,
              query: body.value.query,
              enrichmentProfile: body.value.profile,
              limit: body.value.limit,
              ...(body.value.baselineProfile
                ? { baselineProfile: body.value.baselineProfile }
                : {}),
              ...(body.value.evalGatePass === undefined
                ? {}
                : { evalGatePass: body.value.evalGatePass }),
            }),
          );
        });

        app.post(`${base}/revert`, async (c) => {
          const g = await guard(c);
          if ('response' in g) return g.response;
          const body = await parsed(c, revertBody);
          if ('response' in body) return body.response;
          const target = store(g.item);
          if (!target)
            return problem(c, 409, 'The search engine of the dataset has no store for enrichment');
          try {
            const reverted = await inTask(c, g, 'platform.dataset.enrichment.revert', async () => {
              const count = await target.writer.revertQuestions(
                target.dataset,
                body.value.chunkId,
                body.value.promptHash,
              );
              return {
                value: count,
                audit: {
                  chunk: body.value.chunkId,
                  reverted: count,
                  ...(body.value.promptHash ? { promptHash: body.value.promptHash } : {}),
                },
              };
            });
            return c.json({ reverted, chunkId: body.value.chunkId });
          } catch (error) {
            if (error instanceof AdminRefused) return refusedBy(c, error);
            return problem(c, 502, 'The questions could not be stored', [
              { path: 'chunkId', message: error instanceof Error ? error.message : String(error) },
            ]);
          }
        });
      },
    };
  };

export const datasetEnrichmentModule = createDatasetEnrichmentModule();
