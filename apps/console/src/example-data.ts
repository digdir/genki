import type {
  AuditEntry,
  BlockType,
  EffectiveSettings,
  GridSetting,
  JudgeCalibration,
  LabelItem,
  SinkLabels,
  OnboardingRequest,
  OperationsOverview,
  QualityHistory,
  QualityMatrix,
  RegistryBlock,
  SettingsGrid,
  TaskTimeline,
  Tenant,
  TracingStatus,
} from './types';

export const exampleTenants: Tenant[] = [
  ['Testetaten', '999888777', 'active', 'Ferdig', 6, 9, 9.4, 50, 68, 'Kari Nordmann'],
  ['Digdir', '991825827', 'active', 'Ferdig', 5, 6, 12.5, 100, 91, 'Lise Dahl'],
  ['Prøvekommunen', '910111222', 'active', 'Ferdig', 3, 4, 4.1, 20, 22, 'Hanne Lund'],
  ['Eksempeldirektoratet', '974222333', 'active', 'Ferdig', 11, 14, 38.6, 40, 310, 'Bjørn Aas'],
  ['Statens eksempelverk', '971333444', 'active', 'Ferdig', 2, 5, 1.2, 20, 9, 'Nora Vik'],
  [
    'Fylkeskommunen i Testfylke',
    '921444555',
    'onboarding',
    'Venter på første administrator',
    0,
    0,
    0,
    20,
    0,
    'Ikke logget inn ennå',
  ],
  ['Kontrollrådet', '983555666', 'active', 'Ferdig', 4, 4, 6.8, 20, 51, 'Arne Holm'],
  ['Prøvetilsynet', '986666777', 'paused', 'Ferdig', 0, 3, 0.3, 20, 2, 'Siri Bakke'],
  [
    'Testby kommune',
    '964777888',
    'onboarding',
    'Venter på Digdir',
    0,
    0,
    0,
    20,
    0,
    'Ikke logget inn ennå',
  ],
  ['Eksempelhelseforetaket', '983888999', 'active', 'Ferdig', 5, 7, 17.9, 20, 144, 'Leif Strand'],
  [
    'Eksempel kommune',
    '940999000',
    'onboarding',
    'Venter på vilkår',
    0,
    0,
    0,
    20,
    0,
    'Ikke logget inn ennå',
  ],
].map(([name, orgNumber, status, stage, active, total, tokens, quota, cost, admin]) => ({
  name: name as string,
  orgNumber: orgNumber as string,
  status: status as Tenant['status'],
  stage: stage as string,
  services: total as number,
  servicesActive: active as number,
  tokensMillions: tokens as number,
  quotaMillions: quota as number,
  quotaUsedPercent: Math.round(((tokens as number) / (quota as number)) * 100),
  costNok: cost as number,
  admin: admin as string,
  ...(name === 'Prøvetilsynet'
    ? { note: 'Satt på pause etter ønske fra virksomheten 2. oktober.' }
    : {}),
}));

export const exampleOnboarding: OnboardingRequest[] = [
  {
    orgNumber: '964777888',
    name: 'Testby kommune',
    requestedAt: '2026-10-02T13:05:00+02:00',
    requestedBy: 'Elin Haug, IT-sjef',
    steps: {
      request: { doneBy: 'Elin Haug, Testby kommune', doneAt: '2026-10-02T13:05:00+02:00' },
      terms: { doneBy: 'Elin Haug, Testby kommune', doneAt: '2026-10-02T13:10:00+02:00' },
      access: {},
      login: {},
    },
  },
  {
    orgNumber: '921444555',
    name: 'Fylkeskommunen i Testfylke',
    requestedAt: '2026-09-24T09:30:00+02:00',
    requestedBy: 'Rune Moe, digitaliseringsrådgiver',
    steps: {
      request: {
        doneBy: 'Rune Moe, Fylkeskommunen i Testfylke',
        doneAt: '2026-09-24T09:30:00+02:00',
      },
      terms: {
        doneBy: 'Rune Moe, Fylkeskommunen i Testfylke',
        doneAt: '2026-09-24T09:42:00+02:00',
      },
      access: { doneBy: 'Lise Dahl, Digdir', doneAt: '2026-09-25T11:05:00+02:00' },
      login: { note: 'Venter på virksomheten. Påminnelse sendt 1. oktober.' },
    },
  },
  {
    orgNumber: '940999000',
    name: 'Eksempel kommune',
    requestedAt: '2026-10-05T13:48:00+02:00',
    requestedBy: 'Tone Berg, kommunalsjef',
    steps: {
      request: { doneBy: 'Tone Berg, Eksempel kommune', doneAt: '2026-10-05T13:48:00+02:00' },
      terms: { note: 'Vilkårene er sendt til Tone Berg 5. oktober.' },
      access: {},
      login: {},
    },
  },
  {
    orgNumber: '983555666',
    name: 'Kontrollrådet',
    requestedAt: '2026-08-12T10:00:00+02:00',
    requestedBy: 'Arne Holm',
    steps: {
      request: { doneBy: 'Arne Holm, Kontrollrådet', doneAt: '2026-08-12T10:00:00+02:00' },
      terms: { doneBy: 'Arne Holm, Kontrollrådet', doneAt: '2026-08-12T10:20:00+02:00' },
      access: { doneBy: 'Jon Øien, Digdir', doneAt: '2026-08-13T08:55:00+02:00' },
      login: { doneBy: 'Arne Holm, Kontrollrådet', doneAt: '2026-08-13T14:31:00+02:00' },
    },
    checklist: { done: 5, total: 5 },
  },
];

export const exampleModelUsage: Record<
  string,
  { tenant: string; service: string; role: string }[]
