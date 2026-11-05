import type { Shape } from '@genai/kernel';
import type { Descriptor } from '@genai/operations';
import { enterTenant } from './access.js';
import { problem } from './http.js';
import { modelDisplayNames, modelsForTenant } from './model-access.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export type OperationFieldType = 'text' | 'number' | 'boolean' | 'choice' | 'list' | 'object';

export interface OperationField {
  name: string;
  type: OperationFieldType;
  required: boolean;
  values?: string[];
}

const fieldType = (shape: Shape): Pick<OperationField, 'type' | 'values'> => {
  switch (shape.kind) {
    case 'optional':
      return fieldType(shape.shape);
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'choice', values: [...shape.values] };
    case 'array':
      return { type: 'list' };
    case 'object':
    case 'variant':
    case 'json':
      return { type: 'object' };
    case 'either': {
      const first = shape.options.find((o) => o.kind !== 'null');
      return first ? fieldType(first) : { type: 'text' };
    }
    default:
      return { type: 'text' };
  }
};

export const operationFields = (input: Shape): OperationField[] =>
  input.kind === 'object'
    ? Object.entries(input.fields).map(([name, shape]) => ({
        name,
        required: shape.kind !== 'optional',
        ...fieldType(shape),
      }))
    : [];

const mediaTypes = (shape: Shape): string[] => {
  switch (shape.kind) {
    case 'media':
      return [shape.type];
    case 'optional':
      return mediaTypes(shape.shape);
    case 'array':
      return mediaTypes(shape.item);
    case 'object':
      return Object.values(shape.fields).flatMap(mediaTypes);
    case 'variant':
    case 'either':
      return Object.values(shape.options).flatMap(mediaTypes);
    default:
      return [];
  }
};

const notForSteps = new Set(['decide']);

export const stepOperationsModule: PlatformModuleFactory = (deps) => ({
  id: 'step-operations',
  mount: (app, mounted) => {
    app.get('/tenants/:tenant/step-flows/operations', async (c) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Not authenticated');
      const tenant = c.req.param('tenant') ?? '';
      const entered = enterTenant(c, mounted.access, principal, tenant);
      if ('response' in entered) return entered.response;
      const operations = deps.operations;
      if (!operations) return c.json({ data: [] });
      await operations.descriptors.refresh();
      const visible = modelsForTenant(deps, tenant);
      const names = modelDisplayNames(visible);
      const usable: Descriptor[] = [];
      for (const d of operations.descriptors.list()) {
        if (d.status === 'review' || notForSteps.has(d.operation)) continue;
        const maturity = await operations.governance.maturityOf(d.operation);
        if (maturity.maturity === 'production') usable.push(d);
      }
      const recorded = new Map<string, boolean>();
      const hasRecord = async (endpoint: string) => {
        if (!recorded.has(endpoint))
          recorded.set(endpoint, Boolean(await operations.governance.processorRecord(endpoint)));
        return recorded.get(endpoint) ?? false;
      };
      const data = await Promise.all(
        usable.map(async (d) => ({
          id: d.id,
          operation: d.operation,
          summary: d.summary,
          status: d.status,
          input: operationFields(d.input),
          media: [...new Set(mediaTypes(d.output))],
          models: await Promise.all(
            visible
              .filter((m) => m.operations.includes(d.operation))
              .map(async (m) => ({
                id: m.id,
                name: names.get(m.id) ?? m.id,
                residency: m.residency,
                processorRecord: await hasRecord(m.endpoint),
              })),
          ),
        })),
      );
      return c.json({ environment: operations.tier, data });
    });
  },
});
