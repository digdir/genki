import type {
  AssistantProposal,
  AssistantQuestion,
  AssistantTurn,
  JsonPatchOp,
} from '../api/assistant';
import {
  applySpec,
  type OutputField,
  type ServiceDefinition,
  type ServiceSpec,
  type SpecPatch,
} from './service-definition';
import {
  autoPublicName,
  examplesOf,
  piiCategories,
  refuseTopicsOf,
  slug,
  toolRefsOf,
  withChannel,
  withExamples,
  withGuard,
  withRefuseTopics,
  type JobId,
} from './service-form';

export { slug, type JobId };

export type ServiceStatus = 'Utkast' | 'I test' | 'I bruk' | 'Satt på pause' | 'Arkivert';

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const variantSlug = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const jobs: { id: JobId; label: string; example: string; icon: string }[] = [
  {
    id: 'answers',
    label: 'Svarer på spørsmål',
    example:
      'En saksbehandler spør hva evalueringer sier om digital veiledning, og får svar med kilder.',
    icon: 'M4 5h16v11H9l-5 4z',
  },
  {
    id: 'drafts',
    label: 'Lager utkast',
    example: 'Utkast til svar på en klage, basert på saken og malen for svarbrev.',
    icon: 'M6 3h9l3 3v15H6z M9 11h6 M9 15h6',
  },
  {
    id: 'rewrites',
    label: 'Omskriver',
    example: 'Et utgående brev skrives om til klarspråk, eller fra bokmål til nynorsk.',
    icon: 'M4 8h13l-3-3 M20 16H7l3 3',
  },
  {
    id: 'summarises',
    label: 'Oppsummerer',
    example: '214 høringssvar oppsummeres per tema, med hvem som mener hva.',
    icon: 'M4 6h16 M4 11h12 M4 16h8',
  },
  {
    id: 'extracts',
    label: 'Henter ut opplysninger',
    example: 'Navn, organisasjonsnummer og beløp hentes ut fra søknader om tilskudd.',
    icon: 'M4 5h16v14H4z M4 10h16 M10 10v9',
  },
  {
    id: 'sorts',
    label: 'Sorterer',
    example: 'Innkommende post fordeles til riktig avdeling og får en prioritet.',
    icon: 'M4 5h16l-6 7v6l-4 2v-8z',
  },
  {
    id: 'prepares',
    label: 'Forbereder saker',
    example: 'En søknad sjekkes mot regelverket i flere steg, og saksbehandler godkjenner.',
    icon: 'M5 7l2 2 3-3 M13 8h6 M5 15l2 2 3-3 M13 16h6',
  },
  {
    id: 'transcribes',
    label: 'Transkriberer',
    example: 'Et møteopptak blir til tekst og et referat med beslutninger.',
    icon: 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z M6 11a6 6 0 0 0 12 0 M12 17v3',
  },
];

export const templates: [string, JobId, string][] = [
  ['Spør dokumentene våre', 'answers', 'Spørsmål → svar med kilder'],
  ['Utkast til svarbrev', 'drafts', 'Sak og brevmal → brevutkast som dokument'],
  ['Klarspråk for utgående brev', 'rewrites', 'Brev → omskrevet brev med endringene markert'],
  ['Sorter innkommende post', 'sorts', 'E-post og vedlegg → saksområde, prioritet og mottaker'],
  ['Oppsummer høringssvar', 'summarises', 'Mappe med høringssvar → oppsummering per tema'],
  ['Møtereferat fra lydopptak', 'transcribes', 'Lydopptak → transkripsjon og referat'],
];

export const statusColor: Record<ServiceStatus, 'neutral' | 'info' | 'success' | 'warning'> = {
  Utkast: 'neutral',
  'I test': 'info',
  'I bruk': 'success',
  'Satt på pause': 'warning',
  Arkivert: 'neutral',
};

export interface ServiceRow {
  id: string;
  name: string;
  purpose: string;
  job: JobId;
  start: string[];
  status: ServiceStatus;
  usage: string;
  unit: string;
  by: string;
  when: string;
}

export const serviceRows: ServiceRow[] = [
  {
    id: 'rapportassistenten',
    name: 'Rapportassistenten',
    purpose: 'Svarer saksbehandlere på spørsmål om evalueringer, med kilder.',
    job: 'answers',
    start: ['Chat', 'Fra fagsystem'],
    status: 'I bruk',
    usage: '1 284',
    unit: 'spørsmål',
    by: 'Kari Nordmann',
    when: '1. okt.',
  },
  {
    id: 'soknadsuttrekk',
    name: 'Søknadsuttrekk',
    purpose: 'Henter ut søker, organisasjonsnummer og beløp fra søknader om tilskudd.',
    job: 'extracts',
    start: ['Når et dokument kommer inn'],
    status: 'I test',
    usage: '10',
    unit: 'prøvekjøringer',
    by: 'Kari Nordmann',
    when: 'i dag',
  },
  {
    id: 'postsortering',
    name: 'Postsortering',
    purpose: 'Foreslår saksområde, prioritet og mottaker for innkommende post.',
    job: 'sorts',
    start: ['Melding i kø'],
    status: 'I bruk',
    usage: '3 906',
    unit: 'meldinger',
    by: 'Ola Nordmann',
    when: '28. sep.',
  },
  {
    id: 'svarbrev',
    name: 'Svarbrev til innbyggere',
    purpose: 'Lager utkast til svar på henvendelser, basert på saken og brevmalen.',
    job: 'drafts',
    start: ['Fra fagsystem'],
    status: 'I bruk',
    usage: '512',
    unit: 'utkast',
    by: 'Per Hansen',
    when: '30. sep.',
  },
  {
    id: 'klarsprak-brev',
    name: 'Klarspråk i utgående brev',
    purpose: 'Skriver om brev til klarspråk og viser hva som er endret.',
    job: 'rewrites',
    start: ['Fra fagsystem'],
    status: 'I bruk',
    usage: '1 090',
    unit: 'brev',
    by: 'Kari Nordmann',
    when: '22. sep.',
  },
  {
    id: 'motereferat',
    name: 'Møtereferat',
    purpose: 'Gjør om møteopptak til tekst og referat med beslutninger og oppgaver.',
    job: 'transcribes',
    start: ['Når et dokument kommer inn', 'Chat'],
    status: 'I bruk',
    usage: '27',
    unit: 'møter',
    by: 'Ola Nordmann',
    when: '20. sep.',
  },
  {
    id: 'horingsoppsummering',
    name: 'Høringsoppsummering',
    purpose: 'Oppsummerer høringssvar per tema og viser hvem som mener hva.',
    job: 'summarises',
    start: ['Samlet jobb'],
    status: 'I test',
    usage: '1',
    unit: 'jobb med 214 svar',
    by: 'Per Hansen',
    when: '4. okt.',
  },
  {
    id: 'vedtaksutkast',
    name: 'Vedtaksutkast',
    purpose: 'Sjekker søknader mot regelverket i flere steg og lager utkast til vedtak.',
    job: 'prepares',
    start: ['Fra fagsystem'],
    status: 'Utkast',
    usage: '0',
    unit: 'kjøringer',
    by: 'Per Hansen',
    when: '30. sep.',
  },
  {
    id: 'nettsider-nynorsk',
    name: 'Nettsider på nynorsk',
    purpose: 'Set om nye og endrede nettsider til nynorsk hver natt.',
    job: 'rewrites',
    start: ['Etter tidsplan'],
    status: 'Satt på pause',
    usage: '0',
    unit: 'sider',
    by: 'Ola Nordmann',
    when: '2. okt.',
  },
];

