import { buildExampleUsage, exampleProjects, quotaTokensPerMonth } from './data/usage';
import { platformStepBlocks } from './mock/step-blocks';
import { examplePng, exampleStepOperations } from './mock/step-operations';
import { platformRecipes } from './mock/recipes';
import { strategyRoutes } from './mock/strategies';
import { assistantMock } from './mock/assistant';
import { buildingBlocksMock } from './mock/building-blocks';
import { datasetsMock } from './mock/datasets';
import { keyPoliciesMock } from './mock/key-policies';
import { accessMock } from './mock/access';
import { maskinportenMock } from './mock/maskinporten';
import { hooksMock } from './mock/hooks';
import { triggersMock } from './mock/triggers';
import { environmentsMock } from './mock/environments';
import { preferencesMock } from './mock/preferences';
import { onboardingMock } from './mock/onboarding';
import { playgroundMock } from './mock/playground';
import { qualityMock } from './mock/quality';
import { batchRunsMock } from './mock/batch-runs';
import { searchEnginesMock } from './mock/search-engines';
import { skillsMock } from './mock/skills';
import { exampleAudit, platformStatusMock } from './mock/platform-status';
import { devtoolsMock } from './mock/devtools';
import { settingsMock } from './mock/settings';
import { blocksMock } from './mock/blocks';
import { serviceTabsMock } from './mock/service-tabs';
import { exampleSecretNames } from './data/building-blocks';
import { inputFieldsOf } from './data/playground';
import { parseYaml } from './yaml';
import { reasonProblem } from './components/ReasonField';
import { clientMock, exampleKeyAudit } from './mock-clients';
import type { ServiceSpec } from './data/service-definition';
import type {
  ClientView,
  ServiceKeyView,
  CapabilityModel,
  EvalRunSummary,
  FeedbackItem,
  TestSet,
  DatasetSummary,
  EffectiveSetting,
  FacetField,
  SettingInfo,
  ModelOption,
  Residency,
  DefinitionWithHistory,
  Organisation,
  PublishedDefinition,
  TaskTimeline,
  VersionSummary,
  AccessView,
  ConnectionView,
  IntegrationsView,
  SharedService,
  TaskRow,
  UsageReport,
} from './types';
import {
  logTasks,
  logTimelines,
  playgroundTasks,
  playgroundTimeline,
  serviceRuns,
} from './data/log';
import { exampleQualityFeedback, exampleQualityRuns, exampleQualityTestSets } from './data/quality';

export const exampleOrganisations: Organisation[] = [
  { orgNumber: '999888777', name: 'Testetaten' },
  { orgNumber: '999777666', name: 'Prøvekommunen' },
  { orgNumber: '999666555', name: 'Eksempeldirektoratet' },
];

const service = (
  id: string,
  name: string,
  purpose: string,
  spec: Record<string, unknown>,
  history: VersionSummary[],
): DefinitionWithHistory => {
  const last = history.at(-1) as VersionSummary;
  const definition = {
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant: '999888777', id, name, version: last.version },
    spec: { purpose, ...spec },
  };
  const latest: PublishedDefinition = {
    kind: 'Service',
    tenant: '999888777',
    id,
    ...last,
    definition,
  };
  return { kind: 'Service', tenant: '999888777', id, latest, versions: history };
};

const exampleEarlierSpecs: Record<string, Record<number, Record<string, unknown>>> = import.meta.env
  .MODE === 'test'
  ? {}
  : {
      rapportassistenten: {
        5: {
          strategy: { id: 'agent-loop', version: 1, config: { maxSteps: 5, tokenBudget: 12000 } },
          knowledge: { datasets: [{ dataset: 'digdir/kudos' }], runtimeDocuments: true },
          model: { primary: 'aivar/qwen3-8', residency: 'norway' },
          exposure: { chat: true, rest: true },
        },
        6: {
          strategy: { id: 'agent-loop', version: 1, config: { maxSteps: 6, tokenBudget: 16000 } },
          output: { kind: 'answer', withSources: false },
          model: { primary: 'aivar/borealis-27b', residency: 'norway' },
          exposure: { chat: true, mcp: true, rest: true },
        },
      },
    };

export const exampleServices: DefinitionWithHistory[] = [
  service(
    'rapportassistenten',
    'Rapportassistenten',
    'Svarer saksbehandlere på spørsmål om evalueringer, med kilder.',
    {
      riskClass: 'limited',
      audience: ['employees'],
      output: { kind: 'answer', withSources: true },
      strategy: {
        id: 'agent-loop',
        version: 1,
        config: {
          maxSteps: 8,
          tokenBudget: 20000,
          instructions:
            'Svar saksbehandlere i Testetaten på spørsmål om evalueringer. Bruk bare rapportene og nettsidene. Vis alltid kilden med dato.',
        },
      },
      knowledge: { datasets: [{ dataset: 'digdir/kudos' }], runtimeDocuments: false },
      tools: ['rag@1'],
      model: { primary: 'aivar/borealis-27b', fallback: 'aivar/qwen3-8', residency: 'norway' },
      exposure: { chat: true, mcp: true, openai: true, rest: true },
    },
    [
      ...(import.meta.env.MODE === 'test'
        ? []
        : [
            {
              version: 5,
              publishedBy: 'employee:ansattporten:ola',
              publishedAt: '2026-09-02T08:30:00Z',
              reason: 'Første versjon i drift',
            },
          ]),
      {
        version: 6,
        publishedBy: 'employee:ansattporten:kari',
        publishedAt: '2026-09-20T09:12:00Z',
        reason: 'Nye kilder fra Kudos',
      },
      {
        version: 7,
        publishedBy: 'employee:ansattporten:kari',
        publishedAt: '2026-10-01T13:40:00Z',
        reason: 'Strammere krav til kilder',
      },
    ],
  ),
  service(
    'postsortering',
    'Postsortering',
    'Foreslår saksområde, prioritet og mottaker for innkommende post.',
    {
      riskClass: 'limited',
      input: { accepts: ['text/plain', 'application/pdf'] },
      output: {
        kind: 'fields',
        fields: [{ name: 'category', type: 'string', description: 'Tema' }],
      },
      strategy: { id: 'step-flow', version: 1, config: { flow: 'postsortering-flyt@1' } },
      model: { primary: 'aivar/borealis-27b', residency: 'norway' },
      exposure: { rest: true },
      triggers: [{ kind: 'queue-message', queue: 'post-inn' }],
    },
    [
      {
        version: 3,
        publishedBy: 'employee:ansattporten:ola',
        publishedAt: '2026-09-28T08:05:00Z',
        reason: 'Ny kø for klager',
      },
    ],
  ),
  service(
    'motereferat',
    'Møtereferat',
    'Gjør om opptak til tekst og lager et referat med beslutninger og oppgaver.',
    {
      riskClass: 'limited',
      output: { kind: 'document' },
      tools: ['digdir.transkribering@1.4'],
      model: { primary: 'aivar/borealis-27b', residency: 'norway' },
      triggers: [{ kind: 'document-arrives', folder: 'teams-opptak' }],
    },
    [
      {
        version: 2,
        publishedBy: 'employee:ansattporten:kari',
        publishedAt: '2026-09-18T10:00:00Z',
        reason: 'Beslutninger som egen liste',
      },
    ],
  ),
  service(
    'vedtaksutkast',
    'Vedtaksutkast',
    'Forbereder søknader i flere steg og lager utkast til vedtak.',
    {
      riskClass: 'high',
      output: { kind: 'document' },
      tools: ['digdir.klarsprak@2.3'],
      model: { primary: 'foundry-openai/gpt-4.1', residency: 'eu' },
    },
    [
      {
        version: 7,
        publishedBy: 'employee:ansattporten:per',
        publishedAt: '2026-09-30T13:05:00Z',
        reason: 'Nytt steg for vedlegg',
      },
    ],
  ),
  service(
    'nettsider-nynorsk',
    'Nettsider på nynorsk',
    'Oversetter nye og endrede nettsider fra bokmål til nynorsk.',
    {
      riskClass: 'minimal',
      output: { kind: 'answer' },
      tools: ['digdir.nynorsk@1.2'],
      model: { primary: 'aivar/borealis-27b', residency: 'norway' },
      triggers: [{ kind: 'schedule', cron: '0 2 * * *' }],
    },
    [
      {
        version: 4,
        publishedBy: 'employee:ansattporten:ola',
        publishedAt: '2026-10-02T13:10:00Z',
        reason: 'Satt på pause',
      },
    ],
  ),
];

