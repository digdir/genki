import { createHash } from 'node:crypto';
import { validateDefinition, type PluginSchemas } from '@genai/definitions';

const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

const behaviourOf = (spec: unknown) => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const rest: Record<string, unknown> = { ...spec };
  delete rest.riskConfirmation;
  return rest;
};

export const definitionSubject = (spec: unknown) =>
  `spec:${createHash('sha256')
    .update(stable(behaviourOf(spec)))
    .digest('hex')
    .slice(0, 16)}`;

export const publishedSubject = (definition: unknown, plugins: PluginSchemas) => {
  const validated = validateDefinition(definition, plugins);
  return definitionSubject(
    validated.ok ? validated.definition.spec : (definition as { spec?: unknown }).spec,
  );
};
