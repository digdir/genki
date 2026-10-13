import type { PlainKey } from '../i18n';
import { publicApiBase } from '../public-api';

export const defaultKeyCallsPerMinute = 120;

export const API_BASE = publicApiBase;

export type ItemStatus =
  | 'Aktiv'
  | 'Feiler'
  | 'Ikke i bruk'
  | 'Bare testmiljø'
  | 'Satt på pause'
  | 'Fullført'
  | 'Feilet'
  | 'Avbrutt';

export const statusKey: Record<ItemStatus, PlainKey> = {
  Aktiv: 'integrations.statusActive',
  Feiler: 'integrations.statusFailing',
  'Ikke i bruk': 'integrations.statusUnused',
  'Bare testmiljø': 'integrations.statusTestOnly',
  'Satt på pause': 'integrations.statusPaused',
  Fullført: 'integrations.statusCompleted',
  Feilet: 'integrations.statusFailed',
  Avbrutt: 'integrations.statusCancelled',
};

export const statusColor: Record<string, 'success' | 'danger' | 'neutral' | 'info' | 'warning'> = {
  Aktiv: 'success',
  Feiler: 'danger',
  'Ikke i bruk': 'neutral',
  'Bare testmiljø': 'info',
  'Satt på pause': 'warning',
  Fullført: 'success',
  Feilet: 'danger',
  Avbrutt: 'neutral',
};

export interface IntegrationError {
  what: string;
  why: string;
  code: string;
  fix: 'scope' | 'key';
}

export const scopes: [string, PlainKey, PlainKey][] = [
  ['digdir:ki.tjenester.kall', 'integrations.scopeCallLabel', 'integrations.scopeCallDesc'],
  ['digdir:ki.datasett.les', 'integrations.scopeReadLabel', 'integrations.scopeReadDesc'],
  ['digdir:ki.datasett.skriv', 'integrations.scopeWriteLabel', 'integrations.scopeWriteDesc'],
  ['digdir:ki.forbruk.les', 'integrations.scopeUsageLabel', 'integrations.scopeUsageDesc'],
];

export interface SystemClient {
  id: string;
  name: string;
  env: string;
  client: string;
  scopes: string[];
  last: string;
  calls: string;
  services: string[];
  status: ItemStatus;
  owner: string;
  error?: IntegrationError;
}

export const exampleSystems: SystemClient[] = [
  {
    id: 'sbs',
    name: 'Saksbehandlingssystemet',
    env: 'Produksjon',
    client: '8f3c2a1e-4b7d-4e19-9a52-6d0c3e7b1f84',
    scopes: ['digdir:ki.tjenester.kall', 'digdir:ki.datasett.les'],
    last: 'I dag kl. 10.48',
    calls: '12 840 kall siste 30 dager',
    services: ['Vedtaksutkast', 'Søknadsuttrekk'],
    status: 'Aktiv',
    owner: 'Jonas Lie',
  },
  {
    id: 'cms',
    name: 'Publiseringssystemet',
    env: 'Produksjon',
    client: '2d91b7c4-0e3a-4f6b-8c15-a7e2d94f0b33',
    scopes: ['digdir:ki.tjenester.kall'],
    last: 'I dag kl. 02.03',
    calls: '31 kall siste 30 dager',
    services: ['Nettsider på nynorsk'],
    status: 'Aktiv',
    owner: 'Line Johansen',
  },
  {
    id: 'okon',
    name: 'Rapportverktøy for økonomi',
    env: 'Produksjon',
    client: 'c47e0f12-9b3d-4a8e-b6f1-05d2e8a9c7d1',
    scopes: ['digdir:ki.tjenester.kall'],
    last: 'I dag kl. 07.00 (avvist)',
    calls: '4 avviste kall i dag',
    services: [],
    status: 'Feiler',
    owner: 'Ahmed Ali',
    error: {
      what: 'Kallene blir avvist fordi klienten mangler en tillatelse.',
      why: 'Systemet prøver å hente forbrukstall, men Maskinporten-klienten har ikke tillatelsen «digdir:ki.forbruk.les». Legg den til på klienten i Samarbeidsportalen, og kryss den av her.',
      code: '403 insufficient_scope',
      fix: 'scope',
    },
  },
  {
    id: 'ark',
    name: 'Arkivsystemet',
    env: 'Testmiljø',
    client: 'f0a8e3b5-71c2-4d9e-a3f4-b8c61e2d5a07',
    scopes: ['digdir:ki.datasett.skriv'],
    last: '14. august kl. 13.22',
    calls: 'Ingen kall siste 30 dager',
    services: [],
    status: 'Ikke i bruk',
    owner: 'Ingrid Berg',
  },
];

