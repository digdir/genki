import type { PlainKey } from '../i18n';

export type SourceKind = 'kudos' | 'web' | 'upload' | 'cms' | 'shared' | 'unknown';
export type DatasetStatus =
  | 'Klar'
  | 'Delvis lest inn'
  | 'Feilet'
  | 'Innlesing pågår'
  | 'Ikke lest inn'
  | 'Utenfor plattformen';
export type RunStatus =
  | 'Fullført'
  | 'Fullført med merknader'
  | 'Delvis lest inn'
  | 'Feilet'
  | 'Pågår'
  | 'Satt i kø'
  | 'Stoppet';

export interface IngestionError {
  item: string;
  what: string;
  why: string;
  code: string;
  fix?: string;
}

export interface IngestionRun {
  id: string;
  when: string;
  how: string;
  duration: string;
  status: RunStatus;
  added: number;
  changed: number;
  removed: number;
  errors: IngestionError[];
  progress?: number;
  total?: number;
}

export interface Facet {
  name: string;
  field: string;
  enabled: boolean;
  values: [string, number][];
  moreValues: number;
  moreDocs?: number;
}

export interface DatasetDetails {
  id: string;
  name: string;
  source: SourceKind;
  owner?: string;
  docs: number;
  chunks: string;
  last: string;
  lastOk: string;
  next: string;
  status: DatasetStatus;
  usedBy: string[];
  description: string;
  settings: [string, string][];
  runs: IngestionRun[];
  facets: Facet[];
}

export const sourceKeys: Record<SourceKind, PlainKey> = {
  kudos: 'datasets.sourceKudos',
  web: 'datasets.sourceWeb',
  upload: 'datasets.sourceUpload',
  cms: 'datasets.sourceCms',
  shared: 'datasets.sourceShared',
  unknown: 'datasets.sourceUnknown',
};

export const statusKeys: Record<DatasetStatus, PlainKey> = {
  Klar: 'datasets.statusReady',
  'Delvis lest inn': 'datasets.statusPartial',
  Feilet: 'datasets.statusFailed',
  'Innlesing pågår': 'datasets.statusRunning',
  'Ikke lest inn': 'datasets.statusNotRead',
  'Utenfor plattformen': 'datasets.statusExternal',
};

export const runKeys: Record<RunStatus, PlainKey> = {
  Fullført: 'datasets.runDone',
  'Fullført med merknader': 'datasets.runDoneNotes',
  'Delvis lest inn': 'datasets.statusPartial',
  Feilet: 'datasets.statusFailed',
  Pågår: 'datasets.runRunning',
  'Satt i kø': 'datasets.runQueued',
  Stoppet: 'datasets.runStopped',
};

export const statusColors: Record<
  DatasetStatus,
  'success' | 'warning' | 'danger' | 'info' | 'neutral'
> = {
  Klar: 'success',
  'Delvis lest inn': 'warning',
  Feilet: 'danger',
  'Innlesing pågår': 'info',
  'Ikke lest inn': 'neutral',
  'Utenfor plattformen': 'info',
};

export const runColors: Record<RunStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  Fullført: 'success',
  'Fullført med merknader': 'warning',
  'Delvis lest inn': 'warning',
  Feilet: 'danger',
  Pågår: 'info',
  'Satt i kø': 'info',
  Stoppet: 'neutral',
};

export const kudosTypes: [string, number][] = [
  ['Evaluering', 12480],
  ['Årsrapport', 9912],
  ['Tildelingsbrev', 8104],
  ['Utredning', 6230],
  ['Tilsynsrapport', 3870],
  ['Veileder', 2940],
];

export const kudosDocumentTypes = [
  'Tildelingsbrev',
  'Årsrapport',
  'Evaluering',
  'Statusrapport',
  'Strategi/plan',
  'Instruks',
  'Melding',
  'Proposisjon til Stortinget',
];

export const sampleFiles: [string, string][] = [
  ['Tilskuddsregelverk 2026.pdf', '1,2 MB'],
  ['Veileder for søkere.docx', '340 kB'],
  ['Spørsmål og svar.md', '18 kB'],
  ['Presentasjon fra møtet.pages', '4,8 MB'],
  ['Rundskriv 3-2026.pdf', '620 kB'],
];

