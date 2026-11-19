import {
  appendVersion,
  maturityEntryKind,
  maturityStep,
  platformScope,
  processorRecordKind,
  ProcessorRecordSpec,
  type ConfigEntry,
  type MaturityRecord,
  type MaturityState,
  type OperationGovernanceStore,
  type ProcessorRecord,
} from '@genai/composition';
import {
  operationModelsOf,
  variantModelOf,
  type FlowStep,
  type ServiceDefinition,
  type StepFlowDefinition,
  type ValidationError,
} from '@genai/definitions';
import { maturities, mediaTypeCovers, mediaTypesOf, residencyAllows } from '@genai/kernel';
import type { Descriptor, DescriptorRegistry } from '@genai/operations';
import { builtInOperations, type ModelDescription } from '@genai/port-model';
import { callOperationModel, callOperationRef } from '@genai/strategy-step-flow';
import type { Context } from 'hono';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const maturityAction = 'platform.operations.maturity';
export const processorRecordAction = 'platform.operations.processor-record';
export const kindDeleteAction = 'platform.operations.kind.delete';
export const operationKindInUseType = 'urn:genai:problem:operation-kind-in-use';
export const operationKindBuiltInType = 'urn:genai:problem:operation-kind-built-in';

type Status = 400 | 401 | 403 | 404 | 409;

const titles: Record<Status, string> = {
  400: 'Invalid request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
};

