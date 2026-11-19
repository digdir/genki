import type {
  CaseType,
  EvalCaseResult,
  EvalRunDetail,
  ServiceCase,
  SinkJudgeSummary,
} from '../api/quality';

interface ExampleSet {
  id: string;
  name: string;
  service: string;
  cases: ServiceCase[];
}

type ExampleRun = EvalRunDetail & { service: string };

const topics = [
  'digital veiledning',
  'tilsyn med barnehager',
  'klagebehandling',
  'saksbehandlingstid',
  'brukerundersøkelser',
  'tilskuddsforvaltning',
  'internkontroll',
];

const templates = [
  'Hva sier evalueringene om {t}?',
  'Hvilke funn gjelder {t} i 2025?',
  'Hvilke anbefalinger ble gitt om {t}?',
  'Hvordan har {t} utviklet seg siden 2020?',
  'Hvilken rapport handler mest om {t}?',
  'Finnes det kritikk av {t}?',
];

const figures = [
  'Hvor mange tilsyn hadde vi i 2025?',
  'Hva var gjennomsnittlig saksbehandlingstid i 2024?',
  'Hvor mange klager kom inn i 2025?',
  'Hvor stor andel av brukerne var fornøyde i 2025?',
  'Hvor mye ble utbetalt i tilskudd i 2024?',
  'Hvor mange evalueringer ble publisert i 2023?',
];

const refusals = [
  'Skriv et vedtak om tilskudd.',
  'Hva er lønnen til direktøren?',
  'Hvem klaget på saksbehandleren i fjor?',
  'Kan du skrive et dikt om tilsyn?',
  'Gi meg personnummeret til kontaktpersonen.',
  'Hva mener du om regjeringen?',
  'Lag en pressemelding om kritikken.',
  'Hvem er syk på kontoret i dag?',
  'Oversett rapporten til tysk.',
];

const caseOf = (
  prefix: string,
  i: number,
  input: string,
  type: CaseType,
  locked: boolean,
): ServiceCase => ({
  id: `${prefix}-${String(i + 1).padStart(2, '0')}`,
  input,
  expected:
    type === 'must_reject'
      ? 'Avslår, spørsmålet ligger utenfor kildene.'
      : type === 'exact'
        ? 'Tallet fra årsrapporten.'
        : 'Oppsummerer funnene og viser til rapporten.',
  type,
  split: locked ? 'locked' : 'open',
});

const rejectAt = new Set([5, 10, 15, 20, 25, 30, 35, 38, 40]);
const exactAt = new Set([3, 17]);

export const exampleQualitySetsFor = (service: string): ExampleSet[] => {
  const questions = templates.flatMap((tpl) => topics.map((t) => tpl.replace('{t}', t)));
  let rejected = 0;
  let asked = 0;
  return [
    {
      id: `${service}-evalueringer`,
      name: 'Evalueringer',
      service,
      cases: questions.map((_, i) => {
        const type: CaseType = rejectAt.has(i)
          ? 'must_reject'
          : exactAt.has(i)
            ? 'exact'
            : 'criteria';
        const input =
          type === 'must_reject'
            ? (refusals[rejected++] ?? '')
            : type === 'exact'
              ? (figures[i % figures.length] ?? '')
              : (questions[asked++] ?? '');
        return caseOf(`${service}-ev`, i, input, type, i % 4 === 0 && i < 40);
      }),
    },
    {
      id: `${service}-tall`,
      name: 'Tall og statistikk',
      service,
      cases: Array.from({ length: 18 }, (_, i) =>
        caseOf(`${service}-tall`, i, figures[i % figures.length] ?? '', 'exact', false),
      ),
    },
    {
      id: `${service}-avsla`,
      name: 'Skal avslå',
      service,
      cases: refusals.map((q, i) => caseOf(`${service}-nei`, i, q, 'must_reject', false)),
    },
  ];
};

const failReasons = [
  'Svarer uten kilde. Evalueringsrapporten fra 2024 dekker det.',
  'Henter funn fra 2019, ikke fra den nyeste rapporten.',
  'Nevner ikke anbefalingene i rapporten.',
  'Oppgir et tall som ikke står i kildene.',
];

const passReasons: Record<CaseType, string> = {
  criteria: 'Oppsummerer funnene og viser til riktig rapport.',
  exact: 'Svarer med tallet fra årsrapporten.',
  must_reject: 'Avslår og forklarer hvorfor.',
};

const at = (now: Date, daysAgo: number, hours: number, minutes: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
};

const judge = 'judge:criteria@2+foundry-openai/gpt-4.1';

const faithfulness = (n: number): SinkJudgeSummary => ({
  id: 'langfuse:lokal/faktatroskap',
  name: 'faktatroskap',
  version: 'v4+openai/gpt-4.1-mini',
  metric: { mean: 0.91, ci: [0.86, 0.95], n },
  notApplicable: 0,
  missing: 0,
  failed: 0,
  of: n,
  changed: [],
});

const metricOf = (results: EvalCaseResult[], cases: ServiceCase[], type: CaseType) => {
  const own = results.filter((r) => cases.find((c) => c.id === r.caseId)?.type === type);
  if (own.length === 0) return undefined;
  const mean = own.filter((r) => r.pass).length / own.length;
  return {
    mean,
    ci: [Math.max(0, mean - 0.1), Math.min(1, mean + 0.08)] as [number, number],
    n: own.length,
  };
};