export interface Frontend {
  id: string;
  name: string;
  env: string;
  client: string;
  redirect: string;
  scopes: string[];
  services: string[];
  last: string;
  logins: string;
  status: ItemStatus;
}

export const exampleFrontends: Frontend[] = [
  {
    id: 'intra',
    name: 'Intranettet',
    env: 'Produksjon',
    client: 'testetaten-intranett',
    redirect: 'https://intranett.testetaten.example.no/ki/callback',
    scopes: ['openid', 'digdir:ki.tjenester.kall'],
    services: ['Rapportassistenten', 'Spør veilederen'],
    last: 'I dag kl. 10.51',
    logins: '412 innlogginger siste 7 dager',
    status: 'Aktiv',
  },
  {
    id: 'sbp',
    name: 'Saksbehandlerportalen',
    env: 'Produksjon',
    client: 'testetaten-sbp',
    redirect: 'https://sak.testetaten.example.no/auth/callback',
    scopes: ['openid', 'digdir:ki.tjenester.kall'],
    services: ['Vedtaksutkast'],
    last: 'I dag kl. 09.53',
    logins: '96 innlogginger siste 7 dager',
    status: 'Aktiv',
  },
  {
    id: 'dev',
    name: 'Testside for chat',
    env: 'Testmiljø',
    client: 'testetaten-chat-test',
    redirect: 'http://localhost:5173/callback',
    scopes: ['openid', 'digdir:ki.tjenester.kall'],
    services: ['Alle tjenester i test'],
    last: '2. oktober kl. 15.10',
    logins: '7 innlogginger siste 7 dager',
    status: 'Bare testmiljø',
  },
];

export interface TriggerSource {
  id: string;
  name: string;
  kind: string;
  where: string;
  service: string;
  last: string;
  count: string;
  status: ItemStatus;
  events: [string, string, ItemStatus][];
  error?: IntegrationError;
  note?: string;
}

