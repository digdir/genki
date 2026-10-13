import type { UiSchema } from '@genai/schema-forms';
export type ParamType = 'int' | 'float' | 'enum' | 'list' | 'text' | 'bool' | 'json' | 'columns';

export interface ParamDef {
  name: string;
  type: ParamType;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  required?: boolean;
  help?: string;
}

export interface BlockDef {
  name: string;
  desc?: string;
  icon: string;
  version?: string;
  inputs: [name: string, type: string, required: boolean][];
  outputs: [name: string, type: string][];
  params: ParamDef[];
  paramsSchema?: UiSchema;
  schemaRef?: string;
}

export type OnError = 'stop' | 'skip' | 'use-default';
export type ParamValue = unknown;

interface StepBase {
  id: string;
  label: string;
}

export interface BlockStep extends StepBase {
  kind: 'block';
  block: string;
  version?: string;
  in: Record<string, string>;
  raw?: Record<string, unknown>;
  p: Record<string, ParamValue>;
  err: OnError;
  def?: string;
  defRaw?: unknown;
}

export interface RepeatStep extends StepBase {
  kind: 'repeat';
  until: { ref: string; val: string; raw?: string };
  max: number | '';
  steps: Step[];
}

export interface ForEachStep extends StepBase {
  kind: 'foreach';
  over: string;
  as: string;
  steps: Step[];
  err?: OnError;
  def?: string;
  defRaw?: unknown;
}

export interface BranchStep extends StepBase {
  kind: 'branch';
  on: string;
  cases: { when: string; raw?: unknown; steps: Step[] }[];
  else: Step[];
}

export interface SubStep extends StepBase {
  kind: 'sub';
  flow: string;
  version?: number;
  in: Record<string, string>;
  raw?: Record<string, unknown>;
  out: [string, string][];
}

export type Step = BlockStep | RepeatStep | ForEachStep | BranchStep | SubStep;

export type RunState = 'ok' | 'warn' | 'fail' | 'wait' | 'none';

export interface RunOverlay {
  id: string;
  status: 'Fullført' | 'Venter på godkjenning' | 'Feilet';
  total: string;
  tokens: string;
  steps: Record<string, [time: string, tokens: string, state: RunState, note?: string]>;
}