export interface ModelChoice {
  id: string;
  name: string;
  via: string;
  where: string;
  cost: string;
  speed: string;
  ore: number;
  note: string;
  residency?: string;
}

export const models: ModelChoice[] = [
  {
    id: 'aivar/qwen3-8',
    name: 'Qwen3.8-27B',
    via: 'AIVAR',
    where: 'Norge',
    cost: 'Lav',
    speed: 'Rask',
    ore: 3.7,
    note: 'Flerspråklig. God til å hente ut felter og til agenter.',
  },
  {
    id: 'aivar/borealis-27b',
    name: 'Borealis-27B',
    via: 'AIVAR',
    where: 'Norge',
    cost: 'Lav',
    speed: 'Middels',
    ore: 5.2,
    note: 'Norsk språkmodell. Skriver godt på bokmål og nynorsk.',
  },
  {
    id: 'foundry-openai/gpt-4.1',
    name: 'GPT-4.1',
    via: 'Azure OpenAI',
    where: 'EU',
    cost: 'Høy',
    speed: 'Middels',
    ore: 14,
    note: 'Sterk på lange og sammensatte oppgaver.',
  },
];

const residencyNames: Record<string, string> = {
  norway: 'Norge',
  eu: 'EU',
  global: 'global region, kan være utenfor EU/EØS',
};

export const residencyName = (residency: string | undefined) =>
  residency ? (residencyNames[residency] ?? residency) : 'Ikke oppgitt';

export const modelFor = (id: string, residency?: string, live = false): ModelChoice => {
  const known = live ? undefined : models.find((m) => m.id === id);
  if (known) return known;
  const [via = '', name = id] = id.includes('/') ? id.split('/', 2) : ['', id];
  return {
    id,
    name,
    via: via === 'foundry-openai' ? 'Azure AI Foundry' : via || 'plattformen',
    where: residencyName(residency),
    cost: 'Ikke oppgitt',
    speed: 'Ikke oppgitt',
    ore: 0,
    note: '',
    ...(residency ? { residency } : {}),
  };
};

const QWEN = 'aivar/qwen3-8';
const BOREALIS = 'aivar/borealis-27b';
const GPT = 'foundry-openai/gpt-4.1';

export interface ToolChoice {
  id: string;
  ref: string;
  name: string;
  group: string;
  reach: string;
}

export const toolGroups = [
  'Plattformverktøy',
  'Fellestjenester fra Digdir',
  'API-er og MCP-servere',
  'Andre tjenester på plattformen',
];

export const tools: ToolChoice[] = [
  {
    id: 'search',
    ref: 'rag@1',
    name: 'Søk i datasett',
    group: 'Plattformverktøy',
    reach: 'Datasettene tjenesten har fått tilgang til.',
  },
  {
    id: 'read',
    ref: 'platform.read@1',
    name: 'Les dokument',
    group: 'Plattformverktøy',
    reach: 'Dokumenter som sendes inn ved kjøring.',
  },
  {
    id: 'compare',
    ref: 'platform.compare@1',
    name: 'Sammenlign dokumenter',
    group: 'Plattformverktøy',
    reach: 'Dokumentene som blir funnet eller sendt inn.',
  },
  {
    id: 'klarsprak',
    ref: 'digdir.klarsprak@2.3',
    name: 'Klarspråk',
    group: 'Fellestjenester fra Digdir',
    reach: 'Bare teksten som sendes til den.',
  },
  {
    id: 'nynorsk',
    ref: 'digdir.nynorsk@1.4',
    name: 'Bokmål til nynorsk',
    group: 'Fellestjenester fra Digdir',
    reach: 'Bare teksten som sendes til den.',
  },
  {
    id: 'anonymise',
    ref: 'digdir.anonymisering@1.2',
    name: 'Anonymisering',
    group: 'Fellestjenester fra Digdir',
    reach: 'Bare teksten som sendes til den.',
  },
  {
    id: 'transcribe',
    ref: 'digdir.transkribering@1.0',
    name: 'Transkribering',
    group: 'Fellestjenester fra Digdir',
    reach: 'Lydfiler som sendes til den.',
  },
  {
    id: 'brreg',
    ref: 'enhetsregisteret@1',
    name: 'Oppslag i Enhetsregisteret',
    group: 'API-er og MCP-servere',
    reach: 'Åpne data om virksomheter. Kan bare lese.',
  },
  {
    id: 'casesystem',
    ref: 'saksbehandling@3',
    name: 'Saksbehandlingssystemet',
    group: 'API-er og MCP-servere',
    reach: 'Kan lese og skrive felter i saker av typen «Tilskudd». Koblet til med OpenAPI.',
  },
  {
    id: 'lovdata',
    ref: 'lovdata@1',
    name: 'Lovdata (MCP-server, eksempel)',
    group: 'API-er og MCP-servere',
    reach: 'Lover og forskrifter. Kan bare lese.',
  },
  {
    id: 'svc-minutes',
    ref: 'testetaten.motereferat@4',
    name: 'Møtereferat',
    group: 'Andre tjenester på plattformen',
    reach: 'Det tjenesten Møtereferat har tilgang til.',
  },
];

export const prohibitedUses = [
  'Gi folk poeng ut fra oppførsel eller egenskaper (sosial poengsetting)',
  'Påvirke folk på en måte som utnytter at de er sårbare',
  'Tolke følelser hos ansatte eller elever',
  'Sortere folk etter sensitive kjennetegn ut fra biometri',
  'Forutsi om en person vil begå lovbrudd ut fra en profil',
];
export const questions: Record<JobId, string[]> = {
  extracts: [
    'Hvor kommer dokumentene fra, og i hvilket format?',
    'Hvilke felter skal hentes ut?',
    'Hvor skal resultatet?',
  ],
  answers: [
    'Hvem skal stille spørsmålene?',
    'Hvilke dokumenter skal svarene bygge på?',
    'Er det noe tjenesten ikke skal svare på?',
  ],
  drafts: [
    'Hva slags dokument skal lages?',
    'Finnes det en mal den skal følge?',
    'Hvem går gjennom utkastet før det sendes?',
  ],
  rewrites: [
    'Skal tekstene skrives om til klarspråk, nynorsk eller noe annet?',
    'Hvor kommer tekstene fra?',
    'Skal endringene markeres?',
  ],
  summarises: [
    'Hva skal oppsummeres, og omtrent hvor mange dokumenter er det?',
    'Skal oppsummeringen deles inn etter tema, avsender eller noe annet?',
    'Hvem skal lese oppsummeringen?',
  ],
  sorts: [
    'Hva kommer inn, og hvor kommer det fra?',
    'Hvilke kategorier eller mottakere finnes?',
    'Hva skal skje når tjenesten er usikker?',
  ],
  prepares: [
    'Hvilke steg går en sak gjennom i dag?',
    'Hvilket regelverk gjelder?',
    'Hvor i flyten skal en saksbehandler godkjenne?',
  ],
  transcribes: [
    'Hvor lastes opptakene opp?',
    'Skal det lages referat, eller bare tekst?',
    'Er det personopplysninger i møtene som må fjernes?',
  ],
};

const wordMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const exampleDatasetRef = 'kudos-rapporter';

const toolRef = (id: string) => tools.find((t) => t.id === id)?.ref ?? id;

const pii = { categories: piiCategories };

const field = (
  name: string,
  type: OutputField['type'],
  description: string,
  required = true,
): OutputField => ({ name, type, description, ...(required ? {} : { required: false }) });

const presets: Record<JobId, (spec: ServiceSpec) => SpecPatch> = {
  answers: (s) => ({
    output: { kind: 'answer', withSources: true },
    guardrails: { ...s.guardrails, 'require-sources': true },
    exposure: { chat: true },
    tools: [toolRef('search'), toolRef('read')],
  }),
  drafts: () => ({
    input: { accepts: ['text/plain', 'application/pdf', wordMime] },
    output: { kind: 'document', template: 'Svarbrev' },
    exposure: { rest: true },
  }),
  rewrites: () => ({ tools: [toolRef('klarsprak')], exposure: { rest: true } }),
  summarises: () => ({
    input: { accepts: ['application/pdf', wordMime] },
    output: { kind: 'document', template: 'Oppsummering' },
    batch: { enabled: true },
    tools: [toolRef('read'), toolRef('compare')],
  }),
  extracts: () => ({
    input: { accepts: ['application/pdf', wordMime] },
    output: { kind: 'fields', fields: [] },
    triggers: [{ kind: 'document-arrives', folder: 'Innboks' }],
    tools: [toolRef('read')],
  }),
  sorts: () => ({
    input: { accepts: ['text/plain', 'application/pdf', wordMime] },
    output: {
      kind: 'fields',
      fields: [
        field('Saksområde', 'list', 'Ett av saksområdene i arkivplanen.'),
        field('Prioritet', 'list', 'Høy, normal eller lav.'),
        field('Mottaker', 'string', 'Avdeling eller person som skal ha saken.'),
      ],
    },
    triggers: [{ kind: 'queue-message', queue: 'innkommende-post' }],
  }),
  prepares: (s) => ({
    input: { accepts: ['application/pdf', wordMime] },
    output: { kind: 'document', template: 'Vedtaksutkast' },
    strategy: { id: 'step-flow', version: 1, config: {} },
    guardrails: { ...s.guardrails, 'human-approval': true },
    exposure: { rest: true },
  }),
  transcribes: () => ({
    input: { accepts: ['audio/mpeg'] },
    output: { kind: 'document', template: 'Møtereferat' },
    tools: [toolRef('transcribe')],
    triggers: [{ kind: 'document-arrives', folder: 'Innboks' }],
  }),
};

export const exampleTemplate = (job: JobId, name = ''): ServiceDefinition => {
  const spec: ServiceSpec = {
    purpose: '',
    audience: ['employees'],
    variants: [
      { id: 'default', ...(autoPublicName(name) ? { publicName: autoPublicName(name) } : {}) },
    ],
    input: { accepts: ['text/plain'], ocr: false },
    output: { kind: 'answer', withSources: false },
    strategy: { id: 'single-call', version: 1, config: {} },
    knowledge: { datasets: [], runtimeDocuments: false },
    tools: [],
    model: { primary: BOREALIS, residency: 'norway' },
    guardrails: { 'pii-before-model': pii, 'pii-out-of-log': pii, language: { mode: 'nb' } },
    exposure: {},
    triggers: [],
    evaluation: { testSets: ['default'], gates: ['sourceHit >= 0.75', 'noTopicWorseThanPrevious'] },
    improve: { allow: ['instructions', 'examples', 'retrieval'] },
  };
  return applySpec(
    {
      apiVersion: 'genai/v1',
      kind: 'Service',
      metadata: { tenant: '', id: slug(name) || 'ny-tjeneste', ...(name ? { name } : {}) },
      spec,
    },
    presets[job](spec),
  );
};

const example = (
  job: JobId,
  name: string,
  edit: (spec: ServiceSpec) => SpecPatch,
): ServiceDefinition => {
  return applySpec(exampleTemplate(job, name), (d) => edit(d.spec));
};

const extraction = example('extracts', 'Søknadsuttrekk', (s) => ({
  purpose:
    'Henter ut søker, organisasjonsnummer og beløp fra søknader om tilskudd, og flagger søknader som mangler vedlegg.',
  riskClass: 'limited',
  output: {
    kind: 'fields',
    fields: [
      field('Søkers navn', 'string', 'Navnet på organisasjonen som søker.'),
      field('Organisasjonsnummer', 'string', 'Ni siffer. Sjekkes mot Enhetsregisteret.'),
      field('Omsøkt beløp', 'number', 'Beløpet det søkes om, i hele kroner.'),
      field('Mangler vedlegg', 'boolean', 'Ja hvis budsjett eller vedtekter mangler.'),
      field('Manglende vedlegg', 'list', 'Hvilke påkrevde vedlegg som mangler.', false),
    ],
  },
  strategy: {
    ...s.strategy,
    config: {
      instructions:
        'Du leser søknader om tilskudd fra frivillige organisasjoner.\n\nHent ut feltene slik de står i søknaden. Ikke gjett. Hvis et felt ikke finnes, la det stå tomt og forklar hvorfor i merknaden.\n\nPåkrevde vedlegg er budsjett og vedtekter. Et vedlegg teller bare når det er lagt ved som egen fil eller egen del av dokumentet.\n\nBeløp oppgis i hele kroner.\n\nNår du er usikker: marker feltet som usikkert i stedet for å velge en verdi.',
      examples: ['«Vi søker om kr 85 000 til nye drakter.» => Omsøkt beløp: 85000'],
    },
  },
  knowledge: { datasets: [], runtimeDocuments: true },
  tools: [toolRef('read'), toolRef('brreg'), toolRef('casesystem')],
  model: { primary: QWEN, fallback: BOREALIS, residency: 'norway' },
  triggers: [{ kind: 'document-arrives', folder: 'Søknader' }],
  variants: [{ id: 'default', publicName: 'soknadsuttrekk__default' }],
}));

