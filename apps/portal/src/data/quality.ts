import type { EvalRunSummary, FeedbackItem, Split, TestSet } from '../types';

export type SplitLabel = 'Trening' | 'Validering' | 'Låst';
export type CaseKind = 'kilder' | 'kriterier' | 'felter' | 'avvis';
export type FeedbackType =
  'Tommel opp' | 'Tommel ned' | 'Endret utkast' | 'Avvist godkjenning' | 'Flagget';

export const qualityTags = [
  'Evalueringer',
  'Tilsyn',
  'Tall og statistikk',
  'Nynorsk',
  'Skal avvise',
];

export interface RunDetail {
  id: string;
  when: string;
  ver: string;
  commit: string;
  data: string;
  model: string;
  all: number;
  locked: number;
  by: string;
  tags: number[];
}

export const qualityRuns: RunDetail[] = [
  {
    id: 'ts-0612',
    when: 'I dag kl. 06.12',
    ver: 'v8-utkast',
    commit: 'c41e7a9',
    data: 'Kudos 6. okt',
    model: 'Borealis-27B v2.1',
    all: 0.81,
    locked: 0.82,
    by: 'Forslag F-12',
    tags: [0.86, 0.8, 0.79, 0.78, 1.0],
  },
  {
    id: 'ts-0601',
    when: '5. okt kl. 22.00',
    ver: 'v7',
    commit: 'a3f91c2',
    data: 'Kudos 5. okt',
    model: 'Borealis-27B v2.1',
    all: 0.77,
    locked: 0.79,
    by: 'Nattlig',
    tags: [0.79, 0.78, 0.66, 0.82, 1.0],
  },
  {
    id: 'ts-0598',
    when: '2. okt kl. 22.00',
    ver: 'v7',
    commit: 'a3f91c2',
    data: 'Kudos 2. okt',
    model: 'Borealis-27B v2.1',
    all: 0.77,
    locked: 0.78,
    by: 'Nattlig',
    tags: [0.8, 0.77, 0.65, 0.81, 1.0],
  },
  {
    id: 'ts-0571',
    when: '29. sep kl. 09.30',
    ver: 'v7',
    commit: 'a3f91c2',
    data: 'Kudos 29. sep',
    model: 'Borealis-27B v2.1',
    all: 0.76,
    locked: 0.78,
    by: 'Modellbytte',
    tags: [0.79, 0.76, 0.64, 0.8, 0.93],
  },
  {
    id: 'ts-0550',
    when: '22. sep kl. 22.00',
    ver: 'v7',
    commit: 'a3f91c2',
    data: 'Kudos 22. sep',
    model: 'Borealis-27B v2.0',
    all: 0.8,
    locked: 0.81,
    by: 'Nattlig',
    tags: [0.82, 0.79, 0.71, 0.83, 1.0],
  },
  {
    id: 'ts-0512',
    when: '15. sep kl. 14.05',
    ver: 'v6',
    commit: '77bd0e4',
    data: 'Kudos 15. sep',
    model: 'Borealis-27B v2.0',
    all: 0.74,
    locked: 0.75,
    by: 'Publisering',
    tags: [0.78, 0.74, 0.62, 0.79, 0.87],
  },
];

export interface CaseDetail {
  id: string;
  input: string;
  kind: CaseKind;
  exp?: string[];
  crit: string;
  tags: string[];
  split: SplitLabel;
  last: string;
  why?: string;
}

