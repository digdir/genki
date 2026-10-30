import type { PlainKey } from '../i18n';
import type {
  TaskRow,
  TaskStatus,
  TaskTimeline,
  TimelineBlock,
  TimelineStep,
  TimelineStepState,
} from '../types';

type CompactBlock =
  | { kind: 'quote' | 'error' | 'note'; text: string; label?: string }
  | { kind: 'kv' | 'fields'; rows: [string, string][]; label?: string }
  | { kind: 'tags'; items: string[]; label?: string }
  | { kind: 'list'; items: [string, string][]; label?: string }
  | { kind: 'answer'; text: string; sources: string[] }
  | { kind: 'doc'; title: string; body: string };

interface CompactStep {
  type: string;
  title: string;
  summary: string;
  t: number | null;
  dur?: number;
  tokens?: number;
  state?: TimelineStepState;
  raw?: string;
  blocks?: CompactBlock[];
  depth?: number;
}

const toBlock = (b: CompactBlock): TimelineBlock =>
  b.kind === 'list' ? { kind: 'list', ...(b.label ? { label: b.label } : {}), rows: b.items } : b;

export const toSteps = (steps: CompactStep[], prefix: string): TimelineStep[] =>
  steps.map((s, i) => ({
    id: `${prefix}-s${i + 1}`,
    type: s.type,
    title: s.title,
    summary: s.summary,
    at: s.t ?? -1,
    ...(s.dur !== undefined ? { durationSeconds: s.dur } : {}),
    ...(s.tokens !== undefined ? { tokens: s.tokens } : {}),
    ...(s.state ? { state: s.state } : {}),
    ...(s.raw ? { description: s.raw } : {}),
    ...(s.depth ? { depth: s.depth } : {}),
    blocks: (s.blocks ?? []).map(toBlock),
  }));

const at = (daysAgo: number, hh: number, mm: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
};

export const serviceNames: Record<string, string> = {
  rapportassistenten: 'Rapportassistenten',
  vedtaksutkast: 'Vedtaksutkast',
  soknadsuttrekk: 'Søknadsuttrekk',
  'nettsider-nynorsk': 'Nettsider på nynorsk',
  horingsoppsummering: 'Høringsoppsummering',
  motereferat: 'Møtereferat',
  postsortering: 'Sorter innkommende post',
  maloppnaelse: 'Vurdering av måloppnåelse',
};

export type BatchItemStatus = 'Fullført' | 'Feilet' | 'Kjører' | 'Venter' | 'Avbrutt';

export const batchStatusKeys: Record<BatchItemStatus, PlainKey> = {
  Fullført: 'taskStatus.completed',
  Feilet: 'taskStatus.failed',
  Kjører: 'taskStatus.running',
  Venter: 'logBatch.waiting',
  Avbrutt: 'taskStatus.cancelled',
};

export const batchStatusColors: Record<
  BatchItemStatus,
  'info' | 'warning' | 'success' | 'danger' | 'neutral'
> = {
  Fullført: 'success',
  Feilet: 'danger',
  Kjører: 'info',
  Venter: 'neutral',
  Avbrutt: 'neutral',
};

export const triggerKinds = [
  'Chat',
  'Fra fagsystem',
  'Når et dokument kommer inn',
  'Melding i kø',
  'Etter tidsplan',
  'Samlet jobb',
] as const;

export const triggerKindKeys: Record<(typeof triggerKinds)[number], PlainKey> = {
  Chat: 'logRuns.triggerChat',
  'Fra fagsystem': 'logRuns.triggerSystem',
  'Når et dokument kommer inn': 'logRuns.triggerDocument',
  'Melding i kø': 'logRuns.triggerQueue',
  'Etter tidsplan': 'logRuns.triggerSchedule',
  'Samlet jobb': 'logRuns.triggerBatch',
};

export interface TraceLine {
  note: string;
  link?: string;
}

export interface RunExtras {
  triggerKind: string;
  triggerDetail: string;
  traces: TraceLine[];
  batch?: boolean;
  revealedName?: string;
  afterApproval?: AfterApproval;
}

export interface AfterApproval {
  approvedTitle: string;
  approvedSummary: string;
  approvedRows: [string, string][];
  approvedFlash: string;
  rejectedFlash: string;
  totalTime: string;
}