const reportAssistant = example('answers', 'Rapportassistenten', (s) => ({
  purpose: 'Svarer saksbehandlere på spørsmål om evalueringer fra 2020 og nyere, med kilder.',
  riskClass: 'limited',
  strategy: {
    id: 'agent-loop',
    version: 1,
    config: {
      instructions:
        'Du hjelper saksbehandlere i staten med å finne kunnskap i evalueringer.\n\nSvar kort og presist på bokmål. Start med svaret, og forklar etterpå.\n\nBruk bare innhold fra kildene du finner. Vis alltid hvilke rapporter svaret bygger på, med årstall.\n\nNår du er usikker eller ikke finner noe: si det rett ut, og foreslå et bedre søk.\n\nIkke gi råd i enkeltsaker.',
    },
  },
  knowledge: {
    datasets: [
      {
        dataset: exampleDatasetRef,
        filters: { Dokumenttype: ['Evaluering'], År: '2020–2026' },
      },
    ],
    runtimeDocuments: false,
  },
  tools: [toolRef('search'), toolRef('read'), toolRef('compare')],
  model: { primary: BOREALIS, fallback: QWEN, residency: 'norway' },
  guardrails: {
    ...s.guardrails,
    'refuse-topics': ['Råd i enkeltsaker', 'Juridiske vurderinger'],
  },
  exposure: { chat: true, mcp: true },
  variants: [{ id: 'default', publicName: 'rapportassistenten__default' }],
}));

export const exampleDatasets: Record<string, { name: string; meta: string }> = {
  [exampleDatasetRef]: { name: 'Kudos-rapporter', meta: '48 312 dokumenter' },
  'veiledere-og-rundskriv': { name: 'Veiledere og rundskriv', meta: '612 dokumenter' },
};

export const exampleDefinitions: Record<string, ServiceDefinition> = {
  soknadsuttrekk: extraction,
  rapportassistenten: reportAssistant,
};

export interface ChangeCard {
  title: string;
  detail: string;
  section: string;
  tag?: string;
  undo?: (d: ServiceDefinition) => SpecPatch;
  apply?: { path: string; value: unknown };
}

export const cards: Record<string, ChangeCard> = {
  'c-trigger': {
    title: 'La til utløser: ny fil i mappen Søknader',
    detail: 'Tjenesten starter av seg selv når en fil legges i mappen.',
    section: 'start',
    undo: (d) => withChannel(d.spec, 'fileTrigger', false),
  },
  'c-input': {
    title: 'Satte inn: filer (PDF og Word)',
    detail: 'Søknadene kommer som filer. Tekst kan ikke sendes inn direkte.',
    section: 'io',
    undo: (d) => ({ input: { ...d.spec.input, accepts: ['text/plain'] } }),
  },
  'c-fields': {
    title: 'La til 5 felter i resultatet',
    detail: 'Søkers navn, organisasjonsnummer, omsøkt beløp, mangler vedlegg og manglende vedlegg.',
    section: 'io',
    undo: () => ({ output: { kind: 'answer', withSources: false } }),
  },
  'c-tools': {
    title: 'La til verktøy: Enhetsregisteret og saksbehandlingssystemet',
    detail: 'Organisasjonsnummeret sjekkes mot Enhetsregisteret. Resultatet skrives inn i saken.',
    section: 'tools',
    undo: (d) => ({
      tools: toolRefsOf(d.spec).filter(
        (t) => t !== toolRef('brreg') && t !== toolRef('casesystem'),
      ),
    }),
  },
  'c-how': {
    title: 'Valgte arbeidsmåte: ett steg',
    detail:
      'Hver søknad behandles for seg, og jobben er lik hver gang. Ett steg er raskere og billigere enn en agent, og lettere å etterprøve.',
    section: 'how',
  },
  'c-model': {
    title: 'Valgte modell: Qwen3.8-27B',
    detail: 'Data behandles i Norge. Omtrent 4 øre per søknad. God til å hente ut felter.',
    section: 'model',
    undo: (d) => ({ model: { ...d.spec.model, primary: BOREALIS } }),
  },
  'c-risk': {
    title: 'Foreslo risikonivå: begrenset',
    detail: 'Tjenesten forbereder saken. Saksbehandleren avgjør. Du må bekrefte risikonivået.',
    section: 'risk',
    undo: () => ({ riskClass: undefined, riskConfirmation: undefined }),
  },
  'c-pii': {
    title: 'Slo på: hold personopplysninger utenfor loggen',
    detail: 'Navn og kontaktinformasjon holdes utenfor loggen.',
    section: 'guards',
    undo: (d) => withGuard(d.spec, 'pii-out-of-log', false),
  },
  'c-batch': {
    title: 'Kjørte prøve på 10 filer',
    detail: '8 ser riktige ut, 1 mulig feil, 1 kunne ikke leses. Kostnad 33 øre.',
    section: 'test',
    tag: 'Prøve',
  },
  'c-example': {
    title: 'La til eksempel i instruksjonene',
    detail: '«kr 1,2 mill.» skal bli 1200000.',
    section: 'instructions',
    undo: (d) =>
      withExamples(
        d.spec,
        examplesOf(d.spec).filter((e) => !e.input.includes('1,2 mill')),
      ),
  },
  'c-ocr': {
    title: 'Slo på tekstgjenkjenning for skannede filer',
    detail: 'Koster omtrent 1 øre ekstra per skannet side.',
    section: 'io',
    undo: (d) => ({ input: { ...d.spec.input, ocr: false } }),
  },
  'r-know': {
    title: 'La til kunnskap: Kudos-rapporter',
    detail: 'Filter: evalueringer fra 2020 til 2026.',
    section: 'knowledge',
    undo: (d) => ({ knowledge: { ...d.spec.knowledge, datasets: [] } }),
  },
  'r-how': {
    title: 'Valgte arbeidsmåte: agent',
    detail:
      'Spørsmål om evalueringer går ofte på tvers av flere rapporter. En agent kan søke flere ganger og sammenligne funn. Det koster omtrent tre ganger så mye per spørsmål som ett søk, men gir bedre svar her.',
    section: 'how',
  },
  'r-refuse': {
    title: 'La til emne å avslå: råd i enkeltsaker',
    detail: 'Tjenesten sier fra og forklarer hvorfor.',
    section: 'guards',
    undo: (d) =>
      withRefuseTopics(
        d.spec,
        refuseTopicsOf(d.spec).filter((r) => r !== 'Råd i enkeltsaker'),
      ),
  },
  'r-src': {
    title: 'Slo på: krev kilder i svaret',
    detail: 'Uten støtte i kildene sier tjenesten at den ikke vet.',
    section: 'guards',
    undo: (d) => ({
      ...withGuard(d.spec, 'require-sources', false),
      output: { ...d.spec.output, withSources: false },
    }),
  },
  'r-start': {
    title: 'La til start: chat og MCP',
    detail:
      'Saksbehandlere bruker chatten. Agenter kan kalle tjenesten som rapportassistenten__default.',
    section: 'start',
    undo: (d) => ({ exposure: { ...d.spec.exposure, chat: false, mcp: false } }),
  },
};
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  cards?: string[];
  actions?: [string, string][];
  turn?: string;
}

