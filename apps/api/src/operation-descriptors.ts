import {
  appendVersion,
  checkDescriptorUpload,
  exchangeDigest,
  isTryCapability,
  maxDescriptorFixtures,
  type TryRecord,
  descriptorEntryKind,
  maxDescriptorUploadBytes,
  platformScope,
  uploadedDescriptor,
  uploadedDescriptors,
  uploadLoadProblem,
  uploadStatuses,
  type ConfigEntry,
  type UploadedDescriptor,
} from '@genai/composition';
import { flowUsesOf, type Definition } from '@genai/definitions';
import type { Shape } from '@genai/kernel';
import { bundledFixtureDir, type Descriptor, type WireExchange } from '@genai/operations';
import {
  contractFailures,
  fixturesFor,
  operationContract,
  operationContractVersion,
  OperationFixtureSpec,
  type OperationFixture,
} from '@genai/operations/contract';
import { callOperationRef } from '@genai/strategy-step-flow';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { stepsIn } from './operation-governance.js';
import type { ModuleDeps, MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const descriptorFixtureAction = 'platform.operations.descriptor-fixture';
export const descriptorUploadAction = 'platform.operations.descriptor-upload';
export const descriptorStatusAction = 'platform.operations.descriptor-status';
export const descriptorWithdrawAction = 'platform.operations.descriptor-withdraw';

type Status = 400 | 401 | 403 | 404 | 409 | 413 | 422;

const titles: Record<Status, string> = {
  400: 'Invalid request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'The request is too large',
  422: 'The change is invalid',
};

const problem = (c: Context, status: Status, errors: { path: string; message: string }[] = []) =>
  c.json({ type: 'about:blank', title: titles[status], status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const contractView = async (descriptor: Descriptor, fixtures: readonly OperationFixture[]) => {
  if (fixtures.length === 0) return null;
  const results = await operationContract(descriptor, fixtures);
  const failed = contractFailures(results);
  return {
    suite: operationContractVersion,
    checks: results.length,
    passed: failed.length === 0,
    failures: failed,
  };
};

type ShapeView =
  | Exclude<Shape, { kind: 'ref' | 'optional' | 'object' | 'array' | 'variant' | 'either' }>
  | { kind: 'ref'; pattern?: string }
  | { kind: 'optional'; shape: ShapeView }
  | { kind: 'object'; fields: Record<string, ShapeView> }
  | { kind: 'array'; item: ShapeView; min?: number; max?: number; unique?: string }
  | { kind: 'variant'; key: string; options: Record<string, ShapeView> }
  | { kind: 'either'; options: ShapeView[] };

const entriesOf = (record: Readonly<Record<string, Shape>>) =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, shapeView(v)]));

/** A shape as JSON, so the console can build a form from a descriptor's typed input. */
export const shapeView = (shape: Shape): ShapeView => {
  switch (shape.kind) {
    case 'ref':
      return { kind: 'ref', ...(shape.pattern ? { pattern: shape.pattern.source } : {}) };
    case 'optional':
      return { kind: 'optional', shape: shapeView(shape.shape) };
    case 'object':
      return { kind: 'object', fields: entriesOf(shape.fields) };
    case 'array':
      return { ...shape, item: shapeView(shape.item) };
    case 'variant':
      return { kind: 'variant', key: shape.key, options: entriesOf(shape.options) };
    case 'either':
      return { kind: 'either', options: shape.options.map(shapeView) };
    default:
      return shape;
  }
};

interface ServiceUse {
  tenant: string;
  service: string;
  version: number;
}