> = {
  'foundry-openai/gpt-4o-2m-tps': [
    { tenant: 'Eksempelhelseforetaket', service: 'Henvisningssortering', role: 'Hovedmodell' },
    { tenant: 'Statens eksempelverk', service: 'Saksforberedelse', role: 'Hovedmodell' },
    { tenant: 'Eksempeldirektoratet', service: 'Høringsanalyse', role: 'Reservemodell' },
  ],
  'foundry-openai/gpt-4.1': [
    { tenant: 'Testetaten', service: 'Vedtaksutkast', role: 'Hovedmodell' },
    { tenant: 'Eksempeldirektoratet', service: 'Utkast til svarbrev', role: 'Hovedmodell' },
    { tenant: 'Eksempelhelseforetaket', service: 'Journalsammendrag', role: 'Hovedmodell' },
    { tenant: 'Testetaten', service: 'Rapportassistenten', role: 'Reservemodell' },
  ],
};

export const exampleBlockTypes: BlockType[] = [
  ['strategi', 'Strategier', 'Hvordan en tjeneste jobber: ett steg, agent, stegflyt og nye måter.'],
  ['verktoy', 'Verktøy og fellestjenester', 'Det tjenester og agenter kan kalle.'],
  ['modell', 'Modeller', 'Språkmodeller tjenestene kan velge.'],
  ['sok', 'Søk', 'Indekser, rangering og søkemetoder.'],
  ['lagring', 'Lagring', 'Hvor dokumenter, tekstbiter og logger lagres.'],
  ['kilde', 'Kilder og innlesing', 'Koblinger som leser inn dokumenter til dokumentsamlinger.'],
  ['innlogging', 'Innlogging', 'Hvordan personer og systemer logger inn.'],
  ['vern', 'Vern', 'Kontroller som kjøres før og etter modellen.'],
  ['evaluator', 'Evaluatorer', 'Måler kvaliteten på resultater i testsett.'],
  ['optimalisering', 'Optimaliserere', 'Lager forbedringsforslag fra feil og tilbakemeldinger.'],
  [
    'sporing',
    'Sporing og evalueringsverktøy',
    'Tidslinjer, målinger og eksport til eksterne verktøy.',
  ],
  ['utloser', 'Utløsere', 'Det som kan starte en tjeneste av seg selv.'],
  ['inngang', 'Innganger', 'Hvordan systemer og brukere kaller tjenestene.'],
].map(([id, name, description]) => ({ id, name, description }) as BlockType);

export const exampleAgencies = [
  'Testetaten',
  'Prøvekommunen',
  'Eksempeldirektoratet',
  'Statens eksempelverk',
  'Kontrollrådet',
  'Eksempelhelseforetaket',
  'Testby kommune',
  'Prøvetilsynet',
  'Eksempel kommune',
];

const passingTests = [
  'Svarer på kall i riktig format',
  'Respekterer tidsavbrudd',
  'Logger hvert kall i tidslinjen',
  'Sender ikke data ut av tillatt område',
  'Håndterer feil uten å stoppe plattformen',
];

const failingTests: Record<string, [string, string]> = {
  klarsprak: [
    'Gir stabil kvalitet på testsettet',
    'Poengene falt fra 89 til 79 etter modellbytte 29. sep',
  ],
  reranker: ['Svarer innen 2 sekunder ved 95 % av kallene', '95 % av kallene tok 2,8 s'],
  sharepoint: ['Leser filer med norske tegn i navnet', 'Filnavn med «å» feilet'],
};

const blockServices: Record<string, [string, string, string][]> = {
  mcp: [
    ['Testetaten', 'Rapportassistenten', 'streamable-http'],
    ['Testetaten', 'Spør veilederen', 'sse'],
    ['Eksempeldirektoratet', 'Spør regelverket', 'sse'],
    ['Kontrollrådet', 'Klagehjelp', 'streamable-http'],
    ['Prøvekommunen', 'Innbyggerspørsmål', 'sse'],
    ['Eksempelhelseforetaket', 'Journalsammendrag', 'streamable-http'],
  ],
  borealis: [
    ['Testetaten', 'Rapportassistenten', 'hovedmodell'],
    ['Testetaten', 'Nettsider på nynorsk', 'hovedmodell'],
    ['Testetaten', 'Høringsoppsummering', 'hovedmodell'],
    ['Prøvekommunen', 'Innbyggerspørsmål', 'hovedmodell'],
    ['Eksempeldirektoratet', 'Spør regelverket', 'hovedmodell'],
    ['Digdir', 'Klarspråk (fellestjeneste)', 'hovedmodell'],
    ['Digdir', 'Bokmål til nynorsk (fellestjeneste)', 'hovedmodell'],
  ],
  default: [
    ['Testetaten', 'Rapportassistenten', ''],
    ['Eksempeldirektoratet', 'Spør regelverket', ''],
    ['Kontrollrådet', 'Sorter innkommende post', ''],
    ['Prøvekommunen', 'Innbyggerspørsmål', ''],
  ],
};

type Row = [string, string, string, string, [number, string], string, number | string[], number];

