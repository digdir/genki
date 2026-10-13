export type SettingType = 'int' | 'float' | 'enum' | 'bool' | 'list' | 'secret' | 'risk' | 'text';
export type Sensitivity = 'Lav' | 'Middels' | 'Høy' | 'Hemmelig';
export type Scope = 'virksomhet' | 'tjeneste' | 'datasett';
export type RiskLevel = 'minimal' | 'limited' | 'high';
export type RiskValues = Record<RiskLevel, string>;
export type SettingValue = string | number | boolean | string[] | RiskValues;

export interface SettingRow {
  id: string;
  apiKey?: string;
  cat: string;
  label: string;
  desc: string;
  type: SettingType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  opts?: [string, string][];
  sens: Sensitivity;
  scope: Scope[];
  P: SettingValue | null;
  V: SettingValue | null;
  svc: Record<string, SettingValue>;
  ds: Record<string, SettingValue>;
  pins?: Record<string, [string, SettingValue]>;
  needs?: Record<string, number>;
  rule?: string;
  minRisk?: string;
  categories?: string[];
  floor?: number;
  notDecided?: boolean;
  json?: boolean;
}

export const categories = ['Søk', 'Svar', 'Modell', 'Vern', 'Innlesing', 'Grenser'];

export const exampleServiceNames = [
  'Rapportassistenten',
  'Vedtaksutkast',
  'Søknadsuttrekk',
  'Nettsider på nynorsk',
  'Høringsoppsummering',
  'Møtereferat',
];

export const exampleDatasetNames = [
  'Kudos-rapporter',
  'Tilsynsrapporter 2025',
  'Nettsidene til Testetaten',
  'Veiledere og rundskriv',
];

export const highRiskServices = ['Vedtaksutkast'];
export const norwayOnlyServices = ['Møtereferat'];

export const riskLevels: [RiskLevel, string][] = [
  ['minimal', 'Minimal risiko'],
  ['limited', 'Begrenset risiko'],
  ['high', 'Høy risiko'],
];

const piiCategories = [
  'Fødselsnummer og D-nummer',
  'Navn',
  'Adresse',
  'Telefonnummer',
  'E-post',
  'Kontonummer',
];

const row = (r: Omit<SettingRow, 'svc' | 'ds'> & Partial<Pick<SettingRow, 'svc' | 'ds'>>) => ({
  svc: {},
  ds: {},
  ...r,
});