export const runExtras: Record<string, RunExtras> = {
  t1: {
    triggerKind: 'Chat',
    triggerDetail: 'Chat · Ansatt i Testetaten (A-4K7Q)',
    revealedName: 'Per Hansen',
    traces: [
      { note: 'Sendt til Langfuse (Testetaten), fullt innhold, maskert.', link: 'Åpne i Langfuse' },
      { note: 'Metadata sendt til Langfuse (Digdir).' },
    ],
  },
  t2: {
    triggerKind: 'Fra fagsystem',
    triggerDetail: 'Saksbehandlingssystemet · sak 2026/1432',
    afterApproval: {
      approvedTitle: 'Levert til saksbehandlingssystemet',
      approvedSummary: 'Vedtaksutkastet er lagt i sak 2026/1432',
      approvedRows: [
        ['Verktøy', 'Saksbehandlingssystemet'],
        ['Sak', '2026/1432'],
        ['Dokument', 'Vedtaksutkast.docx'],
      ],
      approvedFlash: 'Utkastet er godkjent og levert til sak 2026/1432.',
      rejectedFlash: 'Utkastet er avvist. Ingenting er sendt til saksbehandlingssystemet.',
      totalTime: '41 min 21 s',
    },
    traces: [
      {
        note: 'Sendt til Langfuse (Testetaten), bare metadata fordi tjenesten har høy risiko.',
        link: 'Åpne i Langfuse',
      },
    ],
  },
  t3: {
    triggerKind: 'Når et dokument kommer inn',
    triggerDetail: 'Mappen Søknader',
    traces: [
      { note: 'Sendt til Langfuse (Testetaten), fullt innhold, maskert.', link: 'Åpne i Langfuse' },
      { note: 'Metadata sendt til Langfuse (Digdir).' },
    ],
  },
  t4: {
    triggerKind: 'Etter tidsplan',
    triggerDetail: 'Hver natt kl. 02.00',
    traces: [
      { note: 'Ikke sendt til Langfuse: tjenesten er ikke valgt under Sporing og evaluering.' },
    ],
  },
  t5: {
    triggerKind: 'Samlet jobb',
    triggerDetail: 'Mappen Høring 2026/7 · 214 høringssvar',
    batch: true,
    revealedName: 'Per Hansen',
    traces: [{ note: 'Ikke sendt til Langfuse: ikke med i utvalget på 25 %.' }],
  },
  t7: {
    triggerKind: 'Chat',
    triggerDetail: 'Prøvekjøring i byggeren',
    traces: [{ note: 'Ikke sendt til Langfuse: ikke med i utvalget på 25 %.' }],
  },
  t6: {
    triggerKind: 'Når et dokument kommer inn',
    triggerDetail: 'Ledermøte 3. oktober.m4a',
    traces: [{ note: 'Ikke sendt til Langfuse: ikke med i utvalget på 25 %.' }],
  },
};

export const revealReasons = [
  'Sikkerhetshendelse',
  'Mistanke om misbruk av tjenesten',
  'Den ansatte har bedt om det',
  'Pålegg fra tilsyn eller domstol',
] as const;

export const revealReasonKeys: Record<(typeof revealReasons)[number], PlainKey> = {
  Sikkerhetshendelse: 'logRun.reasonSecurity',
  'Mistanke om misbruk av tjenesten': 'logRun.reasonAbuse',
  'Den ansatte har bedt om det': 'logRun.reasonRequested',
  'Pålegg fra tilsyn eller domstol': 'logRun.reasonOrder',
};

export const approver = 'Kari Nordmann';

export const approvalDetails: [string, string][] = [
  ['Tildelt', 'Saksbehandlere i seksjon for tilskudd'],
  ['Frist', '8. oktober'],
  ['Gjelder', 'Utkastet til vedtak i steget over'],
];

export const changeTypes = [
  'Alle',
  'Konfigurasjon',
  'Tilgang',
  'Publisering',
  'Endring fra Digdir',
  'Støttetilgang',
] as const;

export interface ChangeEntry {
  when: string;
  type: (typeof changeTypes)[number];
  what: string;
  who: string;
  why: string;
  color?: 'warning';
}

export const changeTypeKeys: Record<(typeof changeTypes)[number], PlainKey> = {
  Alle: 'logChanges.typeAll',
  Konfigurasjon: 'logChanges.typeConfig',
  Tilgang: 'logChanges.typeAccess',
  Publisering: 'logChanges.typePublish',
  'Endring fra Digdir': 'logChanges.typeOperator',
  Støttetilgang: 'logChanges.typeSupport',
};

export const changeColors: Record<string, 'warning' | 'success' | 'info' | 'neutral'> = {
  Støttetilgang: 'warning',
  Publisering: 'success',
  'Endring fra Digdir': 'info',
  Tilgang: 'neutral',
  Konfigurasjon: 'neutral',
};