export const exampleMessages: Record<string, ChatMessage[]> = {
  soknadsuttrekk: [
    {
      role: 'user',
      text: 'Hver gang det kommer en søknad, vil jeg hente ut navn, organisasjonsnummer og beløp, og flagge søknader som mangler vedlegg.',
    },
    {
      role: 'assistant',
      text: 'Det er en jobb der tjenesten henter ut opplysninger fra dokumenter. Tre spørsmål før jeg setter det opp:\n1. Hvor kommer søknadene inn, og i hvilket format?\n2. Hvilke vedlegg er påkrevd?\n3. Hvor skal resultatet?',
    },
    {
      role: 'user',
      text: 'De kommer som PDF i mappen Søknader. Budsjett og vedtekter er påkrevd. Resultatet skal inn i saksbehandlingssystemet.',
    },
    {
      role: 'assistant',
      text: 'Da foreslår jeg dette oppsettet. Du kan endre alt i oppsettet til høyre.',
      cards: ['c-trigger', 'c-input', 'c-fields', 'c-tools', 'c-how', 'c-model'],
    },
    {
      role: 'assistant',
      text: 'Søknadene inneholder navn og kontaktinformasjon, så personopplysninger holdes utenfor loggen. Jeg foreslår risikonivået begrenset, fordi tjenesten forbereder og saksbehandleren avgjør. Du må bekrefte risikonivået under Formål og målgruppe. Vil du at jeg kjører en prøve på 10 søknader fra i fjor?',
      cards: ['c-risk', 'c-pii'],
    },
    { role: 'user', text: 'Ja, kjør prøven.' },
    {
      role: 'assistant',
      text: 'Prøven er ferdig. 8 av 10 ser riktige ut.\n\nSøknad_2025_007: beløpet står som «kr 1,2 mill.» i en tabell og ble lest som 1 200 kroner.\nSøknad_2025_009: filen er skannet uten tekst, så den kunne ikke leses.\n\nJeg foreslår to endringer:',
      cards: ['c-batch'],
      actions: [
        ['a-example', 'Legg til eksempel om forkortede beløp'],
        ['a-ocr', 'Slå på tekstgjenkjenning'],
      ],
    },
  ],
  rapportassistenten: [
    {
      role: 'user',
      text: 'Saksbehandlere skal kunne spørre om evalueringer fra 2020 og nyere, med kilder.',
    },
    {
      role: 'assistant',
      text: 'Skal de spørre i Testetatens egne evalueringer, eller i alle evalueringer i Kudos?',
    },
    { role: 'user', text: 'Alle i Kudos. Og den må ikke gi råd i enkeltsaker.' },
    {
      role: 'assistant',
      text: 'Da foreslår jeg dette:',
      cards: ['r-know', 'r-how', 'r-refuse', 'r-src', 'r-start'],
    },
    {
      role: 'assistant',
      text: 'Vil du prøve noen spørsmål? Testen ligger under fanen Test.',
      actions: [['a-gotest', 'Åpne testen']],
    },
  ],
};

export interface VersionRow {
  n: number;
  when: string;
  who: string;
  state: 'I test' | 'I bruk' | 'Tidligere';
  score: string;
  diff: string[];
}

export const exampleVersions: Record<string, VersionRow[]> = {
  soknadsuttrekk: [
    {
      n: 1,
      when: '3. oktober kl. 14.20',
      who: 'Kari Nordmann',
      state: 'I test',
      score: '7 av 10 riktige på prøven',
      diff: [
        'Byttet modell fra Borealis-27B til Qwen3.8-27B',
        'La til Enhetsregisteret og saksbehandlingssystemet som verktøy',
      ],
    },
  ],
  rapportassistenten: [
    {
      n: 3,
      when: '1. oktober kl. 09.42',
      who: 'Kari Nordmann',
      state: 'I bruk',
      score: 'Testsett: 46 av 50 (92 %)',
      diff: [],
    },
    {
      n: 2,
      when: '24. september kl. 14.05',
      who: 'Kari Nordmann',
      state: 'Tidligere',
      score: 'Testsett: 43 av 50 (86 %)',
      diff: ['Byttet modell fra Qwen3.8-27B til Borealis-27B'],
    },
    {
      n: 1,
      when: '19. august kl. 11.02',
      who: 'Kari Nordmann',
      state: 'Tidligere',
      score: 'Ingen testsett',
      diff: ['La til krav om kilder', 'La til MCP som kanal'],
    },
  ],
};

export const exampleUpdates: Record<
  string,
  { id: string; name: string; kind: string; score: string }[]
> = {
  rapportassistenten: [
    {
      id: 'borealis',
      name: 'Borealis-27B 2.1 → 2.2',
      kind: 'Modell, AIVAR, Norge',
      score: '0,92 → 0,93',
    },
  ],
  'klarsprak-brev': [
    {
      id: 'klarsprak',
      name: 'digdir.klarsprak@2.3 → @2.4',
      kind: 'Verktøy (fellestjeneste)',
      score: '0,81 → 0,82',
    },
  ],
};

export interface BatchSnapshot {
  ocr: boolean;
  example: boolean;
  model: string;
  v1?: boolean;
}

export interface BatchRow {
  id: string;
  file: string;
  name: string;
  org: string;
  amount: string;
  missing: string;
  ok: boolean;
  status: string;
  color: 'success' | 'warning' | 'danger';
  note: string;
  ore: number;
  scanned: boolean;
  attachments: string;
  summary: string;
}

const batchFiles: [string, string, string, string, string][] = [
  ['001', 'Eksempel Idrettslag', '912 345 678', '85 000 kr', ''],
  ['002', 'Fjellvegen Velforening', '998 877 665', '40 000 kr', 'vedtekter'],
  ['003', 'Nordlys Kulturforum', '921 000 111', '250 000 kr', ''],
  ['004', 'Bygdekvinnelaget i Eksempelvik', '987 654 321', '12 500 kr', 'budsjett'],
  ['005', 'Testby Sjakklubb', '930 112 233', '18 000 kr', ''],
  ['006', 'Ungdomsrådet i Prøvdal', '915 443 221', '60 000 kr', ''],
  ['007', 'Elvebakken Musikkorps', '944 556 677', '1 200 000 kr', ''],
  ['008', 'Havbris Frivilligsentral', '976 543 210', '300 000 kr', ''],
  ['009', 'Solbakken Grendelag', '919 191 919', '45 000 kr', 'vedtekter'],
  ['010', 'Solsiden Seniorforening', '911 222 333', '22 000 kr', 'vedtekter'],
];