export const exampleTimeline: TaskTimeline = {
  id: 't1',
  service: 'Rapportassistenten',
  status: 'completed',
  trigger: 'Chat',
  caller: 'Ansatt i Testetaten (A-4K7Q)',
  startedAt: '2026-10-06T10:41:00+02:00',
  durationSeconds: 4.7,
  inputTokens: 4120,
  outputTokens: 350,
  costOre: 2.1,
  steps: [
    {
      id: 's1',
      type: 'trigger',
      title: 'Spørsmål i chat',
      summary: 'Ansatt i Testetaten (A-4K7Q) i intranettet',
      at: 0,
      blocks: [
        { kind: 'quote', text: 'Hva sier evalueringer om digital veiledning siden 2020?' },
        {
          kind: 'kv',
          rows: [
            ['Kanal', 'Vår chatløsning (intranett)'],
            ['Samtale', 's-81f2 · melding 3'],
          ],
        },
      ],
    },
    {
      id: 's2',
      type: 'guard',
      title: 'Personopplysninger sjekket',
      summary: 'Ingen funnet',
      at: 0.1,
      durationSeconds: 0.05,
      blocks: [],
    },
    {
      id: 's3',
      type: 'search',
      title: 'Søk',
      summary: '«digital veiledning evaluering» · 14 treff',
      at: 0.6,
      durationSeconds: 0.3,
      blocks: [
        { kind: 'quote', text: 'digital veiledning evaluering' },
        {
          kind: 'tags',
          label: 'Filter',
          items: ['Datasett: Kudos-rapporter', 'Dokumenttype: Evaluering', 'År: 2020–2026'],
        },
      ],
    },
    {
      id: 's4',
      type: 'model',
      title: 'Modellkall',
      summary: 'Borealis-27B · 4 120 inn, 350 ut',
      at: 2.6,
      durationSeconds: 1.9,
      blocks: [
        {
          kind: 'kv',
          rows: [
            ['Modell', 'Borealis-27B via AIVAR'],
            ['Data behandlet i', 'Norge'],
            ['Reservemodell', 'Ikke brukt'],
          ],
        },
      ],
    },
    {
      id: 's5',
      type: 'rerank',
      title: 'Rangering',
      summary: 'Ny stegtype fra plattformen',
      at: 4.0,
      blocks: [{ kind: 'kv', rows: [['Kandidater', '40']] }],
    },
    {
      id: 's6',
      type: 'result',
      title: 'Svar sendt',
      summary: 'Svar med 3 kilder',
      at: 4.7,
      blocks: [
        {
          kind: 'answer',
          text: 'Evalueringene peker på at digital veiledning virker best når den kombineres med muntlig hjelp.',
        },
      ],
    },
  ],
};

export const exampleStepFlow: DefinitionWithHistory = {
  kind: 'StepFlow',
  tenant: '999888777',
  id: 'postruting',
  latest: {
    kind: 'StepFlow',
    tenant: '999888777',
    id: 'postruting',
    version: 2,
    publishedBy: 'employee:ansattporten:kari',
    publishedAt: '2026-10-02T10:00:00Z',
    reason: 'Ny regel for klager',
    definition: {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: '999888777', id: 'postruting', name: 'Postruting', version: 2 },
      spec: {
        purpose: 'Klassifiser og rut innkommende post',
        steps: [
          { id: 'klassifiser', name: 'Klassifiser', block: 'classify@1' },
          {
            id: 'velg-mottaker',
            switchOn: 'klassifiser.kategori',
            cases: [{ when: 'klage', steps: [{ id: 'til-klage', block: 'route@1' }] }],
            else: [{ id: 'til-arkiv', block: 'route@1' }],
          },
        ],
      },
    },
  },
  versions: [
    {
      version: 2,
      publishedBy: 'employee:ansattporten:kari',
      publishedAt: '2026-10-02T10:00:00Z',
      reason: 'Ny regel for klager',
    },
  ],
};

export const exampleTestSets: TestSet[] = exampleQualityTestSets;

export const exampleRuns: EvalRunSummary[] = exampleQualityRuns;

export const exampleFeedback: FeedbackItem[] = exampleQualityFeedback;

export const exampleCapabilities: CapabilityModel[] = [
  { id: 'rapportassistenten__default', description: 'Svarer med kilder' },
  { id: 'tjenestebygger__default', description: 'Hjelper deg å endre tjenester' },
];

export const exampleChatReply = [
  'Jeg foreslår å bytte til en modell som kjører i Norge.',
  '```json',
  '{"changes":[{"path":"spec.model.primary","value":"aivar/qwen3-8","reason":"Kjører i Norge"}]}',
  '```',
].join('\n');

export const mockMeActor = 'employee:mock:kari';

const keysSeenIn = (rows: TaskRow[], service: string) => [
  ...new Map(
    rows
      .filter((r) => r.service === service && r.actor?.kind === 'api-key' && r.actor.id)
      .map((r) => [
        r.actor?.id ?? '',
        {
          id: (r.actor?.id ?? '').replace(/^api-key:/, ''),
          name: r.actor?.name ?? '',
          bound: true,
        },
      ]),
  ).values(),
];