export const exampleChanges: ChangeEntry[] = [
  {
    when: 'I dag kl. 10.52',
    type: 'Endring fra Digdir',
    what: 'Rapportassistenten: Antall treff 20 → 30. Under støttetilgang kl. 10.41–11.11.',
    who: 'Lise Dahl, Digdir',
    why: 'Kunden ser ikke kvoten riktig, sak DIG-4420',
    color: 'warning',
  },
  {
    when: 'I dag kl. 10.41',
    type: 'Støttetilgang',
    what: 'Lise Dahl, Digdir, åpnet portalen (30 min, kan endre på vegne av Testetaten)',
    who: 'Lise Dahl, Digdir',
    why: 'Kunden ser ikke kvoten riktig, sak DIG-4420',
  },
  {
    when: 'I dag kl. 08.30',
    type: 'Publisering',
    what: 'Høringsoppsummering versjon 3 publisert',
    who: 'Per Hansen',
    why: 'Ny instruksjon om sitater',
  },
  {
    when: '5. okt kl. 15.44',
    type: 'Endring fra Digdir',
    what: 'Plattformstandard v12: logg for begrenset risiko 60 → 90 dager. Rapportassistenten er festet til v11.',
    who: 'Digdir',
    why: 'Krav fra personvernombudet',
  },
  {
    when: '5. okt kl. 14.02',
    type: 'Tilgang',
    what: 'Vedtaksutkast: la til gruppen Saksbehandlere tilskudd',
    who: 'Kari Nordmann',
    why: '',
  },
  {
    when: '4. okt kl. 11.20',
    type: 'Endring fra Digdir',
    what: 'GPT-4o fases ut. Ingen av tjenestene deres bruker modellen.',
    who: 'Digdir',
    why: '',
  },
  {
    when: '3. okt kl. 09.12',
    type: 'Konfigurasjon',
    what: 'Søknadsuttrekk: kall per minutt 300 → 600',
    who: 'Kari Nordmann',
    why: 'Flere søknader før fristen',
  },
  {
    when: '2. okt kl. 13.15',
    type: 'Konfigurasjon',
    what: 'Ny API-nøkkel «Testskript for analyse»',
    who: 'Jonas Lie',
    why: '',
  },
];

const t1Steps: CompactStep[] = [
  {
    type: 'trigger',
    title: 'Spørsmål i chat',
    summary: 'Ansatt i Testetaten (A-4K7Q) i intranettet',
    t: 0,
    blocks: [
      { kind: 'quote', text: 'Hva sier evalueringer om digital veiledning siden 2020?' },
      {
        kind: 'kv',
        rows: [
          ['Kanal', 'Vår chatløsning (intranett)'],
          ['Bruker', 'Ansatt i Testetaten (A-4K7Q), Testetaten'],
          ['Samtale', 's-81f2 · melding 3'],
        ],
      },
    ],
  },
  {
    type: 'guard',
    title: 'Personopplysninger sjekket',
    summary: 'Ingen funnet',
    t: 0.1,
    dur: 0.05,
  },
  {
    type: 'plan',
    title: 'Plan',
    summary: '4 steg',
    t: 0.2,
    dur: 0.4,
    blocks: [
      {
        kind: 'list',
        label: 'Agenten planla',
        items: [
          ['Søk etter evalueringer om digital veiledning fra 2020', ''],
          ['Les de mest relevante rapportene', ''],
          ['Søk etter funn om kanalvalg og ventetid', ''],
          ['Sammenlign funn og svar med kilder', ''],
        ],
      },
    ],
  },
  {
    type: 'search',
    title: 'Søk',
    summary: '«digital veiledning evaluering» · 14 treff',
    t: 0.6,
    dur: 0.3,
    blocks: [
      { kind: 'quote', text: 'digital veiledning evaluering' },
      {
        kind: 'tags',
        label: 'Filter',
        items: ['Datasett: Kudos-rapporter', 'Dokumenttype: Evaluering', 'År: 2020–2026'],
      },
      {
        kind: 'list',
        label: 'Beste treff',
        items: [
          ['Evaluering av digital veiledning i Testetaten', '2023 · relevans 0,91'],
          ['Sluttrapport fra veiledningsprosjektet', '2024 · relevans 0,88'],
          ['Kartlegging av brukerreiser i staten', '2021 · relevans 0,74'],
        ],
      },
    ],
  },
  {
    type: 'read',
    title: 'Leste 3 rapporter',
    summary: '11 tekstbiter',
    t: 0.9,
    dur: 0.4,
    blocks: [
      {
        kind: 'list',
        label: 'Dokumenter',
        items: [
          ['Evaluering av digital veiledning i Testetaten (2023)', '5 tekstbiter, side 4–9'],
          ['Sluttrapport fra veiledningsprosjektet (2024)', '4 tekstbiter, side 12–15'],
          ['Kartlegging av brukerreiser i staten (2021)', '2 tekstbiter, side 31'],
        ],
      },
    ],
  },
  {
    type: 'search',
    title: 'Søk',
    summary: '«veiledning kanalvalg ventetid» · 6 treff',
    t: 1.4,
    dur: 0.3,
    blocks: [
      { kind: 'quote', text: 'veiledning kanalvalg ventetid' },
      {
        kind: 'tags',
        label: 'Filter',
        items: ['Datasett: Kudos-rapporter', 'Dokumenttype: Evaluering', 'År: 2020–2026'],
      },
    ],
  },
  {
    type: 'model',
    title: 'Modellkall',
    summary: 'Borealis-27B · 4 120 inn, 350 ut',
    t: 2.6,
    dur: 1.9,
    tokens: 4470,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Modell', 'Borealis-27B via AIVAR'],
          ['Data behandlet i', 'Norge'],
          ['Tokens', '4 120 inn, 350 ut'],
          ['Tid', '1,9 s'],
          ['Reservemodell', 'Ikke brukt'],
        ],
      },
    ],
  },
  {
    type: 'guard',
    title: 'Kilder kontrollert',
    summary: 'Alle påstander har kilde',
    t: 4.5,
    dur: 0.1,
  },
  {
    type: 'result',
    title: 'Svar sendt',
    summary: 'Svar med 3 kilder',
    t: 4.7,
    blocks: [
      {
        kind: 'answer',
        text: 'Evalueringene peker på tre ting:\n1. Digital veiledning virker best når den kombineres med mulighet for å snakke med en person.\n2. Brukerne gir opp når de må gjenta opplysninger de allerede har gitt.\n3. Kort ventetid betyr mer for tilfredsheten enn lange åpningstider.',
        sources: [
          'Evaluering av digital veiledning i Testetaten (2023)',
          'Sluttrapport fra veiledningsprosjektet (2024)',
          'Kartlegging av brukerreiser i staten (2021)',
        ],
      },
    ],
  },
];