const blockRows: (Row & unknown[])[] = [
  ['ett_steg', 'strategi', 'Ett steg', '2.1', [1, '6. okt'], 'alle', 9, 58],
  ['agent', 'strategi', 'Agent i flere steg', '1.6', [1, '6. okt'], 'alle', 7, 21],
  ['stegflyt', 'strategi', 'Fast stegflyt', '1.3', [1, '6. okt'], 'alle', 5, 12],
  [
    'debatt',
    'strategi',
    'Flere modeller drøfter',
    '0.2',
    [1, '3. okt'],
    'utvalgte',
    ['Testetaten', 'Eksempeldirektoratet'],
    1,
  ],
  ['lovdata', 'verktoy', 'Lovdata', '1.4', [1, '6. okt'], 'alle', 6, 9],
  ['klarsprak', 'verktoy', 'Klarspråk (fellestjeneste)', '2.3', [0, '6. okt'], 'alle', 14, 22],
  [
    'nynorsk',
    'verktoy',
    'Bokmål til nynorsk (fellestjeneste)',
    '1.8',
    [1, '6. okt'],
    'alle',
    10,
    13,
  ],
  [
    'transkribering',
    'verktoy',
    'Transkribering (fellestjeneste)',
    '2.0',
    [1, '5. okt'],
    'alle',
    5,
    6,
  ],
  ['openapi', 'verktoy', 'Eget API (OpenAPI)', '1.2', [1, '6. okt'], 'alle', 4, 7],
  ['borealis', 'modell', 'Borealis-27B (AIVAR, Norge)', '2.1', [1, '6. okt'], 'alle', 9, 64],
  ['qwen', 'modell', 'Qwen3.8-27B (AIVAR, Norge)', '1.3', [1, '6. okt'], 'alle', 6, 14],
  ['gpt41', 'modell', 'GPT-4.1 (Azure OpenAI, EU)', '1.1', [1, '6. okt'], 'alle', 5, 12],
  [
    'gpt4o',
    'modell',
    'GPT-4o (Azure OpenAI, EU)',
    '1.0',
    [1, '2. okt'],
    'utvalgte',
    ['Eksempelhelseforetaket', 'Statens eksempelverk', 'Eksempeldirektoratet'],
    3,
  ],
  ['hybrid', 'sok', 'Hybridsøk', '3.0', [1, '6. okt'], 'alle', 9, 71],
  ['reranker', 'sok', 'Rangering av treff', '1.2', [0, '6. okt'], 'alle', 8, 40],
  ['vektorlager', 'lagring', 'Vektorlager (Norge)', '4.1', [1, '6. okt'], 'alle', 9, 71],
  ['logglager', 'lagring', 'Logglager', '2.0', [1, '6. okt'], 'alle', 9, 94],
  ['kudos', 'kilde', 'Kudos', '1.5', [1, '6. okt'], 'alle', 8, 11],
  ['nettsted', 'kilde', 'Nettsted', '2.2', [1, '6. okt'], 'alle', 7, 9],
  [
    'sharepoint',
    'kilde',
    'SharePoint',
    '1.1',
    [0, '5. okt'],
    'utvalgte',
    ['Testetaten', 'Kontrollrådet'],
    3,
  ],
  ['ansattporten', 'innlogging', 'Ansattporten', '1.0', [1, '6. okt'], 'alle', 9, 48],
  ['maskinporten', 'innlogging', 'Maskinporten', '1.0', [1, '6. okt'], 'alle', 8, 31],
  ['pii', 'vern', 'Filtrering av personopplysninger', '3.2', [1, '6. okt'], 'alle', 9, 77],
  ['kildekrav', 'vern', 'Kildekrav', '1.4', [1, '6. okt'], 'alle', 9, 52],
  ['kildetreff', 'evaluator', 'Kildetreff', '1.1', [1, '6. okt'], 'alle', 6, 24],
  [
    'llmdommer',
    'evaluator',
    'Vurdering med modell som dommer',
    '0.9',
    [1, '6. okt'],
    'alle',
    6,
    19,
  ],
  [
    'forslag',
    'optimalisering',
    'Forbedringsforslag fra feilklynger',
    '0.7',
    [1, '5. okt'],
    'utvalgte',
    ['Testetaten', 'Eksempeldirektoratet', 'Kontrollrådet'],
    5,
  ],
  ['tidslinje', 'sporing', 'Oppgavetidslinje', '2.4', [1, '6. okt'], 'alle', 9, 94],
  [
    'otel',
    'sporing',
    'Eksport til OpenTelemetry',
    '1.0',
    [1, '6. okt'],
    'utvalgte',
    ['Eksempeldirektoratet'],
    4,
  ],
  ['mappe', 'utloser', 'Når et dokument kommer inn', '1.3', [1, '6. okt'], 'alle', 5, 8],
  ['ko', 'utloser', 'Melding i kø', '1.1', [1, '6. okt'], 'alle', 3, 4],
  ['tidsplan', 'utloser', 'Etter tidsplan', '1.0', [1, '6. okt'], 'alle', 6, 10],
  ['rest', 'inngang', 'REST-API', '1.4', [1, '6. okt'], 'alle', 9, 61],
  ['mcp', 'inngang', 'MCP', '1.2', [1, '6. okt'], 'alle', 6, 19],
  ['openai', 'inngang', 'OpenAI-kompatibel', '1.1', [1, '6. okt'], 'alle', 5, 14],
  ['a2a', 'inngang', 'A2A (agent til agent)', '0.3', [1, '4. okt'], 'ingen', [], 0],
];