export const exampleTasks: TaskRow[] =
  import.meta.env.MODE === 'test' ? logTasks : [...logTasks, ...serviceRuns('rapportassistenten')];

export const exampleUsage: UsageReport = buildExampleUsage();

export const exampleShared: SharedService[] = [
  [
    'klarsprak',
    'Klarspråk',
    'Skriver om tekst så den blir lettere å forstå, uten å endre innholdet.',
    3,
  ],
  [
    'nynorsk',
    'Bokmål til nynorsk',
    'Oversetter tekst fra bokmål til nynorsk etter gjeldende rettskriving.',
    1,
  ],
  ['oppsummering', 'Oppsummering', 'Lager korte sammendrag av lange dokumenter.', 3],
  ['anonymisering', 'Anonymisering', 'Finner og fjerner personopplysninger.', 1],
  ['transkribering', 'Transkribering', 'Gjør lydopptak om til tekst.', 2],
  ['hent_felter', 'Hent ut opplysninger', 'Fyller ut feltene dere definerer fra dokumenter.', 1],
].map(([id, name, purpose, version]) => ({
  tenant: '991825827',
  id: id as string,
  name: name as string,
  purpose: purpose as string,
  version: version as number,
  riskClass: 'minimal',
  residency: 'norway',
  dataLocation: 'norway' as const,
  model: 'aivar/borealis-27b',
  exposure: ['rest', 'mcp'],
  variants: [{ id: 'default', publicName: `${String(id)}__default`, aliases: [] }],
}));

export const exampleAccess: AccessView = {
  services: [
    {
      id: 'rapportassistenten',
      name: 'Rapportassistenten',
      publicName: 'rapportassistenten__default',
      requirement: {
        resource: 'urn:altinn:resource:digdir-genai-platform',
        action: 'read',
        scope: 'legacy:query',
      },
    },
  ],
  keys: [
    {
      id: 'key-cms',
      name: 'Publiseringssystemet',
      prefix: 'gk_live_7f2a',
      lastFour: 'x9Qz',
      scopes: ['query'],
      datasets: [],
      agents: ['nettsider-nynorsk__default'],
      createdAt: '2026-08-14T10:00:00Z',
      lastUsedAt: '2026-10-07T08:30:00Z',
      expiresAt: null,
      revokedAt: null,
    },
    {
      id: 'key-analyse',
      name: 'Testskript for analyse',
      prefix: 'gk_test_3c91',
      lastFour: 'b2Lm',
      scopes: ['query'],
      datasets: [],
      agents: [],
      createdAt: '2026-10-02T09:00:00Z',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    },
    {
      id: 'key-gammel',
      name: 'Gammel integrasjon',
      prefix: 'gk_live_a81d',
      lastFour: 'Q7rT',
      scopes: ['query'],
      datasets: ['digdir/kudos'],
      agents: ['rapportassistenten__default'],
      createdAt: '2026-03-02T09:00:00Z',
      expiresAt: null,
      revokedAt: '2026-06-03T09:00:00Z',
    },
  ],
};

export const exampleConnections: ConnectionView[] = [
  {
    id: 'arkiv',
    name: 'Arkivsøk',
    endpoint: 'https://mcp.testetaten.example.no/mcp',
    version: '1.2',
    allow: [{ host: 'mcp.testetaten.example.no' }],
    auth: { kind: 'bearer', secret: 'arkiv-token' },
    tools: [
      { name: 'arkiv.sok', description: 'Søk i saksarkivet' },
      { name: 'arkiv.hent', description: 'Hent ett dokument' },
    ],
    pending: [{ name: 'arkiv.sok', description: 'Søk i saksarkivet, nå med datofilter' }],
  },
];

export interface MockRequest {
  path: string;
  url: URL;
  method: string;
  init: RequestInit | undefined;
  body: <T>() => T;
  reason: string | null;
  json: (body: unknown, status?: number) => Response;
  notFound: () => Response;
  reasonMissing: () => Response;
}

export type MockHandler = (
  request: MockRequest,
) => Response | undefined | Promise<Response | undefined>;

// Feature mocks live in mock/<feature>.ts as `(options) => MockHandler`; a handler returns undefined for paths it does not own.
const featureMocks = {
  buildingBlocks: buildingBlocksMock,
  skills: skillsMock,
  playground: playgroundMock,
  searchEngines: searchEnginesMock,
  assistant: assistantMock,
  datasets: datasetsMock,
  quality: qualityMock,
  batchRuns: batchRunsMock,
  onboarding: onboardingMock,
  maskinporten: maskinportenMock,
  keyPolicies: keyPoliciesMock,
  hooks: hooksMock,
  triggers: triggersMock,
  environments: environmentsMock,
  preferences: preferencesMock,
  platformStatus: platformStatusMock,
  access: accessMock,
  devtools: devtoolsMock,
  settings: settingsMock,
  blocks: blocksMock,
  serviceTabs: serviceTabsMock,
};

export type FeatureMockOptions = {
  [K in keyof typeof featureMocks]?: Parameters<(typeof featureMocks)[K]>[0];
};

