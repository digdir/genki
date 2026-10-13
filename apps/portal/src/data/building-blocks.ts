import type {
  BlockKind,
  BlockScore,
  BlockStatus,
  BlockUser,
  BlockVersion,
  CatalogItem,
  CatalogProposal,
  DataLocation,
  ExtensionPoint,
  Permission,
  RegistrationAuth,
  RegistrationType,
  SettingProperty,
  SettingsSchema,
} from '../api/building-blocks';
import { translator, type PlainKey } from '../i18n';

export const blockKinds: {
  kind: BlockKind;
  label: PlainKey;
  one: PlainKey;
  description: PlainKey;
}[] = [
  {
    kind: 'model',
    label: 'blocks.kindManyModel',
    one: 'blocks.kindOneModel',
    description: 'blocks.kindDescModel',
  },
  {
    kind: 'dataset',
    label: 'blocks.kindManyDataset',
    one: 'blocks.kindOneDataset',
    description: 'blocks.kindDescDataset',
  },
  {
    kind: 'search_engine',
    label: 'blocks.kindManySearchEngine',
    one: 'blocks.kindOneSearchEngine',
    description: 'blocks.kindDescSearchEngine',
  },
  {
    kind: 'tool',
    label: 'blocks.kindManyTool',
    one: 'blocks.kindOneTool',
    description: 'blocks.kindDescTool',
  },
  {
    kind: 'skill',
    label: 'blocks.kindManySkill',
    one: 'blocks.kindOneSkill',
    description: 'blocks.kindDescSkill',
  },
  {
    kind: 'extension_point',
    label: 'blocks.kindManyExtensionPoint',
    one: 'blocks.kindOneExtensionPoint',
    description: 'blocks.kindDescExtensionPoint',
  },
  {
    kind: 'guardrail',
    label: 'blocks.kindManyGuardrail',
    one: 'blocks.kindOneGuardrail',
    description: 'blocks.kindDescGuardrail',
  },
  {
    kind: 'judge',
    label: 'blocks.kindManyJudge',
    one: 'blocks.kindOneJudge',
    description: 'blocks.kindDescJudge',
  },
  {
    kind: 'step_flow',
    label: 'blocks.kindManyStepFlow',
    one: 'blocks.kindOneStepFlow',
    description: 'blocks.kindDescStepFlow',
  },
  {
    kind: 'shared_service',
    label: 'blocks.kindManySharedService',
    one: 'blocks.kindOneSharedService',
    description: 'blocks.kindDescSharedService',
  },
];

export const kindLabel = (t: (key: PlainKey) => string, kind: BlockKind) => {
  const found = blockKinds.find((k) => k.kind === kind);
  return found ? t(found.one) : kind;
};

export const extensionPoints: { value: ExtensionPoint; label: PlainKey }[] = [
  { value: 'before_search', label: 'blocks.pointBeforeSearch' },
  { value: 'after_search', label: 'blocks.pointAfterSearch' },
  { value: 'before_model', label: 'blocks.pointBeforeModel' },
  { value: 'after_model', label: 'blocks.pointAfterModel' },
  { value: 'before_tool', label: 'blocks.pointBeforeTool' },
  { value: 'on_publish', label: 'blocks.pointOnPublish' },
  { value: 'on_feedback', label: 'blocks.pointOnFeedback' },
];

export const extensionPointLabel = (
  point: ExtensionPoint,
  t: (key: PlainKey) => string = translator('nb'),
) => {
  const found = extensionPoints.find((p) => p.value === point);
  return found ? t(found.label) : point;
};

export const publisherOptions = [
  { value: 'all', label: 'blocks.publisherAll' },
  { value: 'digdir', label: 'blocks.publisherDigdir' },
  { value: 'own', label: 'blocks.publisherOwn' },
  { value: 'shared', label: 'blocks.publisherShared' },
] as const satisfies readonly { value: string; label: PlainKey }[];

export type StatusColor = 'success' | 'info' | 'warning' | 'danger';

export const statusLabels: Record<BlockStatus, { label: PlainKey; color: StatusColor }> = {
  in_use: { label: 'blocks.statusInUse', color: 'success' },
  available: { label: 'blocks.statusAvailable', color: 'info' },
  requires_approval: { label: 'blocks.statusRequiresApproval', color: 'warning' },
  pending_approval: { label: 'blocks.statusPendingApproval', color: 'warning' },
  not_allowed: { label: 'blocks.statusNotAllowed', color: 'danger' },
};

export const storageLabels: Record<DataLocation, PlainKey> = {
  norway: 'blocks.storageNorway',
  eu: 'blocks.storageEu',
  global: 'blocks.storageGlobal',
};