const blockExtras: Record<string, Partial<RegistryBlock>> = {
  debatt: { badge: 'Ny 3. okt' },
  gpt4o: { badge: 'Fases ut 1. des' },
  a2a: {
    badge: 'Ny 4. okt',
    settingsSchema: [
      {
        field: 'agentkort_url',
        type: 'tekst',
        default: '/.well-known/agent.json',
        allowed: 'Sti på plattformen',
        description: 'Hvor andre agenter finner beskrivelsen av tjenesten',
      },
      {
        field: 'oppgaver_maks_s',
        type: 'heltall',
        default: '300',
        allowed: '10–3 600',
        description: 'Hvor lenge en kjøring kan kjøre',
      },
      {
        field: 'strommer',
        type: 'ja/nei',
        default: 'ja',
        allowed: '–',
        description: 'Sender delresultater underveis',
      },
    ],
    changelog: [
      {
        version: '0.3',
        at: '4. okt',
        text: 'Registrert på plattformen. Kontrakttestene er bestått.',
      },
    ],
  },
  lovdata: {
    settingsSchema: [
      {
        field: 'url',
        type: 'tekst',
        default: 'https://mcp.lovdata.example.no',
        allowed: 'Gyldig https-adresse',
        description: 'Adressen til MCP-serveren',
      },
      {
        field: 'tidsavbrudd_s',
        type: 'heltall',
        default: '10',
        allowed: '1–60',
        description: 'Hvor lenge verktøyet får før det regnes som feilet',
      },
      {
        field: 'bare_lesing',
        type: 'ja/nei',
        default: 'ja',
        allowed: '–',
        description: 'Verktøyet kan ikke endre noe',
      },
    ],
    changelog: [
      { version: '1.4', at: '2. okt', text: 'Raskere oppslag i forskrifter' },
      { version: '1.3', at: '4. sep', text: 'Ny parameter: tidsavbrudd_s' },
    ],
  },
  borealis: {
    provider: 'AIVAR',
    settingsSchema: [
      {
        field: 'temperatur',
        type: 'desimaltall',
        default: '0,2',
        allowed: '0–1',
        description: 'Variasjon i svar',
      },
      {
        field: 'maks_tokens',
        type: 'heltall',
        default: '4 000',
        allowed: '200–8 000',
        description: 'Lengste svar',
      },
      {
        field: 'tidsavbrudd_s',
        type: 'heltall',
        default: '20',
        allowed: '5–120',
        description: 'Bytter til reservemodell etter dette',
      },
    ],
    changelog: [
      {
        version: '2.1',
        at: '29. sep',
        text: 'Ny modellversjon fra AIVAR. Klarspråk falt på testsettet',
      },
      { version: '2.0', at: '2. jun', text: 'Første versjon' },
    ],
    next: {
      version: '2.2',
      description: 'Ny modellversjon fra AIVAR. Bedre på nynorsk.',
      breakingChanges: ['Svarer i snitt 6 % lengre', 'Ingen endringer i innstillingene'],
      testPassed: true,
      testedAt: '6. okt',
    },
  },
  reranker: {
    settingsSchema: [
      {
        field: 'modell',
        type: 'valg',
        default: 'bge-reranker-nb',
        allowed: 'bge-reranker-nb, cohere-rerank-eu',
        description: 'Modellen som rangerer',
      },
      {
        field: 'behold',
        type: 'heltall',
        default: '8',
        allowed: '1–50',
        description: 'Hvor mange treff som beholdes',
      },
    ],
    changelog: [
      { version: '1.2', at: '1. okt', text: 'Ny standardmodell for norsk' },
      { version: '1.1', at: '12. aug', text: 'Raskere' },
    ],
  },
  mcp: {
    settingsSchema: [
      {
        field: 'transport',
        type: 'valg',
        default: 'streamable-http',
        allowed: 'streamable-http, sse',
        description: 'Hvordan klienter kobler til',
      },
      {
        field: 'verktoynavn',
        type: 'tekst',
        default: '{tjeneste}__{versjon}',
        allowed: 'Små bokstaver, tall og _',
        description: 'Navnet tjenesten får som verktøy, for eksempel ka__default',
      },
      {
        field: 'maks_samtidige',
        type: 'heltall',
        default: '20',
        allowed: '1–200',
        description: 'Samtidige kall per klient',
      },
    ],
    changelog: [
      { version: '1.2', at: '18. sep', text: 'Støtte for streamable-http' },
      { version: '1.1', at: '2. jul', text: 'Verktøynavn kan settes per tjeneste' },
      { version: '1.0', at: '14. mai', text: 'Første versjon' },
    ],
    next: {
      version: '2.0',
      description: 'Følger MCP-spesifikasjonen 2026-06. SSE-transport fjernes.',
      breakingChanges: [
        'SSE fjernes. 3 tjenester bruker SSE i dag',
        'Nytt felt «autorisasjon» er påkrevd',
      ],
      testPassed: false,
      testedAt: '6. okt',
    },
  },
};

const availabilityOf = { alle: 'all', utvalgte: 'selected', ingen: 'none' } as const;

export const exampleRegistry: RegistryBlock[] = blockRows.map((row) => {
  const [id, type, name, version, test, avail, agencies, serviceCount] = row as Row;
  const fail = failingTests[id];
  const services = (blockServices[id] ?? blockServices.default ?? [])
    .slice(0, serviceCount)
    .map(([tenant, service, detail]) => ({ tenant, service, ...(detail ? { detail } : {}) }));
  return {
    id,
    type,
    name,
    version,
    testPassed: test[0] === 1,
    testedAt: test[1],
    tests: [
      ...passingTests.map((t) => ({ name: t, passed: true })),
      ...(fail ? [{ name: fail[0], passed: false, reason: fail[1] }] : []),
    ],
    availability: availabilityOf[avail as keyof typeof availabilityOf],
    agencies: Array.isArray(agencies) ? agencies : exampleAgencies.slice(0, agencies),
    serviceCount,
    services,
    provider: type === 'modell' ? 'AIVAR' : 'Digdir',
    ...blockExtras[id],
  };
});