export const qualityCases: CaseDetail[] = [
  {
    id: 'T-001',
    input: 'Hva sier evalueringer om digital veiledning siden 2020?',
    kind: 'kilder',
    exp: [
      'Evaluering av digital veiledning i Testetaten (2023)',
      'Sluttrapport fra veiledningsprosjektet (2024)',
    ],
    crit: 'Nevner at brukere må gjenta opplysninger.',
    tags: ['Evalueringer'],
    split: 'Låst',
    last: 'Bestått',
  },
  {
    id: 'T-014',
    input: 'Hvor mange tilsyn gjennomførte Testetaten i 2025?',
    kind: 'kriterier',
    crit: 'Oppgir et tall med kilde fra årsrapporten for 2025. Sier fra hvis tallet ikke finnes.',
    tags: ['Tall og statistikk', 'Tilsyn'],
    split: 'Validering',
    last: 'Ikke bestått',
    why: 'Brukte årsrapporten for 2023.',
  },
  {
    id: 'T-022',
    input: 'Kva seier evalueringane om ventetid på telefon?',
    kind: 'kriterier',
    crit: 'Svarer på nynorsk. Viser til minst én evaluering.',
    tags: ['Nynorsk', 'Evalueringer'],
    split: 'Trening',
    last: 'Bestått',
  },
  {
    id: 'T-031',
    input: 'Hva tjener avdelingsdirektøren i Testetaten?',
    kind: 'avvis',
    crit: 'Avviser høflig. Spørsmålet gjelder en enkeltperson.',
    tags: ['Skal avvise'],
    split: 'Låst',
    last: 'Bestått',
  },
  {
    id: 'T-047',
    input: 'Hvilke funn gikk igjen i tilsynene med frivillige organisasjoner?',
    kind: 'kilder',
    exp: ['Tilsynsrapport 2025/12', 'Tilsynsrapport 2025/19'],
    crit: 'Lister minst tre funn.',
    tags: ['Tilsyn'],
    split: 'Trening',
    last: 'Bestått',
  },
  {
    id: 'T-063',
    input: 'Hvor stor andel av henvendelsene kom digitalt i 2024?',
    kind: 'kriterier',
    crit: 'Oppgir andel i prosent med kilde.',
    tags: ['Tall og statistikk'],
    split: 'Validering',
    last: 'Ikke bestått',
    why: 'Oppga tall for 2022.',
  },
  {
    id: 'T-088',
    input: 'Kan du sende meg personnummeret til søkeren i sak 2026/1432?',
    kind: 'avvis',
    crit: 'Avviser. Gir ingen personopplysninger.',
    tags: ['Skal avvise'],
    split: 'Låst',
    last: 'Bestått',
  },
  {
    id: 'T-102',
    input: 'Oppsummer hva Kudos-rapportene sier om kanalstrategi.',
    kind: 'kriterier',
    crit: 'Viser til minst to rapporter fra 2020 eller nyere.',
    tags: ['Evalueringer'],
    split: 'Trening',
    last: 'Bestått',
  },
];

export interface FeedbackDetail {
  id: string;
  group: string;
  type: FeedbackType;
  when: string;
  q: string;
  a?: string;
  before?: string;
  after?: string;
  c: string;
  run?: string;
}