const run = (
  id: string,
  when: string,
  how: string,
  duration: string,
  status: RunStatus,
  added: number,
  changed: number,
  removed: number,
  errors: IngestionError[] = [],
): IngestionRun => ({ id, when, how, duration, status, added, changed, removed, errors });

const facet = (
  name: string,
  field: string,
  enabled: boolean,
  values: [string, number][],
  moreValues = 0,
  moreDocs?: number,
): Facet => ({ name, field, enabled, values, moreValues, ...(moreDocs ? { moreDocs } : {}) });

export const datasetDetails: DatasetDetails[] = [
  {
    id: 'digdir/kudos',
    name: 'Kudos-rapporter',
    source: 'kudos',
    docs: 48312,
    chunks: '1,9 mill.',
    last: 'I dag kl. 04.00',
    lastOk: 'I dag kl. 04.00',
    next: 'I morgen kl. 04.00',
    status: 'Klar',
    usedBy: ['Rapportassistenten', 'Spør veilederen', 'Høringsoppsummering'],
    description: 'Rapporter fra statlige virksomheter i rapportarkivet Kudos.',
    settings: [
      ['Kilde', 'Kudos rapportarkiv'],
      ['Utvalg', 'Alle virksomheter'],
      ['Dokumenttyper', 'Alle'],
      ['Fra år', '2010'],
      ['Etter tidsplan', 'Hver natt kl. 04.00'],
      ['Tekstgjenkjenning', 'På'],
    ],
    runs: [
      run('k1', 'I dag kl. 04.00', 'Planlagt', '22 min', 'Fullført', 38, 112, 0),
      run('k2', '5. oktober kl. 04.00', 'Planlagt', '19 min', 'Fullført', 41, 96, 2),
      run('k3', '4. oktober kl. 04.00', 'Planlagt', '24 min', 'Fullført med merknader', 12, 80, 0, [
        {
          item: 'Årsrapport 2025, Eksempelverket.pdf',
          what: 'Filen er skadet og kunne ikke åpnes.',
          why: 'Kudos har en ødelagt kopi av filen. Vi prøver igjen neste natt. Virksomheten som eier rapporten, kan laste den opp på nytt i Kudos.',
          code: 'PDF-CORRUPT',
        },
      ]),
    ],
    facets: [
      facet('Dokumenttype', 'type', true, [
        ['Evaluering', 12480],
        ['Årsrapport', 9912],
        ['Tildelingsbrev', 8104],
        ['Utredning', 6230],
        ['Annet', 4776],
        ['Tilsynsrapport', 3870],
        ['Veileder', 2940],
      ]),
      facet(
        'År',
        'aar',
        true,
        [
          ['2026', 1210],
          ['2025', 4980],
          ['2024', 5120],
          ['2023', 5340],
          ['2022', 4870],
          ['2021', 4610],
          ['2020', 4390],
        ],
        10,
        17792,
      ),
      facet(
        'Virksomhet',
        'virksomhet',
        true,
        [
          ['Testetaten', 1840],
          ['Eksempeldirektoratet', 1622],
          ['Statens eksempelverk', 1290],
          ['Prøvetilsynet', 1104],
          ['Fylkesmannsetaten', 988],
          ['Kontrollrådet', 870],
        ],
        212,
        40598,
      ),
      facet(
        'Departement',
        'departement',
        false,
        [
          ['Eksempeldepartementet', 8120],
          ['Prøvedepartementet', 6410],
          ['Testdepartementet', 5980],
        ],
        12,
        27802,
      ),
    ],
  },
  {
    id: '999888777/tilsynsrapporter-2025',
    name: 'Tilsynsrapporter 2025',
    source: 'upload',
    docs: 136,
    chunks: '4 210',
    last: '5. oktober kl. 14.32',
    lastOk: '5. oktober kl. 14.32',
    next: 'Ikke planlagt',
    status: 'Delvis lest inn',
    usedBy: ['Rapportassistenten'],
    description: 'Tilsynsrapporter fra 2025, lastet opp av Kari Nordmann.',
    settings: [
      ['Kilde', '148 opplastede filer'],
      ['Lastet opp av', 'Kari Nordmann'],
      ['Tekstgjenkjenning', 'Av'],
      ['Etter tidsplan', 'Ingen. Leses inn når filer lastes opp.'],
    ],
    runs: [
      run('t1', '5. oktober kl. 14.32', 'Opplasting', '6 min', 'Delvis lest inn', 136, 0, 0, [
        {
          item: '12 skannede PDF-er, for eksempel Tilsyn_2025_031.pdf',
          what: 'Filene er skannet uten tekst.',
          why: 'Dokumentene er bilder av papir, så det finnes ingen tekst å søke i. Slå på tekstgjenkjenning, så leser vi dem på nytt.',
          code: 'NO-TEXT',
          fix: 'Slå på tekstgjenkjenning og prøv igjen',
        },
      ]),
    ],
    facets: [
      facet('Dokumenttype', 'type', true, [
        ['Tilsynsrapport', 121],
        ['Varsel om pålegg', 15],
      ]),
      facet(
        'Måned',
        'maaned',
        true,
        [
          ['Januar', 9],
          ['Februar', 11],
          ['Mars', 14],
          ['April', 12],
          ['Mai', 10],
          ['Juni', 13],
        ],
        6,
        67,
      ),
    ],
  },
  {
    id: '999888777/nettsider',
    name: 'Nettsidene til Testetaten',
    source: 'web',
    docs: 2104,
    chunks: '31 800',
    last: 'I dag kl. 06.00',
    lastOk: '4. oktober kl. 06.00',
    next: 'I morgen kl. 06.00',
    status: 'Feilet',
    usedBy: ['Nettsider på nynorsk', 'Intern spørsmålsbank'],
    description: 'Alle offentlige sider på testetaten.example.no.',
    settings: [
      ['Startadresse', 'https://testetaten.example.no'],
      ['Ta med', '/tilskudd, /tilsyn, /om-oss, /veiledning'],
      ['Utelat', '/sok, /logg-inn'],
      ['Maks antall sider', '5 000'],
      ['Etter tidsplan', 'Hver natt kl. 06.00'],
      ['Følg lenker til PDF', 'Ja'],
    ],
    runs: [
      run('w1', 'I dag kl. 06.00', 'Planlagt', '3 min', 'Feilet', 0, 0, 0, [
        {
          item: 'testetaten.example.no',
          what: 'Fikk ikke kontakt med nettstedet.',
          why: 'Nettstedet svarte «utilgjengelig» tre ganger på rad. Det skjer ofte under vedlikehold. Ingenting er endret i datasettet, og søket bruker innholdet fra 4. oktober.',
          code: 'HTTP 503',
        },
      ]),
      run('w2', '5. oktober kl. 06.00', 'Planlagt', '1 min', 'Feilet', 0, 0, 0, [
        {
          item: 'testetaten.example.no',
          what: 'Fikk ikke kontakt med nettstedet.',
          why: 'Samme feil som i dag. Hvis den kommer igjen i morgen, bør dere sjekke med dem som drifter nettstedet.',
          code: 'HTTP 503',
        },
      ]),
      run('w3', '4. oktober kl. 06.00', 'Planlagt', '14 min', 'Fullført med merknader', 14, 37, 3, [
        {
          item: '/arkiv/2019/arsrapport.pdf',
          what: 'Siden finnes ikke lenger.',
          why: 'Lenken gir «ikke funnet». Dokumentet er fjernet fra datasettet, så det ikke vises i svar.',
          code: 'HTTP 404',
        },
        {
          item: '/tilskudd/min-soknad',
          what: 'Siden krever innlogging.',
          why: 'Vi leser bare åpne sider. Siden er hoppet over. Legg den til under «Utelat» hvis den aldri skal være med.',
          code: 'HTTP 401',
        },
      ]),
      run('w4', '3. oktober kl. 06.00', 'Planlagt', '12 min', 'Fullført', 2, 11, 0),
      run('w5', '2. oktober kl. 10.15', 'Manuell · Kari Nordmann', '13 min', 'Fullført', 0, 24, 1),
    ],
    facets: [
      facet('Seksjon', 'seksjon', true, [
        ['Tilskudd', 412],
        ['Tilsyn', 388],
        ['Veiledning', 356],
        ['Nyheter', 530],
        ['Om oss', 140],
        ['Annet', 278],
      ]),
      facet('Språk', 'sprak', true, [
        ['Bokmål', 1890],
        ['Nynorsk', 160],
        ['Engelsk', 54],
      ]),
      facet('Sist endret', 'endret_aar', false, [
        ['2026', 610],
        ['2025', 804],
        ['2024', 402],
        ['Eldre', 288],
      ]),
    ],
  },
  {
    id: '999888777/veiledere',
    name: 'Veiledere og rundskriv',
    source: 'cms',
    docs: 612,
    chunks: '9 400',
    last: '1. oktober kl. 05.00',
    lastOk: '1. oktober kl. 05.00',
    next: '8. oktober kl. 05.00',
    status: 'Klar',
    usedBy: ['Spør veilederen', 'Vedtaksutkast'],
    description: 'Veiledere og rundskriv fra publiseringssystemet.',
    settings: [
      ['Kilde', 'Publiseringssystemet (koblet til under Integrasjoner)'],
      ['Innholdstyper', 'Veileder, Rundskriv'],
      ['Etter tidsplan', 'Hver onsdag kl. 05.00'],
    ],
    runs: [run('v1', '1. oktober kl. 05.00', 'Planlagt', '4 min', 'Fullført', 3, 9, 0)],
    facets: [
      facet('Innholdstype', 'type', true, [
        ['Veileder', 438],
        ['Rundskriv', 174],
      ]),
    ],
  },
  {
    id: '999666555/statsbudsjett-2026',
    name: 'Statsbudsjettet 2026',
    source: 'shared',
    owner: 'Eksempeldirektoratet',
    docs: 1870,
    chunks: '22 100',
    last: '30. september kl. 03.00',
    lastOk: '30. september kl. 03.00',
    next: 'Styres av eieren',
    status: 'Klar',
    usedBy: [],
    description:
      'Delt med Testetaten av Eksempeldirektoratet. Dere kan søke i det, men ikke endre det.',
    settings: [
      ['Eier', 'Eksempeldirektoratet'],
      ['Delt med', 'Alle statlige virksomheter'],
      ['Kilde', 'Styres av eieren'],
    ],
    runs: [run('s1', '30. september kl. 03.00', 'Hos eieren', '31 min', 'Fullført', 1870, 0, 0)],
    facets: [
      facet(
        'Departement',
        'dep',
        true,
        [
          ['Eksempeldepartementet', 310],
          ['Prøvedepartementet', 280],
          ['Testdepartementet', 255],
        ],
        14,
        1025,
      ),
    ],
  },
  {
    id: '999888777/horing-2026-7',
    name: 'Høring 2026/7',
    source: 'upload',
    docs: 214,
    chunks: '2 880',
    last: 'I dag kl. 07.20',
    lastOk: 'I dag kl. 07.20',
    next: 'Ikke planlagt',
    status: 'Klar',
    usedBy: ['Høringsoppsummering'],
    description: 'Høringssvar på forslag om nye tilskuddsregler.',
    settings: [
      ['Kilde', '214 opplastede filer'],
      ['Lastet opp av', 'Per Hansen'],
      ['Tekstgjenkjenning', 'På'],
    ],
    runs: [
      run('h1', 'I dag kl. 07.20', 'Opplasting', '5 min', 'Fullført med merknader', 210, 0, 0, [
        {
          item: '4 filer, for eksempel Høringssvar_017.pdf',
          what: 'Filene kunne ikke åpnes.',
          why: 'Tre er passordbeskyttet og én er i formatet .pages. Be avsenderen om en vanlig PDF eller Word-fil, og last den opp på nytt.',
          code: 'UNREADABLE',
        },
      ]),
    ],
    facets: [
      facet('Avsendertype', 'avsender', true, [
        ['Kommune', 88],
        ['Organisasjon', 71],
        ['Statlig virksomhet', 39],
        ['Privatperson', 12],
      ]),
    ],
  },
];
