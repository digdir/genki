import type { UiText } from '@genai/contracts';
import { jsonSchemaOf } from '@genai/definitions';
import type { Context } from 'hono';
import type { z } from 'zod';
import { enterTenant } from './access.js';
import { t } from './i18n/index.js';
import { strategyTitle } from './schemas.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export type StrategyHow = 'single' | 'agent' | 'flow';
export type ConfigUse = 'required' | 'optional' | 'no';

export interface PipelineStep {
  title: UiText;
  description: UiText;
  repeats?: true;
}

export interface StrategyEntry {
  id: string;
  version: number;
  how: StrategyHow;
  default: boolean;
  title: UiText;
  description: UiText;
  pipeline: PipelineStep[];
  newConfig: Record<string, unknown>;
  takes: { instructions: ConfigUse; examples: ConfigUse };
  schema: string;
}

interface Described {
  how: StrategyHow;
  default?: true;
  description: UiText;
  pipeline: PipelineStep[];
  newConfig?: Record<string, unknown>;
}

const text = (nb: string, en: string): UiText => ({ nb, en });

const step = (title: UiText, description: UiText, repeats?: true): PipelineStep => ({
  title,
  description,
  ...(repeats ? { repeats } : {}),
});

const described: Record<string, Described> = {
  'single-call': {
    how: 'single',
    default: true,
    description: text(
      'Ett modellkall per oppgave. Raskest, billigst og lettest å etterprøve.',
      'One model call per task. Fastest, cheapest and easiest to verify.',
    ),
    pipeline: [
      step(
        text('Les inn', 'Read input'),
        text('Teksten eller filen som kommer inn.', 'The text or file that comes in.'),
      ),
      step(
        text('Modellkall', 'Model call'),
        text(
          'Ett kall med instruksjonene og eksemplene.',
          'One call with the instructions and the examples.',
        ),
      ),
      step(
        text('Vern', 'Guardrails'),
        text(
          'Kontroll etter risikonivå før resultatet leveres.',
          'Checks by risk level before the result is delivered.',
        ),
      ),
    ],
  },
  'rag-single-shot': {
    how: 'single',
    description: text(
      'Ett søk i datasettene og ett modellkall med treffene som grunnlag. Rask og forutsigbar.',
      'One search in the datasets and one model call based on the hits. Fast and predictable.',
    ),
    pipeline: [
      step(
        text('Søk', 'Search'),
        text(
          'Ett søk i datasettene med spørsmålet.',
          'One search in the datasets with the question.',
        ),
      ),
      step(
        text('Ranger', 'Rank'),
        text('De beste tekstbitene velges ut.', 'The best passages are selected.'),
      ),
      step(
        text('Skriv svar', 'Write answer'),
        text('Ett modellkall med treffene som grunnlag.', 'One model call based on the hits.'),
      ),
    ],
  },
  'agent-loop': {
    how: 'agent',
    default: true,
    description: text(
      'Modellen bestemmer selv hvilke verktøy den bruker og i hvilken rekkefølge, til den har nok til å svare eller når grensene.',
      'The model decides which tools to use and in what order, until it has enough to answer or reaches the limits.',
    ),
    pipeline: [
      step(
        text('Planlegg', 'Plan'),
        text(
          'Agenten lager en plan ut fra spørsmålet.',
          'The agent makes a plan from the question.',
        ),
      ),
      step(
        text('Søk og les', 'Search and read'),
        text(
          'Gjentas til agenten har nok, eller til budsjettet for søk og lesing er brukt.',
          'Repeats until the agent has enough, or until the budget for searching and reading is used up.',
        ),
        true,
      ),
      step(
        text('Vurder grunnlaget', 'Assess the basis'),
        text(
          'Agenten sjekker om kildene holder til å svare.',
          'The agent checks whether the sources are enough to answer.',
        ),
        true,
      ),
      step(
        text('Svar', 'Answer'),
        text(
          'Svar med kilder. Vernet kjøres før svaret sendes.',
          'Answer with sources. Guardrails run before the answer is sent.',
        ),
      ),
    ],
    newConfig: { maxIterations: 8 },
  },
  'step-flow': {
    how: 'flow',
    default: true,
    description: text(
      'Faste steg i en bestemt rekkefølge. Flyten er data, ikke kode, og hver endring blir en ny versjon.',
      'Fixed steps in a set order. The flow is data, not code, and every change becomes a new version.',
    ),
    pipeline: [],
  },
  'remote-agent': {
    how: 'single',
    description: text(
      'Hele svaret lages av en motor du driver selv. Plattformen sender samtalen dit og beholder tilgang, kanaler, vern, kostnadstak og logg.',
      'The whole answer is made by an engine you run yourself. The platform sends the conversation there and keeps access, channels, safeguards, cost caps and logging.',
    ),
    pipeline: [
      step(
        text('Sender samtalen', 'Sends the conversation'),
        text(
          'Spørsmålet, tidligere meldinger og det tjenesten har sagt ja til å dele.',
          'The question, earlier messages and what the service has agreed to share.',
        ),
      ),
      step(
        text('Din motor svarer', 'Your engine answers'),
        text(
          'Svar, kilder, steg og forbruk kommer tilbake i en avtalt form.',
          'The answer, sources, steps and usage come back in an agreed form.',
        ),
      ),
      step(
        text('Plattformen tar imot', 'The platform receives it'),
        text(
          'Svaret sjekkes og vises i alle kanaler, og stegene vises i Hva skjedde.',
          'The answer is checked and shown in every channel, and the steps show in What happened.',
        ),
      ),
    ],
  },
};

const internal = new Set(['builder-assistant', 'optimiser']);

const splitKey = (key: string) => {
  const at = key.lastIndexOf('@');
  return { id: key.slice(0, at), version: Number(key.slice(at + 1)) };
};

const useOf = (schema: Record<string, unknown>, property: string): ConfigUse => {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (!(property in properties)) return 'no';
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return required.includes(property) ? 'required' : 'optional';
};

export const strategyCatalogue = (strategies: Map<string, z.ZodType>): StrategyEntry[] =>
  [...strategies]
    .map(([key, schema]) => ({ ...splitKey(key), schema }))
    .filter(({ id }) => !internal.has(id))
    .map(({ id, version, schema }) => {
      const known = described[id];
      const json = jsonSchemaOf(schema) as Record<string, unknown>;
      return {
        id,
        version,
        how: known?.how ?? 'single',
        default: known?.default === true,
        title: strategyTitle(id) ?? text(id, id),
        description: known?.description ?? text('', ''),
        pipeline: known?.pipeline ?? [],
        newConfig: known?.newConfig ?? {},
        takes: { instructions: useOf(json, 'instructions'), examples: useOf(json, 'examples') },
        schema: `/schemas/${encodeURIComponent(`Strategy.${id}@${version}`)}`,
      };
    });

const notSignedIn = (c: Context) =>
  c.json({ type: 'about:blank', title: t('problems.notSignedIn'), status: 401 }, 401, {
    'content-type': 'application/problem+json',
  });

export const strategyCatalogueModule: PlatformModuleFactory = () => ({
  id: 'strategy-catalogue',
  mount: (app, deps) => {
    app.get('/tenants/:tenant/definitions/strategies', async (c) => {
      const principal = await deps.authenticate(c.req.raw);
      if (!principal) return notSignedIn(c);
      const entered = enterTenant(c, deps.access, principal, c.req.param('tenant') ?? '');
      if ('response' in entered) return entered.response;
      return c.json({ data: strategyCatalogue(deps.plugins.strategies) });
    });
  },
});