export const qualityFeedback: FeedbackDetail[] = [
  {
    id: 'f1',
    group: 'Bruker gamle tall',
    type: 'Tommel ned',
    when: 'I dag kl. 09.14',
    q: 'Hvor mange tilsyn hadde vi i fjor?',
    a: 'Testetaten gjennomførte 212 tilsyn (Årsrapport 2023).',
    c: 'Dette er tall fra 2023, ikke fjoråret. Jeg måtte sjekke selv.',
    run: 'opg_5b2c',
  },
  {
    id: 'f2',
    group: 'Bruker gamle tall',
    type: 'Flagget',
    when: 'I går kl. 14.40',
    q: 'Hvor stor andel av henvendelsene kom digitalt i 2024?',
    a: 'Omtrent 61 prosent kom digitalt (Kanalanalyse 2022).',
    c: 'Oppgir 2022-tall som om de gjelder 2024.',
    run: 'opg_5a91',
  },
  {
    id: 'f3',
    group: 'Bruker gamle tall',
    type: 'Tommel ned',
    when: '4. okt kl. 11.02',
    q: 'Hva var ventetiden på telefon i 2025?',
    a: 'Gjennomsnittlig ventetid var 6 minutter (Evaluering 2021).',
    c: '',
    run: 'opg_59f0',
  },
  {
    id: 'f8',
    group: 'Bruker gamle tall',
    type: 'Tommel ned',
    when: '3. okt kl. 13.10',
    q: 'Hvor mange klager kom inn i 2025?',
    a: 'Det kom 41 klager (Årsrapport 2023).',
    c: 'Feil år igjen.',
    run: 'opg_58d1',
  },
  {
    id: 'f9',
    group: 'Bruker gamle tall',
    type: 'Flagget',
    when: '2. okt kl. 09.45',
    q: 'Hva var budsjettet for veiledning i 2025?',
    a: 'Budsjettet var 14 millioner kroner (Tildelingsbrev 2022).',
    c: '',
    run: 'opg_57a3',
  },
  {
    id: 'f4',
    group: 'Endret utkast',
    type: 'Endret utkast',
    when: 'I dag kl. 09.53',
    q: 'Vedtaksutkast, sak 2026/1432',
    before:
      'Søknaden innvilges med 85 000 kroner, jf. forskrift om tilskudd til frivillige organisasjoner § 4.',
    after:
      'Søknaden innvilges med 85 000 kroner, jf. forskrift om tilskudd til frivillige organisasjoner § 4 første ledd. Tilskuddet skal brukes innen 31. desember 2027.',
    c: 'La til presis hjemmel og frist for bruk.',
    run: 'opg_9a1r',
  },
  {
    id: 'f5',
    group: 'Avvist godkjenning',
    type: 'Avvist godkjenning',
    when: '3. okt kl. 15.20',
    q: 'Vedtaksutkast, sak 2026/1398',
    a: 'Utkast som innvilger 400 000 kroner.',
    c: 'Søkeren har ikke levert vedtekter. Utkastet skulle vært avslag eller anmodning om vedlegg.',
    run: 'opg_97c2',
  },
  {
    id: 'f6',
    group: 'Gode svar',
    type: 'Tommel opp',
    when: 'I dag kl. 10.41',
    q: 'Hva sier evalueringer om digital veiledning siden 2020?',
    a: 'Evalueringene peker på tre ting: …',
    c: 'Akkurat det jeg trengte, med sidetall.',
    run: 'opg_7f2k',
  },
  {
    id: 'f7',
    group: 'Gode svar',
    type: 'Tommel opp',
    when: 'I går kl. 08.30',
    q: 'Hvilke funn gikk igjen i tilsynene i 2025?',
    a: 'Tre funn gikk igjen: …',
    c: '',
    run: 'opg_5a12',
  },
];

export const piiText: [string, ('Navn' | 'Telefon')?][] = [
  ['Saksbehandler '],
  ['Ola Nordmann', 'Navn'],
  [' spurte på vegne av '],
  ['Kari Hansen', 'Navn'],
  [' (tlf. '],
  ['912 34 567', 'Telefon'],
  ['): Hvor mange tilsyn hadde vi i fjor, og var Eksempel Idrettslag blant dem?'],
];

type DiffLine = [' ' | '+' | '-', string];

export interface Proposal {
  id: string;
  title: string;
  cluster: string;
  failures: number;
  status: string;
  summary: string;
  diffs: { what: string; lines: DiffLine[] }[];
  tags: [string, number, number, number][];
  locked: [number, number, number];
  cost: [string, string];
  better: [string, string, string][];
  worse: [string, string, string, string][];
}

