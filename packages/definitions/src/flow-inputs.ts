import type { FlowStep, ServiceDefinition, StepFlowDefinition } from './schema.js';
import type { ValidationError } from './validate.js';

export const alwaysProvidedInputs = ['query', 'text', 'history', 'parts'] as const;

const inputRef = /(?<![\w.])input\.([A-Za-z_][A-Za-z0-9_]*)/g;

export const flowInputRefs = (flow: StepFlowDefinition): string[] => [
  ...new Set([...JSON.stringify(flow.spec.steps).matchAll(inputRef)].map((m) => m[1] as string)),
];

export const flowInputProblems = (
  service: ServiceDefinition,
  flow: StepFlowDefinition,
  ref: string,
): ValidationError[] => {
  const fields = service.spec.input.fields ?? [];
  if (fields.length === 0) return [];
  const provided = new Set<string>([...alwaysProvidedInputs, ...fields.map((f) => f.id)]);
  return flowInputRefs(flow)
    .filter((name) => !provided.has(name))
    .map((name) => ({
      path: 'spec.input.fields',
      message: `the step flow ${ref} reads input.${name}, but no input field has the id ${name} (fields: ${fields.map((f) => f.id).join(', ')})`,
    }));
};

const tableColumnKeys = (steps: FlowStep[]): string[][] =>
  steps.flatMap((s) => [
    ...(s.block?.startsWith('table@') && Array.isArray(s.params?.columns)
      ? [
          (s.params.columns as unknown[]).map((c) =>
            String((c as { key?: unknown } | null)?.key ?? ''),
          ),
        ]
      : []),
    ...tableColumnKeys([
      ...(s.repeat?.steps ?? []),
      ...(s.forEach?.steps ?? []),
      ...(s.cases ?? []).flatMap((c) => c.steps),
      ...(s.else ?? []),
    ]),
  ]);

export const flowTableProblems = (
  service: ServiceDefinition,
  flow: StepFlowDefinition,
  ref: string,
): ValidationError[] => {
  const columns = service.spec.output.kind === 'table' ? service.spec.output.columns : undefined;
  if (!columns) return [];
  const tables = tableColumnKeys(flow.spec.steps);
  if (tables.length === 0)
    return [{ path: 'spec.output.kind', message: `the step flow ${ref} has no table step` }];
  const made = new Set(tables.flat());
  return columns
    .filter((c) => !made.has(c.key))
    .map((c) => ({
      path: 'spec.output.columns',
      message: `the step flow ${ref} makes no column ${c.key} (columns: ${[...made].join(', ')})`,
    }));
};