export const versionEventLabels: Record<NonNullable<BlockVersion['event']>, PlainKey> = {
  adopted: 'blocks.eventAdopted',
  approval_requested: 'blocks.eventApprovalRequested',
  approved: 'blocks.eventApproved',
  rejected: 'blocks.eventRejected',
  withdrawn: 'blocks.eventWithdrawn',
  settings: 'blocks.eventSettings',
};

export const permissionLabels: Record<Permission['type'], PlainKey> = {
  network: 'blocks.permNetwork',
  secret: 'blocks.permSecret',
  data: 'blocks.permData',
  model: 'blocks.permModel',
};

export const registrationTypes: {
  type: RegistrationType;
  label: PlainKey;
  description: PlainKey;
  notDecided: boolean;
}[] = [
  {
    type: 'mcp',
    label: 'blocks.regMcp',
    description: 'blocks.regMcpDesc',
    notDecided: false,
  },
  {
    type: 'openapi',
    label: 'blocks.regOpenapi',
    description: 'blocks.regOpenapiDesc',
    notDecided: false,
  },
  {
    type: 'a2a',
    label: 'blocks.regA2a',
    description: 'blocks.regA2aDesc',
    notDecided: false,
  },
  {
    type: 'extension_point',
    label: 'blocks.regExtensionPoint',
    description: 'blocks.regExtensionPointDesc',
    notDecided: true,
  },
  {
    type: 'skill_package',
    label: 'blocks.regSkillPackage',
    description: 'blocks.regSkillPackageDesc',
    notDecided: true,
  },
];

export const authOptions: {
  value: RegistrationAuth['kind'];
  label: PlainKey;
  unavailable?: { types: RegistrationType[]; reason: PlainKey };
}[] = [
  {
    value: 'maskinporten',
    label: 'blocks.authMaskinporten',
    unavailable: {
      types: ['mcp', 'a2a', 'openapi'],
      reason: 'blocks.authMaskinportenUnavailable',
    },
  },
  { value: 'api-key', label: 'blocks.authApiKey' },
  {
    value: 'oauth-client-credentials',
    label: 'blocks.authOauth',
    unavailable: {
      types: ['extension_point'],
      reason: 'blocks.authOauthUnavailable',
    },
  },
  { value: 'none', label: 'blocks.authNone' },
];

export const authUnavailableKey = (type: RegistrationType, kind: RegistrationAuth['kind']) => {
  const option = authOptions.find((o) => o.value === kind);
  return option?.unavailable?.types.includes(type) ? option.unavailable.reason : undefined;
};

export const authUnavailable = (type: RegistrationType, kind: RegistrationAuth['kind']) => {
  const key = authUnavailableKey(type, kind);
  return key ? translator('nb')(key) : undefined;
};

export const defaultAuthFor = (type: RegistrationType): RegistrationAuth['kind'] =>
  authUnavailableKey(type, 'maskinporten') ? 'none' : 'maskinporten';

export const exampleSecretNames = ['arkiv-nokkel', 'saks-api'];

export const mcpContractTests = [
  'Oppsettet er gyldig',
  'Svarer på tools/list',
  'Verktøyene har beskrivelse og inputSchema',
  'Respekterer tidsavbrudd',
  'Bruker bare adressene i manifestet',
];

export const contractTestFailures: Record<string, string> = {
  'Verktøyene har beskrivelse og inputSchema':
    '2 av 6 verktøy mangler inputSchema: hent_vedlegg, sok_journal.',
  'Bruker bare adressene i manifestet':
    'Serveren kalte files.testetaten.example.no, som ikke står i manifestet.',
};

const property = (p: SettingProperty) => p;

const schema = (properties: Record<string, SettingProperty>): SettingsSchema => ({
  type: 'object',
  properties,
  additionalProperties: false,
});

export const defaultSettingsSchema = schema({
  enabled: property({
    type: 'boolean',
    title: 'Kan brukes i tjenestene',
    description: 'Slå av for å stoppe bruken uten å fjerne byggeklossen.',
    default: true,
  }),
  timeoutSeconds: property({
    type: 'integer',
    title: 'Tidsavbrudd',
    description: 'Hvor lenge et kall får ta før det regnes som feilet.',
    default: 30,
    minimum: 1,
    maximum: 300,
    'x-unit': 'sekunder',
  }),
});

const defaultPermissions: Permission[] = [
  { type: 'network', value: 'Ingen adresser utenfor plattformen' },
  { type: 'secret', value: 'Ingen' },
  { type: 'data', value: 'Det tjenesten sender i kallet' },
];