export const exampleMatrix: { models: QualityMatrix; blocks: QualityMatrix } = {
  models: {
    columns: [
      { name: 'Borealis-27B 2.1', status: 'in_use' },
      { name: 'Borealis-27B 2.2', status: 'new' },
      { name: 'Qwen3.8-27B 1.3', status: 'allowed' },
      { name: 'GPT-4.1 (EU)', status: 'allowed' },
      { name: 'NorLlama-70B 0.9', status: 'review' },
    ],
    baseline: [0, 0, 0, 0, 0],
    rows: [
      { testSet: 'Klarspråk', kind: 'Fellestjeneste', scores: [81, 85, 78, 87, 83] },
      {
        testSet: 'Bokmål til nynorsk',
        kind: 'Fellestjeneste',
        scores: [87, 90, 79, 82, 88],
        advisoryJudge: 'svar',
      },
      { testSet: 'Oppsummering', kind: 'Fellestjeneste', scores: [84, 85, 81, 88, 86] },
      { testSet: 'Anonymisering', kind: 'Fellestjeneste', scores: [95, 95, 94, 93, 92] },
      { testSet: 'Hent ut opplysninger', kind: 'Fellestjeneste', scores: [83, 84, 86, 89, 79] },
      {
        testSet: 'Rapportassistenten · Testetaten',
        kind: 'Delt testsett',
        scores: [83, 84, 79, 86, 85],
      },
      {
        testSet: 'Spør regelverket · Eksempeldirektoratet',
        kind: 'Delt testsett',
        scores: [78, 76, 74, 82, 80],
      },
      {
        testSet: 'Innbyggerspørsmål · Prøvekommunen',
        kind: 'Delt testsett',
        scores: [79, 80, 75, 81, 77],
      },
    ],
  },
  blocks: {
    columns: [
      { name: 'Rangering 1.2', status: 'in_use' },
      { name: 'Rangering 1.3', status: 'new' },
      { name: 'Hybridsøk 3.0', status: 'in_use' },
      { name: 'Hybridsøk 3.1', status: 'new' },
    ],
    baseline: [0, 0, 2, 2],
    rows: [
      {
        testSet: 'Rapportassistenten · Testetaten',
        kind: 'Delt testsett',
        scores: [83, 85, 83, 84],
      },
      {
        testSet: 'Spør regelverket · Eksempeldirektoratet',
        kind: 'Delt testsett',
        scores: [78, 79, 78, 73],
      },
      {
        testSet: 'Innbyggerspørsmål · Prøvekommunen',
        kind: 'Delt testsett',
        scores: [79, 80, 79, 80],
      },
      { testSet: 'Oppsummering', kind: 'Fellestjeneste', scores: [84, 84, 84, 84] },
    ],
  },
};

export const exampleJudges: JudgeCalibration[] = [
  {
    judge: 'svar',
    name: 'Svarkvalitet',
    model: 'GPT-4.1 (EU)',
    n: 420,
    measuredAt: '1. oktober',
    jobTypes: ['Svarer', 'Oppsummerer'],
    kappaByLanguage: { Bokmål: [0.74, 0.68], Nynorsk: [0.52, 0.47] },
    kappa: 0.62,
    observed: 0.81,
    blocking: true,
    advisory: false,
  },
  {
    judge: 'kilde',
    name: 'Kildetroskap',
    model: 'Borealis-27B',
    n: 380,
    measuredAt: '1. oktober',
    jobTypes: ['Svarer', 'Oppsummerer'],
    kappaByLanguage: { Bokmål: [0.81, 0.72], Nynorsk: [0.77, 0.66] },
    kappa: 0.75,
    observed: 0.88,
    blocking: true,
    advisory: false,
  },
  {
    judge: 'klar',
    name: 'Klarspråk',
    model: 'Borealis-27B',
    n: 210,
    measuredAt: '24. september',
    jobTypes: ['Omskriver'],
    kappaByLanguage: { Bokmål: [0.63], Nynorsk: [0.41] },
    kappa: 0.52,
    observed: 0.74,
    blocking: false,
    advisory: true,
  },
  {
    judge: 'felt',
    name: 'Riktige opplysninger',
    model: 'Regler og Qwen3.8-27B',
    n: 300,
    measuredAt: '28. september',
    jobTypes: ['Henter ut opplysninger', 'Sorterer'],
    kappaByLanguage: { Bokmål: [0.88, 0.71], Nynorsk: [0.84, null] },
    kappa: 0.81,
    observed: 0.9,
    blocking: true,
    advisory: false,
  },
];

/** Labels people made in DFØ's Langfuse project, waiting for an operator. */
export const exampleSinkLabels: SinkLabels = {
  connections: [
    { tenant: '991825827', connection: 'kudos', labels: true },
    { tenant: '991825827', connection: 'test', labels: false },
  ],
  batches: [
    {
      tenant: '991825827',
      connection: 'kudos',
      judge: 'langfuse:991825827/kudos/kudos_quotes_covered',
      name: 'kudos_quotes_covered',
      labels: [
        {
          id: 'merknad-1',
          revision: '2026-11-02T10:00:00.000Z|good',
          run: 'kjoring-41',
          case: 'tilskudd-frist',
          repeat: 0,
          humanLabel: 'good',
          judgeLabel: 'good',
          labeller: 'pseudonym:3f9a1c27b0d4',
        },
        {
          id: 'merknad-2',
          revision: '2026-11-02T10:00:00.000Z|bad',
          run: 'kjoring-41',
          case: 'rapport-mangler',
          repeat: 0,
          humanLabel: 'bad',
          judgeLabel: 'good',
          labeller: 'pseudonym:3f9a1c27b0d4',
        },
        {
          id: 'merknad-3',
          revision: '2026-11-02T10:00:00.000Z|good',
          run: 'kjoring-41',
          case: 'personvern',
          repeat: 0,
          humanLabel: 'good',
          labeller: 'pseudonym:8e02d5aa41c9',
        },
      ],
      paired: 2,
      alike: 1,
      unpaired: 1,
      labellers: 2,
    },
  ],
};