export const batchRows = (snap: BatchSnapshot): BatchRow[] => {
  const m = models.find((x) => x.id === snap.model) ?? (models[0] as ModelChoice);
  return batchFiles.map(([n, name, org, amount, missing]) => {
    const r: BatchRow = {
      id: n,
      file: `Søknad_2025_${n}.pdf`,
      name,
      org,
      amount,
      missing,
      ok: true,
      status: 'Ser riktig ut',
      color: 'success',
      note: '',
      ore: m.ore,
      scanned: n === '009',
      attachments: '',
      summary: '',
    };
    if (n === '007' && !snap.example && snap.model !== GPT) {
      Object.assign(r, {
        amount: '1 200 kr',
        ok: false,
        status: 'Mulig feil',
        color: 'warning',
        note: 'Beløpet står som «kr 1,2 mill.» og ble lest som 1 200 kr.',
      });
    }
    if (n === '004' && snap.v1) {
      Object.assign(r, {
        missing: '',
        ok: false,
        status: 'Mulig feil',
        color: 'warning',
        note: 'Manglende budsjett ble ikke flagget.',
      });
    }
    if (n === '009') {
      if (!snap.ocr)
        Object.assign(r, {
          name: '–',
          org: '–',
          amount: '–',
          missing: '',
          ok: false,
          status: 'Kunne ikke leses',
          color: 'danger',
          note: 'Skannet PDF uten tekst.',
          ore: 0.6,
        });
      else r.ore = m.ore + 1;
    }
    r.attachments =
      r.status === 'Kunne ikke leses' ? '–' : r.missing ? `Mangler ${r.missing}` : 'Alle vedlegg';
    r.summary = `${r.name} · ${r.org} · ${r.amount}`;
    return r;
  });
};

export const formatOre = (o: number) => `${o.toFixed(1).replace('.', ',')} øre`;

export const assistantStates = [
  'normal',
  'utilgjengelig',
  'avslatt',
  'budsjett-brukt',
  'strommer',
  'sporsmal',
  'validering-feilet',
  'policy-avvist',
  'forbedre-instruksjoner',
  'testforslag',
  'api-kall',
  'plattform-1',
  'plattform-2',
  'plattform-3',
  'plattform-3-uten-rett',
  'plattform-4',
  'plattform-4-avslatt',
] as const;

export type AssistantState = (typeof assistantStates)[number];

export const assistantUserMessages: Partial<Record<AssistantState, string>> = {
  strommer: 'Hvordan finner tjenesten omsøkt beløp?',
  sporsmal: 'Lag en tjeneste som sorterer klager.',
  'validering-feilet': 'Sett tidsavbruddet for Enhetsregisteret til 5 minutter.',
  'policy-avvist': 'Bytt til GPT-5, den er best på uttrekk.',
  'api-kall': 'Legg til sjekk av om søkeren er slettet i Enhetsregisteret.',
  'plattform-1': 'Kan tjenesten sjekke at søkeren ikke er slettet i Enhetsregisteret?',
  'plattform-2': 'Hent opplysningene fra fagsystemets database i stedet for fra PDF-ene.',
  'plattform-3': 'Kan tjenesten regne ut risikoscore etter modellen vår i Excel-arket?',
  'plattform-3-uten-rett': 'Kan tjenesten regne ut risikoscore etter modellen vår i Excel-arket?',
  'plattform-4': 'Tjenesten skal signere vedtakene med virksomhetssertifikatet vårt.',
  'plattform-4-avslatt': 'Tjenesten skal signere vedtakene med virksomhetssertifikatet vårt.',
};

export const assistantLevels = [
  'Det kan settes opp med det som finnes',
  'Ny kobling foreslått',
  'Ny byggekloss foreslått',
  'Krever endring i plattformen',
] as const;

type Pointer = Record<string, unknown> | unknown[];

export const applyJsonPatch = <T>(doc: T, ops: JsonPatchOp[]): T => {
  const out = structuredClone(doc);
  for (const op of ops) {
    const keys = op.path
      .split('/')
      .slice(1)
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    const last = keys.pop();
    if (last === undefined) continue;
    let target = out as Pointer;
    for (const key of keys) {
      const parent = target as Record<string, unknown>;
      parent[key] ??= {};
      target = parent[key] as Pointer;
    }
    if (Array.isArray(target)) {
      const index = last === '-' ? target.length : Number(last);
      if (op.op === 'remove') target.splice(index, 1);
      else if (op.op === 'add') target.splice(index, 0, op.value);
      else target[index] = op.value;
    } else if (op.op === 'remove') Reflect.deleteProperty(target, last);
    else target[last] = op.value;
  }
  return out;
};

const draftInstructions = (draft: Record<string, unknown>) => {
  const spec = asRecord(draft.spec);
  const instructions = asRecord(asRecord(spec.strategy).config).instructions;
  return typeof instructions === 'string' ? instructions : '';
};

const exampleUsage = { tokens: 2140, budgetLeftToday: 118400, dailyBudget: 200000 };

const changeProposal = (
  draft: Record<string, unknown>,
  id: string,
  title: string,
  detail: string,
  section: string,
  patch: JsonPatchOp[],
): AssistantProposal => ({
  id,
  level: 1,
  kind: 'change',
  title,
  detail,
  section,
  patch,
  after: applyJsonPatch(draft, patch),
  validation: { ok: true },
  requiresApproval: false,
  appliedToDraft: false,
});

const instructionLine = (
  draft: Record<string, unknown>,
  id: string,
  title: string,
  detail: string,
  line: string,
) => {
  const current = draftInstructions(draft);
  return changeProposal(draft, id, title, detail, 'instructions', [
    {
      op: 'add',
      path: '/spec/strategy/config/instructions',
      value: current ? `${current}\n\n${line}` : line,
    },
  ]);
};

export const exampleStreamText =
  'Tjenesten finner omsøkt beløp i tre trinn.\n\nFørst ser den etter feltet «Omsøkt beløp» i søknadsskjemaet. Finnes det, brukes det.\n\nMangler feltet, leser den budsjettet og bruker summen av postene det søkes om. Da merkes resultatet som usikkert, så saksbehandler ser det.\n\nTil slutt sjekker den at beløpet ikke er større enn rammen for ordningen. Er det større, flagges søknaden.';

const improvedExtraction =
  'Du hjelper Testetaten med å hente opplysninger fra søknader om tilskudd.\n\nHent ut disse feltene: søkers navn, organisasjonsnummer, omsøkt beløp, formål og frist.\n\nNår et felt mangler:\n- La feltet stå tomt. Ikke gjett.\n- Står beløpet bare i budsjettet, bruk summen og merk feltet som usikkert.\n\nSkannede sider leses med tekstgjenkjenning. Er teksten uleselig, merk søknaden for manuell kontroll.\n\nSkriv aldri personnummer eller kontonummer i resultatet.';

export const exampleQuestions: AssistantQuestion[] = [
  {
    id: 'source',
    label: 'Hvor kommer klagene inn?',
    options: ['E-post til postmottaket', 'Skjema på nettsiden', 'Saksbehandlingssystemet'],
    allowOther: true,
  },
  {
    id: 'after',
    label: 'Hva skal skje med en klage etterpå?',
    options: ['Foreslå saksbehandler', 'Opprette sak', 'Bare sortere'],
    allowOther: true,
  },
  {
    id: 'approval',
    label: 'Skal en person godkjenne før noe sendes videre?',
    options: ['Ja, alltid', 'Bare ved høy prioritet', 'Nei'],
    allowOther: true,
  },
];

const turn = (
  turnId: string,
  message: string,
  extra: Partial<AssistantTurn> = {},
): AssistantTurn => ({
  turnId,
  status: 'completed',
  message,
  proposals: [],
  usage: exampleUsage,
  ...extra,
});