export const exampleServices: BlockUser[] = [
  { id: 'rapportassistenten', name: 'Rapportassistenten' },
  { id: 'postsortering', name: 'Postsortering' },
  { id: 'motereferat', name: 'Møtereferat' },
  { id: 'vedtaksutkast', name: 'Vedtaksutkast' },
  { id: 'nettsider-nynorsk', name: 'Nettsider på nynorsk' },
];

const allServices = exampleServices.map((s) => s.id);

const publishers = {
  digdir: { type: 'digdir', name: 'Digdir' },
  own: { type: 'own', name: 'Testetaten' },
  eksempelverk: { type: 'shared', name: 'Statens eksempelverk' },
  eksempeldirektoratet: { type: 'shared', name: 'Eksempeldirektoratet' },
} as const;

const needs = (...rows: [Permission['type'], string, string?][]): Permission[] =>
  rows.map(([type, value, note]) => (note ? { type, value, note } : { type, value }));

type Example = Omit<
  CatalogItem,
  | 'permissions'
  | 'settingsSchema'
  | 'tenantOverrides'
  | 'scores'
  | 'usedBy'
  | 'settingsVersion'
  | 'right'
> &
  Partial<Pick<CatalogItem, 'permissions' | 'settingsSchema' | 'tenantOverrides'>> & {
    usedBy?: string[];
    scores?: { service: string; testSet: string; score: number }[];
    versions?: { version: string; publishedAt: string; notes: string }[];
  };

const exampleRun = '2026-10-06T05:00:00Z';

const userOf = (id: string): BlockUser => ({
  id,
  name: exampleServices.find((s) => s.id === id)?.name ?? id,
});

const block = ({ versions: _v, usedBy, scores, ...b }: Example): CatalogItem => ({
  ...b,
  permissions: b.permissions ?? defaultPermissions,
  settingsSchema: b.settingsSchema ?? defaultSettingsSchema,
  tenantOverrides: b.tenantOverrides ?? {},
  settingsVersion: b.tenantOverrides ? 1 : 0,
  right: b.kind === 'dataset' || b.kind === 'search_engine' ? 'manage-datasets' : 'manage-services',
  scores: (scores ?? []).map((s): BlockScore => ({
    ...s,
    run: `run-${b.id}-${s.service}`,
    at: exampleRun,
  })),
  usedBy: (usedBy ?? []).map(userOf),
});