export const exampleLabelQueue: LabelItem[] = [
  {
    item: 's1',
    judge: 'svar',
    judgeLabel: 'bad',
    tenant: '999888777',
    service: 'Rapportassistenten',
    case: 'q1',
    question: 'Hvilke funn gikk igjen i tilsynene med frivillige organisasjoner i 2025?',
    answer:
      'Tre funn gikk igjen: mangelfull rapportering av bruk av midler, manglende vedtekter og for sen innsending av regnskap.',
    sources: ['Tilsynsrapport 2025/12, side 3', 'Tilsynsrapport 2025/19, side 5'],
    lang: 'nb',
    meta: 'Svarer · bokmål · delt testsett fra Testetaten',
    judgeCriteria: { correct: 'Delvis', grounded: 'Nei' },
  },
  {
    item: 's2',
    judge: 'svar',
    judgeLabel: 'good',
    tenant: '999888777',
    service: 'Rapportassistenten',
    case: 'q2',
    question: 'Kva seier evalueringane om ventetida på telefon?',
    answer: 'Ventetida gjekk ned frå 9 til 4 minutt frå 2022 til 2025.',
    sources: ['Årsrapport 2025, side 21'],
    lang: 'nn',
    meta: 'Svarer · nynorsk · delt testsett fra Testetaten',
    judgeCriteria: { correct: 'Ja', grounded: 'Ja' },
  },
  {
    item: 's3',
    judge: 'svar',
    judgeLabel: 'good',
    tenant: '974222333',
    service: 'Spør regelverket',
    case: 'q3',
    question: 'Hvor mange søknader kom inn i 2024?',
    answer: 'Det kom inn 1 240 søknader i 2024.',
    sources: ['Årsrapport 2023, side 9'],
    lang: 'nb',
    meta: 'Svarer · bokmål · kjøring delt av Eksempeldirektoratet',
    judgeCriteria: { correct: 'Ja', grounded: 'Ja' },
  },
];

export const exampleHistory: QualityHistory = {
  series: [
    { name: 'Klarspråk', now: 81, before: 89 },
    { name: 'Spør regelverket', tenant: 'Eksempeldirektoratet', now: 74, before: 77 },
    { name: 'Rapportassistenten', tenant: 'Testetaten', now: 86, before: 86 },
    { name: 'Innbyggerspørsmål', tenant: 'Prøvekommunen', now: 82, before: 80 },
    { name: 'Oppsummering', now: 84, before: 81 },
  ],
};

export const exampleTracing: TracingStatus = {
  enabled: true,
  source: 'environment',
  endpoint: 'https://langfuse.digdir.example.no/api/public/otel',
  content: false,
  sampleRate: 0.1,
  stats: { exported: 41200, dropped: 0, failed: 0, sampledOut: 0 },
};

export const exampleOperations: OperationsOverview = {
  incidents: [
    {
      title: 'Redusert ytelse hos AIVAR',
      text: 'Svar fra de norske modellene tar lengre tid enn vanlig siden kl. 09.40. Tjenester med reservemodell i EU bytter automatisk etter 20 sekunder. AIVAR er varslet, sak DIG-4415.',
    },
  ],
  components: [
    { name: 'API og pålogging', status: 'normal', errorRate: '0,04 %', p95: '180 ms' },
    {
      name: 'AIVAR (norske modeller)',
      status: 'degraded',
      errorRate: '2,1 %',
      p95: '4,8 s',
      note: 'Høy ventetid siden kl. 09.40. AIVAR er varslet.',
    },
    { name: 'Azure OpenAI (EU)', status: 'normal', errorRate: '0,2 %', p95: '2,1 s' },
    { name: 'Søk og indeks', status: 'normal', errorRate: '0,01 %', p95: '95 ms' },
    { name: 'Innlesing', status: 'normal', errorRate: '0,6 %', p95: '–' },
    { name: 'Jobbkø', status: 'normal', errorRate: '0 %', p95: '–' },
    { name: 'Ansattporten', status: 'normal', errorRate: '0 %', p95: '310 ms' },
    { name: 'Maskinporten', status: 'normal', errorRate: '0 %', p95: '140 ms' },
  ],
  queueStats: [
    { label: 'Innlesinger som kjører', value: '1' },
    { label: 'Innlesinger i kø', value: '1' },
    { label: 'Samlede jobber som kjører', value: '1' },
    { label: 'Lengst ventetid', value: '22 min' },
  ],
  queue: [
    {
      type: 'Innlesing',
      what: 'Kudos-rapporter · Eksempeldirektoratet',
      status: 'running',
      progress: '61 %',
      age: '14 min',
    },
    {
      type: 'Innlesing',
      what: 'Tilsynsrapporter · Prøvetilsynet',
      status: 'waiting',
      progress: '–',
      age: '3 min',
    },
    {
      type: 'Samlet jobb',
      what: 'Høringsoppsummering · Testetaten',
      status: 'running',
      progress: '68 %',
      age: '1 t 12 min',
    },
    {
      type: 'Samlet jobb',
      what: 'Journalsammendrag · Eksempelhelseforetaket',
      status: 'waiting',
      progress: '–',
      age: '22 min',
    },
    {
      type: 'Innlesing',
      what: 'Nettsidene · Testby kommune',
      status: 'failed',
      progress: '–',
      age: '–',
    },
  ],
  triggers: [
    {
      tenant: 'Testetaten',
      what: 'Køen «innkommende-post»',
      error: 'Tilgangsnøkkelen er utløpt',
      lastSuccess: '1. oktober kl. 23.58',
      waiting: '132 meldinger venter',
    },
    {
      tenant: 'Kontrollrådet',
      what: 'Mappen «Klager»',
      error: 'Mappen finnes ikke lenger',
      lastSuccess: 'I dag kl. 06.00',
      waiting: 'Ingen ventende',
    },
    {
      tenant: 'Eksempeldirektoratet',
      what: 'Hver time',
      error: 'Tjenesten er satt på pause',
      lastSuccess: 'I dag kl. 10.00',
      waiting: 'Hopper over',
    },
  ],
};