export const exampleTriggers: TriggerSource[] = [
  {
    id: 'mappe-sok',
    name: 'Mappen «Søknader»',
    kind: 'Når et dokument kommer inn',
    where: 'SharePoint · Tilskudd / Søknader',
    service: 'Søknadsuttrekk',
    last: 'I dag kl. 08.03: Søknad_2026_118.pdf',
    count: '46 hendelser siste 7 dager',
    status: 'Aktiv',
    events: [
      ['I dag kl. 08.03', 'Søknad_2026_118.pdf', 'Fullført'],
      ['I dag kl. 07.41', 'Søknad_2026_117.pdf', 'Fullført'],
      ['I går kl. 15.20', 'Søknad_2026_116.pdf', 'Fullført'],
    ],
  },
  {
    id: 'ko-post',
    name: 'Køen «innkommende-post»',
    kind: 'Melding i kø',
    where: 'Meldingskø · testetaten-integrasjon / innkommende-post',
    service: 'Sorter innkommende post',
    last: '1. oktober kl. 23.58',
    count: '132 meldinger venter',
    status: 'Feiler',
    events: [
      ['I dag kl. 10.45', 'Fikk ikke lese fra køen', 'Feilet'],
      ['I dag kl. 10.30', 'Fikk ikke lese fra køen', 'Feilet'],
      ['1. oktober kl. 23.58', 'Brev fra Prøvekommunen.pdf', 'Fullført'],
    ],
    error: {
      what: 'Vi får ikke lest fra køen fordi tilgangsnøkkelen er utløpt.',
      why: 'Nøkkelen dere la inn, gikk ut 2. oktober. Meldingene ligger trygt i køen, og ingenting er tapt. Lag en ny nøkkel med lesetilgang i meldingskøen og lim den inn her. Da behandles de 132 meldingene som venter.',
      code: 'AUTH_KEY_EXPIRED',
      fix: 'key',
    },
  },
  {
    id: 'mappe-lyd',
    name: 'Mappen «Opptak»',
    kind: 'Når et dokument kommer inn',
    where: 'SharePoint · Ledelse / Opptak',
    service: 'Møtereferat',
    last: 'I går kl. 15.02: Ledermøte 3. oktober.m4a',
    count: '3 hendelser siste 7 dager',
    status: 'Aktiv',
    events: [
      ['I går kl. 15.02', 'Ledermøte 3. oktober.m4a', 'Avbrutt'],
      ['29. september kl. 11.40', 'Avdelingsmøte.m4a', 'Fullført'],
    ],
  },
  {
    id: 'plan-natt',
    name: 'Hver natt kl. 02.00',
    kind: 'Etter tidsplan',
    where: 'Kjøres av plattformen',
    service: 'Nettsider på nynorsk',
    last: 'I dag kl. 02.00: feilet',
    count: 'Neste kjøring i natt kl. 02.00',
    status: 'Aktiv',
    events: [
      ['I dag kl. 02.00', 'Publiseringssystemet svarte ikke (503)', 'Feilet'],
      ['5. oktober kl. 02.00', '23 sider oversatt', 'Fullført'],
    ],
    note: 'Utløseren virker. Feilen skjedde i tjenesten. Se tidslinjen i Logg.',
  },
  {
    id: 'plan-uke',
    name: 'Hver mandag kl. 06.00',
    kind: 'Etter tidsplan',
    where: 'Kjøres av plattformen',
    service: 'Ukesoppsummering for ledelsen',
    last: '5. oktober kl. 06.00',
    count: 'Neste kjøring 12. oktober',
    status: 'Satt på pause',
    events: [['5. oktober kl. 06.00', 'Oppsummerte 38 saker', 'Fullført']],
  },
];

export const frontendServiceChoices: [string, string, string][] = [
  ['Rapportassistenten', 'Rapportassistenten', 'Svarer'],
  ['Vedtaksutkast', 'Vedtaksutkast', 'Lager utkast'],
  ['Spør veilederen', 'Spør veilederen', 'Svarer'],
];

export interface KeyExtras {
  rate: number;
  last?: string;
  created?: string;
  origin?: 'new' | 'rotated';
}

export const keyExtras: Record<string, KeyExtras> = {
  'key-cms': { rate: 60, last: 'i dag kl. 02.03', created: '14. aug av Line Johansen' },
  'key-analyse': { rate: 600, last: '2. okt kl. 15.10', created: '2. okt av Jonas Lie' },
  'key-gammel': { rate: 120, last: '3. juni', created: '2. mars av Ahmed Ali' },
};

export interface Choice {
  value: string;
  label: string;
}

export const keyServiceChoices: Choice[] = [
  { value: 'rapportassistenten__default', label: 'Rapportassistenten' },
  { value: 'vedtaksutkast__default', label: 'Vedtaksutkast' },
  { value: 'soknadsuttrekk__default', label: 'Søknadsuttrekk' },
  { value: 'nettsider-nynorsk__default', label: 'Nettsider på nynorsk' },
];

export const keyDatasetChoices: Choice[] = [
  { value: 'digdir/kudos', label: 'Kudos-rapporter' },
  { value: 'testetaten/tilsynsrapporter-2025', label: 'Tilsynsrapporter 2025' },
  { value: 'testetaten/nettsider', label: 'Nettsidene til Testetaten' },
];

