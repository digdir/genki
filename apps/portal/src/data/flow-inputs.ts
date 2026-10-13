const always = new Set(['query', 'text', 'history', 'parts']);
const inputRef = /(?<![\w.])input\.([A-Za-z_][A-Za-z0-9_]*)/g;

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export interface FlowInputCheck {
  flow: string;
  name?: string;
  used: string[];
  missing: string[];
  declared: string[];
}

export const alwaysProvided = always;

export const checkFlowInputs = (
  flowRef: string,
  flowDefinition: unknown,
  fieldIds: string[],
): FlowInputCheck => {
  const spec = record(record(flowDefinition).spec);
  const used = [
    ...new Set([...JSON.stringify(spec.steps ?? []).matchAll(inputRef)].map((m) => m[1] as string)),
  ];
  const provided = new Set([...always, ...fieldIds]);
  const declared = Object.keys(record(spec.input)).filter((k) => !provided.has(k));
  const name = record(record(flowDefinition).metadata).name;
  return {
    flow: flowRef,
    ...(typeof name === 'string' && name ? { name } : {}),
    used,
    missing: used.filter((k) => !provided.has(k)),
    declared: declared.filter((k) => !used.includes(k)),
  };
};