const auditRow = (
  at: string,
  actorName: string,
  actorOrg: string,
  tenantName: string,
  actionLabel: string,
  target: string,
  reason: string,
  i: number,
): AuditEntry => ({
  task: `a-${i}`,
  tenant: exampleTenants.find((t) => t.name === tenantName)?.orgNumber ?? 'alle',
  tenantName,
  action: actionLabel,
  actionLabel,
  actor: actorOrg === 'Digdir' ? `operator:${actorName}` : `employee:${actorName}`,
  actorName,
  actorOrg,
  at,
  outcome: 'applied',
  target,
  reason,
});

export const exampleOperatorAudit: AuditEntry[] = (
  [
    [
      '2026-10-07T10:41:00+02:00',
      'Lise Dahl',
      'Digdir',
      'Testetaten',
      'Åpnet diagnostikk for kjøring',
      'opg_7f2kq9d1',
      'Sak DIG-4412',
    ],
    [
      '2026-10-07T09:53:00+02:00',
      'Kari Nordmann',
      'Testetaten',
      'Testetaten',
      'Godkjente utkast',
      'Vedtaksutkast, sak 2026/1432',
      '',
    ],
    [
      '2026-10-07T09:12:00+02:00',
      'Jon Øien',
      'Digdir',
      'Eksempelhelseforetaket',
      'Så innhold',
      'Hele portalen',
      'Feil i en dokumentsamling meldt av kunden, sak DIG-4409',
    ],
    [
      '2026-10-07T08:30:00+02:00',
      'Per Hansen',
      'Testetaten',
      'Testetaten',
      'Publiserte tjeneste',
      'Høringsoppsummering v3',
      '',
    ],
    [
      '2026-10-05T15:44:00+02:00',
      'Lise Dahl',
      'Digdir',
      'Alle',
      'Endret plattformstandard',
      'Logg for begrenset risiko: 60 → 90 dager',
      'Krav fra personvernombudet',
    ],
    [
      '2026-10-05T14:02:00+02:00',
      'Kari Nordmann',
      'Testetaten',
      'Testetaten',
      'Endret tilgang',
      'Vedtaksutkast: la til Saksbehandlere tilskudd',
      '',
    ],
    [
      '2026-10-04T11:20:00+02:00',
      'Jon Øien',
      'Digdir',
      'Alle',
      'Satte modell til utfasing',
      'GPT-4o fases ut 1. desember',
      'Microsoft avslutter versjonen',
    ],
    [
      '2026-10-03T10:05:00+02:00',
      'Siri Bakke',
      'Prøvetilsynet',
      'Prøvetilsynet',
      'Satte alle tjenester på pause',
      '3 tjenester',
      '',
    ],
    [
      '2026-10-02T13:10:00+02:00',
      'Elin Haug',
      'Testby kommune',
      'Testby kommune',
      'Godtok vilkår',
      'Vilkår versjon 2.0',
      '',
    ],
    [
      '2026-09-25T11:05:00+02:00',
      'Lise Dahl',
      'Digdir',
      'Fylkeskommunen i Testfylke',
      'La til i tilgangslister',
      'Ansattporten og Maskinporten',
      '',
    ],
  ] as const
).map((r, i) => auditRow(r[0], r[1], r[2], r[3], r[4], r[5], r[6], i));

export const exampleTimeline: TaskTimeline = {
  id: 'opg_7f2kq9d1',
  service: 'rapportassistenten',
  serviceName: 'Rapportassistenten',
  version: 7,
  status: 'completed',
  trigger: 'chat',
  caller: 'employee:4f1c',
  callerPseudonym: 'A-4K7Q',
  startedAt: '2026-10-07T10:41:00+02:00',
  durationSeconds: 4.2,
  inputTokens: 4120,
  outputTokens: 350,
  costOre: 2.2,
  steps: (
    [
      [
        'trigger',
        'Spørsmål i chat fra ansatt i Testetaten (A-4K7Q)',
        '«Hva sier evalueringer om digital veiledning siden 2020?»',
      ],
      [
        'audit',
        'Tilgang sjekket',
        'Den ansatte har «Bruke tjenester» i Altinn (hentet 10.38). Tjenesten er åpen for alle med den rettigheten.',
      ],
      [
        'audit',
        'Innstillinger lest',
        'Tjeneste v7, plattformstandard 2026-10-05. Risiko: begrenset.',
      ],
      ['guard', 'Personopplysninger sjekket', 'Ingen funnet. Policy personvernfilter 3.2.'],
      [
        'plan',
        'Agent planla 4 steg',
        'Søk evalueringer, les rapporter, søk kanalvalg, svar med kilder.',
      ],
      [
        'search',
        '«digital veiledning evaluering» · 14 treff',
        'Filter: Kudos-rapporter, Evaluering, 2020–2026. Beste treff 0,91.',
      ],
      [
        'read',
        '3 rapporter, 11 tekstbiter',
        'Evaluering 2023 (s. 4–9), Sluttrapport 2024 (s. 12–15), Kartlegging 2021 (s. 31).',
      ],
      ['search', '«veiledning kanalvalg ventetid» · 6 treff', 'Samme filter.'],
      [
        'model',
        'Borealis-27B · 4 120 inn, 350 ut',
        'AIVAR, Norge. 1,9 s. Instruksjoner v7 (612 tokens), 11 tekstbiter (3 280 tokens), spørsmål (228 tokens).',
      ],
      ['guard', 'Kilder kontrollert', 'Alle 3 påstander har kilde.'],
      ['result', 'Svar med 3 kilder', 'Sendt til intranettet kl. 10.41.04.'],
      ['audit', 'Lagret i logg', 'Oppbevares i 60 dager (festet til plattformstandard v11).'],
    ] as const
  ).map(([type, title, summary], i) => ({
    id: `s${i}`,
    type,
    title,
    summary,
    at: i * 0.3,
    blocks: [],
  })),
};

