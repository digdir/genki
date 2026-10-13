import {
  serviceDefinition,
  skillDefinition,
  stepFlowDefinition,
  strategyKey,
  validateDefinition,
  type PluginSchemas,
  type ValidationError,
} from '@genai/definitions';
import type { z } from 'zod';

export interface CodedError extends ValidationError {
  code: string;
}

const joinPath = (path: PropertyKey[]) =>
  path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');

const codeOfIssue = (code: string) =>
  code === 'too_big'
    ? 'VALIDATION_MAXIMUM'
    : code === 'too_small'
      ? 'VALIDATION_MINIMUM'
      : `VALIDATION_${code.toUpperCase()}`;

const issuesOf = (schema: z.ZodType | undefined, value: unknown, base: string) => {
  const parsed = schema?.safeParse(value);
  if (!parsed || parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: [base, joinPath(issue.path)].filter(Boolean).join('.'),
    code: codeOfIssue(issue.code),
  }));
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const zodIssues = (definition: unknown, plugins: PluginSchemas) => {
  const kind = record(definition).kind;
  const schema =
    kind === 'Skill'
      ? skillDefinition
      : kind === 'StepFlow'
        ? stepFlowDefinition
        : serviceDefinition;
  const strategy = record(record(record(definition).spec).strategy);
  const strategySchema =
    typeof strategy.id === 'string' && typeof strategy.version === 'number'
      ? plugins.strategies.get(strategyKey(strategy.id, strategy.version))
      : undefined;
  return [
    ...issuesOf(schema, definition, ''),
    ...issuesOf(strategySchema, strategy.config, 'spec.strategy.config'),
  ];
};

const fallbackCode = (message: string) =>
  /^unknown /.test(message)
    ? 'VALIDATION_UNKNOWN_REFERENCE'
    : /too big/i.test(message)
      ? 'VALIDATION_MAXIMUM'
      : /too small/i.test(message)
        ? 'VALIDATION_MINIMUM'
        : 'VALIDATION_RULE';

export const validateCoded = (definition: unknown, plugins: PluginSchemas): CodedError[] => {
  const result = validateDefinition(definition, plugins);
  if (result.ok) return [];
  const issues = zodIssues(definition, plugins);
  return result.errors.map((error) => ({
    ...error,
    code: issues.find((i) => i.path === error.path)?.code ?? fallbackCode(error.message),
  }));
};

const fieldLabels: [string, string][] = [
  ['spec.guardrails.pii-before-model', 'Personopplysninger før modellen'],
  ['spec.guardrails.pii-out-of-log', 'Personopplysninger i loggen'],
  ['spec.guardrails', 'Vern'],
  ['spec.knowledge.datasets', 'Datasett'],
  ['spec.knowledge', 'Kunnskap'],
  ['spec.model', 'Modell'],
  ['spec.strategy.config.instructions', 'Instruksjoner'],
  ['spec.strategy.config.temperature', 'Temperatur'],
  ['spec.strategy.config.generate', 'Lag svar'],
  ['spec.strategy', 'Oppsett for svar'],
  ['spec.tools', 'Verktøy'],
  ['spec.skills', 'Ferdigheter'],
  ['spec.purpose', 'Formål'],
  ['spec.description', 'Beskrivelse'],
  ['spec.instructions', 'Instruksjoner'],
  ['spec.examples', 'Eksempler'],
  ['spec.output', 'Svarformat'],
  ['spec.input', 'Inndata'],
  ['spec.riskClass', 'Risikonivå'],
  ['spec.riskConfirmation', 'Bekreftet risikonivå'],
  ['spec.audience', 'Målgruppe'],
  ['spec.exposure', 'Tilgang'],
  ['spec.variants', 'Varianter'],
  ['spec.settings', 'Innstillinger'],
  ['spec.triggers', 'Start'],
  ['metadata.name', 'Navn'],
  ['metadata', 'Metadata'],
];