export interface MockExtras {
  features?: FeatureMockOptions;
  testSets?: TestSet[];
  runs?: EvalRunSummary[];
  feedback?: FeedbackItem[];
  capabilities?: CapabilityModel[];
  chatReply?: string;
  stepFlows?: DefinitionWithHistory[];
  tasks?: TaskRow[];
  playgroundTasks?: TaskRow[];
  usage?: UsageReport;
  shared?: SharedService[];
  access?: AccessView;
  integrations?: IntegrationsView;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const asObject = (definition: unknown): Record<string, unknown> => {
  if (typeof definition !== 'string') return definition as Record<string, unknown>;
  const id = /\bid:\s*(\S+)/.exec(definition)?.[1] ?? 'uten-id';
  const tenant = /\btenant:\s*'?(\d{9})/.exec(definition)?.[1] ?? '999888777';
  const kind = /\bkind:\s*StepFlow/.test(definition) ? 'StepFlow' : 'Service';
  return { apiVersion: 'genai/v1', kind, metadata: { tenant, id }, spec: { purpose: 'Fra YAML' } };
};

const validationErrors = (body: { definition?: unknown }) => {
  const definition = body.definition;
  if (typeof definition === 'string')
    return /steps:\s*\[\]/.test(definition)
      ? [{ path: 'spec.steps', message: 'Too small: expected array to have >=1 items' }]
      : [];
  const spec = (definition as { kind?: string; spec?: { steps?: unknown[] } } | undefined)?.spec;
  if ((definition as { kind?: string })?.kind === 'StepFlow' && !spec?.steps?.length)
    return [{ path: 'spec.steps', message: 'Too small: expected array to have >=1 items' }];
  return [];
};

const reasonOf = (init: RequestInit | undefined) => {
  const raw = new Headers(init?.headers).get('change-reason');
  const reason = raw === null ? null : decodeURIComponent(raw);
  return reason === null || reasonProblem(reason) ? null : reason;
};

const notFound = () => json({ type: 'about:blank', title: 'Not found', status: 404 }, 404);

const missingReason = () =>
  json(
    {
      title: 'Invalid request',
      status: 400,
      errors: [{ path: 'change-reason', message: reasonProblem('') }],
    },
    400,
  );

export const exampleModels: ModelOption[] = [
  {
    id: 'aivar/borealis-27b',
    family: 'borealis',
    residency: 'norway',
    capabilities: ['stream', 'tools', 'json-schema'],
    operations: ['chat', 'generate-image'],
    price: { inputPerThousand: 0.0119, outputPerThousand: 0.0952 },
  },
  {
    id: 'aivar/nora-70b',
    family: 'nora',
    residency: 'norway',
    capabilities: ['stream', 'tools', 'json-schema'],
  },
  { id: 'aivar/qwen3-8', family: 'qwen3', residency: 'norway', capabilities: ['stream'] },
  {
    id: 'ai-gateway/borealis-27b',
    name: 'Borealis 27B',
    family: 'borealis',
    residency: 'norway',
    capabilities: ['stream', 'tools'],
  },
  {
    id: 'foundry-openai/gpt-4.1',
    name: 'GPT-4.1',
    family: 'gpt-4.1',
    residency: 'eu',
    capabilities: ['stream', 'tools', 'json-schema'],
    operations: ['chat', 'generate-image'],
  },
  {
    id: 'foundry-openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    family: 'gpt-4.1',
    residency: 'eu',
    capabilities: ['stream', 'tools', 'json-schema'],
  },
  {
    id: 'foundry-openai/gpt-5',
    name: 'GPT-5 (OpenAI)',
    family: 'gpt-5',
    residency: 'global',
    capabilities: ['stream', 'tools'],
  },
  {
    id: 'foundry-openai/gpt-4o-2m-tps',
    family: 'gpt-4o',
    residency: 'global',
    capabilities: ['stream', 'tools', 'json-schema'],
  },
];

export const exampleDatasets: DatasetSummary[] = [
  [
    'digdir/kudos',
    'Kudos-rapporter',
    'Rapporter fra statlige virksomheter i rapportarkivet Kudos.',
    'ready',
  ],
  [
    '999888777/tilsynsrapporter-2025',
    'Tilsynsrapporter 2025',
    'Tilsynsrapporter fra 2025.',
    'partial',
  ],
  [
    '999888777/nettsider',
    'Nettsidene til Testetaten',
    'Alle offentlige sider på testetaten.example.no.',
    'failed',
  ],
  [
    '999888777/veiledere',
    'Veiledere og rundskriv',
    'Veiledere og rundskriv fra publiseringssystemet.',
    'ready',
  ],
  [
    '999666555/statsbudsjett-2026',
    'Statsbudsjettet 2026',
    'Delt av Eksempeldirektoratet.',
    'ready',
  ],
  [
    '999888777/horing-2026-7',
    'Høring 2026/7',
    'Høringssvar på forslag om nye tilskuddsregler.',
    'ready',
  ],
].map(([id, name, description, status]) => ({
  id: id as string,
  name: name as string,
  description: description as string,
  'enabled?': true,
  status: status as string,
}));

export const exampleFacets: Record<string, FacetField['options']> = {
  type: [
    { value: 'Tildelingsbrev', count: 412, selected: false },
    { value: 'Årsrapport', count: 1290, selected: false },
  ],
  orgs_long: [
    { value: 'Digitaliseringsdirektoratet', count: 61, selected: false },
    { value: 'Skatteetaten', count: 88, selected: false },
  ],
};

const readableTypes = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];

const mockFileInput = (definition: unknown) => {
  const spec = (definition as { spec?: ServiceSpec } | undefined)?.spec;
  const accepts = spec?.input.accepts ?? [];
  const documents =
    spec?.knowledge?.runtimeDocuments === true
      ? accepts.filter((type) => readableTypes.includes(type))
      : [];
  const media = accepts.filter((type) => type.startsWith('audio/') || type.startsWith('image/'));
  return {
    documents: documents.length ? { accepts: documents, maxBytes: 2097152, maxCount: 5 } : null,
    media: media.length ? { accepts: media, maxBytes: 10485760, maxCount: 5 } : null,
    maxRequestBytes: 16777216,
  };
};

const mockInputFields = (definition: unknown) => {
  let parsed = definition;
  try {
    if (typeof definition === 'string') parsed = parseYaml(definition);
  } catch {
    return [];
  }
  return inputFieldsOf(parsed).map((f) => {
    const values = f.optionsFrom ? exampleFacets[f.optionsFrom.facet] : undefined;
    return values?.length
      ? { ...f, options: [...values].sort((a, b) => b.count - a.count).map((v) => v.value) }
      : f;
  });
};

export const exampleSettingsCatalog: SettingInfo[] = [
  {
    key: 'retrieval.retrieveTopK',
    description: 'Chunks fetched by id after merging, before boosting and reranking.',
    category: 'retrieval',
    axis: 'service',
    sensitivity: 'normal',
    default: 100,
    settableAt: ['platform', 'tenant', 'service'],
  },
  {
    key: 'answers.writtenStandard',
    description: 'Målform i svar.',
    category: 'answers',
    axis: 'service',
    sensitivity: 'normal',
    default: 'user',
    settableAt: ['platform', 'tenant', 'service', 'call'],
    schema: { type: 'string', enum: ['user', 'bokmal', 'nynorsk'] },
  },
];

export const exampleEffective: Record<string, EffectiveSetting> = {
  'retrieval.retrieveTopK': {
    key: 'retrieval.retrieveTopK',
    value: 20,
    source: 'service',
    defaultVersion: 2,
    overridden: [
      { layer: 'tenant', value: 15 },
      { layer: 'platform', value: 100 },
    ],
    rejected: [],
  },
  'answers.writtenStandard': {
    key: 'answers.writtenStandard',
    value: 'user',
    source: 'pin',
    pinnedVersion: 1,
    defaultVersion: 3,
    overridden: [],
    rejected: [],
  },
  'usage.monthlyTokens': {
    key: 'usage.monthlyTokens',
    value: quotaTokensPerMonth,
    source: 'tenant',
    defaultVersion: 1,
    overridden: [],
    rejected: [],
  },
};

