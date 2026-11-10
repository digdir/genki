import { OperationTryError } from '@genai/composition';
import { GateError, KernelError, type GateRefusal } from '@genai/kernel';
import { OperationError } from '@genai/operations';
import { ModelError } from '@genai/port-model';
import type { Context } from 'hono';
import { z } from 'zod';
import { AdminRefused, routeOnly } from './admin.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

type Status = 400 | 401 | 403 | 404 | 502;

const problem = (
  c: Context,
  status: Status,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const OperationTryBody = z.strictObject({
  model: z.string().min(1),
  input: z.unknown(),
  synthetic: z.literal(true, { error: 'the raw tier takes synthetic data only; set it to true' }),
});

const gateStatus: Record<GateRefusal, 400 | 403> = {
  admission: 403,
  disabled: 403,
  'not-shared': 403,
  residency: 403,
  maturity: 403,
  processor: 403,
  media: 400,
  shape: 400,
};

const titles = { 400: 'Invalid request', 403: 'Forbidden' } as const;

const failure = (c: Context, error: unknown) => {
  if (error instanceof GateError)
    return problem(c, gateStatus[error.refusal], titles[gateStatus[error.refusal]], [
      { path: error.refusal, message: error.message },
    ]);
  if (error instanceof OperationTryError)
    return error.refusal === 'not-synthetic'
      ? problem(c, 400, titles[400], [{ path: 'synthetic', message: error.message }])
      : problem(c, 403, titles[403], [{ path: error.refusal, message: error.message }]);
  if (error instanceof KernelError && error.code === 'forbidden')
    return problem(c, 403, 'Forbidden', [{ path: 'policy', message: error.message }]);
  if (error instanceof ModelError && ['bad_request', 'unsupported'].includes(error.code))
    return problem(c, 400, titles[400], [{ path: error.code, message: error.message }]);
  const message =
    error instanceof OperationError || error instanceof ModelError || error instanceof Error
      ? error.message
      : String(error);
  return problem(c, 502, 'A service behind the platform did not answer', [
    { path: 'provider', message },
  ]);
};

export const operationTryAction = 'platform.operations.try';

export const operatorOperationsModule: PlatformModuleFactory = (deps) => ({
  id: 'operator-operations',
  handlers: { [operationTryAction]: routeOnly },
  mount: (app, mounted: MountDeps) => {
    app.post('/operator/operations/:id{.+}/try', async (c) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Not authenticated');
      if (principal.kind !== 'operator')
        return problem(c, 403, titles[403], [
          { path: 'principal', message: 'only operators try descriptors in review' },
        ]);
      const operations = deps.operations;
      if (!operations || operations.tier !== 'test')
        return problem(c, 403, titles[403], [
          { path: 'environment', message: 'GENAI_ENV is not test' },
        ]);
      if (!isReasonLongEnough(changeReasonOf(c) ?? ''))
        return problem(c, 400, 'Invalid request', [
          { path: 'change-reason', message: reasonTooShort },
        ]);
      const body = OperationTryBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success)
        return problem(
          c,
          400,
          'Invalid request',
          body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const id = c.req.param('id') ?? '';
      await operations.descriptors.refresh();
      if (!operations.descriptors.get(id))
        return problem(c, 404, 'Not found', [{ path: 'id', message: `no descriptor ${id}` }]);
      if (!deps.models.describe().some((m) => m.id === body.data.model))
        return problem(c, 404, 'Not found', [
          { path: 'model', message: `no model ${body.data.model}` },
        ]);
      let ran: string | undefined;
      try {
        const done = await mounted.admin.within(
          { ...principal, tenant: deps.platformTenant },
          operationTryAction,
          {
            tenant: deps.platformTenant,
            reason: changeReasonOf(c) ?? '',
            descriptor: id,
            model: body.data.model,
          },
          async () => {
            const outcome = await operations.try(principal, {
              descriptor: id,
              model: body.data.model,
              input: body.data.input,
              synthetic: body.data.synthetic,
            });
            ran = outcome.task;
            if (!outcome.ok) throw outcome.error;
            return { value: outcome, target: `operation:${id}`, audit: { run: outcome.task } };
          },
        );
        c.header('genai-task', done.value.task);
        return c.json(
          {
            task: done.value.task,
            descriptor: id,
            model: body.data.model,
            result: done.value.result,
            ...(done.value.exchange ? { exchange: done.value.exchange } : {}),
          },
          200,
        );
      } catch (error) {
        if (ran) c.header('genai-task', ran);
        if (error instanceof AdminRefused)
          return problem(c, 403, titles[403], [{ path: 'principal', message: error.message }]);
        return failure(c, error);
      }
    });
  },
});