const flowCallsDescriptor = async (
  deps: ModuleDeps,
  tenant: string,
  flowRef: string,
  id: string,
  seen: Set<string>,
): Promise<boolean> => {
  if (seen.has(flowRef)) return false;
  seen.add(flowRef);
  const at = flowRef.lastIndexOf('@');
  const flowId = flowRef.slice(0, at);
  const version = Number(flowRef.slice(at + 1));
  const found =
    (await deps.definitions.get('StepFlow', tenant, flowId, version)) ??
    (await deps.definitions.get('StepFlow', deps.platformTenant, flowId, version));
  const flow = found?.definition;
  if (flow?.kind !== 'StepFlow') return false;
  for (const step of stepsIn(flow.spec.steps)) {
    const params = (step.params ?? {}) as { descriptor?: unknown };
    if (step.block === callOperationRef && params.descriptor === id) return true;
    if (step.subflow && (await flowCallsDescriptor(deps, tenant, step.subflow, id, seen)))
      return true;
  }
  return false;
};

/** The published services whose step flows, or the subflows they reach, call a descriptor. */
export const servicesUsing = async (deps: ModuleDeps, id: string): Promise<ServiceUse[]> => {
  const uses = new Map<string, ServiceUse>();
  for (const compiled of await deps.definitions.capabilities()) {
    const { tenant, id: service, version } = compiled.service;
    const key = `${tenant}/${service}`;
    if (uses.has(key)) continue;
    const published = await deps.definitions.get('Service', tenant, service, version);
    const definition: Definition | undefined = published?.definition;
    if (definition?.kind !== 'Service') continue;
    const seen = new Set<string>();
    for (const use of flowUsesOf(definition.spec))
      if (await flowCallsDescriptor(deps, tenant, use.flow, id, seen)) {
        uses.set(key, { tenant, service, version });
        break;
      }
  }
  return [...uses.values()].sort((a, b) =>
    `${a.tenant}/${a.service}`.localeCompare(`${b.tenant}/${b.service}`),
  );
};

const RecordBody = z.strictObject({
  task: z.string().min(1).max(200),
  name: OperationFixtureSpec.shape.name,
  exchange: z.record(z.string(), z.unknown()),
});

const bundledView = async (descriptor: Descriptor) => {
  const fixtures = fixturesFor(bundledFixtureDir, descriptor.id);
  return {
    id: descriptor.id,
    operation: descriptor.operation,
    status: descriptor.status,
    source: 'bundled' as const,
    summary: descriptor.summary,
    family: descriptor.api.family,
    fixtures: fixtures.length,
    contract: await contractView(descriptor, fixtures),
  };
};

const uploadedView = async (
  entry: ConfigEntry<UploadedDescriptor>,
  loaded: Descriptor | undefined,
) => {
  const loadProblem = uploadLoadProblem(entry.spec);
  const document = entry.spec.document;
  return {
    id: entry.id,
    operation: typeof document.operation === 'string' ? document.operation : '',
    status: entry.spec.status,
    source: 'uploaded' as const,
    summary: typeof document.summary === 'string' ? document.summary : '',
    family: loaded?.api.family ?? null,
    fixtures: entry.spec.fixtures.length,
    contract: loaded ? await contractView(loaded, entry.spec.fixtures) : null,
    ...(loadProblem ? { problems: [loadProblem] } : {}),
    version: entry.version,
    by: entry.by,
    at: entry.at,
    reason: entry.reason,
  };
};