export const serviceTemplate = (tenant: string, models: ModelOption[] = exampleModels) => {
  const model = models[0];
  return {
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id: 'ny-tjeneste' },
    spec: {
      purpose: 'Ny tjeneste',
      audience: ['employees'],
      riskClass: 'limited',
      variants: [{ id: 'default', aliases: [], overrides: {} }],
      input: { accepts: ['text/plain'], ocr: false },
      output: { kind: 'answer', withSources: true },
      strategy: { id: 'single-call', version: 1, config: { instructions: '' } },
      knowledge: { datasets: [], runtimeDocuments: false },
      tools: [],
      model: { primary: model?.id ?? '', residency: model?.residency ?? 'norway' },
      guardrails: {
        'pii-before-model': { categories: ['national-id', 'd-number', 'phone', 'email'] },
        'pii-out-of-log': { categories: ['national-id', 'd-number', 'phone', 'email'] },
        language: { mode: 'nb' },
      },
      exposure: { chat: true, mcp: false, openai: false, rest: false },
    },
  };
};

const residencyOrder: Residency[] = ['norway', 'eu', 'global'];

const strategyNeeds: Record<string, string[]> = {
  'agent-loop@1': ['tools', 'json-schema'],
  'rag-single-shot@1': ['json-schema'],
};

const withMockQuota = (report: UsageReport): UsageReport => {
  const month = report.to.slice(0, 7);
  const usedTokens = report.daily
    .filter((d) => d.date.startsWith(month))
    .reduce((n, d) => n + d.usage.inputTokens + d.usage.outputTokens, 0);
  const usedPercent = (usedTokens / quotaTokensPerMonth) * 100;
  return {
    ...report,
    quota: {
      usedTokens: Math.round(usedTokens),
      monthlyTokens: quotaTokensPerMonth,
      usedPercent,
      alertPercent: 80,
      alert: usedPercent >= 80,
    },
  };
};