const examples: Example[] = [
  {
    id: 'borealis',
    kind: 'model',
    name: 'Borealis-27B',
    description: 'Norsk språkmodell fra AIVAR, driftet i Norge.',
    publisher: publishers.digdir,
    version: '2.1',
    latestVersion: '2.2',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: [
      'rapportassistenten',
      'postsortering',
      'motereferat',
      'nettsider-nynorsk',
      'vedtaksutkast',
    ],
    capabilities: [
      'Svarer på bokmål og nynorsk',
      'Leser opptil 128 000 tokens i én kjøring',
      'Kan kalle verktøy',
      'Gir strukturerte felter etter et skjema',
    ],
    permissions: needs(
      ['network', 'Ingen. Modellen kjører på plattformen.'],
      ['secret', 'Ingen'],
      ['data', 'Instruksjonene, spørsmålet og tekstbitene fra søket', 'Lagres ikke av modellen'],
    ),
    scores: [
      { service: 'rapportassistenten', testSet: 'Spørsmål om rapporter', score: 84 },
      { service: 'postsortering', testSet: 'Innkommende post', score: 91 },
      { service: 'motereferat', testSet: 'Referater', score: 78 },
    ],
    update: {
      version: '2.2',
      availableFrom: '2026-10-06',
      notes: 'Ny modellversjon fra AIVAR. Bedre på nynorsk. Svarer i snitt 6 prosent lengre.',
      perService: [
        { service: 'rapportassistenten', scoreBefore: 84, scoreAfter: 87 },
        { service: 'postsortering', scoreBefore: 91, scoreAfter: 91 },
        { service: 'motereferat', scoreBefore: 78, scoreAfter: 82 },
        { service: 'nettsider-nynorsk', scoreBefore: 80, scoreAfter: 86 },
        { service: 'vedtaksutkast', scoreBefore: 72, scoreAfter: 71 },
      ],
    },
    versions: [
      { version: '2.2', publishedAt: '2026-10-06', notes: 'Tilgjengelig. Bedre på nynorsk.' },
      { version: '2.1', publishedAt: '2026-09-29', notes: 'Ny modellversjon fra AIVAR.' },
      { version: '2.0', publishedAt: '2026-06-02', notes: 'Første versjon på plattformen.' },
    ],
    settingsSchema: schema({
      temperature: property({
        type: 'number',
        title: 'Temperatur',
        description: 'Hvor mye svarene varierer. Lav verdi gir like svar på like spørsmål.',
        default: 0.2,
        minimum: 0,
        maximum: 1,
        multipleOf: 0.1,
      }),
      maxTokens: property({
        type: 'integer',
        title: 'Lengste svar',
        description: 'Svar som blir lengre, kuttes.',
        default: 4000,
        minimum: 200,
        maximum: 8000,
        'x-unit': 'tokens',
      }),
      fallbackModel: property({
        type: 'string',
        title: 'Reservemodell',
        description: 'Brukes hvis Borealis ikke svarer innen tidsavbruddet.',
        default: 'qwen',
        enum: ['qwen', 'none'],
        enumTitles: ['Qwen3.8-27B', 'Ingen reserve'],
      }),
      timeoutSeconds: property({
        type: 'integer',
        title: 'Tidsavbrudd',
        description: 'Bytter til reservemodellen etter dette.',
        default: 20,
        minimum: 5,
        maximum: 120,
        'x-unit': 'sekunder',
      }),
    }),
    tenantOverrides: { temperature: 0.1 },
  },
  {
    id: 'qwen',
    kind: 'model',
    name: 'Qwen3.8-27B',
    description: 'Flerspråklig modell som er god til å hente ut felter.',
    publisher: publishers.digdir,
    version: '1.3',
    dataLocation: 'norway',
    status: 'available',
    capabilities: [
      'Svarer på norsk og engelsk',
      'Gir strukturerte felter etter et skjema',
      'Raskere og billigere enn Borealis',
    ],
    scores: [{ service: 'postsortering', testSet: 'Innkommende post', score: 88 }],
  },
  {
    id: 'gpt41',
    kind: 'model',
    name: 'GPT-4.1 (Azure OpenAI)',
    description: 'Stor modell for krevende resonnering. Data behandles i Sverige.',
    publisher: publishers.digdir,
    version: '1.1',
    dataLocation: 'eu',
    status: 'requires_approval',
    approver: 'digdir',
    policyBlock: {
      rule: 'models.requireApprovalOutsideNorway',
      ownedBy: 'Digdir',
      text: 'Data behandles i EU/EØS, men ikke i Norge. Digdir må godkjenne at Testetaten tar modellen i bruk.',
    },
    capabilities: [
      'Resonnerer over lange dokumenter',
      'Kan kalle verktøy',
      'Leser bilder og skannede dokumenter',
    ],
    permissions: needs(
      ['network', 'Azure OpenAI, region Sweden Central', 'Behandler data i EU/EØS'],
      ['secret', 'Ingen. Digdir eier avtalen.'],
      [
        'data',
        'Instruksjonene, spørsmålet og tekstbitene fra søket',
        'Lagres ikke av leverandøren etter avtale',
      ],
    ),
  },
  {
    id: 'gpt5',
    kind: 'model',
    name: 'GPT-5 (OpenAI)',
    description: 'Nyeste modell fra OpenAI. Data behandles i USA.',
    publisher: publishers.digdir,
    version: '1.0',
    dataLocation: 'global',
    status: 'not_allowed',
    policyBlock: {
      rule: 'models.allowOutsideEea',
      ownedBy: 'Digdir',
      text: 'Ikke tillatt: data behandles utenfor EU/EØS. Digdir kan endre dette i plattforminnstillingene.',
    },
    capabilities: ['Resonnerer over lange dokumenter', 'Kan kalle verktøy'],
    permissions: needs(
      ['network', 'api.openai.com, USA', 'Behandler data utenfor EU/EØS'],
      ['secret', 'Ingen. Digdir eier avtalen.'],
      ['data', 'Instruksjonene, spørsmålet og tekstbitene fra søket'],
    ),
  },
  {
    id: 'ds-kudos',
    kind: 'dataset',
    name: 'Kudos-rapporter',
    description: 'Evalueringer, årsrapporter og utredninger fra Kudos.',
    publisher: publishers.own,
    version: 'Lest inn i dag kl. 05.00',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten'],
    capabilities: ['53 536 dokumenter, søkbare med hybridsøk', 'Oppdateres hver natt'],
  },
  {
    id: 'ds-web',
    kind: 'dataset',
    name: 'Nettsidene til Testetaten',
    description: 'Alle sider på testetaten.example.no.',
    publisher: publishers.own,
    version: 'Lest inn 5. okt',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten', 'nettsider-nynorsk'],
    capabilities: [
      '1 204 sider',
      'Siste innlesing feilet. Tjenestene bruker innholdet fra 5. oktober.',
    ],
  },
  {
    id: 'ds-veil',
    kind: 'dataset',
    name: 'Veiledere fra Statens eksempelverk',
    description: 'Veiledere og rundskriv som Statens eksempelverk deler med andre virksomheter.',
    publisher: publishers.eksempelverk,
    version: 'Lest inn 4. okt',
    dataLocation: 'norway',
    status: 'available',
    capabilities: ['812 dokumenter', 'Bare lesing. Statens eksempelverk eier innholdet.'],
  },
  {
    id: 'hybrid',
    kind: 'search_engine',
    name: 'Hybridsøk',
    description: 'Kombinerer søk på ord med søk på betydning.',
    publisher: publishers.digdir,
    version: '3.0',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten', 'vedtaksutkast'],
    capabilities: [
      'Finner treff selv når ordene er forskjellige',
      'Kan filtrere på dokumenttype og år',
    ],
    scores: [{ service: 'rapportassistenten', testSet: 'Spørsmål om rapporter', score: 84 }],
    settingsSchema: schema({
      hits: property({
        type: 'integer',
        title: 'Antall treff',
        description: 'Hvor mange treff som hentes før rangering.',
        default: 20,
        minimum: 5,
        maximum: 100,
      }),
      semanticWeight: property({
        type: 'number',
        title: 'Vekt på betydning',
        description: '0 er bare ordsøk, 1 er bare betydningssøk.',
        default: 0.6,
        minimum: 0,
        maximum: 1,
        multipleOf: 0.1,
      }),
      language: property({
        type: 'string',
        title: 'Språk',
        default: 'nb-nn',
        enum: ['nb-nn', 'nb', 'all'],
        enumTitles: ['Bokmål og nynorsk', 'Bare bokmål', 'Alle språk'],
      }),
    }),
  },
  {
    id: 'rerank',
    kind: 'search_engine',
    name: 'Rangering av treff',
    description: 'Sorterer treffene fra søket så de mest relevante kommer først.',
    publisher: publishers.digdir,
    version: '1.2',
    latestVersion: '1.3',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten'],
    update: {
      version: '1.3',
      availableFrom: '2026-10-05',
      notes: 'Ny standardmodell for norsk. Raskere.',
      perService: [{ service: 'rapportassistenten', scoreBefore: 84, scoreAfter: 86 }],
    },
    capabilities: ['Bruker en egen modell for norsk'],
  },
  {
    id: 'graf',
    kind: 'search_engine',
    name: 'Grafsøk',
    description: 'Følger henvisninger mellom dokumenter, for eksempel fra lov til forskrift.',
    publisher: publishers.digdir,
    version: '0.4',
    dataLocation: 'norway',
    status: 'available',
    isNew: true,
    capabilities: [
      'Finner dokumenter som henviser til hverandre',
      'Passer for regelverk og saker med mange vedlegg',
    ],
  },
  {
    id: 'lovdata',
    kind: 'tool',
    name: 'Lovdata',
    description: 'Slår opp i lover og forskrifter. MCP-server.',
    publisher: publishers.digdir,
    version: '1.4',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['vedtaksutkast'],
    capabilities: [
      'Slår opp en paragraf ut fra lovnavn og nummer',
      'Søker i forskrifter',
      'Kan ikke endre noe',
    ],
    permissions: needs(
      ['network', 'mcp.lovdata.example.no', 'Slår opp i lover og forskrifter'],
      ['secret', 'Ingen'],
      ['data', 'Søkeordene tjenesten sender', 'Ikke dokumentene i saken'],
    ),
    settingsSchema: schema({
      timeoutSeconds: property({
        type: 'integer',
        title: 'Tidsavbrudd',
        description: 'Hvor lenge verktøyet får før det regnes som feilet.',
        default: 10,
        minimum: 1,
        maximum: 60,
        'x-unit': 'sekunder',
      }),
      readOnly: property({
        type: 'boolean',
        title: 'Bare lesing',
        description: 'Verktøyet kan ikke endre noe.',
        default: true,
      }),
    }),
  },
  {
    id: 'arkiv',
    kind: 'tool',
    name: 'Saksarkivet',
    description: 'Henter saksdokumenter fra arkivet. REST-verktøy laget fra en OpenAPI-fil.',
    publisher: publishers.own,
    version: '1.0',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['vedtaksutkast', 'postsortering'],
    capabilities: ['Henter en sak med vedlegg', 'Søker i journalen'],
    permissions: needs(
      ['network', 'arkiv.testetaten.example.no', 'Henter saker og vedlegg'],
      ['secret', 'arkiv-klient (Maskinporten)', 'Lagret i hemmelighetene til Testetaten'],
      ['data', 'Saksnummer', 'Dokumentene leses inn i kjøringen og lagres ikke'],
    ),
  },
  {
    id: 'a2a-skatt',
    kind: 'tool',
    name: 'Skatteveilederen',
    description:
      'Agent fra Statens eksempelverk som svarer på spørsmål om skatteregler. A2A-agent.',
    publisher: publishers.eksempelverk,
    version: '0.3',
    dataLocation: 'eu',
    status: 'requires_approval',
    approver: 'digdir',
    policyBlock: {
      rule: 'sharedAgents.approver',
      ownedBy: 'Digdir',
      text: 'Agenten er delt av Statens eksempelverk. Digdir godkjenner hvem som kan bruke delte agenter.',
    },
    capabilities: [
      'Svarer på spørsmål om skatteregler med kilder',
      'Kan stille oppfølgingsspørsmål',
    ],
    permissions: needs(
      ['network', 'agent.eksempelverk.example.no', 'Kaller agenten'],
      ['secret', 'Ingen. Plattformen logger inn med Maskinporten.'],
      ['data', 'Spørsmålet og det tjenesten legger ved', 'Behandles i EU/EØS'],
    ),
  },
  {
    id: 'sk-vedtak',
    kind: 'skill',
    name: 'Skrive vedtaksbrev',
    description: 'Oppbygging, faste formuleringer og klagerett for vedtak fra Testetaten.',
    publisher: publishers.own,
    version: '1.2',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['vedtaksutkast'],
    capabilities: [
      'Instruksjoner for oppbygging av vedtak',
      '12 eksempler på gode vedtak',
      'Mal for klagerett',
    ],
  },
  {
    id: 'sk-klar',
    kind: 'skill',
    name: 'Klarspråk i brev',
    description: 'Retningslinjer for klart språk i brev til innbyggere.',
    publisher: publishers.digdir,
    version: '1.0',
    dataLocation: 'norway',
    status: 'available',
    capabilities: ['Retningslinjer for klart språk', 'Eksempler før og etter'],
  },
  {
    id: 'ut-mask',
    kind: 'extension_point',
    name: 'Maskering av saksnummer',
    description: 'Bytter saksnummer med plassholdere før modellen får teksten.',
    publisher: publishers.own,
    version: '1.1',
    dataLocation: 'norway',
    status: 'in_use',
    extensionPoint: 'before_model',
    usedBy: ['postsortering', 'vedtaksutkast'],
    capabilities: ['Kjøres før modellkall', 'Setter saksnumrene tilbake i svaret'],
    permissions: needs(
      ['network', 'maskering.testetaten.example.no', 'Endepunktet som kjøres'],
      ['secret', 'maskering-nokkel', 'Lagret i hemmelighetene til Testetaten'],
      ['data', 'Teksten som skal til modellen'],
    ),
  },
  {
    id: 'ut-arkiv',
    kind: 'extension_point',
    name: 'Journalføring ved publisering',
    description: 'Lagrer oppsettet for tjenesten i arkivet hver gang den publiseres.',
    publisher: publishers.own,
    version: '0.9',
    dataLocation: 'norway',
    status: 'in_use',
    extensionPoint: 'on_publish',
    usedBy: allServices,
    capabilities: ['Kjøres ved publisering', 'Gjelder alle tjenestene til Testetaten'],
  },
  {
    id: 'pii',
    kind: 'guardrail',
    name: 'Filtrering av personopplysninger',
    description: 'Finner og fjerner fødselsnummer, navn og adresser før modellkall.',
    publisher: publishers.digdir,
    version: '3.2',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: allServices,
    capabilities: [
      'Finner fødselsnummer, D-nummer, navn og adresser',
      'Kan stoppe kjøringen eller maskere',
    ],
  },
  {
    id: 'kildekrav',
    kind: 'guardrail',
    name: 'Kildekrav',
    description: 'Svar uten kilde stoppes og sendes ikke ut.',
    publisher: publishers.digdir,
    version: '1.4',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten'],
    capabilities: ['Sjekker at svaret viser til minst én kilde'],
  },
  {
    id: 'dom-kilde',
    kind: 'judge',
    name: 'Kildetreff',
    description: 'Sjekker at svaret bruker kildene som er forventet.',
    publisher: publishers.digdir,
    version: '1.1',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten'],
    capabilities: ['Sammenligner kildene i svaret med forventede kilder'],
  },
  {
    id: 'dom-llm',
    kind: 'judge',
    name: 'Modell som dommer',
    description: 'Vurderer svar etter kriterier skrevet i vanlige ord.',
    publisher: publishers.digdir,
    version: '0.9',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['rapportassistenten', 'vedtaksutkast'],
    capabilities: [
      'Gir poeng og begrunnelse per kriterium',
      'Kappa mot menneskelige vurderinger: 0,72',
    ],
  },
  {
    id: 'sf-vedtak',
    kind: 'step_flow',
    name: 'Vedtaksforberedelse',
    description: 'Leser søknaden, henter regelverk, vurderer vilkår og skriver utkast.',
    publisher: publishers.own,
    version: '2',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['vedtaksutkast'],
    capabilities: ['5 steg', 'Saksbehandler godkjenner før noe sendes'],
  },
  {
    id: 'sf-hoering',
    kind: 'step_flow',
    name: 'Høringsoppsummering',
    description: 'Grupperer høringssvar etter tema og oppsummerer hvert tema.',
    publisher: publishers.eksempeldirektoratet,
    version: '1.0',
    dataLocation: 'norway',
    status: 'available',
    capabilities: ['4 steg', 'Viser hvilke høringssvar hvert tema bygger på'],
  },
  {
    id: 'fs-trans',
    kind: 'shared_service',
    name: 'Transkribering',
    description: 'Gjør om lydopptak til tekst, med hvem som snakker.',
    publisher: publishers.digdir,
    version: '2.0',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['motereferat'],
    capabilities: ['Bokmål, nynorsk og engelsk', 'Skiller mellom de som snakker'],
  },
  {
    id: 'fs-klar',
    kind: 'shared_service',
    name: 'Klarspråk',
    description: 'Skriver om tekst til klart språk.',
    publisher: publishers.digdir,
    version: '2.3',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['vedtaksutkast'],
    capabilities: ['Beholder fagbegreper', 'Viser hva som er endret'],
  },
  {
    id: 'fs-nyn',
    kind: 'shared_service',
    name: 'Bokmål til nynorsk',
    description: 'Omset tekst frå bokmål til nynorsk.',
    publisher: publishers.digdir,
    version: '1.8',
    dataLocation: 'norway',
    status: 'in_use',
    usedBy: ['nettsider-nynorsk'],
    capabilities: ['Følgjer rettskrivinga frå 2012', 'Kan bruke ordlista til verksemda'],
  },
  {
    id: 'fs-anon',
    kind: 'shared_service',
    name: 'Anonymisering',
    description: 'Fjerner personopplysninger fra dokumenter før deling.',
    publisher: publishers.digdir,
    version: '1.0',
    dataLocation: 'norway',
    status: 'available',
    isNew: true,
    capabilities: [
      'Finner navn, fødselsnummer og adresser',
      'Lager en liste over det som er fjernet',
    ],
  },
];