const t2Steps: CompactStep[] = [
  {
    type: 'trigger',
    title: 'Kall fra saksbehandlingssystemet',
    summary: 'Sak 2026/1432 · API',
    t: 0,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Kanal', 'API · vedtaksutkast__default'],
          ['System', 'Saksbehandlingssystemet (nøkkel «sbs-prod»)'],
          ['Sak', '2026/1432, søknad om tilskudd'],
          ['Vedlegg', 'Søknad.pdf (6 sider), Budsjett.xlsx'],
        ],
      },
    ],
  },
  {
    type: 'plan',
    title: 'Stegflyt',
    summary: 'Les inn → lag utkast → kontroller → godkjenning → lever',
    t: 0.1,
  },
  {
    type: 'read',
    title: 'Leste søknaden',
    summary: '2 filer, 7 sider',
    t: 0.3,
    dur: 1.2,
    blocks: [
      {
        kind: 'list',
        label: 'Dokumenter',
        items: [
          ['Søknad.pdf', '6 sider'],
          ['Budsjett.xlsx', '1 ark, 42 rader'],
        ],
      },
    ],
  },
  {
    type: 'tool',
    title: 'Oppslag i Lovdata',
    summary: 'Forskrift om tilskudd til frivillige organisasjoner, § 4 og § 7',
    t: 1.6,
    dur: 0.8,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Verktøy', 'Lovdata (MCP-server, eksempel)'],
          ['Kan nå', 'Lover og forskrifter. Kan bare lese.'],
          ['Spørring', 'tilskudd frivillige organisasjoner vilkår'],
          ['Svar', '2 paragrafer'],
        ],
      },
    ],
  },
  {
    type: 'model',
    title: 'Modellkall',
    summary: 'GPT-4.1 · 11 300 inn, 1 420 ut',
    t: 2.5,
    dur: 6.1,
    tokens: 12720,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Modell', 'GPT-4.1 via Azure OpenAI'],
          ['Data behandlet i', 'EU (Sverige)'],
          ['Tokens', '11 300 inn, 1 420 ut'],
          ['Steg', 'Lag utkast'],
        ],
      },
    ],
  },
  {
    type: 'testetaten.risikoscore',
    title: 'Risikoscore beregnet',
    summary: '0,32 (lav)',
    t: 8.7,
    dur: 0.2,
    raw: 'Egendefinert steg fra Testetaten. Beregner risiko for feilutbetaling ut fra søknadsbeløp og tidligere tilskudd.',
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Stegtype', 'testetaten.risikoscore'],
          ['Verdi', '0,32'],
          ['Versjon', '2.1'],
        ],
      },
    ],
  },
  {
    type: 'model',
    title: 'Modellkall',
    summary: 'GPT-4.1 · 6 940 inn, 540 ut',
    t: 8.9,
    dur: 3.2,
    tokens: 7480,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Modell', 'GPT-4.1 via Azure OpenAI'],
          ['Data behandlet i', 'EU (Sverige)'],
          ['Tokens', '6 940 inn, 540 ut'],
          ['Steg', 'Kontroller mot regelverk'],
        ],
      },
    ],
  },
  {
    type: 'document',
    title: 'Utkast til vedtak laget',
    summary: 'Vedtaksutkast.docx · 2 sider',
    t: 12.2,
    dur: 0.4,
    blocks: [
      {
        kind: 'doc',
        title: 'Vedtak om tilskudd',
        body: 'Testetaten viser til søknad fra Eksempel Idrettslag (org.nr. 912 345 678) om tilskudd på 85 000 kroner.\n\nVedtak\nSøknaden innvilges med 85 000 kroner, jf. forskrift om tilskudd til frivillige organisasjoner § 4.\n\nBegrunnelse\nSøkeren oppfyller vilkårene i § 4 første ledd. Budsjettet viser at tilskuddet skal brukes til nye drakter og utstyr …',
      },
    ],
  },
  {
    type: 'approval',
    title: 'Godkjenning',
    summary: 'Venter på saksbehandler',
    t: 12.6,
    state: 'waiting',
  },
  {
    type: 'result',
    title: 'Levere til saksbehandlingssystemet',
    summary: 'Starter når utkastet er godkjent',
    t: null,
    state: 'pending',
  },
];