export const docs: { title: PlainKey; desc: PlainKey; href: string }[] = [
  {
    title: 'integrations.docCodeTitle',
    desc: 'integrations.docCodeDesc',
    href: '#/integrations/code',
  },
  { title: 'integrations.docApiTitle', desc: 'integrations.docApiDesc', href: '#/api-reference' },
  {
    title: 'integrations.docMaskinportenTitle',
    desc: 'integrations.docMaskinportenDesc',
    href: 'https://docs.digdir.no/docs/Maskinporten/',
  },
  {
    title: 'integrations.docAnsattportenTitle',
    desc: 'integrations.docAnsattportenDesc',
    href: 'https://docs.digdir.no/docs/idporten/',
  },
  {
    title: 'integrations.docOpenaiTitle',
    desc: 'integrations.docOpenaiDesc',
    href: '#/api-reference?endpoint=oa-chat',
  },
  {
    title: 'integrations.docMcpTitle',
    desc: 'integrations.docMcpDesc',
    href: '#/api-reference?view=service',
  },
  { title: 'integrations.docLimitsTitle', desc: 'integrations.docLimitsDesc', href: '#/usage' },
  { title: 'integrations.docStatusTitle', desc: 'integrations.docStatusDesc', href: '#/status' },
];

export const callErrors: [string, PlainKey, PlainKey][] = [
  ['401', 'integCode.error401Title', 'integCode.error401Text'],
  ['403', 'integCode.error403Title', 'integCode.error403Text'],
  ['404', 'integCode.error404Title', 'integCode.error404Text'],
  ['422', 'integCode.error422Title', 'integCode.error422Text'],
  ['429', 'integCode.error429Title', 'integCode.error429Text'],
  ['503', 'integCode.error503Title', 'integCode.error503Text'],
];

export type CodeServiceType = 'svar' | 'felter' | 'dokument';

export const codeServices: { id: string; name: string; type: CodeServiceType }[] = [
  { id: 'rapportassistenten__default', name: 'Rapportassistenten', type: 'svar' },
  { id: 'soknadsuttrekk__default', name: 'Søknadsuttrekk', type: 'felter' },
  { id: 'vedtaksutkast__default', name: 'Vedtaksutkast', type: 'dokument' },
];

export const codeInput: Record<CodeServiceType, unknown> = {
  svar: {
    query: 'Hva sier evalueringer om digital veiledning siden 2020?',
    input: { tekst: 'Hva sier evalueringer om digital veiledning siden 2020?' },
    filter: { dokumenttype: ['Evaluering'], aar_fra: 2020 },
    vent: true,
  },
  felter: {
    query: 'Hent ut feltene fra søknaden.',
    input: { fil: { navn: 'Søknad_2026_118.pdf', innhold_base64: 'JVBERi0xLjcKJcfsj6IK…' } },
    vent: true,
  },
  dokument: {
    query: 'Lag et utkast til vedtak.',
    input: {
      tekst: 'Søknad om tilskudd fra Eksempel Idrettslag, 85 000 kroner.',
      filer: [{ navn: 'Søknad.pdf', url: 'https://sak.testetaten.example.no/dok/2026-1432/1' }],
    },
    saksnummer: '2026/1432',
    vent: false,
  },
};

const sources = [
  {
    tittel: 'Evaluering av digital veiledning i Testetaten',
    aar: 2023,
    side: '4–9',
    url: 'https://kudos.example.no/dok/48211',
  },
  {
    tittel: 'Sluttrapport fra veiledningsprosjektet',
    aar: 2024,
    side: '12–15',
    url: 'https://kudos.example.no/dok/51007',
  },
];