const problem = (
  c: Context,
  status: Status,
  errors: ValidationError[] = [],
  extra: { type?: string; title?: string; usedBy?: { kind: string; id: string }[] } = {},
) =>
  c.json({ type: 'about:blank', title: titles[status], status, errors, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

export const stepsIn = (steps: readonly FlowStep[]): FlowStep[] =>
  steps.flatMap((s) => [
    s,
    ...stepsIn(s.repeat?.steps ?? []),
    ...stepsIn(s.forEach?.steps ?? []),
    ...(s.cases ?? []).flatMap((c) => stepsIn(c.steps)),
    ...stepsIn(s.else ?? []),
  ]);

export const stepMediaTypes = async (
  flowRefs: readonly string[],
  deps: Pick<DescribedStepDeps, 'descriptors' | 'flow'>,
): Promise<string[]> => {
  const seen = new Set<string>();
  const types = new Set<string>();
  const visit = async (ref: string) => {
    if (seen.has(ref)) return;
    seen.add(ref);
    const flow = await deps.flow(ref);
    for (const step of stepsIn(flow?.spec.steps ?? [])) {
      if (step.subflow) await visit(step.subflow);
      const id = (step.params as { descriptor?: unknown } | undefined)?.descriptor;
      if (step.block !== callOperationRef || typeof id !== 'string') continue;
      const descriptor = deps.descriptors.get(id);
      for (const type of descriptor ? mediaTypesOf(descriptor.input) : []) types.add(type);
    }
  };
  for (const ref of flowRefs) await visit(ref);
  return [...types];
};

export interface DescribedStepDeps {
  descriptors: DescriptorRegistry;
  governance: OperationGovernanceStore;
  models: () => ModelDescription[];
  flow: (ref: string) => Promise<StepFlowDefinition | undefined>;
}

const serviceModels = (spec: ServiceDefinition['spec']) =>
  new Set(
    [
      spec.model.primary,
      spec.model.fallback,
      ...Object.values(spec.model.roles ?? {}),
      ...operationModelsOf(spec.model),
      ...spec.variants.map(variantModelOf),
    ].filter((m): m is string => typeof m === 'string'),
  );

interface CallOperationStep {
  ref: string;
  step: FlowStep;
}

const callOperationSteps = async (
  flow: StepFlowDefinition,
  flowRef: string,
  load: DescribedStepDeps['flow'],
): Promise<CallOperationStep[]> => {
  const seen = new Set<string>([flowRef]);
  const found: CallOperationStep[] = [];
  const visit = async (current: StepFlowDefinition, ref: string) => {
    for (const step of stepsIn(current.spec.steps)) {
      if (step.subflow && !seen.has(step.subflow)) {
        seen.add(step.subflow);
        const sub = await load(step.subflow);
        if (sub) await visit(sub, step.subflow);
      }
      if (step.block === callOperationRef) found.push({ ref, step });
    }
  };
  await visit(flow, flowRef);
  return found;
};

const fixedCall = (service: ServiceDefinition, step: FlowStep) => {
  const params = (step.params ?? {}) as { descriptor?: unknown; model?: unknown };
  const id = typeof params.descriptor === 'string' ? params.descriptor : '';
  const modelId =
    params.model === undefined
      ? callOperationModel(id, undefined, service.spec.model)
      : params.model;
  const templated = id.includes('{{') || (typeof modelId === 'string' && modelId.includes('{{'));
  return { id, modelId, templated };
};

export interface UnmaskedInputUse {
  flow: string;
  step: string;
  stepName?: string;
  descriptor: string;
  operation: string;
  mediaType: string;
  consent?: { mediaType: string; reason: string };
}

const unmaskedInputOf = (
  service: ServiceDefinition,
  { ref, step }: CallOperationStep,
  descriptor: Descriptor,
): UnmaskedInputUse[] => {
  const consented = service.spec.riskConfirmation?.unmaskedInput ?? [];
  return mediaTypesOf(descriptor.input).map((mediaType) => {
    const consent = consented.find((c) => mediaTypeCovers(c.mediaType, mediaType));
    return {
      flow: ref,
      step: step.id,
      ...(step.name ? { stepName: step.name } : {}),
      descriptor: descriptor.id,
      operation: descriptor.operation,
      mediaType,
      ...(consent ? { consent: { mediaType: consent.mediaType, reason: consent.reason } } : {}),
    };
  });
};

export const unmaskedInputIn = async (
  service: ServiceDefinition,
  flow: StepFlowDefinition,
  flowRef: string,
  deps: Pick<DescribedStepDeps, 'descriptors' | 'flow'>,
): Promise<UnmaskedInputUse[]> => {
  await deps.descriptors.refresh?.();
  return (await callOperationSteps(flow, flowRef, deps.flow)).flatMap((call) => {
    const { id, templated } = fixedCall(service, call.step);
    const descriptor = templated ? undefined : deps.descriptors.get(id);
    return descriptor ? unmaskedInputOf(service, call, descriptor) : [];
  });
};

/** What keeps a service from publishing its `call-operation` steps, here and in the subflows they reach. */
export const describedStepProblems = async (
  service: ServiceDefinition,
  flow: StepFlowDefinition,
  flowRef: string,
  deps: DescribedStepDeps,
): Promise<ValidationError[]> => {
  const path = 'spec.strategy.config.flow';
  await deps.descriptors.refresh?.();
  const own = serviceModels(service.spec);
  const catalogue = new Map(deps.models().map((m) => [m.id, m]));
  const problems: ValidationError[] = [];
  for (const call of await callOperationSteps(flow, flowRef, deps.flow)) {
    const { ref, step } = call;
    const at = `step ${step.id} in ${ref}`;
    const refuse = (message: string) => problems.push({ path, message: `${at}: ${message}` });
    const { id, modelId, templated } = fixedCall(service, step);
    if (templated) {
      refuse('the operation and the model are fixed values, not filled in while the service runs');
      continue;
    }
    const descriptor = deps.descriptors.get(id);
    if (!descriptor) {
      refuse(`there is no operation descriptor ${id}`);
      continue;
    }
    if (descriptor.operation === 'decide')
      refuse(
        'decide is served only through the purpose-check guardrail, which sends a refusal or a low-confidence answer to a person',
      );
    for (const use of unmaskedInputOf(service, call, descriptor))
      if (!use.consent)
        refuse(
          `${id} takes ${use.mediaType} input, which cannot be masked; the service's risk assessment must record unmasked input of ${use.mediaType} with a reason`,
        );
    if (!('pii-before-model' in service.spec.guardrails))
      refuse(
        'a call-operation step needs the pii-before-model guardrail, so the text it sends is masked',
      );
    if (descriptor.status === 'review')
      refuse(
        `${id} is in review; an operator tries it in the raw tier, and a service can use it once it is reviewed`,
      );
    const maturity = await deps.governance.maturityOf(descriptor.operation);
    if (maturity.maturity !== 'production')
      refuse(
        `the ${descriptor.operation} operation is in test in this environment; an operator must move it to production before a service can use it`,
      );
    if (typeof modelId !== 'string' || !own.has(modelId)) {
      refuse(`the model ${String(modelId)} is not one of the service's models`);
      continue;
    }
    const model = catalogue.get(modelId);
    if (!model) {
      refuse(`there is no model ${modelId} in the catalogue`);
      continue;
    }
    const bound = model.apis[descriptor.operation];
    if (bound !== id)
      refuse(
        bound
          ? `the model ${modelId} binds ${bound} for ${descriptor.operation}, not ${id}`
          : `the model ${modelId} binds no API for ${descriptor.operation}`,
      );
    if (!residencyAllows(service.spec.model.residency, model.residency))
      refuse(
        `the model ${modelId} runs in ${model.residency}, outside ${service.spec.model.residency}`,
      );
    if (!(await deps.governance.processorRecord(model.endpoint)))
      refuse(
        `the endpoint ${model.endpoint} of ${modelId} has no processor record, so it cannot serve a service with real data`,
      );
  }
  return problems;
};

const builtInKinds: readonly string[] = [...builtInOperations, 'embed', 'rerank'];

const maturityView = (state: MaturityState, descriptors: DescriptorRegistry) => ({
  ...state,
  builtIn: builtInKinds.includes(state.kind),
  ...(builtInKinds.includes(state.kind) ? { typed: 'production' as const } : {}),
  descriptors: descriptors
    .list()
    .filter((d) => d.operation === state.kind)
    .map((d) => ({ id: d.id, status: d.status, family: d.api.family })),
});

const processorView = (endpoint: string, entry: ConfigEntry<ProcessorRecord> | undefined) => ({
  endpoint,
  record: entry
    ? {
        agreement: entry.spec.agreement,
        subProcessors: entry.spec.subProcessors,
        retention: entry.spec.retention,
        ...(entry.spec.providerState ? { providerState: entry.spec.providerState } : {}),
      }
    : null,
  ...(entry ? { by: entry.by, at: entry.at } : {}),
});

export const operationGovernanceModule: PlatformModuleFactory = (deps) => ({
  id: 'operation-governance',
  handlers: routeOnlyActions([maturityAction, processorRecordAction, kindDeleteAction]),
  mount: (app, mounted: MountDeps) => {
    const operator = async (c: Context) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return { response: problem(c, 401) };
      if (principal.kind !== 'operator')
        return {
          response: problem(c, 403, [
            { path: 'principal', message: 'only operators govern operations' },
          ]),
        };
      const operations = deps.operations;
      if (!operations)
        return {
          response: problem(c, 404, [
            { path: 'operations', message: 'this platform has no operation descriptors' },
          ]),
        };
      return { principal: { ...principal, tenant: deps.platformTenant }, operations };
    };
    const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
    const audited = async <T>(
      c: Context,
      principal: Parameters<MountDeps['admin']['within']>[0],
      action: string,
      data: Record<string, unknown>,
      work: Parameters<MountDeps['admin']['within']>[3],
    ) => {
      const done = await mounted.admin
        .within(
          principal,
          action,
          { tenant: deps.platformTenant, reason: reasonOf(c), ...data },
          work,
        )
        .catch((error: unknown) => {
          if (error instanceof AdminRefused) return error;
          throw error;
        });
      if (done instanceof AdminRefused) {
        c.header('genai-task', done.task);
        return { response: refusedBy(c, done) };
      }
      c.header('genai-task', done.task);
      return { value: done.value as T };
    };
    const knownEndpoint = (id: string) =>
      deps.models.describe().some((m) => m.endpoint === id) ||
      Boolean(deps.catalog.get('model-endpoint', id));

    app.get('/operator/operation-kinds', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const { governance, descriptors } = guard.operations;
      await descriptors.refresh();
      const kinds = new Set([
        ...builtInKinds,
        ...descriptors.list().map((d) => d.operation),
        ...(await governance.maturities()).map((m) => m.kind),
      ]);
      const data = await Promise.all(
        [...kinds]
          .sort()
          .map(async (k) => maturityView(await governance.maturityOf(k), descriptors)),
      );
      return c.json({ environment: governance.tier, governs: 'descriptor-calls', data });
    });

    app.post('/operator/operation-kinds/:kind/maturity', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const { governance, descriptors } = guard.operations;
      const kind = c.req.param('kind') ?? '';
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      await descriptors.refresh();
      if (!descriptors.list().some((d) => d.operation === kind))
        return problem(c, 404, [{ path: 'kind', message: `no descriptor describes ${kind}` }]);
      const body = (await c.req.json().catch(() => ({}))) as { maturity?: unknown };
      const maturity = maturities.find((m) => m === body.maturity);
      if (!maturity)
        return problem(c, 400, [{ path: 'maturity', message: 'maturity is test or production' }]);
      const by = actorOf(guard.principal.actor ?? guard.principal);
      const before = await governance.maturityOf(kind);
      const step = maturityStep(before, maturity);
      if (step === 'unchanged') return c.json({ ...maturityView(before, descriptors), step });
      const done = await audited<MaturityState>(
        c,
        guard.principal,
        maturityAction,
        { kind, maturity, step },
        async () => {
          await appendVersion<MaturityRecord>(deps.configEntries, {
            kind: maturityEntryKind,
            scope: governance.tier,
            id: kind,
            spec: { maturity },
            deleted: false,
            by,
            reason: reasonOf(c),
          });
          const after = await governance.maturityOf(kind);
          return {
            value: after,
            target: `operation-kind:${kind}`,
            audit: {
              before: { maturity: before.maturity },
              after: { maturity: after.maturity },
              step,
              environment: governance.tier,
            },
          };
        },
      );
      if ('response' in done) return done.response;
      return c.json({ ...maturityView(done.value, descriptors), step });
    });

    app.delete('/operator/operation-kinds/:kind', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const { governance, descriptors } = guard.operations;
      const kind = c.req.param('kind') ?? '';
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      if (builtInKinds.includes(kind))
        return problem(
          c,
          409,
          [{ path: 'kind', message: t('problems.operationKindBuiltIn', { kind }) }],
          {
            type: operationKindBuiltInType,
          },
        );
      await descriptors.refresh();
      const describing = descriptors.list().filter((d) => d.operation === kind);
      if (describing.length > 0)
        return problem(
          c,
          409,
          describing.map((d) => ({
            path: 'descriptors',
            message: t('problems.operationKindDescribedBy', { descriptor: d.id }),
          })),
          {
            type: operationKindInUseType,
            title: t('problems.operationKindInUseTitle'),
            usedBy: describing.map((d) => ({ kind: 'descriptor', id: d.id })),
          },
        );
      const listed = (await governance.maturities()).find((m) => m.kind === kind);
      if (!listed)
        return problem(c, 404, [
          { path: 'kind', message: t('problems.operationKindNotFound', { kind }) },
        ]);
      const done = await audited(c, guard.principal, kindDeleteAction, { kind }, async () => {
        await appendVersion<MaturityRecord>(deps.configEntries, {
          kind: maturityEntryKind,
          scope: governance.tier,
          id: kind,
          spec: { maturity: listed.maturity },
          deleted: true,
          by: actorOf(guard.principal.actor ?? guard.principal),
          reason: reasonOf(c),
        });
        return {
          value: undefined,
          target: `operation-kind:${kind}`,
          audit: { before: { maturity: listed.maturity }, environment: governance.tier },
        };
      });
      if ('response' in done) return done.response;
      return c.body(null, 204);
    });

    app.get('/operator/processor-records', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const records = new Map(
        (await guard.operations.governance.processorRecords()).map((e) => [e.id, e]),
      );
      const endpoints = new Set([
        ...deps.models.describe().map((m) => m.endpoint),
        ...deps.catalog.list({ kind: 'model-endpoint' }).map((e) => e.id),
        ...records.keys(),
      ]);
      return c.json({
        data: [...endpoints].sort().map((e) => processorView(e, records.get(e))),
        typedCalls: guard.operations.processorRecords ?? 'warn',
      });
    });

    const recordPath = '/operator/model-endpoints/:id/processor-record';

    app.get(recordPath, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      const entry = await guard.operations.governance.processorRecord(id);
      if (!entry)
        return problem(c, 404, [{ path: 'id', message: `${id} has no processor record` }]);
      return c.json(processorView(id, entry));
    });

    app.put(recordPath, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      if (!knownEndpoint(id))
        return problem(c, 404, [{ path: 'id', message: `no model endpoint ${id}` }]);
      const parsed = ProcessorRecordSpec.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success)
        return problem(
          c,
          400,
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const before = await guard.operations.governance.processorRecord(id);
      const done = await audited<ConfigEntry<ProcessorRecord>>(
        c,
        guard.principal,
        processorRecordAction,
        { endpoint: id },
        async () => ({
          value: await appendVersion<ProcessorRecord>(deps.configEntries, {
            kind: processorRecordKind,
            scope: platformScope,
            id,
            spec: parsed.data,
            deleted: false,
            by: actorOf(guard.principal.actor ?? guard.principal),
            reason: reasonOf(c),
          }),
          target: `model-endpoint:${id}/processor-record`,
          audit: { ...(before ? { before: before.spec } : {}), after: parsed.data },
        }),
      );
      if ('response' in done) return done.response;
      return c.json(processorView(id, done.value));
    });

    app.delete(recordPath, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      const before = await guard.operations.governance.processorRecord(id);
      if (!before)
        return problem(c, 404, [{ path: 'id', message: `${id} has no processor record` }]);
      const done = await audited(
        c,
        guard.principal,
        processorRecordAction,
        { endpoint: id, removed: true },
        async () => ({
          value: await appendVersion<ProcessorRecord>(deps.configEntries, {
            kind: processorRecordKind,
            scope: platformScope,
            id,
            spec: before.spec,
            deleted: true,
            by: actorOf(guard.principal.actor ?? guard.principal),
            reason: reasonOf(c),
          }),
          target: `model-endpoint:${id}/processor-record`,
          audit: { before: before.spec },
        }),
      );
      if ('response' in done) return done.response;
      return c.body(null, 204);
    });
  },
});