const resolvedRows: [string, string, string, string, string, string, string][] = [
  [
    'Strategi',
    'Ett steg',
    '–',
    'Agent i flere steg',
    'Agent i flere steg',
    'service',
    'Valgt i versjon 5.',
  ],
  ['Hovedmodell', 'Borealis-27B', '–', '–', 'Borealis-27B', 'platform', ''],
  ['Reservemodell', 'GPT-4.1 mini', '–', 'GPT-4.1', 'GPT-4.1', 'service', ''],
  [
    'Datasett',
    '–',
    '–',
    'Kudos-rapporter, Tilsynsrapporter 2025',
    'Kudos-rapporter, Tilsynsrapporter 2025',
    'service',
    '',
  ],
  ['Standardfilter', '–', '–', 'Evaluering, fra 2020', 'Evaluering, fra 2020', 'service', ''],
  ['Svarspråk', 'Samme som spørsmålet', '–', '–', 'Samme som spørsmålet', 'platform', ''],
  [
    'Fjern personopplysninger før modellkall',
    'Per risikonivå: av / på / på (gulv: på for høy)',
    '–',
    '–',
    'På (begrenset risiko)',
    'platform',
    '',
  ],
  [
    'Kilder påkrevd',
    'Per risikonivå: av / på / på',
    '–',
    '–',
    'På (begrenset risiko)',
    'platform',
    '',
  ],
  ['Maks tokens per kjøring', '32 000', '–', '–', '32 000', 'platform', ''],
  ['Kall per minutt', '600', '1 200', '–', '1 200', 'tenant', 'Gjelder hele Testetaten.'],
  [
    'Logg oppbevares',
    'Per risikonivå: 30 dager / 90 dager / 10 år (ikke bestemt)',
    '–',
    'Festet: 60 dager',
    '60 dager',
    'pin',
    'v12 endret begrenset risiko til 90 dager. Tjenesten er festet til v11.',
  ],
];

export const exampleEffective: EffectiveSettings = Object.fromEntries(
  resolvedRows.map(([label, platform, tenant, service, value, source, note], i) => {
    const overridden = (
      [
        ['platform', platform],
        ['tenant', tenant],
        ['service', service],
      ] as const
    )
      .filter(
        ([layer, v]) => v !== '–' && layer !== source && !(source === 'pin' && layer === 'service'),
      )
      .map(([layer, v]) => ({ layer, value: v }));
    return [
      `setting.${i}`,
      {
        key: `setting.${i}`,
        label,
        value,
        source,
        defaultVersion: 12,
        ...(source === 'pin' ? { pinnedVersion: 11 } : {}),
        overridden,
        rejected: [],
        ...(note ? { note } : {}),
      },
    ];
  }),
);

const S = (
  s: Omit<GridSetting, 'version' | 'tenants' | 'services'> & Partial<GridSetting>,
): GridSetting => ({
  version: 12,
  tenants: {},
  services: {},
  ...s,
});

export const exampleSettingsGrid: SettingsGrid = {
  platformVersion: 12,
  platformDate: '5. okt',
  tenants: ['983555666', '983888999', '964777888'],
  services: [{ tenant: '983555666', name: 'rapportassistenten' }],
  settings: [
    S({
      key: 'usage.monthlyTokens',
      category: 'Forbruk',
      label: 'Tokens per måned',
      description: 'Tokens en virksomhet kan bruke per kalendermåned.',
      type: 'int',
      min: 0,
      sensitivity: 'low',
      scope: ['tenant'],
      platform: 20_000_000,
      tenants: { '983555666': 40_000_000, '983888999': 30_000_000, '964777888': 5_000_000 },
    }),
    S({
      key: 'usage.tenantCallsPerMinute',
      category: 'Forbruk',
      label: 'Kall per minutt',
      description: 'Kall en virksomhet kan gjøre per minutt.',
      type: 'int',
      min: 1,
      sensitivity: 'low',
      scope: ['tenant'],
      platform: 60,
      tenants: { '983555666': 120 },
    }),
    S({
      key: 'assistant.dailyTokens',
      category: 'Assistent',
      label: 'Tokens per dag for assistenten',
      description: 'Nullstilles kl. 00.00 norsk tid.',
      type: 'int',
      min: 0,
      sensitivity: 'low',
      scope: ['tenant'],
      platform: 200_000,
    }),
    S({
      key: 'batch.approvalLimitNok',
      category: 'Forbruk',
      label: 'Grense per massekjøring før godkjenning',
      description: 'Massekjøringer som koster mer, må godkjennes.',
      type: 'int',
      min: 0,
      unit: 'kr',
      sensitivity: 'low',
      scope: ['tenant'],
      platform: 500,
    }),
    S({
      key: 'answers.writtenStandard',
      category: 'Svar',
      label: 'Målform i svar',
      description: 'Hvilken målform svarene skal ha.',
      type: 'enum',
      options: [
        { value: 'bokmal', label: 'Bokmål' },
        { value: 'nynorsk', label: 'Nynorsk' },
      ],
      sensitivity: 'low',
      scope: ['tenant', 'service'],
      platform: 'bokmal',
      tenants: { '983888999': 'nynorsk', '964777888': 'nynorsk' },
    }),
  ],
};

export const exampleSettingHistory: Record<string, [number, string, string, string][]> = {
  'usage.monthlyTokens': [
    [12, '20000000', '2026-10-05T10:00:00+02:00', 'Økt fra 10 millioner etter pilotene'],
    [11, '10000000', '2026-06-02T10:00:00+02:00', 'Første versjon'],
  ],
};