export const exampleSettings: SettingRow[] = [
  row({
    id: 'search.top_k',
    apiKey: 'retrieval.topK',
    cat: 'Søk',
    label: 'Antall treff som leses',
    desc: 'Hvor mange tekstbiter tjenesten leser før den svarer. Flere treff gir mer grunnlag, men koster mer og tar lengre tid.',
    type: 'int',
    min: 1,
    max: 50,
    unit: 'treff',
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste'],
    P: 8,
    V: null,
    svc: { Rapportassistenten: 12, Høringsoppsummering: 20 },
  }),
  row({
    id: 'search.min_score',
    cat: 'Søk',
    label: 'Laveste relevans',
    desc: 'Treff under denne verdien blir ikke brukt. Høyere verdi gir færre, men mer treffsikre kilder.',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.05,
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste', 'datasett'],
    P: 0.5,
    V: 0.6,
  }),
  row({
    id: 'search.sort',
    cat: 'Søk',
    label: 'Sortering av treff',
    desc: 'Hvordan treffene rangeres før de leses.',
    type: 'enum',
    opts: [
      ['relevans', 'Relevans'],
      ['relevans_nyeste', 'Relevans, deretter nyeste år'],
      ['nyeste', 'Nyeste først'],
    ],
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste'],
    P: 'relevans',
    V: null,
    svc: { Rapportassistenten: 'relevans_nyeste' },
  }),
  row({
    id: 'search.hybrid',
    cat: 'Søk',
    label: 'Kombiner ord- og betydningssøk',
    desc: 'Søker både etter ordene i spørsmålet og etter tekst som betyr det samme.',
    type: 'bool',
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste', 'datasett'],
    P: true,
    V: null,
  }),
  row({
    id: 'answer.language',
    apiKey: 'answer.language',
    cat: 'Svar',
    label: 'Svarspråk',
    desc: 'Hvilken målform svaret skal ha.',
    type: 'enum',
    opts: [
      ['samme', 'Samme som spørsmålet'],
      ['nb', 'Bokmål'],
      ['nn', 'Nynorsk'],
    ],
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste'],
    P: 'samme',
    V: null,
    svc: { 'Nettsider på nynorsk': 'nn' },
  }),
  row({
    id: 'answer.max_tokens',
    cat: 'Svar',
    label: 'Maks lengde på svar',
    desc: 'Lengste svar modellen kan skrive. Lange utkast trenger høyere verdi.',
    type: 'int',
    min: 200,
    max: 4000,
    step: 100,
    unit: 'tokens',
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste'],
    P: 800,
    V: 600,
    svc: { Vedtaksutkast: 2000 },
  }),
  row({
    id: 'answer.citations',
    cat: 'Svar',
    label: 'Kildehenvisning',
    desc: 'Hvordan kilder vises i svaret.',
    type: 'enum',
    opts: [
      ['tittel_side', 'Tittel og side'],
      ['tittel', 'Bare tittel'],
      ['fotnote', 'Fotnoter'],
    ],
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste'],
    P: 'tittel_side',
    V: null,
  }),
  row({
    id: 'model.primary',
    cat: 'Modell',
    label: 'Hovedmodell',
    desc: 'Modellen tjenesten bruker. Stedet for behandling følger modellen.',
    type: 'enum',
    opts: [
      ['borealis', 'Borealis-27B (Norge)'],
      ['qwen', 'Qwen3.8-27B (Norge)'],
      ['gpt41', 'GPT-4.1 (EU)'],
      ['mini', 'GPT-4.1 mini (EU)'],
    ],
    sens: 'Middels',
    scope: ['virksomhet', 'tjeneste'],
    P: 'borealis',
    V: null,
    svc: { Vedtaksutkast: 'gpt41', Søknadsuttrekk: 'qwen', Møtereferat: 'qwen' },
  }),
  row({
    id: 'model.fallback',
    cat: 'Modell',
    label: 'Reservemodell',
    desc: 'Brukes når hovedmodellen ikke svarer innen 20 sekunder.',
    type: 'enum',
    opts: [
      ['mini', 'GPT-4.1 mini (EU)'],
      ['borealis', 'Borealis-27B (Norge)'],
      ['qwen', 'Qwen3.8-27B (Norge)'],
      ['gpt41', 'GPT-4.1 (EU)'],
      ['ingen', 'Ingen'],
    ],
    sens: 'Middels',
    scope: ['virksomhet', 'tjeneste'],
    P: 'mini',
    V: null,
    svc: { Rapportassistenten: 'gpt41', Møtereferat: 'ingen' },
  }),
  row({
    id: 'model.temperature',
    cat: 'Modell',
    label: 'Variasjon i svar',
    desc: 'Lav verdi gir like svar på like spørsmål. Høy verdi gir mer variasjon.',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.1,
    sens: 'Lav',
    scope: ['virksomhet', 'tjeneste'],
    P: 0.2,
    V: null,
  }),
  row({
    id: 'model.azure_key',
    cat: 'Modell',
    label: 'Nøkkel til eget Azure OpenAI-abonnement',
    desc: 'Brukes hvis virksomheten vil betale for Azure OpenAI selv. Verdien vises aldri.',
    type: 'secret',
    sens: 'Hemmelig',
    scope: ['virksomhet'],
    P: null,
    V: 'set',
  }),
  row({
    id: 'guard.pii_before_model',
    cat: 'Vern',
    label: 'Fjern personopplysninger før modellkall',
    desc: 'Bytter ut fødselsnummer og D-nummer, navn, adresse, telefonnummer, e-post og kontonummer før teksten sendes til modellen. Felt i resultatet som trenger en av disse, blir tomme.',
    type: 'bool',
    sens: 'Høy',
    scope: ['virksomhet', 'tjeneste'],
    P: true,
    V: null,
    minRisk: 'Kan ikke slås av for høy risiko.',
    categories: piiCategories,
  }),
  row({
    id: 'guard.pii_out_of_log',
    cat: 'Vern',
    label: 'Hold personopplysninger utenfor loggen',
    desc: 'Lagrer ikke fødselsnummer og D-nummer, navn, adresse, telefonnummer, e-post, kontonummer og helseopplysninger i loggen og tidslinjen. Gjelder også spor til eksterne verktøy.',
    type: 'bool',
    sens: 'Høy',
    scope: ['virksomhet', 'tjeneste'],
    P: true,
    V: null,
    minRisk: 'Kan ikke slås av for høy risiko.',
    categories: [...piiCategories, 'Helseopplysninger'],
  }),
  row({
    id: 'guard.sources_required',
    cat: 'Vern',
    label: 'Kilder påkrevd i svar',
    desc: 'Svar uten kilde blir stoppet og erstattet med «Jeg fant ikke noe om dette».',
    type: 'bool',
    sens: 'Høy',
    scope: ['virksomhet', 'tjeneste'],
    P: true,
    V: null,
    svc: { Møtereferat: false, 'Nettsider på nynorsk': false },
  }),
  row({
    id: 'guard.refuse_topics',
    cat: 'Vern',
    label: 'Tema som skal avvises',
    desc: 'Spørsmål om disse temaene får et høflig avslag. Ett tema per linje.',
    type: 'list',
    sens: 'Høy',
    scope: ['virksomhet', 'tjeneste'],
    P: ['Personopplysninger om enkeltpersoner'],
    V: ['Personopplysninger om enkeltpersoner', 'Lønn for navngitte ansatte'],
  }),
  row({
    id: 'guard.human_approval',
    cat: 'Vern',
    label: 'Menneskelig godkjenning',
    desc: 'Når et menneske må godkjenne resultatet før det sendes videre.',
    type: 'enum',
    opts: [
      ['hoy', 'Ved høy risiko'],
      ['alltid', 'Alltid'],
      ['av', 'Aldri'],
    ],
    sens: 'Høy',
    scope: ['virksomhet', 'tjeneste'],
    P: 'hoy',
    V: null,
    svc: { Vedtaksutkast: 'alltid' },
    rule: '«Aldri» er ikke tillatt for tjenester med høy risiko.',
  }),
  row({
    id: 'ingest.chunk_size',
    cat: 'Innlesing',
    label: 'Størrelse på tekstbiter',
    desc: 'Hvor store biter dokumentene deles i. Mindre biter gir mer presise treff, større gir mer sammenheng.',
    type: 'int',
    min: 200,
    max: 2000,
    step: 50,
    unit: 'tokens',
    sens: 'Lav',
    scope: ['virksomhet', 'datasett'],
    P: 800,
    V: null,
    ds: { 'Kudos-rapporter': 600 },
  }),
  row({
    id: 'ingest.ocr',
    cat: 'Innlesing',
    label: 'Tekstgjenkjenning',
    desc: 'Leser skannede dokumenter. Omtrent 1 øre per side.',
    type: 'bool',
    sens: 'Lav',
    scope: ['virksomhet', 'datasett'],
    P: false,
    V: true,
  }),
  row({
    id: 'ingest.schedule',
    cat: 'Innlesing',
    label: 'Oppdater datasett',
    desc: 'Hvor ofte kilden leses inn på nytt.',
    type: 'enum',
    opts: [
      ['natt', 'Hver natt'],
      ['uke', 'Hver uke'],
      ['manuelt', 'Bare manuelt'],
    ],
    sens: 'Lav',
    scope: ['virksomhet', 'datasett'],
    P: 'natt',
    V: null,
    ds: { 'Veiledere og rundskriv': 'uke', 'Tilsynsrapporter 2025': 'manuelt' },
  }),
  row({
    id: 'limits.max_tokens_run',
    cat: 'Grenser',
    label: 'Maks tokens per kjøring',
    desc: 'Kjøringer som bruker mer, stoppes med en feilmelding.',
    type: 'int',
    min: 4000,
    max: 128000,
    step: 1000,
    unit: 'tokens',
    sens: 'Middels',
    scope: ['virksomhet', 'tjeneste'],
    P: 32000,
    V: null,
    svc: { Høringsoppsummering: 64000 },
    needs: { Vedtaksutkast: 20000, Høringsoppsummering: 48000 },
  }),
  row({
    id: 'limits.retention',
    cat: 'Grenser',
    label: 'Oppbevaring av logg',
    desc: 'Hvor lenge kjøringer og tidslinjer lagres, med én verdi per risikonivå. Høy risiko lagres alltid i 10 år (ikke bestemt).',
    rule: 'Gulv: minst 30 dager på alle nivåer.',
    type: 'risk',
    opts: [
      ['30', '30 dager'],
      ['60', '60 dager'],
      ['90', '90 dager'],
      ['180', '180 dager'],
      ['365', '1 år'],
      ['3650', '10 år'],
    ],
    floor: 30,
    notDecided: true,
    sens: 'Middels',
    scope: ['virksomhet', 'tjeneste'],
    P: { minimal: '30', limited: '90', high: '3650' },
    V: null,
    pins: { Rapportassistenten: ['v11', { minimal: '30', limited: '60', high: '3650' }] },
  }),
  row({
    id: 'limits.queue_key',
    cat: 'Grenser',
    label: 'Nøkkel til meldingskø',
    desc: 'Tilgangsnøkkel for køen «innkommende-post». Verdien vises aldri.',
    type: 'secret',
    sens: 'Hemmelig',
    scope: ['virksomhet'],
    P: null,
    V: 'set',
  }),
];