const t3Steps: CompactStep[] = [
  {
    type: 'trigger',
    title: 'Når et dokument kommer inn i Søknader',
    summary: 'Søknad_2026_118.pdf · 2,4 MB',
    t: 0,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Utløser', 'Når et dokument kommer inn'],
          ['Mappe', 'Søknader'],
          ['Fil', 'Søknad_2026_118.pdf, 4 sider, 2,4 MB'],
          ['Lagt inn av', 'postmottak@testetaten.example.no'],
        ],
      },
    ],
  },
  {
    type: 'read',
    title: 'Leste filen',
    summary: '4 sider, 1 skannet',
    t: 0.1,
    dur: 0.6,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Tekstgjenkjenning', 'Brukt på side 3'],
          ['Sider', '4'],
        ],
      },
    ],
  },
  {
    type: 'guard',
    title: 'Personopplysninger filtrert',
    summary: '1 navn og 1 telefonnummer holdes utenfor loggen',
    t: 0.7,
    dur: 0.05,
  },
  {
    type: 'model',
    title: 'Modellkall',
    summary: 'Qwen3.8-27B · 2 980 inn, 140 ut',
    t: 0.8,
    dur: 1.4,
    tokens: 3120,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Modell', 'Qwen3.8-27B via AIVAR'],
          ['Data behandlet i', 'Norge'],
          ['Tokens', '2 980 inn, 140 ut'],
        ],
      },
    ],
  },
  {
    type: 'tool',
    title: 'Oppslag i Enhetsregisteret',
    summary: 'Organisasjonsnummeret finnes, og navnet stemmer',
    t: 2.2,
    dur: 0.2,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Verktøy', 'Oppslag i Enhetsregisteret'],
          ['Kan nå', 'Åpne data om virksomheter. Kan bare lese.'],
          ['Organisasjonsnummer', '944 556 677'],
        ],
      },
    ],
  },
  {
    type: 'result',
    title: 'Felter hentet ut',
    summary: '5 felter · 1 søknad flagget',
    t: 2.4,
    blocks: [
      {
        kind: 'fields',
        rows: [
          ['Søkers navn', 'Elvebakken Musikkorps'],
          ['Organisasjonsnummer', '944 556 677'],
          ['Omsøkt beløp', '1 200 000 kr'],
          ['Mangler vedlegg', 'Ja'],
          ['Manglende vedlegg', 'Vedtekter'],
        ],
      },
    ],
  },
  {
    type: 'tool',
    title: 'Skrev til saksbehandlingssystemet',
    summary: 'Sak 2026/1440 opprettet',
    t: 2.5,
    dur: 0.1,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Verktøy', 'Saksbehandlingssystemet'],
          ['Kan nå', 'Lese og skrive felter i saker av typen «Tilskudd»'],
          ['Sak', '2026/1440'],
        ],
      },
    ],
  },
];

