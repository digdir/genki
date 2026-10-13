import type { Event, Part, Principal, Usage } from '@genai/contracts';
import {
  builderResultMime,
  builderStrategyId,
  optimiserStrategyId,
  serviceIntents,
  skillIntents,
  stepFlowIntents,
  type AssistantProposal,
  type AssistantTurn,
  type AvailableBlock,
  type BlockedResidency,
  type BuilderContext,
  type BuilderIntent,
  type BuilderTarget,
  type BuilderTurnRequest,
  type BuilderTurnResult,
  type ConversationEntry,
  type RefusedBlock,
  type TurnStatus,
} from '@genai/strategy-builder';
import type { Context } from 'hono';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  blockStatusFor,
  readBlockPolicy,
  type BlockKind,
  type BlockPolicy,
  type PolicyRule,
} from './building-blocks.js';
import { originOf } from './draft-runner.js';
import { t } from './i18n/index.js';
import { modelDisplayNames, modelsForTenant } from './model-access.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import {
  builderServiceId,
  defaultModelOf,
  platformService,
  runPlatformService,
  runsPlatformServices,
} from './platform-services.js';
import { storeProposal } from './proposals.js';
import { requireRight, rightRefused, rightsOf, type Right } from './rights.js';
import { recipesOf } from './recipes.js';

export type {
  AssistantProposal,
  AssistantQuestion,
  AssistantTurn,
  RejectedChange,
  PolicyRefusal,
  TurnUsage,
} from '@genai/strategy-builder';

export const enabledKey = 'assistant.enabled';
export const dailyTokensKey = 'assistant.dailyTokens';
export const modelKey = 'assistant.model';
export const defaultDailyTokens = 200_000;
export const answersFollowWithinMs = 2 * 60 * 60 * 1000;

export interface AssistantOptions {
  now?: () => Date;
}

export type AssistantSseEvent =
  | { event: 'delta' | 'paragraph'; data: { text: string } }
  | { event: 'question' | 'proposal' | 'rejected'; data: unknown }
  | { event: 'done'; data: { turn: AssistantTurn } };

const texts = {
  refused: () => t('services.assistantRefused'),
  unavailable: () => t('services.assistantUnavailable'),
  noModel: () => t('services.assistantNoModel'),
  notPublished: () => t('services.assistantNotPublished'),
  budget: (daily: number) => t('services.assistantBudget', { tokens: daily }),
};

const rightNames = {
  'use-services': () => t('services.rightUseServices'),
  'manage-services': () => t('services.rightManageServices'),
  'manage-datasets': () => t('services.rightManageDatasets'),
  'register-building-blocks': () => t('services.rightRegisterBuildingBlocks'),
  'view-usage': () => t('services.rightViewUsage'),
} satisfies Record<Right, () => string>;

export const shownApproval = (proposal: AssistantProposal): AssistantProposal => {
  const right = proposal.approval?.right as Right | undefined;
  if (!right || !(right in rightNames)) return proposal;
  const label = rightNames[right]();
  return {
    ...proposal,
    approval: { right, label, message: t('services.assistantNeedsRight', { right: label }) },
  } as AssistantProposal;
};

export const turnBody = z.object({
  message: z.string(),
  draft: z.object({ definition: z.union([z.record(z.string(), z.unknown()), z.string()]) }),
  answers: z.record(z.string(), z.string()).optional(),
  previousTurn: z.string().min(1).optional(),
  intent: z.enum([...serviceIntents, ...skillIntents]).optional(),
  stream: z.boolean().optional(),
});

const intentsFor: Record<BuilderTarget, readonly BuilderIntent[]> = {
  service: serviceIntents,
  skill: ['chat', ...skillIntents],
  stepflow: stepFlowIntents,
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 422,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const osloMidnight = (now: Date) => {
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
      .formatToParts(now)
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
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1) - offset);
};

const ownerName = (owner: string | undefined) =>
  !owner || owner.toLowerCase() === 'digdir' ? 'Digdir' : 'Virksomheten';