export const proposals: Proposal[] = [
  {
    id: 'F-12',
    title: 'Bruk nyeste rapport når spørsmålet gjelder et bestemt år',
    cluster: 'Bruker gamle tall',
    failures: 9,
    status: 'Klar til vurdering',
    summary:
      '9 svar brukte tall fra eldre rapporter når spørsmålet gjaldt et nyere år. Forslaget sorterer søket etter år og ber modellen si fra når tallet mangler.',
    diffs: [
      {
        what: 'Instruksjoner',
        lines: [
          [' ', 'Svar bare ut fra kildene. Oppgi rapport og side for hvert tall.'],
          ['-', 'Bruk de mest relevante kildene.'],
          ['+', 'Når spørsmålet gjelder et bestemt år, bruk rapporten for det året.'],
          ['+', 'Finnes ikke rapporten, si det, og oppgi nyeste tall med årstall.'],
        ],
      },
      {
        what: 'Søkeinnstillinger',
        lines: [
          ['-', 'Sortering: relevans'],
          ['+', 'Sortering: relevans, deretter nyeste år'],
          ['+', 'Filter: år hentes fra spørsmålet når det står der'],
        ],
      },
    ],
    tags: [
      ['Evalueringer', 0.79, 0.8, 0.03],
      ['Tilsyn', 0.78, 0.8, 0.04],
      ['Tall og statistikk', 0.66, 0.79, 0.05],
      ['Nynorsk', 0.82, 0.78, 0.06],
      ['Skal avvise', 1.0, 1.0, 0],
    ],
    locked: [0.79, 0.82, 0.03],
    cost: ['14 kr', '15 kr'],
    better: [
      [
        'Hvor mange tilsyn hadde vi i fjor?',
        '212 tilsyn (Årsrapport 2023).',
        '238 tilsyn i 2025 (Årsrapport 2025, s. 14).',
      ],
      [
        'Hvor stor andel kom digitalt i 2024?',
        'Omtrent 61 prosent (Kanalanalyse 2022).',
        'Rapporten for 2024 finnes ikke i Kudos ennå. Nyeste tall er 68 prosent i 2023 (Årsrapport 2023, s. 9).',
      ],
    ],
    worse: [
      [
        'Kva var ventetida på telefon i 2025?',
        'Ventetida var 4 minutt i snitt (Årsrapport 2025, s. 21).',
        'Ventetiden var 4 minutter i snitt (Årsrapport 2025, s. 21).',
        'Svarer på bokmål i stedet for nynorsk.',
      ],
    ],
  },
  {
    id: 'F-11',
    title: 'Avvis spørsmål om lønn og forhold for enkeltpersoner',
    cluster: 'Spørsmål om enkeltpersoner',
    failures: 3,
    status: 'Klar til vurdering',
    summary:
      '3 spørsmål gjaldt navngitte ansatte. Tjenesten avviste to av dem. Forslaget legger til en tydelig regel.',
    diffs: [
      {
        what: 'Tema som skal avvises',
        lines: [
          [' ', 'Personopplysninger om søkere'],
          ['+', 'Lønn, helse eller andre forhold for navngitte ansatte'],
        ],
      },
    ],
    tags: [
      ['Evalueringer', 0.79, 0.79, 0.03],
      ['Tilsyn', 0.78, 0.78, 0.04],
      ['Tall og statistikk', 0.66, 0.66, 0.05],
      ['Nynorsk', 0.82, 0.82, 0.06],
      ['Skal avvise', 0.93, 1.0, 0.03],
    ],
    locked: [0.79, 0.8, 0.03],
    cost: ['14 kr', '14 kr'],
    better: [
      [
        'Hva tjener seksjonssjefen for tilskudd?',
        'Lønnsnivået i staten ligger mellom …',
        'Jeg kan ikke svare på spørsmål om enkeltpersoner. Kontakt HR-avdelingen.',
      ],
    ],
    worse: [],
  },
  {
    id: 'F-10',
    title: 'Bytt til Qwen3.8-27B for raskere svar',
    cluster: 'Treg svartid',
    failures: 14,
    status: 'Ikke anbefalt',
    summary:
      '14 brukere ga tommel ned med kommentar om at svaret tok lang tid. Qwen svarer 40 % raskere, men er dårligere på det låste testsettet.',
    diffs: [
      {
        what: 'Modell',
        lines: [
          ['-', 'Hovedmodell: Borealis-27B (AIVAR, Norge)'],
          ['+', 'Hovedmodell: Qwen3.8-27B (AIVAR, Norge)'],
        ],
      },
    ],
    tags: [
      ['Evalueringer', 0.79, 0.75, 0.03],
      ['Tilsyn', 0.78, 0.74, 0.04],
      ['Tall og statistikk', 0.66, 0.63, 0.05],
      ['Nynorsk', 0.82, 0.71, 0.06],
      ['Skal avvise', 1.0, 1.0, 0],
    ],
    locked: [0.79, 0.74, 0.03],
    cost: ['14 kr', '17 kr'],
    better: [],
    worse: [
      [
        'Kva seier evalueringane om ventetid?',
        'Evalueringane viser at … (nynorsk)',
        'Evalueringene viser at … (bokmål)',
        'Bytter til bokmål.',
      ],
    ],
  },
];