const ladderIntro = [
  'Det kan settes opp med det som finnes. Enhetsregisteret er allerede et verktøy i tjenesten.',
  'Ingen byggekloss leser fra fagsystemets database i dag. Det minste steget som løser det, er en ny kobling. Den er laget, men ikke aktiv.',
  'Ingen byggekloss regner ut risikoscore etter deres modell, og en kobling er ikke nok. Jeg har laget en ny byggekloss. Den kjører isolert og er ikke aktiv.',
  'Dette kan ikke løses med en kobling eller en byggekloss. Signering krever en endring i plattformen, så jeg har sendt et forslag til Digdir.',
];

const registryCheck = (draft: Record<string, unknown>, id: string, detail: string) =>
  instructionLine(
    draft,
    id,
    'La til sjekk av status i Enhetsregisteret',
    detail,
    'Slå opp søkeren i Enhetsregisteret. Flagg søknader fra virksomheter som er slettet eller under avvikling.',
  );

const platformTurn = (
  level: 1 | 2 | 3 | 4,
  draft: Record<string, unknown>,
  rejected = false,
): AssistantTurn => {
  const intro = ladderIntro[level - 1] ?? '';
  if (level === 1)
    return turn('trn_p1', intro, {
      proposals: [
        registryCheck(
          draft,
          'prp_p1',
          'Bruker verktøyet Oppslag i Enhetsregisteret. Søknader fra slettede virksomheter flagges.',
        ),
      ],
    });
  if (level === 2)
    return turn('trn_p2', intro, {
      proposals: [
        {
          id: 'prp_p2',
          level: 2,
          kind: 'connector',
          title: 'Kobling til fagsystemets database',
          detail:
            'Jeg har lest tabellene og foreslår hvilke som blir dokumenter og felt. Koblingen leser bare. Den brukes av denne tjenesten og ingen andre.',
          validation: { ok: true },
          requiresApproval: true,
          appliedToDraft: false,
          storedProposalId: 'cp-kobling-fagsystem',
          mapping: [
            {
              table: 'soknad',
              becomes: 'document',
              fields: [
                'soknad_id → ID',
                'innsendt → Dato',
                'belop → Omsøkt beløp',
                'formal → Formål',
              ],
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
          permissions: [
            { type: 'Nettverk', value: 'db.fagsystem.testetaten.example.no, port 5432' },
            { type: 'Hemmelighet', value: 'fagsystem-lesebruker, med bare lesetilgang' },
            { type: 'Data', value: 'Tabellene soknad, soker og vedlegg' },
          ],
          tests: [
            { name: 'Testlesing: 50 søknader lest uten feil.', passed: true },
            { name: 'Leser ikke tabellen saksbehandler_notat.', passed: true },
          ],
        },
      ],
    });
  if (level === 3)
    return turn('trn_p3', intro, {
      proposals: [
        {
          id: 'prp_p3',
          level: 3,
          kind: 'building_block',
          title: 'Byggekloss: Risikoscore for tilskudd',
          detail:
            'Regner ut risiko fra omsøkt beløp, tidligere tilskudd og antall avvik, etter formlene i «Risikomodell 2026.xlsx». Kjører isolert uten nettverk.',
          validation: { ok: true },
          requiresApproval: true,
          appliedToDraft: false,
          storedProposalId: 'cp-risikoscore',
          permissions: [
            { type: 'Nettverk', value: 'Ingen' },
            { type: 'Hemmeligheter', value: 'Ingen' },
            {
              type: 'Data',
              value: 'Feltene Omsøkt beløp, Organisasjonsnummer og Tidligere tilskudd',
            },
          ],
          tests: [{ name: 'Kontrakttest: 5 av 5 bestått.', passed: true }],
          quality:
            'Samme svar som Excel-arket på 48 av 50 søknader. De to andre skiller seg på avrunding.',
        },
      ],
    });
  return turn('trn_p4', intro, {
    proposals: [
      {
        id: 'prp_p4',
        level: 4,
        kind: 'platform_change',
        title: 'Forslag til Digdir: signering av dokumenter',
        detail:
          'En ny type byggekloss, «Signering», som signerer med virksomhetssertifikat fra Buypass eller Commfides. En person godkjenner hver signering. Forslaget er sendt med beskrivelsen av behovet fra denne samtalen.',
        validation: { ok: true },
        requiresApproval: true,
        appliedToDraft: false,
        storedProposalId: 'cp-signering',
        platformChange: {
          summary: 'Signering av dokumenter med virksomhetssertifikat',
          caseId: 'KI-2026-0042',
          status: rejected ? 'rejected' : 'under_review',
          ...(rejected
            ? {
                rejectionReason:
                  'Signering hører hjemme i saksbehandlingssystemene, ikke i KI-plattformen. Se veilederen for elektronisk signering.',
              }
            : {}),
        },
      },
      instructionLine(
        draft,
        'prp_p4_alt',
        'Satte ut til PDF levert til saksbehandlingssystemet',
        'Tjenesten kan lage vedtaket som PDF, og saksbehandler signerer det i saksbehandlingssystemet.',
        'Lag vedtaket som PDF og lever det til saksbehandlingssystemet. Saksbehandler signerer der.',
      ),
    ],
  });
};

export const exampleAssistantTurn = (
  state: AssistantState,
  draft: Record<string, unknown>,
): AssistantTurn | undefined => {
  if (state === 'strommer') return turn('trn_s1', exampleStreamText);
  if (state === 'sporsmal')
    return turn(
      'trn_q1',
      'Før jeg setter opp tjenesten, trenger jeg svar på tre ting. Velg et svar, eller skriv ditt eget.',
      { questions: exampleQuestions },
    );
  if (state === 'validering-feilet')
    return turn(
      'trn_v1',
      'Jeg prøvde å sette tidsavbruddet til 300 sekunder, men plattformen avviste endringen. Jeg har satt det til 60 sekunder, som er det høyeste som er tillatt. Trenger dere mer, må Digdir endre grensen.',
      {
        rejected: [
          {
            attempted: 'tools.enhetsregisteret.timeout_s = 300',
            reason:
              'Største tillatte verdi er 60 sekunder. Grensen står i innstillingsskjemaet til Oppslag i Enhetsregisteret (maximum: 60).',
            code: 'VALIDATION_MAXIMUM',
          },
        ],
        proposals: [
          instructionLine(
            draft,
            'prp_v1',
            'Satte tidsavbrudd for Enhetsregisteret til 60 sekunder',
            'Var 10 sekunder.',
            'Vent høyst 60 sekunder på svar fra Enhetsregisteret.',
          ),
        ],
      },
    );
  if (state === 'policy-avvist')
    return turn(
      'trn_r1',
      'Jeg kan ikke bytte til GPT-5. GPT-5 behandler data i USA. Endringen er ikke gjort.',
      {
        status: 'refused',
        policy: {
          rule: 'Data skal behandles i Norge eller EU/EØS. Det står i plattforminnstillingen «Tillatt datalagring».',
          ownedBy:
            'Digdir eier innstillingen og kan endre den. Administratorer hos dere kan be Digdir om et unntak.',
          link: '#/settings',
          alternative: 'Prøv Qwen3.8-27B i stedet.',
        },
      },
    );
  if (state === 'api-kall')
    return turn(
      'trn_81f2',
      'Jeg har laget en sjekk av status i Enhetsregisteret. Søknader fra virksomheter som er slettet eller under avvikling, blir flagget.',
      { proposals: [registryCheck(draft, 'prp_3k1', 'Flagger slettet og under avvikling.')] },
    );
  if (state === 'forbedre-instruksjoner') {
    const before = draftInstructions(draft);
    const meta = asRecord(draft.metadata);
    const after =
      meta.id === 'soknadsuttrekk'
        ? improvedExtraction
        : `${before.trim()}\n\nNår du er usikker, si det. Ikke gjett.`;
    return turn('trn_i1', 'Her er et forslag til bedre instruksjoner.', {
      improvedInstructions: {
        before,
        after,
        changes:
          meta.id === 'soknadsuttrekk'
            ? [
                'Skiller mellom feltene og sier hva tjenesten gjør når et felt mangler',
                'Sier hva som skjer med skannede sider',
                'Tar bort en setning som gjentok seg',
              ]
            : ['Sier hva tjenesten gjør når den er usikker'],
      },
    });
  }
  if (state === 'testforslag') {
    const extraction = asRecord(draft.metadata).id === 'soknadsuttrekk';
    const cases = extraction
      ? [
          [
            'Søknad med beløp bare i budsjettet',
            'Omsøkt beløp hentes fra budsjettet og merkes usikkert',
            'Søknad_2025_031.pdf',
          ],
          [
            'Skannet søknad uten tekstlag',
            'Tekstgjenkjenning brukes, og alle feltene fylles ut',
            'Søknad_2025_007.pdf',
          ],
          [
            'Søknad fra forening uten organisasjonsnummer',
            'Feltet står tomt, og søknaden flagges',
            'Søknad_2025_044.pdf',
          ],
          ['Søknad på nynorsk', 'Felta blir henta ut som vanleg', 'Søknad_2025_052.pdf'],
        ]
      : [
          ['Et spørsmål tjenesten skal kunne svare på', 'Et svar med kilder', ''],
          ['Et spørsmål utenfor formålet', 'Tjenesten sier at den ikke kan svare', ''],
        ];
    return turn(
      'trn_t1',
      extraction
        ? 'Laget ut fra formålet med tjenesten og et utvalg på 20 søknader fra datasettet. Godta de som er riktige. De blir lagt i testsettet «Søknader 2025».'
        : 'Laget ut fra formålet med tjenesten. Godta de som er riktige. De blir lagt i testsettet for tjenesten.',
      {
        testCases: cases.map(([input = '', expected = '', source = ''], i) => ({
          id: `tc-${i + 1}`,
          input,
          expected,
          ...(source ? { source } : {}),
        })),
      },
    );
  }
  if (state === 'plattform-1') return platformTurn(1, draft);
  if (state === 'plattform-2') return platformTurn(2, draft);
  if (state === 'plattform-3' || state === 'plattform-3-uten-rett') return platformTurn(3, draft);
  if (state === 'plattform-4') return platformTurn(4, draft);
  if (state === 'plattform-4-avslatt') return platformTurn(4, draft, true);
  if (state === 'utilgjengelig')
    return turn('trn_u1', 'Assistenten svarer ikke akkurat nå.', {
      status: 'unavailable',
      reason: 'model_failed',
    });
  if (state === 'budsjett-brukt')
    return turn('trn_b1', 'Assistentens budsjett for i dag er brukt opp.', {
      status: 'budget_exhausted',
      usage: { tokens: 0, budgetLeftToday: 0, dailyBudget: 200000 },
    });
  return undefined;
};

export const answeredTurn = (
  draft: Record<string, unknown>,
  answers: Record<string, string>,
): AssistantTurn => {
  const [source = '', after = '', approval = ''] = exampleQuestions.map((q) => answers[q.id] ?? '');
  return turn(
    'trn_q2',
    `Takk. Jeg setter opp tjenesten slik: klagene kommer fra «${source.toLowerCase()}», tjenesten skal «${after.toLowerCase()}», og godkjenning: «${approval.toLowerCase()}». Endringen er lagt i utkastet, og du kan angre den.`,
    {
      proposals: [
        changeProposal(
          draft,
          'prp_q2',
          'Satte start, inn og ut for klagesortering',
          `Inn: ${source}. Ut: ${after}.`,
          'purpose',
          [
            {
              op: 'replace',
              path: '/spec/purpose',
              value: `Sorterer klager som kommer inn via ${source.toLowerCase()}. ${after}.`,
            },
          ],
        ),
      ],
    },
  );
};

export const chatTurn = (draft: Record<string, unknown>, message: string): AssistantTurn => {
  const t = message.toLowerCase();
  const spec = (draft as Partial<ServiceDefinition>).spec;
  const m = modelFor(spec?.model?.primary ?? '', spec?.model?.residency);
  if (/kost|pris|koste|dyr/.test(t)) {
    const agent = spec?.strategy?.id === 'agent-loop';
    const ore = m.ore * (agent ? 3 : 1);
    return turn(
      'trn_c1',
      `Med ${m.name} og ${agent ? 'en agent' : 'ett steg'} koster en kjøring omtrent ${formatOre(ore)}, altså rundt ${Math.round(ore * 10)} kr per 1000 kjøringer. Data behandles i ${m.where}.\n\nGPT-4.1 i Azure ville kostet omtrent fire ganger så mye, og data behandles da i EU, ikke i Norge.`,
    );
  }
  if (/kjør|prøv|test/.test(t))
    return turn(
      'trn_c2',
      'Åpne fanen Test og prøv tjenesten der. Prøven bruker utkastet, ikke versjonen som er i bruk.',
    );
  if (/personvern|strengere|anonym/.test(t)) {
    const ref = tools.find((x) => x.id === 'anonymise')?.ref ?? 'anonymise';
    return turn(
      'trn_c3',
      'Jeg har lagt til anonymisering før modellkallet. Personopplysninger er allerede filtrert bort fra loggen.',
      {
        proposals: [
          changeProposal(
            draft,
            'prp_c3',
            'La til verktøy: Anonymisering',
            'Navn og kontaktinformasjon erstattes før teksten sendes til modellen. Kan gjøre resultatet litt mindre presist.',
            'tools',
            [{ op: 'add', path: '/spec/tools/-', value: ref }],
          ),
        ],
      },
    );
  }
  const text = message.trim();
  return turn(
    'trn_c4',
    'Notert. Jeg har lagt det til i instruksjonene. Vil du at jeg tester det?',
    {
      proposals: [
        instructionLine(
          draft,
          'prp_c4',
          'Oppdaterte instruksjonene',
          `La til: «${text.slice(0, 90)}${text.length > 90 ? '…' : ''}»`,
          text,
        ),
      ],
    },
  );
};