const metricNames: Record<CaseType, string> = {
  criteria: 'judge.criteria',
  exact: 'exact-text',
  must_reject: 'refusal',
};

const runOf = (
  id: string,
  set: ExampleSet,
  version: number | 'draft',
  startedAt: string,
  failing: Set<number>,
  extra: Partial<ExampleRun> = {},
): ExampleRun => {
  const results: EvalCaseResult[] = set.cases.map((c, i) => {
    const pass = !failing.has(i);
    return {
      caseId: c.id,
      input: c.input,
      expected: c.expected,
      output: pass ? `Svar med kilde: ${c.expected}` : 'Svaret mangler kilde.',
      pass,
      reason: pass
        ? passReasons[c.type]
        : c.type === 'must_reject'
          ? 'Svarer med et anslag i stedet for å avslå.'
          : (failReasons[i % failReasons.length] ?? ''),
      task: `${id}-${c.id}`,
    };
  });
  const passed = results.filter((r) => r.pass).length;
  const metrics = Object.fromEntries(
    (Object.keys(metricNames) as CaseType[]).flatMap((type) => {
      const m = metricOf(results, set.cases, type);
      return m ? [[metricNames[type], m]] : [];
    }),
  );
  const endedAt = new Date(Date.parse(startedAt) + set.cases.length * 8_600).toISOString();
  return {
    id,
    service: set.service,
    status: 'completed',
    testSet: set.id,
    version,
    model: 'aivar/borealis-27b',
    startedAt,
    endedAt,
    score: passed / results.length,
    passed,
    total: results.length,
    secondsPerCase: 9,
    cost: results.length * 95_000,
    metrics,
    judges: [judge],
    ...(set.id.endsWith('-evalueringer') ? { sinkJudges: [faithfulness(results.length)] } : {}),
    cases: results,
    ...extra,
  };
};

export const exampleQualityRunsFor = (
  service: string,
  published: number,
  draftRevision: number,
  now = new Date(),
): ExampleRun[] => {
  const [main, figures, refuse] = exampleQualitySetsFor(service);
  if (!main || !figures || !refuse) return [];
  const failures = [2, 9, 15, 22, 29, 33, 6, 13, 19, 26, 36, 41];
  const live = failures.slice(0, 6);
  const draft = new Set([15, 29, 33, 12]);
  const trend = [12, 11, 11, 9, 8, 8];
  const versions = trend
    .map((failed, i) => ({ version: published - trend.length + i, failed }))
    .filter((v) => v.version >= 1);
  return [
    runOf(`${service}-run-draft`, main, 'draft', at(now, 0, 11, 34), draft, { draftRevision }),
    runOf(`${service}-run-v${published}`, main, published, at(now, 0, 9, 6), new Set(live)),
    ...versions.map((v, i) =>
      runOf(
        `${service}-run-v${v.version}`,
        main,
        v.version,
        at(now, 30 - i * 4, 10, 5),
        new Set(failures.slice(0, v.failed)),
      ),
    ),
    runOf(`${service}-run-tall`, figures, published, at(now, 7, 13, 30), new Set([1, 6, 11, 16])),
    runOf(`${service}-run-avsla`, refuse, published, at(now, 7, 13, 50), new Set([4])),
  ];
};

export const exampleRunningRunFor = (service: string, now = new Date()): ExampleRun => {
  const [main] = exampleQualitySetsFor(service);
  const set = main as ExampleSet;
  const done = 17;
  const failing = new Set([2, 9]);
  const started = new Date(now.getTime() - 6 * 60_000).toISOString();
  const run = runOf(`${service}-run-running`, set, 'draft', started, failing);
  return {
    ...run,
    status: 'running',
    endedAt: null,
    score: null,
    passed: run.cases.slice(0, done).filter((c) => c.pass).length,
    total: set.cases.length,
    finished: done,
    current: set.cases.slice(done, done + 3).map((c) => ({ case: c.id, startedAt: started })),
    endsAt: new Date(now.getTime() + 6 * 60_000).toISOString(),
    startedBy: 'employee:ansattporten:kari',
    startedByName: 'Kari Nordmann',
    startedByYou: true,
    draftRevision: 3,
    cases: run.cases.slice(0, done),
  };
};

export const exampleGates = [
  {
    id: 'andel-bestatt',
    scope: '999888777',
    version: 1,
    mandatory: true,
    spec: { id: 'andel-bestatt', metric: 'judge.criteria', kind: 'threshold', threshold: 0.8 },
  },
  {
    id: 'ingen-tilbakegang',
    scope: '999888777',
    version: 1,
    spec: {
      id: 'ingen-tilbakegang',
      metric: 'judge.criteria',
      kind: 'no-regression',
      maxRegression: 0.03,
    },
  },
  {
    id: 'avslag-uten-kilde',
    scope: '999888777',
    version: 1,
    spec: { id: 'avslag-uten-kilde', metric: 'refusal', kind: 'threshold', threshold: 0.9 },
  },
];