const t4Steps: CompactStep[] = [
  {
    type: 'trigger',
    title: 'Etter tidsplan',
    summary: 'Hver natt kl. 02.00',
    t: 0,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Utløser', 'Etter tidsplan'],
          ['Tidsplan', 'Hver natt kl. 02.00'],
          ['Forrige kjøring', '5. oktober, fullført'],
        ],
      },
    ],
  },
  {
    type: 'tool',
    title: 'Hentet endrede sider',
    summary: '23 sider fra publiseringssystemet',
    t: 0.4,
    dur: 2.1,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Verktøy', 'Publiseringssystemet (OpenAPI)'],
          ['Kan nå', 'Lese og lagre utkast til nettsider'],
          ['Sider', '23 endret siden forrige kjøring'],
        ],
      },
    ],
  },
  {
    type: 'tool',
    title: 'Bokmål til nynorsk',
    summary: 'Fellestjeneste fra Digdir · 12 av 23 sider',
    t: 2.6,
    dur: 168,
    tokens: 80100,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Verktøy', 'digdir.nynorsk@1.4 (fellestjeneste fra Digdir)'],
          ['Kan nå', 'Bare teksten som sendes til den'],
          ['Sider satt om', '12 av 23'],
        ],
      },
    ],
  },
  {
    type: 'error',
    title: 'Lagring feilet',
    summary: 'Publiseringssystemet svarte ikke (503) ved side 13',
    t: 171,
    state: 'failed',
    blocks: [
      {
        kind: 'error',
        text: 'Publiseringssystemet svarte ikke etter tre forsøk (svarkode 503). Kjøringen ble stoppet for å ikke lagre halve endringer.',
      },
      {
        kind: 'kv',
        rows: [
          ['Feilkode', 'TOOL-503'],
          ['Side', '/tilskudd/frivillighet'],
        ],
      },
    ],
  },
  {
    type: 'result',
    title: 'Ingen sider publisert',
    summary: '12 sider som er satt om, er lagret som utkast',
    t: 192,
    state: 'failed',
    blocks: [
      {
        kind: 'note',
        text: 'De 12 sidene som ble satt om, ligger som utkast i publiseringssystemet. Kjør på nytt når systemet svarer igjen.',
      },
    ],
  },
];

const t6Steps: CompactStep[] = [
  {
    type: 'trigger',
    title: 'Når et dokument kommer inn i Opptak',
    summary: 'Ledermøte 3. oktober.m4a · 58 min',
    t: 0,
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Utløser', 'Når et dokument kommer inn'],
          ['Mappe', 'Opptak'],
          ['Fil', 'Ledermøte 3. oktober.m4a, 58 min'],
        ],
      },
    ],
  },
  {
    type: 'tool',
    title: 'Transkribering',
    summary: 'Avbrutt etter 31 %',
    t: 0.3,
    dur: 99,
    state: 'cancelled',
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Verktøy', 'digdir.transkribering@1.2 (fellestjeneste fra Digdir)'],
          ['Kan nå', 'Lydfiler som sendes til den'],
        ],
      },
    ],
  },
  {
    type: 'result',
    title: 'Avbrutt av Ola Nordmann',
    summary: '«Feil opptak, laster opp riktig fil.»',
    t: 100,
    state: 'cancelled',
    blocks: [{ kind: 'note', text: 'Ingenting ble lagret. Lydfilen er slettet fra plattformen.' }],
  },
];

const t7Steps: CompactStep[] = [
  { type: 'trigger', title: 'Skjema lest', summary: 'Departement og år fra skjemaet', t: 0 },
  {
    type: 'search',
    title: 'Finn dokumenter',
    summary: 'Fant 12 årsrapporter.',
    t: 2,
    dur: 1.6,
  },
  {
    type: 'step',
    title: 'For hvert dokument',
    summary: '11 fullført, 1 hoppet over.',
    t: 3,
    dur: 52,
    state: 'partial',
    blocks: [
      {
        kind: 'note',
        text: 'Steget «For hvert dokument» er satt til «Hopp over elementet». Elementer som ble hoppet over, står i resultatet med grunnen.',
      },
    ],
  },
  { type: 'read', title: 'Årsrapport 2025, Mønstertilsynet', summary: 'Vurdert', t: 19, depth: 1 },
  {
    type: 'read',
    title: 'Årsrapport 2025, Skogverket',
    summary: 'Hoppet over: skannet PDF uten tekst. Kunne ikke leses.',
    t: 20,
    state: 'skipped',
    depth: 1,
  },
  { type: 'read', title: 'Årsrapport 2025, Kulturrådet', summary: 'Vurdert', t: 37, depth: 1 },
  {
    type: 'model',
    title: 'Lag tabell med kilder',
    summary:
      'Steget «tabell» feilet første gang: kolonnen «assessment» manglet i svaret. Prøvde på nytt og lyktes.',
    t: 98,
    dur: 6.1,
    tokens: 21400,
    state: 'retried',
  },
  {
    type: 'result',
    title: 'Tabell levert',
    summary: '12 rader, 1 med grunn til at den mangler',
    t: 104,
  },
];