const labelOf = (path: string) =>
  fieldLabels.find(
    ([prefix]) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`),
  )?.[1] ?? 'Utkastet';

const places: Record<string, string> = {
  norway: 'i Norge',
  eu: 'i EU/EØS',
  global: 'globalt',
};

const typeWords: Record<string, string> = {
  object: 'et objekt',
  string: 'tekst',
  number: 'et tall',
  array: 'en liste',
  boolean: 'ja eller nei',
  undefined: 'tom',
  null: 'tom',
};

const capabilityWords: Record<string, string> = {
  'json-schema': 'strukturerte svar',
  tools: 'verktøybruk',
  stream: 'strømming',
  reasoning: 'resonnering',
};

const quoted = (list: string) =>
  list
    .split('|')
    .map((v) => `«${v.replace(/^"|"$/g, '')}»`)
    .join(', ');

const valueAt = (root: unknown, path: string): unknown => {
  let current = root;
  for (const [, key, index] of path.matchAll(/\.?([^.[\]]+)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key ?? index ?? ''];
  }
  return current;
};

const shown = (value: unknown) =>
  typeof value === 'string' ? `«${value}»` : `«${JSON.stringify(value)}»`;

type Rule = [RegExp, (m: RegExpMatchArray, values: unknown[], path: string) => string];

const rules: Rule[] = [
  [
    /^Invalid option: expected one of (.+)$/,
    (m, values) =>
      `${
        values.length === 0
          ? 'Verdien er ikke et tillatt valg'
          : `${values.map(shown).join(', ')} er ikke ${values.length > 1 ? 'tillatte valg' : 'et tillatt valg'}`
      }. Tillatt er ${quoted(m[1] ?? '')}.`,
  ],
  [/^Invalid input: expected nonoptional, received undefined$/, () => 'Feltet mangler.'],
  [
    /^Invalid input: expected (\w+), received (\w+)$/,
    (m, _values, path) =>
      `Verdien skal være ${typeWords[m[1] ?? ''] ?? m[1]}, men er ${typeWords[m[2] ?? ''] ?? m[2]}.` +
      (/^spec\.knowledge\.datasets\[\d+\]$/.test(path)
        ? ' Skriv datasettet som {"dataset": "<id>"}.'
        : ''),
  ],
  [
    /^Unrecognized keys?: (.+)$/,
    (m) => `Feltet ${quoted((m[1] ?? '').replace(/, /g, '|'))} finnes ikke her.`,
  ],
  [/^Too small: expected string to have >=1 characters?$/, () => 'Feltet kan ikke være tomt.'],
  [/^Too small: expected string to have >=(\d+)/, (m) => `Teksten må ha minst ${m[1]} tegn.`],
  [/^Too big: expected string to have <=(\d+)/, (m) => `Teksten kan ha høyst ${m[1]} tegn.`],
  [/^Too small: expected array to have >=(\d+)/, (m) => `Listen må ha minst ${m[1]} element.`],
  [/^Too big: expected array to have <=(\d+)/, (m) => `Listen kan ha høyst ${m[1]} element.`],
  [/^Too small: expected number to be >=?(\S+)$/, (m) => `Verdien må være minst ${m[1]}.`],
  [/^Too big: expected number to be <=?(\S+)$/, (m) => `Verdien kan være høyst ${m[1]}.`],
  [/^unknown model (.+)$/, (m) => `Modellen «${m[1]}» finnes ikke i plattformen.`],
  [
    /^unknown dataset (.+)$/,
    (m) => `Datasettet «${m[1]}» finnes ikke eller er ikke tilgjengelig for virksomheten.`,
  ],
  [/^unknown tool or tool version (.+)$/, (m) => `Verktøyet «${m[1]}» finnes ikke.`],
  [/^unknown guardrail (.+)$/, (m) => `Vernet «${m[1]}» finnes ikke.`],
  [/^unknown reranker (.+)$/, (m) => `Omrangeringen «${m[1]}» finnes ikke.`],
  [/^unknown strategy (.+)$/, (m) => `Oppsettet «${m[1]}» finnes ikke.`],
  [/^unknown setting (.+)$/, (m) => `Innstillingen «${m[1]}» finnes ikke.`],
  [/^unknown building block or version (.+)$/, (m) => `Byggeklossen «${m[1]}» finnes ikke.`],
  [
    /^model (\S+) runs in (\w+), outside (\w+)$/,
    (m) =>
      `Modellen «${m[1]}» kjører ${places[m[2] ?? ''] ?? m[2]}, men tjenesten krever ${places[m[3] ?? ''] ?? m[3]}.`,
  ],
  [
    /^model (\S+) lacks (.+), which (\S+) needs$/,
    (m) =>
      `Modellen «${m[1]}» mangler ${(m[2] ?? '')
        .split(', ')
        .map((c) => capabilityWords[c] ?? c)
        .join(' og ')}, som oppsettet trenger.`,
  ],
  [/^model (\S+) cannot call tools$/, (m) => `Modellen «${m[1]}» kan ikke bruke verktøy.`],
  [/^high-risk services are not offered yet$/, () => 'Tjenester med høy risiko tilbys ikke ennå.'],
  [
    /^services for the public are not offered yet$/,
    () => 'Tjenester for innbyggere tilbys ikke ennå.',
  ],
  [
    /^an output of kind fields needs at least one field$/,
    () => 'Svarformatet trenger minst ett felt.',
  ],
  [
    /^must be lowercase letters, digits and dashes$/,
    () => 'Bruk bare små bokstaver, tall og bindestrek.',
  ],
  [/^must be a versioned reference/, () => 'Skriv referansen med versjon, for eksempel sok@1.'],
  [/^must be a MIME type$/, () => 'Skriv en filtype, for eksempel text/plain.'],
  [
    /^must be a nine-digit organisation number$/,
    () => 'Skriv et organisasjonsnummer med ni sifre.',
  ],
  [/^duplicate variant (.+)$/, (m) => `Varianten «${m[1]}» finnes to ganger.`],
  [
    /^the first variant is the default and must be a chat variant$/,
    () => 'Den første varianten er standard og må kunne brukes i chat.',
  ],
  [/^no published step flow (.+)$/, (m) => `Stegflyten «${m[1]}» er ikke publisert.`],
  [/^public name (.+) is used twice$/, (m) => `Navnet «${m[1]}» er brukt to ganger.`],
];

const patchRules: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^nothing at (.+)$/, (m) => `det finnes ingenting på ${m[1]}`],
  [/^the parent does not exist$/, () => 'stedet endringen peker på finnes ikke'],
  [/^no object at (.+)$/, (m) => `det finnes ikke noe objekt på ${m[1]}`],
  [/^index (\d+) is out of range$/, (m) => `plass ${m[1]} finnes ikke i listen`],
  [/^(.+) is not an array index$/, (m) => `${m[1]} er ikke en plass i en liste`],
  [/^test failed at (.+)$/, (m) => `utkastet har endret seg på ${m[1]}`],
  [/^the root cannot be changed$/, () => 'hele utkastet kan ikke byttes ut'],
];

const translate = (message: string, values: unknown[], path: string) => {
  for (const [pattern, render] of rules) {
    const match = message.match(pattern);
    if (match) return render(match, values, path);
  }
  return 'Verdien er ikke gyldig.';
};

const groupPath = (path: string) => path.replace(/\[\d+\]$/, '');

export const plainReasons = (errors: ValidationError[], after?: unknown): string => {
  const groups = new Map<string, { path: string; message: string; values: unknown[] }>();
  for (const error of errors) {
    const key = `${groupPath(error.path)}\u0000${error.message}`;
    const group = groups.get(key) ?? { path: error.path, message: error.message, values: [] };
    const value = after === undefined ? undefined : valueAt(after, error.path);
    if (value !== undefined) group.values.push(value);
    groups.set(key, group);
  }
  const lines = [...groups.values()].map(
    ({ path, message, values }) => `${labelOf(path)}: ${translate(message, values, path)}`,
  );
  return [...new Set(lines)].join('\n');
};

const reasons: Record<string, string> = {
  PATCH_INVALID: 'Endringen kunne ikke brukes på utkastet',
  RETRY_LIMIT: 'Assistenten har brukt opp forsøkene sine i denne runden',
};

export const reasonFor = (code: string, path: string, message: string) => {
  if (code in reasons) {
    const detail = patchRules
      .map(([pattern, render]) => {
        const match = message.match(pattern);
        return match ? render(match) : undefined;
      })
      .find(Boolean);
    return `${reasons[code]}${detail ? `: ${detail}` : ''}.`;
  }
  return plainReasons([{ path, message }]);
};

export const errorKey = (e: ValidationError) => `${e.path}\u0000${e.message}`;