export interface Flow {
  id: string;
  name: string;
  desc: string;
  version: number;
  draft?: boolean;
  changed: string;
  usedBy: string[];
  input: [string, string][];
  steps: Step[];
  sub?: boolean;
  run?: RunOverlay;
  recipe?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export const blocks: Record<string, BlockDef> = {};

export const registerBlocks = (defs: Record<string, BlockDef>) => Object.assign(blocks, defs);

const step = (
  id: string,
  block: string,
  label: string,
  input: Record<string, string>,
  params: Record<string, ParamValue>,
  err: OnError = 'stop',
  def?: unknown,
): BlockStep => ({
  kind: 'block',
  id,
  block,
  label,
  in: input,
  p: params,
  err,
  ...(def === undefined
    ? {}
    : typeof def === 'string'
      ? { def }
      : { def: JSON.stringify(def), defRaw: def }),
});

const withText = (s: BlockStep, raw: Record<string, unknown>): BlockStep => ({ ...s, raw });

export const exampleFlows: Flow[] = [
  {
    id: 'svar-med-kilder',
    name: 'Svar med kilder',
    desc: 'Planlegger søk, søker til grunnlaget holder, rangerer og svarer med kilder.',
    version: 4,
    changed: '2. okt av Per Hansen',
    usedBy: ['Rapportassistenten', 'Spør veilederen', 'Intern spørsmålsbank'],
    input: [['query', 'tekst']],
    steps: [
      step(
        'plan',
        'model',
        'Planlegg søk',
        { prompt: 'input.query' },
        { system: 'Foreslå inntil tre korte søk som dekker spørsmålet.', temperature: 0 },
      ),
      {
        kind: 'repeat',
        id: 'runde',
        label: 'Søk til grunnlaget holder',
        until: { ref: 'steps.sjekk.sufficient', val: 'true' },
        max: 3,
        steps: [
          step('sok', 'retrieve', 'Søk i rapportene', { query: 'input.query' }, { plan: true }),
          step(
            'ranger',
            'rerank',
            'Ranger treffene',
            { query: 'input.query', chunks: 'steps.sok.chunks' },
            { contextTopK: 8 },
          ),
          step(
            'sjekk',
            'evidence-gate',
            'Holder grunnlaget?',
            { chunks: 'steps.ranger.chunks', contextDocs: 'steps.ranger.contextDocs' },
            { minContextDocs: 2 },
            'use-default',
            { sufficient: true, gatedContextDocs: [] },
          ),
        ],
      },
      step(
        'svar',
        'synthesize',
        'Skriv svar med kilder',
        { query: 'input.query', contextDocs: 'steps.ranger.contextDocs' },
        { temperature: 0.1 },
      ),
    ],
    run: {
      id: 'opg_7f2kq9d1',
      status: 'Fullført',
      total: '4,7 s',
      tokens: '4 470',
      steps: {
        plan: ['0,4 s', '210', 'ok'],
        runde: ['3,1 s', '', 'ok', '2 runder'],
        sok: ['0,3 s', '', 'ok', '2 ganger'],
        ranger: ['0,2 s', '', 'ok', '2 ganger'],
        sjekk: ['0,6 s', '940', 'ok', 'nei, så ja'],
        svar: ['1,9 s', '3 320', 'ok'],
      },
    },
  },
  {
    id: 'saksforberedelse',
    name: 'Saksforberedelse',
    desc: 'Henter dokumentene i saken, sjekker vilkår for hvert dokument, skriver utkast og ber en saksbehandler godkjenne.',
    version: 2,
    changed: '28. sep av Kari Nordmann',
    usedBy: ['Vedtaksutkast'],
    input: [['saksnummer', 'tekst']],
    steps: [
      {
        kind: 'sub',
        id: 'hent',
        label: 'Finn dokumentene i saken',
        flow: 'hent-dokumenter',
        in: { saksnummer: 'input.saksnummer' },
        out: [['dokumenter', 'liste']],
      },
      {
        kind: 'foreach',
        id: 'hver',
        label: 'For hvert dokument',
        over: 'steps.hent.dokumenter',
        as: 'dok',
        steps: [
          step(
            'les',
            'read-document',
            'Les dokumentet',
            { document: 'dok' },
            { maxChunks: 200, topK: 20 },
            'skip',
          ),
          withText(
            step(
              'vilkar',
              'extract',
              'Sjekk vilkår',
              { chunks: 'steps.les.chunks' },
              {
                name: 'vilkar_tilskudd',
                temperature: 0,
                schema: {
                  type: 'object',
                  properties: {
                    oppfylt: { type: 'boolean' },
                    begrunnelse: { type: 'string' },
                  },
                  required: ['oppfylt', 'begrunnelse'],
                },
              },
            ),
            { prompt: 'Er vilkårene for tilskudd oppfylt i {{dok.title}}?' },
          ),
        ],
      },
      withText(
        step(
          'utkast',
          'model',
          'Skriv utkast til vedtak',
          {},
          { system: 'Du skriver utkast til vedtak om tilskudd.' },
        ),
        { prompt: 'Skriv et utkast til vedtak ut fra vurderingene: {{steps.hver}}' },
      ),
      step(
        'godkjenn',
        'approval',
        'Saksbehandler godkjenner',
        {},
        {
          reason: 'Vedtak om tilskudd skal godkjennes av en saksbehandler.',
          prompt: 'Er utkastet til vedtak riktig?',
        },
      ),
      step('ferdig', 'route', 'Send til saksbehandling', {}, { queue: 'Tilskudd' }),
    ],
    run: {
      id: 'opg_9a1rt6k0',
      status: 'Venter på godkjenning',
      total: '41 min hittil',
      tokens: '20 200',
      steps: {
        hent: ['1,5 s', '', 'ok'],
        h1: ['1,5 s', '', 'ok'],
        hver: ['8,4 s', '', 'warn', '4 dokumenter, 1 hoppet over'],
        les: ['2,1 s', '', 'warn', '3 av 4, 1 hoppet over (dokumentet var tomt)'],
        vilkar: ['5,9 s', '11 300', 'ok', '4 ganger'],
        utkast: ['3,2 s', '8 900', 'ok'],
        godkjenn: ['41 min', '', 'wait', 'Venter på saksbehandler'],
        ferdig: ['', '', 'none'],
      },
    },
  },
  {
    id: 'sorter-post',
    name: 'Sorter post',
    desc: 'Klassifiserer innkommende brev og sender dem til riktig kø.',
    version: 1,
    draft: true,
    changed: 'I dag av Ingrid Berg',
    usedBy: ['Sorter innkommende post'],
    input: [['text', 'tekst']],
    steps: [
      step(
        'klass',
        'classify',
        'Hva slags henvendelse?',
        { text: 'input.text' },
        { labels: ['Søknad', 'Klage', 'Innsynskrav', 'Annet'] },
        'use-default',
        { label: 'Annet' },
      ),
      {
        kind: 'branch',
        id: 'velg',
        label: 'Send videre etter kategori',
        on: 'steps.klass.label',
        cases: [
          {
            when: 'Søknad',
            steps: [step('rute-s', 'route', 'Til køen Tilskudd', {}, { queue: 'Tilskudd' })],
          },
          {
            when: 'Klage',
            steps: [step('rute-k', 'route', 'Til køen Klagesaker', {}, { queue: 'Klagesaker' })],
          },
          {
            when: 'Faktura',
            steps: [step('rute-f', 'route', 'Til køen Faktura', {}, { queue: 'Faktura' })],
          },
        ],
        else: [
          step(
            'manuell',
            'approval',
            'Postmottak vurderer',
            {},
            { reason: 'Brevet passer ikke i en kø.', prompt: 'Hvilken kø skal brevet til?' },
          ),
        ],
      },
    ],
    run: {
      id: 'opg_post_118',
      status: 'Feilet',
      total: '2,9 s',
      tokens: '1 840',
      steps: {
        klass: ['1,1 s', '1 840', 'ok', 'Klage (0,93)'],
        velg: ['', '', 'ok', 'Klage'],
        'rute-k': ['1,8 s', '', 'fail', 'Køen Klagesaker svarte ikke'],
        'rute-s': ['', '', 'none'],
        'rute-f': ['', '', 'none'],
        manuell: ['', '', 'none'],
      },
    },
  },
  {
    id: 'hent-dokumenter',
    name: 'Hent dokumentene i en sak',
    desc: 'Finner dokumentene som hører til en sak. Brukes som delflyt.',
    version: 3,
    changed: '14. sep av Jonas Lie',
    usedBy: ['Saksforberedelse (delflyt)', 'Søknadsuttrekk'],
    input: [['saksnummer', 'tekst']],
    sub: true,
    steps: [
      withText(step('h1', 'documents', 'Finn dokumentene i saken', {}, { limit: 50 }), {
        filters: { saksnummer: '{{input.saksnummer}}' },
      }),
    ],
  },
];

export const flowQueryIds: Record<string, string> = {
  svar: 'svar-med-kilder',
  sak: 'saksforberedelse',
  post: 'sorter-post',
};

export const serviceOfFlow: Record<string, string> = {
  'svar-med-kilder': 'Rapportassistenten',
  saksforberedelse: 'Vedtaksutkast',
  'sorter-post': 'Sorter innkommende post',
  'hent-dokumenter': 'Søknadsuttrekk',
};

export type StrategyFieldType = 'enum' | 'int' | 'bool' | 'tools';

export interface StrategyField {
  id: string;
  label: string;
  type: StrategyFieldType;
  help: string;
  options?: string[];
  tools?: [label: string, reach: string][];
  min?: number;
  max?: number;
  def: string | number | boolean | string[];
}

export interface Strategy {
  id: 'ett' | 'agent' | 'stegflyt' | 'auto' | 'debatt';
  name: string;
  isNew?: boolean;
  tags: [label: string, color: 'success' | 'warning' | 'neutral' | 'accent' | 'info' | 'danger'][];
  desc: string;
  when: string;
  note?: string;
  pipeline: [icon: string, title: string, description: string, repeats?: boolean][];
  fields: StrategyField[];
}

const models = ['Borealis-27B (Norge)', 'Qwen3.8-27B (Norge)', 'GPT-4.1 (EU)', 'GPT-4.1 mini (EU)'];

export const strategies: Strategy[] = [
  {
    id: 'ett',
    name: 'Ett steg',
    tags: [
      ['Lav kostnad', 'success'],
      ['Rask', 'success'],
      ['Brukes av 14 tjenester', 'neutral'],
    ],
    desc: 'Ett søk og ett modellkall. Tjenesten finner de beste tekstbitene og svarer ut fra dem.',
    when: 'spørsmålene er korte og svaret som regel står ett sted, for eksempel i en veileder.',
    pipeline: [
      ['S', 'Søk', 'Ett søk i datasettene med spørsmålet.'],
      ['Sv', 'Skriv svar', 'Ett modellkall med treffene som grunnlag.'],
      ['V', 'Vern', 'Kildekrav og filtrering etter risikonivå.'],
    ],
    fields: [
      {
        id: 'datasett',
        label: 'Datasett',
        type: 'enum',
        options: ['Kudos-rapporter', 'Veiledere og rundskriv', 'Nettsidene til Testetaten'],
        def: 'Kudos-rapporter',
        help: 'Hvor tjenesten søker.',
      },
      {
        id: 'treff',
        label: 'Antall treff',
        type: 'int',
        min: 1,
        max: 30,
        def: 8,
        help: 'Hvor mange tekstbiter som sendes til modellen.',
      },
      {
        id: 'modell',
        label: 'Modell',
        type: 'enum',
        options: models,
        def: models[0] as string,
        help: 'Stedet for behandling følger modellen.',
      },
      {
        id: 'format',
        label: 'Resultat',
        type: 'enum',
        options: ['Svar med kilder', 'Felter', 'Dokument fra mal'],
        def: 'Svar med kilder',
        help: 'Hva tjenesten leverer.',
      },
    ],
  },
  {
    id: 'agent',
    name: 'Agent (søker selv)',
    tags: [
      ['Middels kostnad', 'warning'],
      ['Tregere', 'warning'],
      ['Brukes av 6 tjenester', 'neutral'],
    ],
    desc: 'Modellen bestemmer selv hvilke verktøy den bruker og i hvilken rekkefølge, til den har nok til å svare eller når grensene.',
    when: 'spørsmålene krever flere søk, sammenligning eller oppslag i andre systemer.',
    pipeline: [
      ['P', 'Planlegg', 'Agenten lager en plan ut fra spørsmålet.'],
      [
        '↻',
        'Velg og bruk et verktøy',
        'Gjentas til agenten har nok, eller til maks steg eller tokenbudsjett er nådd.',
        true,
      ],
      ['?', 'Vurder grunnlaget', 'Agenten sjekker om den kan svare.', true],
      ['Sv', 'Svar', 'Svar med kilder. Vernet kjøres før svaret sendes.'],
    ],
    fields: [
      {
        id: 'verktoy',
        label: 'Verktøy agenten kan bruke',
        type: 'tools',
        help: 'Agenten kan bare bruke det som er krysset av.',
        def: ['Søk i datasett', 'Les dokument', 'Sammenlign dokumenter'],
        tools: [
          ['Søk i datasett', 'Når: Kudos-rapporter, Tilsynsrapporter 2025'],
          ['Les dokument', 'Når: dokumentene i datasettene over'],
          ['Sammenlign dokumenter', 'Når: dokumenter agenten allerede har lest'],
          [
            'Klarspråk · digdir.klarsprak@2.3',
            'Når: bare teksten som sendes til den. Ny versjon @2.4 er tilgjengelig.',
          ],
          ['Lovdata (MCP)', 'Når: lover og forskrifter, bare lesing'],
          ['Saksbehandlingssystemet (OpenAPI)', 'Når: saker av typen Tilskudd, lesing og skriving'],
        ],
      },
      {
        id: 'maks_steg',
        label: 'Maks antall steg',
        type: 'int',
        min: 1,
        max: 20,
        def: 8,
        help: 'Agenten stopper og svarer med det den har.',
      },
      {
        id: 'budsjett',
        label: 'Tokenbudsjett per kjøring',
        type: 'int',
        min: 2000,
        max: 64000,
        def: 20000,
        help: 'Kjøringen stopper når budsjettet er brukt.',
      },
      {
        id: 'stopp',
        label: 'Agenten er ferdig når',
        type: 'enum',
        options: [
          'Den har et svar med kilder',
          'Et verktøy har levert et resultat',
          'Maks antall steg er nådd',
        ],
        def: 'Den har et svar med kilder',
        help: '',
      },
      {
        id: 'godkjenn',
        label: 'Spør et menneske før agenten skriver til et fagsystem',
        type: 'bool',
        def: true,
        help: 'Gjelder verktøy som kan endre data, som Saksbehandlingssystemet.',
      },
      {
        id: 'modell',
        label: 'Modell',
        type: 'enum',
        options: models,
        def: models[0] as string,
        help: 'Agenter fungerer best med modeller som er gode på verktøybruk.',
      },
    ],
  },
  { id: 'stegflyt', name: 'Fast stegflyt', tags: [], desc: '', when: '', pipeline: [], fields: [] },
  {
    id: 'auto',
    name: 'La assistenten velge',
    tags: [['Standard', 'accent']],
    desc: 'Byggeassistenten kjører testsettet med hver strategi og foreslår den som gir best resultat for prisen. Den bytter aldri strategi uten at du godkjenner det.',
    when: 'du ikke vet hva som passer best, eller jobben er ny.',
    pipeline: [
      ['T', 'Kjør testsettet', 'Med Ett steg, Agent og Fast stegflyt.'],
      ['S', 'Sammenlign', 'Poeng, kostnad og svartid.'],
      ['F', 'Foreslå', 'Du ser forslaget og velger selv.'],
    ],
    fields: [
      {
        id: 'vurder',
        label: 'Vurder strategien på nytt hver måned',
        type: 'bool',
        def: true,
        help: 'Du får et forslag hvis en annen strategi blir bedre. Ingenting byttes automatisk.',
      },
      {
        id: 'vekt',
        label: 'Hva er viktigst',
        type: 'enum',
        options: ['Kvalitet', 'Kostnad', 'Svartid'],
        def: 'Kvalitet',
        help: 'Brukes når strategiene er nesten like gode.',
      },
    ],
  },
  {
    id: 'debatt',
    name: 'Flere modeller drøfter',
    isNew: true,
    tags: [
      ['Beta', 'info'],
      ['Høy kostnad', 'danger'],
    ],
    desc: 'To eller flere modeller lager hvert sitt svar og kommenterer hverandres. En dommermodell velger eller setter sammen det endelige svaret.',
    when: 'svaret krever avveining, og det er viktig å fange opp svakheter i resonnementet.',
    note: 'Lagt til av Digdir 3. oktober. Skjermbildet er laget fra strategiens innstillingsskjema. Ingen andre skjermbilder er endret.',
    pipeline: [
      ['1', 'Hver modell svarer', 'Samme spørsmål og samme kilder.'],
      ['↻', 'Modellene kommenterer hverandre', 'Gjentas så mange runder du velger.', true],
      ['D', 'Dommeren avgjør', 'Velger eller setter sammen det endelige svaret.'],
    ],
    fields: [
      { id: 'antall', label: 'Antall modeller', type: 'int', min: 2, max: 4, def: 2, help: '' },
      {
        id: 'runder',
        label: 'Antall runder med kommentarer',
        type: 'int',
        min: 1,
        max: 3,
        def: 1,
        help: '',
      },
      {
        id: 'dommer',
        label: 'Dommermodell',
        type: 'enum',
        options: models,
        def: models[2] as string,
        help: 'Bør være en annen modell enn dem som svarer.',
      },
    ],
  },
];

export const recommendation = {
  pick: 'Agent i flere steg',
  why: 'Spørsmålene i testsettet krever ofte to eller flere søk, og en av fem gjelder sammenligning av rapporter. Agenten fikk best resultat. Den koster mer per kjøring, men holder seg godt innenfor grensen dere har satt.',
  rows: [
    ['Ett steg', '0,71', '4 kr', '2,1 s'],
    ['Agent i flere steg', '0,83', '11 kr', '4,7 s'],
    ['Fast stegflyt (Svar med kilder)', '0,81', '7 kr', '3,6 s'],
  ] as [string, string, string, string][],
};

export const agentTrace: [action: string, detail: string, meta: string][] = [
  ['Planla', '3 søk om digital veiledning og kanalvalg', '0,4 s · 210 tokens'],
  ['Brukte verktøy', 'Søk i datasett: «digital veiledning evaluering», 14 treff', '0,3 s'],
  ['Brukte verktøy', 'Les dokument: Evaluering 2023, s. 4–9', '0,2 s'],
  ['Brukte verktøy', 'Søk i datasett: «kanalvalg ventetid», 6 treff', '0,3 s'],
  ['Vurderte', 'Grunnlaget holder, stopper søket', '0,5 s · 640 tokens'],
  ['Svarte', 'Svar med 3 kilder', '1,9 s · 3 320 tokens'],
];