export const exampleBlocks: CatalogItem[] = examples.map(block);

export const exampleVersions: Record<string, BlockVersion[]> = Object.fromEntries(
  examples
    .filter((e) => e.versions)
    .map((e) => [
      `${e.kind}:${e.id}`,
      (e.versions ?? []).map((v): BlockVersion => ({
        source: 'publisher',
        version: v.version,
        at: `${v.publishedAt}T08:00:00Z`,
        reason: v.notes,
      })),
    ]),
);

export const emptyTenantBlocks = (): CatalogItem[] =>
  exampleBlocks
    .filter((b) => b.publisher.type !== 'own')
    .map((b) =>
      b.status === 'in_use'
        ? {
            ...b,
            status: 'available',
            usedBy: [],
            tenantOverrides: {},
            settingsVersion: 0,
            scores: [],
          }
        : { ...b, scores: [] },
    );

export const emptyStateSuggestions = ['borealis', 'hybrid', 'pii'];

export const exampleProposal: CatalogProposal = {
  id: 'brreg',
  level: 3,
  createdBy: 'assistant',
  requestedBy: 'Kari Nordmann',
  forService: { id: 'postsortering', name: 'Postsortering' },
  createdAt: '2026-10-06T12:12:00Z',
  state: 'pending',
  permissions: needs(
    ['network', 'data.brreg.no', 'Slår opp organisasjonsnummer'],
    ['secret', 'Ingen'],
    ['data', 'Organisasjonsnummeret i meldingen', 'Ikke resten av meldingen'],
  ),
  tests: [
    { name: 'Svarer i riktig format', passed: true },
    { name: 'Respekterer tidsavbrudd', passed: true },
    { name: 'Bruker bare adressene i manifestet', passed: true },
    { name: 'Håndterer feil uten å stoppe kjøringen', passed: true },
    {
      name: 'Gir riktig svar på eksemplene',
      passed: true,
      reason: '9 av 10. Ett nedlagt foretak ble vist som aktivt.',
    },
  ],
  item: block({
    id: 'brreg',
    kind: 'tool',
    name: 'Oppslag i Enhetsregisteret',
    description: 'Henter navn, adresse og status for et organisasjonsnummer.',
    publisher: publishers.own,
    version: '1',
    dataLocation: 'norway',
    status: 'available',
    capabilities: ['Slår opp ett organisasjonsnummer', 'Kan ikke endre noe'],
    permissions: needs(
      ['network', 'data.brreg.no', 'Slår opp organisasjonsnummer'],
      ['secret', 'Ingen'],
      ['data', 'Organisasjonsnummeret i meldingen', 'Ikke resten av meldingen'],
    ),
  }),
};

