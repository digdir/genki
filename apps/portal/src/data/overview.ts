import type { PlainKey } from '../i18n';
import type { PortalRight } from '../types';

export type StatusColor = 'success' | 'neutral' | 'warning' | 'info' | 'danger';

export interface ServiceSummary {
  id: string;
  name: string;
  status: 'I bruk' | 'Utkast' | 'I test' | 'Satt på pause';
  job: string;
  triggerKind: string;
  trigger: string;
  io: string;
  shared?: string;
  note?: string;
  calls: string;
  callsLabel: string;
}

export const statusColor: Record<ServiceSummary['status'], StatusColor> = {
  'I bruk': 'success',
  Utkast: 'neutral',
  'I test': 'info',
  'Satt på pause': 'warning',
};

export const serviceSummaries: ServiceSummary[] = [
  {
    id: 'rapportassistenten',
    name: 'Rapportassistenten',
    status: 'I bruk',
    job: 'Svarer på spørsmål om rapportene til Testetaten, med kilder.',
    triggerKind: 'Chat',
    trigger: 'Fra intranettet og fra KI-agenter (MCP)',
    io: 'Spørsmål som tekst → svar med kilder',
    calls: '1 284',
    callsLabel: 'spørsmål siste 7 dager',
  },
  {
    id: 'postsortering',
    name: 'Postsortering',
    status: 'I bruk',
    job: 'Leser innkommende post og foreslår saksområde, prioritet og mottaker.',
    triggerKind: 'Melding i kø',
    trigger: 'Ny melding i postkøen',
    io: 'E-post og vedlegg → strukturerte felter til arkivsystemet',
    calls: '3 906',
    callsLabel: 'meldinger siste 7 dager',
  },
  {
    id: 'motereferat',
    name: 'Møtereferat',
    status: 'I bruk',
    job: 'Gjør om opptak til tekst og lager et referat med beslutninger og oppgaver.',
    triggerKind: 'Når et dokument kommer inn',
    trigger: 'Når et opptak lastes opp i Teams-mappen',
    io: 'Lyd → transkripsjon og referat som dokument',
    shared: 'Fellestjenesten Transkribering',
    calls: '27',
    callsLabel: 'møter siste 7 dager',
  },
  {
    id: 'vedtaksutkast',
    name: 'Vedtaksutkast',
    status: 'Utkast',
    job: 'Forbereder søknader i flere steg og lager utkast til vedtak. Saksbehandler godkjenner før noe sendes.',
    triggerKind: 'Fra fagsystem',
    trigger: 'Fra saksbehandlingssystemet',
    io: 'Søknad og vedlegg → utkast til vedtak som dokument',
    shared: 'Fellestjenesten Klarspråk',
    calls: '38',
    callsLabel: 'testkjøringer siste 7 dager',
  },
  {
    id: 'nettsider-nynorsk',
    name: 'Nettsider på nynorsk',
    status: 'Satt på pause',
    job: 'Oversetter nye og endrede nettsider fra bokmål til nynorsk.',
    triggerKind: 'Etter tidsplan',
    trigger: 'Hver natt kl. 02.00, som samlet jobb',
    io: 'Nettsider → nynorsk tekst til publiseringssystemet',
    shared: 'Fellestjenesten Bokmål til nynorsk',
    note: 'Satt på pause av Ola Nordmann 2. oktober: «Venter på at innlesingen av nettsidene virker igjen.»',
    calls: '0',
    callsLabel: 'sider siste 7 dager',
  },
];

export interface IngestIssue {
  id: string;
  dataset: string;
  name: string;
  status: 'Feilet' | 'Delvis lest inn';
  color: StatusColor;
  meta: string;
  message: string;
  retryText: string;
}

export const ingestIssues: IngestIssue[] = [
  {
    id: 'web',
    dataset: 'testetaten/nettsider',
    name: 'Nettsidene til Testetaten',
    status: 'Feilet',
    color: 'danger',
    meta: 'Nettsider · startet i dag kl. 06.00',
    message:
      'Fikk ikke kontakt med testetaten.example.no (svarkode 503) etter tre forsøk. Ingen nye sider er lest inn.',
    retryText: 'Prøv igjen',
  },
  {
    id: 'tilsyn',
    dataset: 'testetaten/tilsynsrapporter-2025',
    name: 'Tilsynsrapporter 2025',
    status: 'Delvis lest inn',
    color: 'warning',
    meta: 'Opplastede filer · i går kl. 14.32',
    message:
      '12 av 148 filer kunne ikke leses fordi de er skannede PDF-er uten tekst. De andre 136 er søkbare.',
    retryText: 'Last opp på nytt',
  },
];

export const runningIngestions = 1;

export const recentChanges = [
  ['ON', 'Ola Nordmann', 'satte Nettsider på nynorsk på pause.', '2. oktober kl. 15.10', 'brand2'],
  [
    'KN',
    'Kari Nordmann',
    'la til datasettet Tilsynsrapporter 2025 i Rapportassistenten.',
    '1. oktober kl. 09.42',
    'accent',
  ],
  [
    'PH',
    'Per Hansen',
    'fikk tilgang til å teste Vedtaksutkast.',
    '30. september kl. 13.05',
    'brand3',
  ],
  [
    'DG',
    'Digdir',
    'gjorde fellestjenesten Anonymisering tilgjengelig for alle virksomheter.',
    '29. september kl. 10.00',
    'neutral',
  ],
  [
    'KN',
    'Kari Nordmann',
    'koblet Postsortering til postkøen «innkommende-post».',
    '26. september kl. 11.18',
    'accent',
  ],
] as const;

export const startSteps = [
  {
    id: 'dataset',
    title: 'overview.step1Title',
    body: 'overview.step1Body',
    cta: 'overview.step1Cta',
    href: '#/datasets/new',
    variant: 'primary',
    right: 'manage-datasets',
  },
  {
    id: 'service',
    title: 'overview.step2Title',
    body: 'overview.step2Body',
    cta: 'overview.step2Cta',
    href: '#/services/new',
    variant: 'secondary',
    right: 'manage-services',
  },
  {
    id: 'access',
    title: 'overview.step3Title',
    body: 'overview.step3Body',
    cta: 'overview.step3Cta',
    href: '#/access',
    variant: 'secondary',
    right: undefined,
  },
] as const satisfies readonly {
  id: string;
  title: PlainKey;
  body: PlainKey;
  cta: PlainKey;
  href: string;
  variant: string;
  right: PortalRight | undefined;
}[];