export const mockFetch = (
  services = exampleServices,
  timelines: TaskTimeline[] = logTimelines,
  models: ModelOption[] = exampleModels,
  datasets: DatasetSummary[] = exampleDatasets,
  extras: MockExtras = {},
): typeof fetch => {
  let current = structuredClone([...services, ...(extras.stepFlows ?? [exampleStepFlow])]);
  const testSets = extras.testSets ?? exampleTestSets;
  const runs = extras.runs ?? exampleRuns;
  const feedback = extras.feedback ?? exampleFeedback;
  const capabilities = extras.capabilities ?? exampleCapabilities;
  const chatReply = extras.chatReply ?? exampleChatReply;
  const taskRows = extras.tasks ?? exampleTasks;
  const trialRows = extras.playgroundTasks ?? playgroundTasks;
  const lifecycles = new Map<
    string,
    { state: string; reason?: string; by?: string; byName?: string; at?: string }
  >();
  const usageReport =
    extras.usage ??
    withMockQuota(
      import.meta.env.MODE === 'test' ? exampleUsage : buildExampleUsage(new Date().toISOString()),
    );
  const shared = extras.shared ?? exampleShared;
  let access = structuredClone(extras.access ?? exampleAccess);
  const clientRoutes = clientMock();
  const batchRuns = featureMocks.batchRuns(extras.features?.batchRuns);
  const features: MockHandler[] = [
    featureMocks.blocks(extras.features?.blocks),
    featureMocks.buildingBlocks(extras.features?.buildingBlocks),
    featureMocks.skills(extras.features?.skills),
    featureMocks.playground(extras.features?.playground),
    featureMocks.searchEngines(extras.features?.searchEngines),
    featureMocks.assistant(extras.features?.assistant),
    featureMocks.datasets(extras.features?.datasets),
    featureMocks.onboarding(extras.features?.onboarding),
    featureMocks.maskinporten(extras.features?.maskinporten),
    featureMocks.keyPolicies(extras.features?.keyPolicies),
    featureMocks.hooks(extras.features?.hooks),
    featureMocks.triggers(extras.features?.triggers),
    featureMocks.preferences(extras.features?.preferences),
    featureMocks.platformStatus(
      extras.features?.platformStatus ??
        (import.meta.env.MODE === 'test'
          ? undefined
          : { audit: [...exampleAudit, ...exampleKeyAudit] }),
    ),
    featureMocks.access(extras.features?.access),
    featureMocks.devtools(extras.features?.devtools),
    featureMocks.settings({ catalog: exampleSettingsCatalog, ...extras.features?.settings }),
    batchRuns,
    featureMocks.environments({
      latest: (service) =>
        current.find((d) => d.kind === 'Service' && d.id === service)?.latest.version,
      ...extras.features?.environments,
    }),
    featureMocks.serviceTabs({
      tasks: () => taskRows,
      keys: async (tenant, service) => {
        const reply = clientRoutes(
          `/tenants/${tenant}/services/${encodeURIComponent(service)}/api-keys`,
          new URL('http://mock'),
          undefined,
          () => false,
        );
        const listed = reply ? ((await reply.json()) as { keys: ServiceKeyView[] }).keys : [];
        if (listed.length === 0) return keysSeenIn(taskRows, service);
        return listed
          .filter((k) => !k.revokedAt)
          .map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            bound: k.service === service,
            ...(k.client ? { client: k.client } : {}),
          }));
      },
      frontends: async (tenant, service) => {
        const reply = clientRoutes(
          `/tenants/${tenant}/clients`,
          new URL(`http://mock/?service=${encodeURIComponent(service)}`),
          undefined,
          () => false,
        );
        const listed = reply ? ((await reply.json()) as { clients: ClientView[] }).clients : [];
        return listed.map((c) => ({
          id: c.definition.metadata.id,
          ...(c.definition.metadata.name ? { name: c.definition.metadata.name } : {}),
          kind: c.definition.spec.kind,
          channels: [...c.definition.spec.channels],
        }));
      },
      ...extras.features?.serviceTabs,
    }),
    featureMocks.quality({
      published: (service) =>
        current.find((d) => d.kind === 'Service' && d.id === service)?.latest.definition,
      ...extras.features?.quality,
    }),
  ];
  let integrations = structuredClone(
    extras.integrations ?? {
      connections: exampleConnections,
      traces: { enabled: true, content: false },
    },
  );
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://mock',
    );
    const path = url.pathname.replace(/^\/api/, '');
    const request: MockRequest = {
      path,
      url,
      method: init?.method ?? 'GET',
      init,
      body: <T>() => JSON.parse(String(init?.body ?? '{}')) as T,
      reason: reasonOf(init),
      json,
      notFound,
      reasonMissing: missingReason,
    };
    for (const handle of features) {
      const reply = await handle(request);
      if (reply) return reply;
    }
    if (path === '/api/datasets') return json({ datasets });
    if (path.startsWith('/api/datasets/')) {
      const id = decodeURIComponent(path.slice('/api/datasets/'.length));
      const found = datasets.find((d) => d.id === id);
      return found ? json({ dataset: found }) : json({ error: 'Dataset not found' }, 404);
    }
    if (path === '/api/facets') {
      const fields = (url.searchParams.get('fields') ?? '').split(',').filter(Boolean);
      const unknown = fields.find((f) => !exampleFacets[f]);
      if (unknown) return json({ error: `dataset digdir/kudos cannot filter on ${unknown}` }, 400);
      return json({ fields: fields.map((field) => ({ field, options: exampleFacets[field] })) });
    }
    if (path === '/health')
      return json({
        status: 'ok',
        version: 'mock',
        builtAt: '2026-10-06T08:00:00Z',
        environment: 'genki-test',
      });
    if (path === '/settings') return json({ data: exampleSettingsCatalog });
    if (/^\/tenants\/[^/]+\/settings\/effective$/.test(path)) return json(exampleEffective);
    const archivedFlow = /^\/tenants\/[^/]+\/step-flows\/([^/]+)$/.exec(path);
    if (archivedFlow && init?.method === 'DELETE')
      return json({ id: decodeURIComponent(archivedFlow[1] ?? ''), archived: true, version: 1 });
    if (/^\/tenants\/[^/]+\/settings\/[^/]+$/.test(path) && init?.method === 'DELETE')
      return json({ task: 'mock', value: null });
    if (/^\/tenants\/[^/]+\/settings\/[^/]+$/.test(path) && init?.method === 'PUT') {
      const reason = reasonOf(init);
      if (!reason)
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [{ path: 'change-reason', message: reasonProblem('') }],
          },
          400,
        );
      const { value } = JSON.parse(String(init.body)) as { value: unknown };
      if (url.searchParams.get('dryRun') !== 'true') return json({ task: 'mock', value });
      return json({
        dryRun: true,
        services: [
          {
            tenant: '999888777',
            service: 'rapportassistenten',
            version: 6,
            status: 'overridden',
            before: 20,
            after: 20,
          },
          {
            tenant: '999888777',
            service: 'klarsprak',
            version: 2,
            status: 'changes',
            before: 15,
            after: value,
          },
        ],
      });
    }
    if (path === '/models') {
      const residency = url.searchParams.get('residency') as Residency | null;
      const needs = strategyNeeds[url.searchParams.get('strategy') ?? ''] ?? [];
      return json({
        data: models.filter(
          (m) =>
            (url.searchParams.get('all') === 'true' ||
              (m as { available?: boolean }).available !== false) &&
            (!residency ||
              residencyOrder.indexOf(m.residency) <= residencyOrder.indexOf(residency)) &&
            needs.every((n) => m.capabilities.includes(n)),
        ),
      });
    }
    if (path === '/v1/models') return json({ object: 'list', data: capabilities });
    if (path === '/v1/chat/completions' && init?.method === 'POST') {
      const asked = JSON.stringify(
        (JSON.parse(String(init.body ?? '{}')) as { messages?: unknown }).messages ?? [],
      );
      const image = /figur|bilde|image/i.test(asked);
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: chatReply } }],
          ...(image
            ? {
                attachments: [
                  {
                    type: 'image',
                    id: 'm1',
                    mediaType: 'image/png',
                    bytes: examplePng.byteLength,
                    step: 'figur',
                    url: '/v1/tasks/prove-1/media/m1',
                  },
                ],
              }
            : {}),
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'genai-task': 'prove-1' } },
      );
    }
    if (/^\/v1\/tasks\/[^/]+\/media\/[^/]+$/.test(path))
      return new Response(examplePng, { status: 200, headers: { 'content-type': 'image/png' } });
    if (/^\/tenants\/[^/]+\/step-flows\/operations$/.test(path))
      return json({ environment: 'test', data: exampleStepOperations });
    if (/^\/tenants\/[^/]+\/step-flows\/blocks$/.test(path))
      return json({ blocks: platformStepBlocks });
    if (/^\/tenants\/[^/]+\/step-flows\/recipes$/.test(path))
      return json({ recipes: platformRecipes.map((r) => ({ ...r, origin: 'shared' })) });
    const recipeVersion = /^\/tenants\/[^/]+\/step-flows\/recipes\/([^/]+)\/versions\/(\d+)$/.exec(
      path,
    );
    if (recipeVersion) {
      const found = platformRecipes.find(
        (r) =>
          r.id === decodeURIComponent(recipeVersion[1] ?? '') &&
          r.version === Number(recipeVersion[2]),
      );
      return found ? json({ recipe: { ...found, origin: 'shared' } }) : notFound();
    }
    const strategies = strategyRoutes(path);
    if (strategies) return json(strategies);
    const template = /^\/tenants\/([^/]+)\/definitions\/template$/.exec(path);
    if (template && url.searchParams.get('kind') === 'Service')
      return json({ definition: serviceTemplate(decodeURIComponent(template[1] ?? ''), models) });
    const datasetCatalog = /^\/tenants\/([^/]+)\/catalog$/.exec(path);
    if (datasetCatalog && url.searchParams.get('kind') === 'dataset' && !init?.method) {
      const tenant = decodeURIComponent(datasetCatalog[1] ?? '');
      return json({
        data: datasets
          .filter((d) => d.id.startsWith('digdir/') || d.id.startsWith(`${tenant}/`))
          .map((d) => ({
            kind: 'dataset',
            id: d.id,
            scope: d.id.startsWith(`${tenant}/`) ? tenant : 'platform',
            version: 1,
            spec: { name: d.name, description: d.description },
          })),
      });
    }
    const ownConfig = /^\/tenants\/[^/]+\/(catalog|gates|guardrail-rules)(\/.*)?$/.exec(path);
    if (ownConfig) {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return json({ data: [] });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return json({ id: path.split('/').pop() ?? '', version: 1, spec: body });
    }
    if (/^\/tenants\/[^/]+\/definitions\/input-fields$/.test(path) && init?.method === 'POST') {
      const { definition } = JSON.parse(String(init.body)) as { definition: unknown };
      return json({ fields: mockInputFields(definition), files: mockFileInput(definition) });
    }
    if (/^\/tenants\/[^/]+\/definitions\/test-run$/.test(path) && init?.method === 'POST')
      return json({ ok: true, task: 'prove-1', answer: chatReply, parts: [] });
    const evalPath = /^\/tenants\/([^/]+)\/(test-sets|eval-runs|feedback)$/.exec(path);
    if (evalPath) {
      const service = url.searchParams.get('service');
      if (evalPath[2] === 'test-sets')
        return json({ data: testSets.filter((t) => !service || t.spec.service === service) });
      if (evalPath[2] === 'eval-runs') return json({ data: runs });
      return json({ data: feedback });
    }
    if (path === '/definitions/validate' && init?.method === 'POST') {
      const errors = validationErrors(JSON.parse(String(init.body)));
      return errors.length
        ? json({ title: 'Invalid definition', status: 422, errors }, 422)
        : json({ valid: true });
    }
    if (path === '/definitions' && init?.method === 'POST') {
      const raw = JSON.parse(String(init.body)) as { definition: unknown };
      const errors = validationErrors(raw);
      if (errors.length) return json({ title: 'Invalid definition', status: 422, errors }, 422);
      const body = { definition: asObject(raw.definition) };
      const metadata = body.definition.metadata as { tenant: string; id: string };
      const kind = body.definition.kind === 'StepFlow' ? 'StepFlow' : 'Service';
      const found = current.find(
        (s) => s.tenant === metadata.tenant && s.id === metadata.id && s.kind === kind,
      );
      if (!found) {
        const created: PublishedDefinition = {
          kind,
          tenant: metadata.tenant,
          id: metadata.id,
          version: 1,
          publishedBy: 'employee:ansattporten:kari',
          publishedAt: '2026-10-06T12:00:00Z',
          reason: reasonOf(init) ?? '',
          definition: { ...body.definition, metadata: { ...metadata, version: 1 } },
        };
        current = [
          ...current,
          { kind, tenant: metadata.tenant, id: metadata.id, latest: created, versions: [created] },
        ];
        return json(created, 201);
      }
      const version = found.latest.version + 1;
      const summary: VersionSummary = {
        version,
        publishedBy: 'employee:ansattporten:kari',
        publishedAt: '2026-10-06T12:00:00Z',
        reason: reasonOf(init) ?? '',
      };
      const latest: PublishedDefinition = {
        ...found.latest,
        ...summary,
        definition: { ...body.definition, metadata: { ...metadata, version } },
      };
      current = current.map((s) =>
        s === found ? { ...s, latest, versions: [...s.versions, summary] } : s,
      );
      return json(latest, 201);
    }
    const needsReason = () => !reasonOf(init);
    const clientReply = clientRoutes(path, url, init, needsReason);
    if (clientReply) return clientReply;
    if (path === '/shared-services') return json({ data: shared });
    const serviceRoute = /^\/tenants\/[^/]+\/services\/([^/]+)$/.exec(path);
    if (serviceRoute && init?.method === 'DELETE') {
      if (needsReason()) return missingReason();
      const id = decodeURIComponent(serviceRoute[1] ?? '');
      const found = current.find((s) => s.kind === 'Service' && s.id === id);
      if (!found) return notFound();
      if (lifecycles.get(id)?.state !== 'archived')
        return json(
          {
            type: 'urn:genai:problem:service-not-archived',
            title: 'Tjenesten er ikke arkivert',
            status: 409,
            errors: [
              {
                path: 'lifecycle',
                message: 'Bare en arkivert tjeneste kan slettes. Arkiver tjenesten først.',
              },
            ],
          },
          409,
        );
      current = current.filter((s) => s !== found);
      lifecycles.delete(id);
      return json({ id, deleted: true, versions: found.versions.length, stepFlows: [] });
    }
    const lifecycleRoute = /^\/tenants\/[^/]+\/services\/([^/]+)\/lifecycle$/.exec(path);
    if (lifecycleRoute) {
      const id = decodeURIComponent(lifecycleRoute[1] ?? '');
      if (init?.method === 'PUT') {
        if (needsReason()) return missingReason();
        const { state } = JSON.parse(String(init.body)) as { state: string };
        lifecycles.set(
          id,
          state === 'active'
            ? { state }
            : {
                state,
                reason: reasonOf(init) ?? '',
                by: 'employee:ansattporten:kari',
                byName: 'Kari Nordmann',
                at: new Date().toISOString(),
              },
        );
      }
      return json(lifecycles.get(id) ?? { state: 'active' });
    }
    if (/^\/tenants\/[^/]+\/services$/.test(path))
      return json({
        data: current
          .filter((s) => s.kind === 'Service')
          .map((s) => {
            const spec = s.latest.definition.spec as Record<string, unknown>;
            const exposure = (spec.exposure ?? {}) as Record<string, unknown>;
            return {
              id: s.id,
              name: (s.latest.definition.metadata as { name?: string }).name ?? s.id,
              purpose: typeof spec.purpose === 'string' ? spec.purpose : '',
              outputKind: (spec.output as { kind?: string } | undefined)?.kind ?? 'answer',
              channels: [
                ...(exposure.chat === true ? ['chatOwn'] : []),
                ...(exposure.rest === true ? ['api'] : []),
                ...(exposure.mcp === true ? ['mcp'] : []),
              ],
              latestVersion: s.latest.version,
              status: lifecycles.get(s.id)?.state === 'paused' ? 'paused' : 'active',
              statusReason: null,
              lifecycle: lifecycles.get(s.id)?.state ?? 'active',
              updatedAt: s.latest.publishedAt,
              updatedBy: s.latest.publishedBy,
              runsThisWeek: taskRows.filter((t) => t.service === s.id).length,
            };
          }),
      });
    const taskOne = /^\/tenants\/[^/]+\/tasks\/([^/]+)$/.exec(path);
    if (taskOne) {
      const found = [...taskRows, ...trialRows].find(
        (t) => t.id === decodeURIComponent(taskOne[1] ?? ''),
      );
      return found ? json(found) : notFound();
    }
    const portal = /^\/tenants\/([^/]+)\/(overview|access|usage|tasks|integrations)$/.exec(path);
    if (portal) {
      if (portal[2] === 'overview')
        return json({
          services: services.map((s) => ({
            id: s.id,
            name: (s.latest.definition.metadata as { name?: string }).name ?? s.id,
            latestVersion: s.latest.version,
            status: lifecycles.get(s.id)?.state === 'paused' ? 'paused' : 'active',
            statusReason: null,
            warnings: [],
            runsThisWeek: taskRows.filter(
              (t) => t.service === s.id && Date.parse(t.createdAt) >= Date.now() - 7 * 86_400_000,
            ).length,
          })),
          recentTasks: taskRows.slice(0, 5),
          usageThisMonth: usageReport.totals,
          qualityWarnings: [
            { service: 'postsortering', message: 'Treff blant de ti beste falt under 70 %.' },
          ],
          review: {
            pendingToolChanges: integrations.connections.reduce((n, c) => n + c.pending.length, 0),
            failedTasksLastDay: taskRows.filter((t) => t.status === 'failed').length,
          },
        });
      if (portal[2] === 'access') return json(access);
      if (portal[2] === 'usage') {
        const project = url.searchParams.get('project');
        const environment = url.searchParams.get('environment');
        if (environment)
          return json({
            ...usageReport,
            environment,
            byEnvironment: usageReport.byEnvironment?.filter((e) => e.environment === environment),
          });
        if (!project) return json(usageReport);
        if (extras.usage)
          return json({
            ...usageReport,
            project,
            byProject: usageReport.byProject?.filter((p) => p.project === project) ?? [],
          });
        return json(
          exampleProjects.some((p) => p.id === project)
            ? buildExampleUsage(undefined, 190, project)
            : { ...buildExampleUsage(undefined, 190, project), byProject: [] },
        );
      }
      if (portal[2] === 'integrations') return json(integrations);
      const status = url.searchParams.get('status');
      const wanted = url.searchParams.get('service');
      const environment = url.searchParams.get('environment');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const limit = Number(url.searchParams.get('limit') ?? 100) || 100;
      const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
      const actor = url.searchParams.get('actor');
      if (actor && actor !== 'me' && !/^(employee|api-key):/.test(actor))
        return json({ title: 'Invalid request', status: 400 }, 400);
      const wantedActor = actor === 'me' ? mockMeActor : actor;
      const frontend = url.searchParams.get('frontend');
      const rows = url.searchParams.get('origin') === 'playground' ? trialRows : taskRows;
      const matching = rows.filter(
        (t) =>
          (!status || t.status === status) &&
          (!wanted || t.service === wanted) &&
          (!environment || t.environment === environment) &&
          (!wantedActor || t.actor?.id === wantedActor) &&
          (!frontend || t.frontend === frontend) &&
          (!from || t.createdAt >= from) &&
          (!to || t.createdAt <= to),
      );
      return json({
        offset,
        limit,
        data: matching.slice(offset, offset + limit).map((t) =>
          t.status === 'failed' && !t.failure
            ? {
                ...t,
                failure: { code: 'deadline_exceeded', reason: 'Kjøringen tok for lang tid.' },
              }
            : t,
        ),
        total: matching.length,
      });
    }
    if (/^\/tenants\/[^/]+\/api-keys$/.test(path) && init?.method === 'POST') {
      if (needsReason()) return missingReason();
      const body = JSON.parse(String(init.body)) as {
        name?: string;
        datasets?: string[];
        agents?: string[];
        callsPerMinute?: number;
      };
      if (!body.name)
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [{ path: 'name', message: 'a name is required' }],
          },
          400,
        );
      const key = 'gp_mockkey_7f3a91c2d4e6b8a0';
      const apiKey = {
        id: `key-${access.keys.length + 1}`,
        name: body.name,
        prefix: key.slice(0, 7),
        lastFour: key.slice(-4),
        scopes: ['query'],
        datasets: body.datasets ?? [],
        agents: body.agents ?? [],
        ...(body.callsPerMinute ? { callsPerMinute: body.callsPerMinute } : {}),
        createdAt: '2026-10-06T12:00:00Z',
        expiresAt: null,
        revokedAt: null,
      };
      access = { ...access, keys: [apiKey, ...access.keys] };
      return json({ key, apiKey }, 201);
    }
    const revoke = /^\/tenants\/[^/]+\/api-keys\/([^/]+)\/revoke$/.exec(path);
    if (revoke && init?.method === 'POST') {
      if (needsReason()) return missingReason();
      const id = decodeURIComponent(revoke[1] ?? '');
      const found = access.keys.find((k) => k.id === id);
      if (!found) return notFound();
      const revoked = { ...found, revokedAt: '2026-10-06T12:00:00Z' };
      access = { ...access, keys: access.keys.map((k) => (k.id === id ? revoked : k)) };
      return json(revoked);
    }
    if (/^\/tenants\/[^/]+\/tool-connections(\/.*)?$/.test(path) && init?.method === 'POST') {
      if (needsReason()) return missingReason();
      const approve = /\/tool-connections\/([^/]+)\/approve$/.exec(path);
      if (approve) {
        const { tool } = JSON.parse(String(init.body)) as { tool: string };
        integrations = {
          ...integrations,
          connections: integrations.connections.map((c) =>
            c.id === approve[1]
              ? {
                  ...c,
                  tools: [
                    ...c.tools.filter((t) => t.name !== tool),
                    ...c.pending.filter((p) => p.name === tool),
                  ],
                  pending: c.pending.filter((p) => p.name !== tool),
                }
              : c,
          ),
        };
        return json({ approved: tool });
      }
      if (/\/sync$/.test(path)) return json({ tools: 2, pending: 0 });
      const body = JSON.parse(String(init.body)) as {
        id?: string;
        name?: string;
        endpoint?: string;
      };
      if (!body.endpoint?.startsWith('https://'))
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [{ path: 'connection', message: 'the endpoint must use https' }],
          },
          400,
        );
      integrations = {
        ...integrations,
        connections: [
          ...integrations.connections,
          {
            id: body.id ?? 'ny',
            name: body.name ?? body.id ?? 'Ny',
            endpoint: body.endpoint,
            version: '1.0',
            allow: [{ host: new URL(body.endpoint).hostname }],
            auth: null,
            tools: [],
            pending: [],
          },
        ],
      };
      return json({ id: body.id }, 200);
    }
    if (/^\/tenants\/[^/]+\/secrets\/[^/]+$/.test(path) && init?.method === 'PUT') {
      if (needsReason()) return missingReason();
      const name = decodeURIComponent(path.split('/').pop() ?? '');
      const { allowedHosts } = JSON.parse(String(init.body)) as { allowedHosts?: string[] };
      if (!exampleSecretNames.includes(name) && !allowedHosts?.length)
        return json(
          {
            title: 'Invalid request',
            status: 400,
            errors: [
              {
                path: 'allowedHosts',
                message:
                  'Skriv adressene hemmeligheten skal brukes mot, for eksempel https://api.example.no.',
              },
            ],
          },
          400,
        );
      return json({ ref: `secret://tenant/999888777/${name}` });
    }
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const [root, tenant, area, kind, id, versions, version] = parts;
    if (root !== 'tenants' || !tenant) return notFound();
    const own = current.filter((s) => s.tenant === tenant);
    if (area === 'definitions' && !kind) {
      return json({
        data: own.map((s) => ({ kind: s.kind, id: s.id, latestVersion: s.latest.version })),
      });
    }
    if (area === 'definitions' && (kind === 'services' || kind === 'step-flows') && id) {
      const wanted = kind === 'services' ? 'Service' : 'StepFlow';
      const found = own.find((s) => s.id === id && s.kind === wanted);
      if (!found) return notFound();
      if (versions === 'versions' && version) {
        const summary = found.versions.find((v) => v.version === Number(version));
        if (!summary) return notFound();
        const earlier = exampleEarlierSpecs[found.id]?.[summary.version];
        const definition = {
          ...found.latest.definition,
          metadata: { ...(found.latest.definition.metadata as object), version: summary.version },
          ...(earlier ? { spec: { ...(found.latest.definition.spec as object), ...earlier } } : {}),
        };
        return json({ ...found.latest, ...summary, definition });
      }
      return json(found);
    }
    if (area === 'tasks' && kind) {
      const found =
        timelines.find((t) => t.id === kind) ??
        (/^tp\d+$/.test(kind) ? playgroundTimeline(kind) : undefined);
      return found ? json(found) : notFound();
    }
    return notFound();
  };
};
