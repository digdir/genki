import type { OperationPort } from '@genai/port-model';
import { z } from 'zod';
import type { Block } from '../blocks.js';

export const callOperationRef = 'call-operation@1';

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
    const model = params.model ?? ctx.config.model?.primary;
    if (!model) throw new Error(`step ${ctx.step} needs a model, and the service names none`);
    const port = await ctx.invocation.use<OperationPort>('described', {
      kind: 'model',
      id: model,
      tenant: ctx.config.model?.tenant ?? ctx.invocation.tenant,
    });
    yield* [];
    return { result: await port.call(params.descriptor, input) };
  },
};
