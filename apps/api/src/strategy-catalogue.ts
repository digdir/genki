import type { UiText } from '@genai/contracts';
import { jsonSchemaOf } from '@genai/definitions';
import {
  datedSystemPromptTemplate,
  defaultSystemPrompt,
  searchPromptSections,
  type PromptSectionId,
} from '@genai/strategy-agent-loop';
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

export interface PromptSectionEntry {
  id: PromptSectionId;
  title: UiText;
  reason: UiText;
  text: string;
}

export interface DefaultInstructions {
  text: UiText;
  note?: UiText;
  sections?: PromptSectionEntry[];
  layered?: true;
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
  defaultInstructions?: DefaultInstructions;
  schema: string;
}

interface Described {
  how: StrategyHow;
  default?: true;
  description: UiText;
  pipeline: PipelineStep[];
  newConfig?: Record<string, unknown>;
  defaultInstructions?: DefaultInstructions;
}

const text = (nb: string, en: string): UiText => ({ nb, en });

const step = (title: UiText, description: UiText, repeats?: true): PipelineStep => ({
  title,
  description,
  ...(repeats ? { repeats } : {}),
});

const sectionLabels: Record<PromptSectionId, { title: UiText; reason: UiText }> = {
  role: {
    title: text('Rolle', 'Role'),
    reason: text(
      'Sier hva agenten er til for. Behold den med mindre tjenesten trenger en annen rolle.',
      'Says what the agent is for. Keep it unless the service needs another role.',
    ),
  },
  reasoning: {
    title: text('Før verktøykall', 'Before a tool call'),
    reason: text(
      'Lar agenten si kort hva den ser etter før et verktøykall, så kjøringen viser det. Vi anbefaler å beholde den.',
      'Lets the agent say briefly what it looks for before a tool call, so the run shows it. We recommend keeping it.',
    ),
  },
  workflow: {
    title: text('Arbeidsmåte', 'Workflow'),
    reason: text(
      'Lar agenten søke, lese og så svare, så svaret bygger på dokumenter. Vi anbefaler å beholde den.',
      'Has the agent search, read and then answer, so the answer rests on documents. We recommend keeping it.',
    ),
  },
  gate: {
    title: text('Kontroll', 'Check'),
    reason: text(
      'Forteller agenten at plattformen sjekker grunnlaget etter hvert steg. Vi anbefaler å beholde den.',
      'Tells the agent that the platform checks the basis after each step. We recommend keeping it.',
    ),
  },
};

export const agentPromptSections: PromptSectionEntry[] = searchPromptSections.map((section) => ({
  ...section,
  ...sectionLabels[section.id],
}));

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
        text('Sikkerhetsregler', 'Guardrails'),
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
      'Ett søk i dokumentsamlingene og ett modellkall med treffene som grunnlag. Rask og forutsigbar.',
      'One search in the document collections and one model call based on the hits. Fast and predictable.',
    ),
    pipeline: [
      step(
        text('Søk', 'Search'),
        text(
          'Ett søk i dokumentsamlingene med spørsmålet.',
          'One search in the document collections with the question.',
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
    defaultInstructions: {
      text: text(datedSystemPromptTemplate, datedSystemPromptTemplate),
      note: text(
        'Ved kjøring blir {date} dagens dato, og plattformen legger til arbeidsinstruksene tjenesten har. Spørsmålet og treffene sendes i en egen melding.',
        "At run time {date} becomes today's date, and the platform adds the work instructions the service has. The question and the hits are sent in a separate message.",
      ),
    },
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
          'Svar med kilder. Sikkerhetsreglene kjøres før svaret sendes.',
          'Answer with sources. Guardrails run before the answer is sent.',
        ),
      ),
    ],
    newConfig: { maxIterations: 8 },
    defaultInstructions: {
      text: text(defaultSystemPrompt, defaultSystemPrompt),
      note: text(
        'Ved kjøring starter plattformen med en beskrivelse av tjenesten: navn, formål, dokumentsamlinger med antall dokumenter og årstall, svarspråk og dagens dato. Etter delene under kommer instruksjonene dine, og så arbeidsinstruksene tjenesten har, aktive filtre og vedlagte dokumenter.',
        "At run time the platform starts with a description of the service: name, purpose, document collections with their number of documents and years, answer languages and today's date. Your instructions come after the sections below, then the work instructions the service has, active filters and attached documents.",
      ),
      sections: agentPromptSections,
      layered: true,
    },
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
  'live-session': {
    how: 'single',
    description: text(
      'En direkte økt mot en ekstern tjeneste, for eksempel tale til tekst mens noen snakker. Hver melding begge veier går gjennom plattformens sikkerhetsregler, og økten er kjøringen.',
      'A live session with an external service, such as speech to text while someone talks. Every message both ways passes the platform safeguards, and the session is the run.',
    ),
    pipeline: [
      step(
        text('Åpner økten', 'Opens the session'),
        text(
          'Plattformen kobler til leverandøren med nøkkelen sin, aldri med din.',
          'The platform connects to the provider with its own key, never yours.',
        ),
      ),
      step(
        text('Sjekker hver melding', 'Checks every message'),
        text(
          'Tekst maskeres på vei ut og gjenopprettes på vei inn. Lyd krever at tjenesten har sagt ja til det.',
          'Text is masked on the way out and restored on the way back. Audio needs the service to have agreed to it.',
        ),
      ),
      step(
        text('Avslutter og lagrer', 'Ends and records'),
        text(
          'Økten stopper ved lengste varighet eller når typen settes tilbake til test. Utskrift, forbruk og logg følger kjøringen.',
          'The session stops at its longest duration or when the kind is set back to test. Transcript, usage and log follow the run.',
        ),
      ),
    ],
  },
  'remote-agent': {
    how: 'single',
    description: text(
      'Hele svaret lages av en motor du driver selv. Plattformen sender samtalen dit og beholder tilgang, kanaler, sikkerhetsregler, kostnadstak og logg.',
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
        ...(known?.defaultInstructions ? { defaultInstructions: known.defaultInstructions } : {}),
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
