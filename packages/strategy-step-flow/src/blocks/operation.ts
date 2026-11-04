import { mediaRefsIn } from '@genai/kernel';
import type { OperationPort } from '@genai/port-model';
import { z } from 'zod';
import type { Block } from '../blocks.js';

export const callOperationRef = 'call-operation@1';

/** The operation kind a descriptor id names, `<provider>/<kind>@<version>`. */
export const operationKindOf = (descriptor: string) => /^[^/]+\/([^@]+)@/.exec(descriptor)?.[1];

/** The model a call-operation step runs on: its own, else the service's model for the kind, else the primary. */
export const callOperationModel = (
  descriptor: string,
  stepModel: string | undefined,
  model: { primary?: string; operations?: Record<string, string> | undefined } | undefined,
) => stepModel ?? model?.operations?.[operationKindOf(descriptor) ?? ''] ?? model?.primary;

const operationParams = z.strictObject({
  descriptor: z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/),
  model: z.string().min(1).optional(),
});

export const callOperationBlock: Block<Record<string, unknown>, z.infer<typeof operationParams>> = {
  name: 'call-operation',
  version: '1',
  description:
    "Call a reviewed operation descriptor on one of the service's models, with the step input as its typed input",
  input: z.record(z.string(), z.unknown()),
  params: operationParams,
  output: z.strictObject({ result: z.unknown() }),
  run: async function* (ctx, input, params) {
    const model = callOperationModel(params.descriptor, params.model, ctx.config.model);
    if (!model) throw new Error(`step ${ctx.step} needs a model, and the service names none`);
    const port = await ctx.invocation.use<OperationPort>('described', {
      kind: 'model',
      id: model,
      tenant: ctx.config.model?.tenant ?? ctx.invocation.tenant,
    });
    yield* [];
    const result = await port.call(params.descriptor, input);
    for (const ref of mediaRefsIn(result)) ref.step ??= ctx.step;
    return { result };
  },
};