const soknadsuttrekk = { id: 'soknadsuttrekk', name: 'Søknadsuttrekk' };

export const builderProposals: CatalogProposal[] = [
  {
    id: 'cp-kobling-fagsystem',
    level: 2,
    createdBy: 'assistant',
    forService: soknadsuttrekk,
    createdAt: '2026-10-07T09:12:00Z',
    state: 'pending',
    mapping: [
      {
        table: 'soknad',
        becomes: 'document',
        fields: ['soknad_id → ID', 'innsendt → Dato', 'belop → Omsøkt beløp', 'formal → Formål'],
      },
      {
        table: 'soker',
        becomes: 'field',
        fields: ['orgnr → Organisasjonsnummer', 'navn → Søkers navn'],
      },
      { table: 'vedlegg', becomes: 'attachment', fields: ['filnavn', 'innhold'] },
      {
        table: 'saksbehandler_notat',
        becomes: 'excluded',
        reason: 'Interne notater som kan inneholde personopplysninger',
      },
    ],
    source: {
      engine: 'postgres',
      host: 'db.fagsystem.testetaten.example.no',
      database: 'fagsystem',
      table: 'soknad',
      fields: {
        id: 'soknad_id',
        title: 'formal',
        text: ['formal', 'beskrivelse'],
        date: 'innsendt',
        metadata: ['belop'],
      },
      filter: [{ column: 'status', op: 'eq', value: 'avsluttet' }],
    },
    permissions: needs(
      ['network', 'db.fagsystem.testetaten.example.no, port 5432'],
      ['secret', 'fagsystem-lesebruker, med bare lesetilgang'],
      ['data', 'Tabellene soknad, soker og vedlegg'],
    ),
    tests: [
      { name: 'Testlesing: 50 søknader lest uten feil.', passed: true },
      { name: 'Leser ikke tabellen saksbehandler_notat.', passed: true },
    ],
  },
  {
    id: 'cp-risikoscore',
    level: 3,
    createdBy: 'assistant',
    forService: soknadsuttrekk,
    createdAt: '2026-10-07T09:14:00Z',
    state: 'pending',
    permissions: needs(
      ['network', 'Ingen'],
      ['secret', 'Ingen'],
      ['data', 'Feltene Omsøkt beløp, Organisasjonsnummer og Tidligere tilskudd'],
    ),
    tests: [{ name: 'Kontrakttest: 5 av 5 bestått.', passed: true }],
    quality:
      'Samme svar som Excel-arket på 48 av 50 søknader. De to andre skiller seg på avrunding.',
    item: block({
      id: 'risikoscore',
      kind: 'tool',
      name: 'Risikoscore for tilskudd',
      description:
        'Regner ut risiko fra omsøkt beløp, tidligere tilskudd og antall avvik, etter formlene i «Risikomodell 2026.xlsx».',
      publisher: publishers.own,
      version: '1',
      dataLocation: 'norway',
      status: 'available',
      capabilities: ['Regner ut en risikoscore', 'Kjører isolert uten nettverk'],
    }),
  },
  {
    id: 'cp-signering',
    level: 4,
    createdBy: 'assistant',
    forService: soknadsuttrekk,
    createdAt: '2026-10-07T09:16:00Z',
    state: 'sent_for_approval',
    permissions: [],
    tests: [],
    platformChange: {
      summary: 'Signering av dokumenter med virksomhetssertifikat',
      caseId: 'KI-2026-0042',
      status: 'under_review',
    },
  },
];