const timeline = (
  id: string,
  service: string,
  status: TaskStatus,
  trigger: string,
  startedAt: string,
  durationSeconds: number,
  inputTokens: number,
  outputTokens: number,
  costOre: number,
  steps: CompactStep[],
): TaskTimeline => ({
  id,
  service,
  status,
  trigger,
  caller: 'Ansatt i Testetaten (A-4K7Q)',
  startedAt,
  durationSeconds,
  inputTokens,
  outputTokens,
  costOre,
  steps: toSteps(steps, id),
});

export const logTimelines: TaskTimeline[] = [
  timeline(
    't1',
    'Rapportassistenten',
    'completed',
    'Chat',
    at(0, 10, 41),
    4.7,
    4120,
    350,
    2.1,
    t1Steps,
  ),
  timeline(
    't2',
    'Vedtaksutkast',
    'interrupted',
    'Fra fagsystem',
    at(0, 9, 12),
    2460,
    18240,
    1960,
    29,
    t2Steps,
  ),
  timeline(
    't3',
    'Søknadsuttrekk',
    'completed',
    'Når et dokument kommer inn',
    at(0, 8, 3),
    2.6,
    2980,
    140,
    4.7,
    t3Steps,
  ),
  timeline(
    't4',
    'Nettsider på nynorsk',
    'failed',
    'Etter tidsplan',
    at(0, 2, 0),
    192,
    41200,
    38900,
    71,
    t4Steps,
  ),
  timeline('t5', 'Høringsoppsummering', 'running', 'Samlet jobb', at(0, 7, 30), 4320, 0, 0, 0, []),
  timeline(
    't6',
    'Møtereferat',
    'cancelled',
    'Når et dokument kommer inn',
    at(1, 15, 2),
    100,
    0,
    0,
    0,
    t6Steps,
  ),
  timeline(
    't7',
    'Vurdering av måloppnåelse',
    'completed',
    'Chat',
    at(2, 10, 14),
    104,
    48200,
    5100,
    38,
    t7Steps,
  ),
];

export const playgroundTimeline = (id: string): TaskTimeline =>
  timeline(id, 'Prøveområdet', 'completed', 'Prøveområdet', at(0, 10, 0), 3.1, 4380, 410, 2.4, [
    {
      type: 'trigger',
      title: 'Prøvekjøring',
      summary: 'Kjørt fra prøveområdet',
      t: 0,
    },
    {
      type: 'search',
      title: 'Søk',
      summary: '«omsøkt beløp» · 9 treff',
      t: 0.2,
      dur: 0.3,
    },
    {
      type: 'searchnote',
      title: 'Søkemerknad',
      summary: '3 dokumenter hoppet over',
      t: 0.5,
      blocks: [
        {
          kind: 'list',
          label: 'Søkemotoren hoppet over',
          items: [
            ['Skannet årsrapport 2019.pdf', 'Skannet PDF uten tekst'],
            ['Budsjett 2024.xlsx', 'Filtypen kan ikke søkes i'],
            ['Personalsak 2023.docx', 'Utenfor tilgangen til tjenesten'],
          ],
        },
      ],
    },
    { type: 'model', title: 'Svar fra modellen', summary: '4380 inn · 410 ut', t: 0.8, dur: 2.2 },
    { type: 'result', title: 'Svar', summary: 'Levert i prøveområdet', t: 3.1 },
  ]);

const serviceIdByName = Object.fromEntries(Object.entries(serviceNames).map(([id, n]) => [n, id]));

export const logTasks: TaskRow[] = logTimelines.map((t) => {
  const service = serviceIdByName[t.service] ?? t.service;
  return {
    id: t.id,
    status: t.status,
    service,
    capability: `999888777/${service}/default`,
    createdAt: t.startedAt,
    endedAt:
      t.status === 'running' || t.status === 'interrupted'
        ? null
        : new Date(Date.parse(t.startedAt) + t.durationSeconds * 1000).toISOString(),
    usage: {
      inputTokens: t.inputTokens ?? 0,
      outputTokens: t.outputTokens ?? 0,
      requests: t.steps.filter((s) => s.type === 'model').length,
      costMicroNok:
        t.costOre === null || t.costOre === undefined ? null : Math.round(t.costOre * 10_000),
    },
  };
});

export const BATCH_TOTAL = 214;