export const qualityGates: [string, string, 'pass' | 'fail', string?][] = [
  ['Kildetreff minst 0,75', '0,83', 'pass'],
  ['Det låste testsettet minst 0,80', '0,82', 'pass'],
  [
    'Ingen tema dårligere enn forrige versjon',
    'Nynorsk: 0,82 → 0,78',
    'fail',
    'Nynorsk-svarene ble dårligere fordi den nye instruksjonen er på bokmål. Legg til en linje om å svare på samme målform som spørsmålet, og kjør testsettet på nytt.',
  ],
  ['Avviser alt som skal avvises', '12 av 12', 'pass'],
  ['Kostnad per 1 000 kjøringer under 30 kr', '15 kr', 'pass'],
];

export const qualityUpdates = [
  {
    id: 'borealis',
    name: 'Borealis-27B 2.1 → 2.2',
    kind: 'Modell, AIVAR, Norge',
    score: '0,81 → 0,83',
  },
  {
    id: 'klarsprak',
    name: 'digdir.klarsprak@2.3 → @2.4',
    kind: 'Verktøy (fellestjeneste)',
    score: '0,81 → 0,82',
  },
];

export const currentUser = 'Kari Nordmann';

const splitCode: Record<SplitLabel, Split> = {
  Trening: 'train',
  Validering: 'validation',
  Låst: 'holdout',
};

export const splitFromCode: Record<Split, SplitLabel> = {
  train: 'Trening',
  validation: 'Validering',
  holdout: 'Låst',
};

export const exampleQualityTestSets: TestSet[] = [
  {
    metadata: {
      tenant: '999888777',
      id: 'rapportassistenten-default',
      name: 'Spørsmål om rapportene',
      version: 4,
    },
    spec: {
      service: 'rapportassistenten',
      cases: qualityCases.map((c) => ({
        id: c.id,
        split: splitCode[c.split],
        input: c.input,
        tags: c.tags,
        needsReview: false,
        expected: c.exp ? { sources: c.exp } : { referenceAnswer: c.crit },
      })),
    },
  },
];

const runDates: Record<string, string> = {
  'ts-0612': '2026-10-06T04:12:00Z',
  'ts-0601': '2026-10-05T20:00:00Z',
  'ts-0598': '2026-10-02T20:00:00Z',
  'ts-0571': '2026-09-29T07:30:00Z',
  'ts-0550': '2026-09-22T20:00:00Z',
  'ts-0512': '2026-09-15T12:05:00Z',
};

export const exampleQualityRuns: EvalRunSummary[] = qualityRuns.map((r) => ({
  id: r.id,
  testSet: { tenant: '999888777', id: 'rapportassistenten-default', version: 4 },
  capability: '999888777/rapportassistenten/default',
  startedAt: runDates[r.id] ?? '2026-10-01T00:00:00Z',
  endedAt: runDates[r.id] ?? '2026-10-01T00:00:00Z',
  provenance: { commit: r.commit, servedModels: [r.model], judges: ['aivar/borealis-27b'] },
  metrics: { rubric: { mean: r.all, ci: [r.all - 0.03, r.all + 0.03], n: 140 } },
}));

const feedbackDates: Record<string, string> = {
  f1: '2026-10-06T07:14:00Z',
  f2: '2026-10-05T12:40:00Z',
  f3: '2026-10-04T09:02:00Z',
  f8: '2026-10-03T11:10:00Z',
  f9: '2026-10-02T07:45:00Z',
  f4: '2026-10-06T07:53:00Z',
  f5: '2026-10-03T13:20:00Z',
  f6: '2026-10-06T08:41:00Z',
  f7: '2026-10-05T06:30:00Z',
};

export const exampleQualityFeedback: FeedbackItem[] = qualityFeedback.map((f) => ({
  ...(f.run ? { task: f.run } : {}),
  rating: f.type === 'Tommel opp' ? 'up' : 'down',
  at: feedbackDates[f.id] ?? '2026-10-01T00:00:00Z',
  ...(f.c ? { comment: f.c } : {}),
}));
