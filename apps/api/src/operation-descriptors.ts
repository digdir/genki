import {
  appendVersion,
  checkDescriptorUpload,
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
import { bundledFixtureDir, type Descriptor } from '@genai/operations';
import {
  contractFailures,
  fixturesFor,
  operationContract,
  operationContractVersion,
  type OperationFixture,
} from '@genai/operations/contract';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

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

const bundledView = async (descriptor: Descriptor) => {
  const fixtures = fixturesFor(bundledFixtureDir, descriptor.id);
  return {
    id: descriptor.id,
    operation: descriptor.operation,
    status: descriptor.status,
    source: 'bundled' as const,
    summary: descriptor.summary,
    protocol: descriptor.api.protocol,
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
    protocol: loaded?.api.protocol ?? null,
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
      if (bundled) return c.json(await bundledView(bundled));
      const entry = await uploadedDescriptor(deps.configEntries, id);
      if (!entry) return problem(c, 404, [{ path: 'id', message: `no descriptor ${id}` }]);
      return c.json({
        ...(await uploadedView(entry, descriptors.get(id))),
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