const platformStrategies = new Set([builderStrategyId, optimiserStrategyId]);

const sseFrame = ({ event, data }: AssistantSseEvent) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const createAssistantModule =
  (options: AssistantOptions = {}): PlatformModuleFactory =>
  (moduleDeps) => {
    const now = options.now ?? (() => new Date());

    return {
      id: 'assistant',
      checkPublish: async (definition) => {
        const d = record(definition);
        const strategy = record(record(d.spec).strategy).id;
        const tenant = record(d.metadata).tenant;
        return platformStrategies.has(String(strategy)) && tenant !== moduleDeps.platformTenant
          ? [{ path: 'spec.strategy.id', message: t('services.platformStrategyOnly') }]
          : [];
      },
      mount: (app, deps: MountDeps) => {
        const setting = (tenant: string, key: string) =>
          deps.settings.effective(tenant)[key]?.value;

        const dailyBudget = (tenant: string) => {
          const value = setting(tenant, dailyTokensKey);
          return typeof value === 'number' ? value : defaultDailyTokens;
        };

        const usedToday = async (tenant: string) => {
          const since = osloMidnight(now()).toISOString();
          let used = 0;
          for (const tracked of await deps.tasks.all(tenant)) {
            if (tracked.at < since) continue;
            const task = await deps.task(tracked.task);
            if (!task || task.createdAt < since) continue;
            if (originOf(task.service.capability.id) !== 'assistant') continue;
            used += (task.usage.inputTokens ?? 0) + (task.usage.outputTokens ?? 0);
          }
          return used;
        };

        const contextFor = async (
          tenant: string,
          policy: BlockPolicy,
          principal: Principal,
        ): Promise<BuilderContext> => {
          const available: AvailableBlock[] = [];
          const refused: RefusedBlock[] = [];
          const classify = (block: AvailableBlock, policyId: string = block.id) => {
            const found = blockStatusFor(policy, {
              kind: block.kind as BlockKind,
              id: policyId,
              dataLocation: block.dataLocation ?? null,
            });
            const rule: PolicyRule | undefined =
              found.status === 'not_allowed'
                ? found.blocked
                : found.status === 'requires_approval' || found.status === 'pending_approval'
                  ? found.approval
                  : undefined;
            if (found.status === 'not_allowed' || rule)
              refused.push({
                kind: block.kind,
                id: block.id,
                rule: rule?.text ?? t('services.blockNeedsApproval', { name: block.name }),
                ownedBy: ownerName(rule?.ownedBy),
                link: rule?.match.residency ? '#/settings' : '#/building-blocks',
              });
            else available.push(block);
          };
          const tenantModels = modelsForTenant(deps, tenant);
          const modelNames = modelDisplayNames(tenantModels);
          for (const model of tenantModels)
            classify({
              kind: 'model',
              id: model.id,
              name: modelNames.get(model.id) ?? model.id,
              dataLocation: model.residency,
              capabilities: [...model.capabilities],
            });
          for (const [id, dataset] of deps.knowledge.datasets())
            if (!dataset.tenants || dataset.tenants.includes(tenant))
              classify({
                kind: 'dataset',
                id,
                name: dataset.name ?? id,
                ...(dataset.description ? { description: dataset.description } : {}),
                dataLocation: dataset.residency,
              });
          for (const state of await deps.connections.list(tenant))
            for (const tool of state.tools)
              classify(
                {
                  kind: 'tool',
                  id: `${tool.name}@${state.connection.version}`,
                  name: tool.name,
                  description: tool.description,
                },
                state.connection.id,
              );
          for (const entry of await deps.definitions.list(tenant)) {
            if (entry.kind !== 'Skill') continue;
            const found = await deps.definitions.get('Skill', tenant, entry.id);
            if (!found) continue;
            const spec = record(record(found.definition).spec);
            classify(
              {
                kind: 'skill',
                id: `${entry.id}@${found.version}`,
                name: entry.id,
                ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
              },
              entry.id,
            );
          }
          for (const id of deps.plugins.guardrails.keys())
            classify({ kind: 'guardrail', id, name: id });
          const blockedResidencies: BlockedResidency[] = policy.rules
            .filter(
              (r) =>
                r.effect === 'not_allowed' &&
                (r.match.kind === undefined || r.match.kind === 'model') &&
                r.match.id === undefined,
            )
            .flatMap((r) =>
              (r.match.residency ?? []).map((residency) => ({
                residency,
                rule: r.text,
                ownedBy: ownerName(r.ownedBy),
                link: '#/settings',
              })),
            );
          const recipes = (
            await recipesOf(deps.definitions, tenant, {
              platformTenant: deps.platformTenant,
              configEntries: deps.configEntries,
            })
          ).map(({ ref, title, summary, purpose, settings }) => ({
            ref,
            title,
            summary,
            purpose,
            settings,
          }));
          return {
            available,
            refused,
            blockedResidencies,
            rights: [...rightsOf(principal, tenant)],
            ...(recipes.length > 0 ? { recipes } : {}),
          };
        };

        const chooseModel = (
          tenant: string,
          context: BuilderContext,
          preferred: string | undefined,
        ) => {
          const configured = setting(tenant, modelKey);
          const usable = context.available.filter(
            (b) =>
              b.kind === 'model' &&
              b.capabilities?.includes('tools') &&
              runsPlatformServices(deps, b.id),
          );
          if (typeof configured === 'string' && configured)
            return usable.find((b) => b.id === configured)?.id;
          return (usable.find((b) => b.id === preferred) ?? usable[0])?.id;
        };

        const usageFor = async (tenant: string, tokens: number) => {
          const daily = dailyBudget(tenant);
          return {
            tokens,
            budgetLeftToday: Math.max(0, daily - (await usedToday(tenant))),
            dailyBudget: daily,
          };
        };

        const bare = async (
          tenant: string,
          status: TurnStatus,
          message: string,
          turnId: string = crypto.randomUUID(),
          tokens = 0,
        ): Promise<AssistantTurn> => ({
          turnId,
          status,
          message,
          proposals: [],
          usage: await usageFor(tenant, tokens),
        });

        const tokensOf = async (task: string) => {
          const found = await deps.task(task);
          return (found?.usage.inputTokens ?? 0) + (found?.usage.outputTokens ?? 0);
        };

        const resultOf = (parts: Part[]) => {
          const part = parts.find((p) => p.mime === builderResultMime && p.body.kind === 'json');
          return part?.body.kind === 'json' ? (part.body.json as BuilderTurnResult) : undefined;
        };

        const turnResult = async (principal: Principal, tenant: string, task: string) => {
          try {
            const found = await deps.kernel.task(principal, task);
            if (found.tenant !== tenant || originOf(found.service.capability.id) !== 'assistant')
              return undefined;
            return { result: resultOf(found.result ?? []), createdAt: found.createdAt };
          } catch {
            return undefined;
          }
        };

        const latestTurn = async (principal: Principal, tenant: string) => {
          const since = new Date(now().getTime() - answersFollowWithinMs).toISOString();
          const recent = (await deps.tasks.all(tenant))
            .filter((t) => t.at >= since)
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 50);
          for (const tracked of recent) {
            const found = await turnResult(principal, tenant, tracked.task);
            if (found?.result) return found.result;
          }
          return undefined;
        };

        const previousOf = async (
          principal: Principal,
          tenant: string,
          body: z.infer<typeof turnBody>,
        ) => {
          if (body.previousTurn)
            return (await turnResult(principal, tenant, body.previousTurn))?.result;
          return body.answers ? latestTurn(principal, tenant) : undefined;
        };

        const labelled = (
          answers: Record<string, string>,
          previous: BuilderTurnResult | undefined,
        ) =>
          Object.fromEntries(
            Object.entries(answers).map(([id, answer]) => [
              previous?.questions?.find((q) => q.id === id)?.label ?? id,
              answer,
            ]),
          );

        async function* execute(
          principal: Principal,
          tenant: string,
          input: BuilderTurnRequest,
          forService: { id: string; name: string },
          model: string,
          budget: Usage,
        ): AsyncGenerator<AssistantSseEvent, AssistantTurn> {
          const queue: Event[] = [];
          let wake: (() => void) | undefined;
          let finished = false;
          const running = runPlatformService(deps, {
            principal,
            tenant,
            service: builderServiceId,
            model,
            data: input as unknown as Record<string, unknown>,
            budget,
            onEvent: (event) => {
              queue.push(event);
              wake?.();
            },
          })
            .catch(() => undefined)
            .finally(() => {
              finished = true;
              wake?.();
            });
          const stored = new Map<string, AssistantProposal>();
          const withStorage = async (proposal: AssistantProposal) => {
            if (proposal.level === 1) return shownApproval(proposal);
            const saved = await storeProposal(
              deps.admin,
              principal,
              tenant,
              forService,
              proposal,
              input.message,
            );
            const next: AssistantProposal = saved
              ? {
                  ...proposal,
                  storedProposalId: saved.id,
                  ...(proposal.platformChange && saved.platformChange
                    ? {
                        platformChange: {
                          summary: saved.platformChange.summary,
                          caseId: saved.platformChange.caseId,
                          status: saved.platformChange.status,
                        },
                      }
                    : {}),
                }
              : proposal;
            const shown = shownApproval(next);
            stored.set(proposal.id, shown);
            return shown;
          };
          for (;;) {
            const event = queue.shift();
            if (!event) {
              if (finished) break;
              await new Promise<void>((resolve) => (wake = resolve));
              wake = undefined;
              continue;
            }
            const data = event.data as Record<string, unknown>;
            if (event.type === 'kernel.part.delta')
              yield { event: 'delta', data: { text: String(data.text ?? '') } };
            else if (event.type === 'x.builder.paragraph')
              yield { event: 'paragraph', data: { text: String(data.text ?? '') } };
            else if (event.type === 'x.builder.question') yield { event: 'question', data };
            else if (event.type === 'x.builder.rejected') yield { event: 'rejected', data };
            else if (event.type === 'x.builder.proposal')
              yield {
                event: 'proposal',
                data: {
                  ...(await withStorage(event.data as AssistantProposal)),
                  appliedToDraft: false as const,
                },
              };
          }
          const outcome = await running;
          if (!outcome?.ok) {
            const task = outcome?.task;
            const tokens = task ? await tokensOf(task) : 0;
            return outcome?.code === 'budget_exceeded'
              ? await bare(
                  tenant,
                  'budget_exhausted',
                  texts.budget(dailyBudget(tenant)),
                  task,
                  tokens,
                )
              : await bare(tenant, 'unavailable', texts.unavailable(), task, tokens);
          }
          const result = resultOf(outcome.parts);
          const tokens = outcome.usage.inputTokens + outcome.usage.outputTokens;
          if (!result)
            return await bare(tenant, 'unavailable', texts.unavailable(), outcome.task, tokens);
          const proposals = await Promise.all(
            result.proposals.map(async (p) => stored.get(p.id) ?? (await withStorage(p))),
          );
          const shown = { ...result };
          Reflect.deleteProperty(shown, 'transcript');
          return {
            ...shown,
            turnId: outcome.task,
            proposals: proposals.map((p) => ({ ...p, appliedToDraft: false as const })),
            usage: await usageFor(tenant, tokens),
          };
        }

        const sseHeaders = {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        };

        const respondWith = (c: Context, stream: boolean, turn: AssistantTurn) =>
          stream
            ? new Response(sseFrame({ event: 'done', data: { turn } }), {
                status: 200,
                headers: sseHeaders,
              })
            : c.json(turn);

        const respond = async (
          c: Context,
          stream: boolean,
          events: AsyncGenerator<AssistantSseEvent, AssistantTurn>,
        ) => {
          if (!stream) {
            for (;;) {
              const next = await events.next();
              if (next.done) return c.json(next.value);
            }
          }
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              try {
                const next = await events.next();
                if (next.done) {
                  controller.enqueue(
                    encoder.encode(sseFrame({ event: 'done', data: { turn: next.value } })),
                  );
                  controller.close();
                } else controller.enqueue(encoder.encode(sseFrame(next.value)));
              } catch (error) {
                controller.error(error);
              }
            },
            cancel: async () => {
              await events.return(undefined as never);
            },
          });
          return new Response(body, { status: 200, headers: sseHeaders });
        };

        const turn = (target: BuilderTarget) => async (c: Context) => {
          const principal = await deps.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Unauthorized');
          const tenant = c.req.param('tenant') ?? '';
          const acting = deps.access(principal, tenant, c.req.raw);
          if (!acting) return problem(c, 404, 'Not found');
          const check = requireRight(acting, tenant, 'manage-services');
          if (!check.ok) return rightRefused(c, check.problem);
          const parsed = turnBody.safeParse(await c.req.json().catch(() => undefined));
          if (!parsed.success)
            return problem(
              c,
              400,
              'Invalid request',
              parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            );
          const body = parsed.data;
          const intent = body.intent ?? 'chat';
          if (!intentsFor[target].includes(intent))
            return problem(c, 400, 'Invalid request', [
              { path: 'intent', message: `must be one of ${intentsFor[target].join(', ')}` },
            ]);
          let draft: Record<string, unknown>;
          try {
            draft = record(
              typeof body.draft.definition === 'string'
                ? parseYaml(body.draft.definition)
                : body.draft.definition,
            );
          } catch (error) {
            return problem(c, 422, 'Utkastet er ikke gyldig YAML', [
              { path: 'draft.definition', message: (error as Error).message },
            ]);
          }
          const owner = record(draft.metadata).tenant;
          if (owner !== undefined && owner !== tenant)
            return problem(c, 403, 'Utkastet tilhører en annen virksomhet', [
              { path: 'draft.definition.metadata.tenant', message: 'another tenant' },
            ]);
          const id = c.req.param('id') ?? 'new';
          const name = record(draft.metadata).name;
          const forService = { id, name: typeof name === 'string' && name ? name : id };
          const stream = body.stream === true;

          if (setting(tenant, enabledKey) === false)
            return respondWith(c, stream, await bare(tenant, 'refused', texts.refused()));
          const daily = dailyBudget(tenant);
          const used = await usedToday(tenant);
          if (used >= daily)
            return respondWith(
              c,
              stream,
              await bare(tenant, 'budget_exhausted', texts.budget(daily)),
            );
          const service = await platformService(deps, builderServiceId);
          if (!service)
            return respondWith(c, stream, await bare(tenant, 'unavailable', texts.notPublished()));
          const context = await contextFor(
            tenant,
            await readBlockPolicy(deps.configEntries, tenant),
            acting,
          );
          const model = chooseModel(tenant, context, defaultModelOf(service));
          if (!model)
            return respondWith(c, stream, await bare(tenant, 'unavailable', texts.noModel()));

          const previous = await previousOf(acting, tenant, body);
          const history: ConversationEntry[] = previous?.transcript ?? [];
          const input: BuilderTurnRequest = {
            target,
            tenant,
            message: body.message,
            ...(body.answers ? { answers: labelled(body.answers, previous) } : {}),
            ...(history.length > 0 ? { history } : {}),
            intent,
            draft,
            stream,
            context,
          };
          const left = daily - used;
          return respond(
            c,
            stream,
            execute(acting, tenant, input, forService, model, {
              inputTokens: left,
              outputTokens: left,
            }),
          );
        };

        app.post('/tenants/:tenant/services/:id/assistant/turns', turn('service'));
        app.post('/tenants/:tenant/skills/:id/assistant/turns', turn('skill'));
        app.post('/tenants/:tenant/step-flows/:id/assistant/turns', turn('stepflow'));
      },
    };
  };

export const assistantModule: PlatformModuleFactory = createAssistantModule();