export const operationDescriptorsModule: PlatformModuleFactory = (deps) => ({
  id: 'operation-descriptors',
  handlers: routeOnlyActions([
    descriptorFixtureAction,
    descriptorUploadAction,
    descriptorStatusAction,
    descriptorWithdrawAction,
  ]),
  mount: (app, mounted: MountDeps) => {
    const operator = async (c: Context) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return { response: problem(c, 401) };
      if (principal.kind !== 'operator')
        return {
          response: problem(c, 403, [
            { path: 'principal', message: 'only operators manage operation descriptors' },
          ]),
        };
      const operations = deps.operations;
      if (!operations)
        return {
          response: problem(c, 404, [
            { path: 'operations', message: 'this platform has no operation descriptors' },
          ]),
        };
      await operations.descriptors.refresh();
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
      c.header('genai-task', done.task);
      if (done instanceof AdminRefused) return { response: refusedBy(c, done) };
      return { value: done.value as T };
    };
    const bundledOnly = (c: Context, id: string) =>
      problem(c, 409, [
        { path: 'id', message: `${id} is bundled with Genki; upload a new version instead` },
      ]);
    const byOf = (principal: Parameters<MountDeps['admin']['within']>[0]) =>
      actorOf(principal.actor ?? principal);

    const base = '/operator/operation-descriptors';

    app.get(base, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const { descriptors } = guard.operations;
      const bundled = await Promise.all(descriptors.bundled.list().map(bundledView));
      const uploaded = await Promise.all(
        (await uploadedDescriptors(deps.configEntries))
          .filter((e) => !descriptors.bundled.get(e.id))
          .map((e) => uploadedView(e, descriptors.get(e.id))),
      );
      return c.json({ data: [...bundled, ...uploaded].sort((a, b) => a.id.localeCompare(b.id)) });
    });

    app.get(`${base}/:id{.+}`, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      const { descriptors } = guard.operations;
      const bundled = descriptors.bundled.get(id);
      const usedBy = await servicesUsing(deps, id);
      if (bundled)
        return c.json({ ...(await bundledView(bundled)), input: shapeView(bundled.input), usedBy });
      const entry = await uploadedDescriptor(deps.configEntries, id);
      if (!entry) return problem(c, 404, [{ path: 'id', message: `no descriptor ${id}` }]);
      const loaded = descriptors.get(id);
      return c.json({
        ...(await uploadedView(entry, loaded)),
        ...(loaded ? { input: shapeView(loaded.input) } : {}),
        usedBy,
        document: entry.spec.document,
        fixtureCases: entry.spec.fixtures,
      });
    });

    const size = maxDescriptorUploadBytes / 1024;
    const tooLarge = (c: Context) =>
      problem(c, 413, [{ path: 'body', message: `an upload is at most ${size} KiB` }]);

    app.put(
      `${base}/:id{.+}`,
      bodyLimit({ maxSize: maxDescriptorUploadBytes, onError: tooLarge }),
      async (c) => {
        const guard = await operator(c);
        if ('response' in guard) return guard.response;
        const id = c.req.param('id') ?? '';
        if (!isReasonLongEnough(reasonOf(c)))
          return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
        if (guard.operations.descriptors.bundled.get(id)) return bundledOnly(c, id);
        const before = await uploadedDescriptor(deps.configEntries, id);
        if (before?.spec.status === 'described')
          return problem(c, 409, [
            {
              path: 'id',
              message: `${id} is described and may be in use; upload a new version instead`,
            },
          ]);
        const body: unknown = await c.req.json().catch(() => undefined);
        if (body === undefined)
          return problem(c, 400, [{ path: 'body', message: 'the body is not JSON' }]);
        const checked = await checkDescriptorUpload(id, body);
        if (!checked.ok) return problem(c, 422, checked.problems);
        const step = before ? 'replaced' : 'uploaded';
        const done = await audited<ConfigEntry<UploadedDescriptor>>(
          c,
          guard.principal,
          descriptorUploadAction,
          { descriptor: id, step },
          async () => ({
            value: await appendVersion<UploadedDescriptor>(deps.configEntries, {
              kind: descriptorEntryKind,
              scope: platformScope,
              id,
              spec: checked.upload,
              deleted: false,
              by: byOf(guard.principal),
              reason: reasonOf(c),
            }),
            target: `operation-descriptor:${id}`,
            audit: {
              step,
              ...(before
                ? { before: { version: before.version, status: before.spec.status } }
                : {}),
              after: {
                status: checked.upload.status,
                fixtures: checked.upload.fixtures.length,
                checks: checked.checks,
              },
            },
          }),
        );
        if ('response' in done) return done.response;
        await guard.operations.descriptors.refresh();
        return c.json(
          {
            ...(await uploadedView(done.value, guard.operations.descriptors.get(id))),
            step,
          },
          before ? 200 : 201,
        );
      },
    );

    app.post(`${base}/:id{.+}/status`, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      if (guard.operations.descriptors.bundled.get(id)) return bundledOnly(c, id);
      const before = await uploadedDescriptor(deps.configEntries, id);
      if (!before) return problem(c, 404, [{ path: 'id', message: `no descriptor ${id}` }]);
      const body = (await c.req.json().catch(() => ({}))) as { status?: unknown };
      const status = uploadStatuses.find((s) => s === body.status);
      if (!status)
        return problem(c, 400, [
          {
            path: 'status',
            message:
              'status is review or described; typed means Genki has its own code for the operation',
          },
        ]);
      const loadProblem = uploadLoadProblem(before.spec);
      if (status === 'described' && loadProblem)
        return problem(c, 422, [{ path: 'descriptor', message: loadProblem }]);
      if (status === 'described') {
        const loaded = guard.operations.descriptors.get(id);
        const contract = loaded ? await contractView(loaded, before.spec.fixtures) : null;
        if (!contract)
          return problem(c, 422, [
            {
              path: 'fixtures',
              message: `${id} has no fixtures yet; record one from a try before it is described`,
            },
          ]);
        if (!contract.passed)
          return problem(
            c,
            422,
            contract.failures.flatMap((f) =>
              f.problems.map((p) => ({ path: 'fixtures', message: `${f.check}: ${p}` })),
            ),
          );
      }
      const view = (entry: ConfigEntry<UploadedDescriptor>) =>
        uploadedView(entry, guard.operations.descriptors.get(id));
      if (before.spec.status === status)
        return c.json({ ...(await view(before)), step: 'unchanged' });
      const step = status === 'described' ? 'described' : 'back-to-review';
      const done = await audited<ConfigEntry<UploadedDescriptor>>(
        c,
        guard.principal,
        descriptorStatusAction,
        { descriptor: id, status, step },
        async () => ({
          value: await appendVersion<UploadedDescriptor>(deps.configEntries, {
            kind: descriptorEntryKind,
            scope: platformScope,
            id,
            spec: { ...before.spec, status },
            deleted: false,
            by: byOf(guard.principal),
            reason: reasonOf(c),
          }),
          target: `operation-descriptor:${id}`,
          audit: { before: { status: before.spec.status }, after: { status }, step },
        }),
      );
      if ('response' in done) return done.response;
      await guard.operations.descriptors.refresh();
      return c.json({ ...(await view(done.value)), step });
    });

    app.post(`${base}/:id{.+}/fixtures`, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      if (guard.operations.tier !== 'test')
        return problem(c, 403, [
          { path: 'environment', message: 'fixtures are recorded from tries, in test only' },
        ]);
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      if (guard.operations.descriptors.bundled.get(id))
        return problem(c, 409, [
          {
            path: 'id',
            message: `${id} is bundled with Genki; its fixtures change through a pull request`,
          },
        ]);
      const before = await uploadedDescriptor(deps.configEntries, id);
      if (!before) return problem(c, 404, [{ path: 'id', message: `no descriptor ${id}` }]);
      if (before.spec.status !== 'review')
        return problem(c, 409, [
          {
            path: 'id',
            message: `${id} is described and may be in use; upload a new version instead`,
          },
        ]);
      const body = RecordBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success)
        return problem(
          c,
          400,
          body.error.issues.map((i) => ({ path: i.path.join('.') || 'body', message: i.message })),
        );
      const task = await deps.task(body.data.task);
      const json = task?.result?.[0]?.body;
      const tried =
        task &&
        task.tenant === deps.platformTenant &&
        task.status === 'completed' &&
        isTryCapability(task.service.capability.id) &&
        json?.kind === 'json'
          ? (json.json as unknown as TryRecord)
          : undefined;
      if (!tried || tried.descriptor !== id)
        return problem(c, 422, [
          { path: 'task', message: `${body.data.task} is not a finished try of ${id}` },
        ]);
      const exchange = body.data.exchange as unknown as WireExchange;
      if (!tried.exchange || tried.exchange.sha256 !== exchangeDigest(exchange))
        return problem(c, 422, [
          { path: 'exchange', message: 'the exchange is not the one this try sent and received' },
        ]);
      if (before.spec.fixtures.some((f) => f.name === body.data.name))
        return problem(c, 422, [
          { path: 'name', message: `${id} already has a fixture called ${body.data.name}` },
        ]);
      if (before.spec.fixtures.length >= maxDescriptorFixtures)
        return problem(c, 422, [
          {
            path: 'fixtures',
            message: `a descriptor has at most ${maxDescriptorFixtures} fixtures`,
          },
        ]);
      const fixture: OperationFixture = {
        name: body.data.name,
        source: `recorded from the synthetic try ${body.data.task}`,
        deployment: exchange.deployment,
        input: exchange.input,
        ...(exchange.steps
          ? { steps: exchange.steps }
          : exchange.request && exchange.response
            ? { request: exchange.request, response: exchange.response }
            : {}),
        result: exchange.result,
        usage: exchange.usage,
        dropped: exchange.dropped,
      };
      const checked = await checkDescriptorUpload(id, {
        descriptor: before.spec.document,
        fixtures: [...before.spec.fixtures, fixture],
      });
      if (!checked.ok) return problem(c, 422, checked.problems);
      const done = await audited<ConfigEntry<UploadedDescriptor>>(
        c,
        guard.principal,
        descriptorFixtureAction,
        { descriptor: id, fixture: body.data.name, run: body.data.task },
        async () => ({
          value: await appendVersion<UploadedDescriptor>(deps.configEntries, {
            kind: descriptorEntryKind,
            scope: platformScope,
            id,
            spec: checked.upload,
            deleted: false,
            by: byOf(guard.principal),
            reason: reasonOf(c),
          }),
          target: `operation-descriptor:${id}`,
          audit: {
            step: 'fixture-recorded',
            before: { version: before.version, fixtures: before.spec.fixtures.length },
            after: { fixtures: checked.upload.fixtures.length, checks: checked.checks },
            run: body.data.task,
          },
        }),
      );
      if ('response' in done) return done.response;
      await guard.operations.descriptors.refresh();
      return c.json(
        {
          ...(await uploadedView(done.value, guard.operations.descriptors.get(id))),
          step: 'fixture-recorded',
        },
        201,
      );
    });

    app.delete(`${base}/:id{.+}`, async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      if (!isReasonLongEnough(reasonOf(c)))
        return problem(c, 400, [{ path: 'change-reason', message: reasonTooShort }]);
      if (guard.operations.descriptors.bundled.get(id)) return bundledOnly(c, id);
      const before = await uploadedDescriptor(deps.configEntries, id);
      if (!before) return problem(c, 404, [{ path: 'id', message: `no descriptor ${id}` }]);
      const done = await audited(
        c,
        guard.principal,
        descriptorWithdrawAction,
        { descriptor: id, withdrawn: true },
        async () => ({
          value: await appendVersion<UploadedDescriptor>(deps.configEntries, {
            kind: descriptorEntryKind,
            scope: platformScope,
            id,
            spec: before.spec,
            deleted: true,
            by: byOf(guard.principal),
            reason: reasonOf(c),
          }),
          target: `operation-descriptor:${id}`,
          audit: { before: { version: before.version, status: before.spec.status } },
        }),
      );
      if ('response' in done) return done.response;
      await guard.operations.descriptors.refresh();
      return c.body(null, 204);
    });
  },
});