export const exampleImportRows: [string, string, string, string, string, string, string?][] = [
  ['Virksomhet', 'answer.max_tokens', 'Maks lengde på svar', '600', '800', 'endres'],
  ['Virksomhet', 'ingest.ocr', 'Tekstgjenkjenning', 'På', 'På', 'uendret'],
  [
    'Virksomhet',
    'limits.queue_key',
    'Nøkkel til meldingskø',
    'Lagret i Key Vault',
    'keyvault://testetaten-test/ko-post-nokkel',
    'konflikt',
    'Hemmelighet: bare referansen byttes',
  ],
  ['Rapportassistenten', 'search.top_k', 'Antall treff som leses', '12', '15', 'konflikt'],
  [
    'Rapportassistenten',
    'limits.retention',
    'Oppbevaring av logg',
    '60 dager (festet til v11)',
    '90 dager',
    'konflikt',
    'Festet verdi',
  ],
  [
    'Søknadsuttrekk',
    'model.primary',
    'Hovedmodell',
    'Qwen3.8-27B (Norge)',
    'Qwen3.8-27B (Norge)',
    'uendret',
  ],
  [
    'Klagesortering (ny)',
    '–',
    'Ny tjeneste med 6 innstillinger',
    '–',
    '6 innstillinger',
    'opprettes',
  ],
  ['Kudos-rapporter', 'ingest.chunk_size', 'Størrelse på tekstbiter', '600', '700', 'endres'],
  [
    'Arkivdokumenter (ny)',
    '–',
    'Datasett finnes ikke her',
    '–',
    'Kilde mangler',
    'hoppes',
    'Kilden «Arkiv test» finnes ikke i produksjon',
  ],
];

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
