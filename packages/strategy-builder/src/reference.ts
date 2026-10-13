import {
  serviceDefinition,
  skillDefinition,
  stepFlowDefinition,
  strategyKey,
  type PluginSchemas,
} from '@genai/definitions';
import { z } from 'zod';
import { untrusted } from './prompt.js';
import type { BuilderContext, BuilderTarget, Residency } from './types.js';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const residencyWords: Record<Residency, string> = {
  norway: 'i Norge',
  eu: 'i EU/EØS',
  global: 'globalt, utenfor EU/EØS',
};

const jsonSchema = (schema: z.ZodType) => {
  try {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    Reflect.deleteProperty(out, '$schema');
    return out;
  } catch {
    return {};
  }
};

const named = (value: unknown) => JSON.stringify(String(value).slice(0, 120));

const refId = (value: unknown) =>
  typeof value === 'string' ? value : typeof value === 'object' ? record(value).use : undefined;

export const draftFacts = (draft: unknown, context: BuilderContext): string[] => {
  const spec = record(record(draft).spec);
  const facts: string[] = [];
  const blockFact = (kind: 'model' | 'dataset' | 'tool' | 'skill', id: string, noun: string) => {
    const found = context.available.find((b) => b.kind === kind && b.id === id);
    const refused = context.refused.find((b) => b.kind === kind && b.id === id);
    if (found)
      return kind === 'model'
        ? `Modellen ${named(id)} finnes i modellregisteret og kjører ${found.dataLocation ? residencyWords[found.dataLocation] : 'et sted registeret ikke oppgir'}.`
        : `${noun} ${named(id)} er tilgjengelig for virksomheten.`;
    if (refused) return `${noun} ${named(id)} er ikke tillatt for virksomheten: ${refused.rule}`;
    return kind === 'model'
      ? `Modellen ${named(id)} finnes ikke i modellregisteret. Den kan ikke brukes, og du vet ikke hvor den kjører.`
      : `${noun} ${named(id)} finnes ikke for virksomheten og kan ikke brukes.`;
  };
  const model = record(spec.model);
  for (const role of ['primary', 'fallback'] as const)
    if (typeof model[role] === 'string') facts.push(blockFact('model', model[role], 'Modellen'));
  const datasets = record(spec.knowledge).datasets;
  for (const d of Array.isArray(datasets) ? datasets : []) {
    const id = typeof d === 'string' ? d : record(d).dataset;
    if (typeof id === 'string') facts.push(blockFact('dataset', id, 'Datasettet'));
  }
  for (const t of Array.isArray(spec.tools) ? spec.tools : []) {
    const id = refId(t);
    if (typeof id === 'string') facts.push(blockFact('tool', id, 'Verktøyet'));
  }
  for (const s of Array.isArray(spec.skills) ? spec.skills : [])
    if (typeof s === 'string') facts.push(blockFact('skill', s, 'Ferdigheten'));
  return facts;
};

const catalogueOf = (context: BuilderContext) => ({
  models: context.available
    .filter((b) => b.kind === 'model')
    .map((b) => ({
      id: b.id,
      name: b.name,
      runs: b.dataLocation ? residencyWords[b.dataLocation] : 'ikke oppgitt',
      residency: b.dataLocation ?? null,
      capabilities: b.capabilities ?? [],
    })),
  datasets: context.available
    .filter((b) => b.kind === 'dataset')
    .map((b) => ({ dataset: b.id, name: b.name, residency: b.dataLocation ?? null })),
  tools: context.available.filter((b) => b.kind === 'tool').map((b) => b.id),
  skills: context.available.filter((b) => b.kind === 'skill').map((b) => b.id),
  guardrails: context.available.filter((b) => b.kind === 'guardrail').map((b) => b.id),
});

export const referenceFor = (
  target: BuilderTarget,
  draft: unknown,
  plugins: PluginSchemas,
  context: BuilderContext,
): string => {
  const strategy = record(record(record(draft).spec).strategy);
  const strategySchema =
    target === 'service' && typeof strategy.id === 'string' && typeof strategy.version === 'number'
      ? plugins.strategies.get(strategyKey(strategy.id, strategy.version))
      : undefined;
  const guardrails = Object.fromEntries(
    [...plugins.guardrails].map(([id, schema]) => [id, jsonSchema(schema)]),
  );
  const facts = draftFacts(draft, context);
  return [
    '# Referanse fra plattformen',
    'Plattformen validerer hvert forslag mot skjemaene under. Bruk nøyaktig disse feltnavnene, typene og tillatte verdiene (enum).',
    '- Bruk bare id-ene i katalogen. Verktøy og ferdigheter skrives med versjon, slik de står der.',
    ...(target === 'service'
      ? [
          '- Et datasett er et objekt, ikke tekst: {"op":"add","path":"/spec/knowledge/datasets/-","value":{"dataset":"<id>"}}. Mangler /spec/knowledge, legg til {"op":"add","path":"/spec/knowledge","value":{"datasets":[{"dataset":"<id>"}]}}.',
          '- spec.model.residency må være lik eller strengere enn der modellen kjører (norway, eu, global).',
          `- Strategier som finnes: ${[...plugins.strategies.keys()].join(', ')}.`,
        ]
      : []),
    '- Si aldri hvor en modell kjører, hva den koster eller hva et datasett inneholder uten at det står i katalogen eller i fakta om utkastet. Står det ikke der, si at du ikke vet.',
    '- Skriv aldri at du har laget et forslag før plattformen har svart at det er godkjent. Er det avvist, si det.',
    '- Husk det brukeren har svart tidligere i samtalen. Ikke spør om det samme igjen, og ikke gå imot et svar brukeren har gitt.',
    ...(facts.length > 0
      ? ['', 'Fakta om utkastet fra registeret:', ...facts.map((f) => `- ${f}`)]
      : []),
    '',
    `Skjema for hele utkastet (JSON Schema): ${JSON.stringify(jsonSchema(target === 'skill' ? skillDefinition : target === 'stepflow' ? stepFlowDefinition : serviceDefinition))}`,
    ...(target === 'stepflow'
      ? [`Byggeklosser et steg kan bruke (block): ${[...plugins.blocks].join(', ')}.`]
      : []),
    ...(target === 'service' && (context.recipes?.length ?? 0) > 0
      ? [
          'Oppskrifter en ny variant kan bruke med propose_variant. settings er et JSON Schema for innstillingene; bruk bare verdier det tillater:',
          untrusted('recipes', context.recipes),
        ]
      : []),
    ...(strategySchema
      ? [
          `Skjema for /spec/strategy/config med ${strategyKey(String(strategy.id), Number(strategy.version))}: ${JSON.stringify(jsonSchema(strategySchema))}`,
        ]
      : []),
    ...(target === 'service' && Object.keys(guardrails).length > 0
      ? [`Skjema for hvert vern under /spec/guardrails/<id>: ${JSON.stringify(guardrails)}`]
      : []),
    '',
    'Katalog over det virksomheten kan bruke:',
    untrusted('catalogue', catalogueOf(context)),
  ].join('\n');
};