const ORGS = [
  'Prøvekommunen',
  'Eksempeldirektoratet',
  'Fylkeskommunen i Testfylke',
  'Frivillighetsforbundet',
  'Testby kommune',
  'Statens eksempelverk',
  'Eksempel Idrettslag',
  'Norsk eksempelforening',
];
const STANDS = ['Støtter forslaget', 'Støtter med endringer', 'Går imot', 'Ingen merknader'];
const TOPICS = [
  'Finansiering',
  'Rapportering',
  'Søknadsfrister',
  'Digital søknad',
  'Krav til vedtekter',
];
const FAILED: Record<number, string> = {
  17: 'Filen er passordbeskyttet.',
  58: 'Filen er tom.',
  93: 'Filen er passordbeskyttet.',
  120: 'Formatet .pages kan ikke leses.',
};

export interface BatchItem {
  i: number;
  name: string;
  org: string;
  status: BatchItemStatus;
  err: string;
  tokens: number;
}

export const batchItems = (done: number, cancelled: boolean): BatchItem[] =>
  Array.from({ length: BATCH_TOTAL }, (_, k) => {
    const i = k + 1;
    const status: BatchItemStatus =
      i <= done
        ? FAILED[i]
          ? 'Feilet'
          : 'Fullført'
        : !cancelled && i <= done + 3
          ? 'Kjører'
          : cancelled
            ? 'Avbrutt'
            : 'Venter';
    return {
      i,
      name: `Høringssvar_${String(i).padStart(3, '0')}.pdf`,
      org: ORGS[i % ORGS.length] ?? '',
      status,
      err: FAILED[i] ?? '',
      tokens: status === 'Fullført' ? 2600 + ((i * 37) % 900) : 0,
    };
  });

const nb = (n: number) => n.toLocaleString('nb-NO');

export const batchItemSteps = (it: BatchItem): TimelineStep[] => {
  const steps: CompactStep[] = [
    {
      type: 'trigger',
      title: 'Element i samlet jobb',
      summary: `${it.name} · fra ${it.org}`,
      t: 0,
      blocks: [
        {
          kind: 'kv',
          rows: [
            ['Jobb', 'Høringsoppsummering, mappen Høring 2026/7'],
            ['Element', `${it.i} av ${BATCH_TOTAL}`],
            ['Fil', it.name],
          ],
        },
      ],
    },
  ];
  if (it.status === 'Venter' || it.status === 'Avbrutt') {
    const cancelled = it.status === 'Avbrutt';
    steps.push({
      type: 'result',
      title: cancelled ? 'Avbrutt' : 'Venter i kø',
      summary: cancelled
        ? 'Jobben ble avbrutt før elementet startet'
        : 'Starter når det er ledig kapasitet',
      t: null,
      state: cancelled ? 'cancelled' : 'pending',
    });
    return toSteps(steps, `item${it.i}`);
  }
  if (it.status === 'Feilet') {
    steps.push({
      type: 'error',
      title: 'Kunne ikke lese filen',
      summary: it.err,
      t: 0.2,
      state: 'failed',
      blocks: [
        {
          kind: 'error',
          text: `${it.err} Elementet er hoppet over. De andre høringssvarene behandles som vanlig.`,
        },
      ],
    });
    return toSteps(steps, `item${it.i}`);
  }
  steps.push(
    { type: 'read', title: 'Leste høringssvaret', summary: '3 sider', t: 0.1, dur: 0.3 },
    {
      type: 'guard',
      title: 'Personopplysninger filtrert',
      summary: 'Navn på privatpersoner holdes utenfor loggen',
      t: 0.4,
      dur: 0.05,
    },
  );
  if (it.status === 'Kjører') {
    steps.push({
      type: 'model',
      title: 'Modellkall',
      summary: 'Borealis-27B · pågår',
      t: 0.5,
      state: 'running',
    });
    return toSteps(steps, `item${it.i}`);
  }
  const topic = TOPICS[it.i % TOPICS.length] ?? '';
  const stand = STANDS[it.i % STANDS.length] ?? '';
  steps.push(
    {
      type: 'model',
      title: 'Modellkall',
      summary: `Borealis-27B · ${nb(it.tokens - 180)} inn, 180 ut`,
      t: 0.5,
      dur: 1.6,
      tokens: it.tokens,
      blocks: [
        {
          kind: 'kv',
          rows: [
            ['Modell', 'Borealis-27B via AIVAR'],
            ['Data behandlet i', 'Norge'],
          ],
        },
      ],
    },
    {
      type: 'result',
      title: 'Oppsummert',
      summary: `${topic} · ${stand}`,
      t: 2.1,
      blocks: [
        {
          kind: 'fields',
          rows: [
            ['Avsender', it.org],
            ['Tema', topic],
            ['Standpunkt', stand],
            ['Hovedargument', 'Fristen bør flyttes slik at små organisasjoner rekker å søke.'],
          ],
        },
      ],
    },
  );
  return toSteps(steps, `item${it.i}`);
};