export const codeResult: Record<CodeServiceType, Record<string, unknown>> = {
  svar: {
    oppgave_id: 'opg_7f2kq9d1',
    status: 'fullfort',
    resultat: { type: 'svar', svar: 'Evalueringene peker på tre ting: …', kilder: sources },
    forbruk: { modell: 'borealis-27b', behandlet_i: 'NO', tokens_inn: 4120, tokens_ut: 350 },
    tidslinje: `${API_BASE}/tenants/999888777/tasks/opg_7f2kq9d1/timeline`,
  },
  felter: {
    oppgave_id: 'opg_3m8xw2c5',
    status: 'fullfort',
    resultat: {
      type: 'felter',
      felter: {
        sokers_navn: 'Elvebakken Musikkorps',
        organisasjonsnummer: '944556677',
        omsokt_belop: 1200000,
        mangler_vedlegg: true,
        manglende_vedlegg: ['Vedtekter'],
      },
      usikre_felter: [],
    },
    forbruk: { modell: 'qwen3.8-27b', behandlet_i: 'NO', tokens_inn: 2980, tokens_ut: 140 },
    tidslinje: `${API_BASE}/tenants/999888777/tasks/opg_3m8xw2c5/timeline`,
  },
  dokument: {
    oppgave_id: 'opg_9a1rt6k0',
    status: 'venter_paa_godkjenning',
    resultat: null,
    godkjenning: { tildelt: 'Saksbehandlere tilskudd', frist: '2026-10-08' },
    tidslinje: `${API_BASE}/tenants/999888777/tasks/opg_9a1rt6k0/timeline`,
  },
};

export const answerSources = sources;

export interface TraceTool {
  id: string;
  name: string;
  nameKey?: PlainKey;
  desc: PlainKey;
  fields: [string, PlainKey, 'url' | 'text' | 'secret', string, PlainKey | ''][];
}

export const traceTools: TraceTool[] = [
  {
    id: 'langfuse',
    name: 'Langfuse',
    desc: 'integTracing.toolLangfuseDesc',
    fields: [
      [
        'host',
        'integTracing.fieldLangfuseHost',
        'url',
        'https://langfuse.testetaten.example.no',
        '',
      ],
      ['pk', 'integTracing.fieldPublicKey', 'text', 'pk-lf-', 'integTracing.helpPublicKey'],
      ['sk', 'integTracing.fieldSecretKey', 'secret', 'sk-lf-', 'integTracing.helpSecretKey'],
    ],
  },
  {
    id: 'phoenix',
    name: 'Arize Phoenix',
    desc: 'integTracing.toolPhoenixDesc',
    fields: [
      ['endpoint', 'integTracing.fieldPhoenixHost', 'url', 'https://', ''],
      ['apikey', 'integTracing.fieldApiKey', 'secret', '', 'integTracing.helpVault'],
    ],
  },
  {
    id: 'appinsights',
    name: 'Application Insights',
    desc: 'integTracing.toolAppInsightsDesc',
    fields: [
      [
        'conn',
        'integTracing.fieldConnectionString',
        'secret',
        'InstrumentationKey=…',
        'integTracing.helpVault',
      ],
    ],
  },
  {
    id: 'otel',
    name: 'OpenTelemetry',
    nameKey: 'integTracing.toolOtelName',
    desc: 'integTracing.toolOtelDesc',
    fields: [
      ['endpoint', 'integTracing.fieldOtlpAddress', 'url', 'https://', ''],
      ['headers', 'integTracing.fieldExtraHeaders', 'secret', '', 'integTracing.helpVault'],
    ],
  },
];

export const traceServices: [string, PlainKey][] = [
  ['Rapportassistenten', 'integTracing.riskLimited'],
  ['Vedtaksutkast', 'integTracing.riskHigh'],
  ['Søknadsuttrekk', 'integTracing.riskLimited'],
  ['Nettsider på nynorsk', 'integTracing.riskMinimal'],
  ['Høringsoppsummering', 'integTracing.riskLimited'],
  ['Møtereferat', 'integTracing.riskLimited'],
];

export const highRiskServices = ['Vedtaksutkast'];
