import type { Locale } from '@genai/i18n';
import { PROVENANCE_MIME } from './provenance';
import { tableFrom } from './ResultTable';
import type {
  Approval,
  ApprovalsApi,
  ChatFailure,
  ChatMessage,
  ChatReply,
  DocumentDraft,
  FailedRun,
  ServiceOption,
  TableReview,
  WorkspaceApi,
  WrittenStandard,
} from './types';

export const caseworker = {
  name: 'Per Hansen',
  organisations: [{ orgNumber: '999888777', name: 'Testetaten' }],
};

export const exampleServices: ServiceOption[] = [
  {
    id: 'rapportassistenten',
    name: 'Rapportassistenten',
    processing: 'i Norge, av språkmodellen Borealis-27B hos AIVAR',
    prompt: 'Still et spørsmål om rapportene',
  },
];

const ministries = [
  'Arbeids- og inkluderingsdepartementet',
  'Barne- og familiedepartementet',
  'Digitaliserings- og forvaltningsdepartementet',
  'Energidepartementet',
  'Finansdepartementet',
  'Forsvarsdepartementet',
  'Helse- og omsorgsdepartementet',
  'Justis- og beredskapsdepartementet',
  'Klima- og miljødepartementet',
  'Kommunal- og distriktsdepartementet',
  'Kultur- og likestillingsdepartementet',
  'Kunnskapsdepartementet',
  'Landbruks- og matdepartementet',
  'Nærings- og fiskeridepartementet',
  'Samferdselsdepartementet',
  'Testdepartementet',
  'Utenriksdepartementet',
];

const agencies = [
  'Statens eksempelverk',
  ...['Arkiv', 'Bygg', 'Data', 'Energi', 'Fiske', 'Helse', 'Kyst', 'Mat'].flatMap((w) =>
    ['direktoratet', 'tilsynet', 'etaten'].map((e) => `${w}${e}`),
  ),
];

export const exampleFormService: ServiceOption = {
  id: 'maloppnaelse__default',
  name: 'Vurdering av måloppnåelse',
  description:
    'Vurderer hvordan en virksomhet har nådd målene i tildelingsbrevet, ut fra årsrapporten.',
  processing: 'i Norge, av språkmodellen Borealis-27B hos AIVAR',
  inputFields: [
    {
      id: 'ministry',
      label: 'Departement',
      kind: 'choice',
      required: true,
      help: `Søk blant ${ministries.length} departementer.`,
      options: ministries,
    },
    {
      id: 'agency',
      label: 'Virksomhet',
      kind: 'organisation',
      required: true,
      help: 'Søk på navn.',
      options: agencies,
      dependsOn: 'ministry',
    },
    {
      id: 'year',
      label: 'År',
      kind: 'choice',
      required: true,
      help: 'Årene det finnes årsrapporter for.',
      options: ['2025', '2024', '2023', '2022', '2021'],
    },
  ],
};

const goalSource = (page: number, excerpt: string) => [
  {
    document: 'kudos:arsrapport-2025',
    title: 'Årsrapport 2025, Statens eksempelverk',
    url: 'https://kudos.dfo.no',
    page,
    excerpt,
    version: '2',
    published_at: '2026-03-15',
  },
];

export const exampleGoalTable = {
  title: 'Måloppnåelse 2025, Statens eksempelverk',
  columns: [
    { key: 'goal', label: 'Mål i tildelingsbrevet', kind: 'document' },
    { key: 'report', label: 'Hva årsrapporten sier', kind: 'document' },
    {
      key: 'assessment',
      label: 'Vurdering',
      kind: 'assessment',
      values: ['Nådd', 'Delvis nådd', 'Ikke nådd', 'Ikke omtalt'],
    },
    { key: 'reason', label: 'Begrunnelse', kind: 'assessment' },
  ],
  rows: [
    [
      'Mål 1: Raskere saksbehandling',
      'Saksbehandlingstiden gikk ned fra 41 til 28 dager.',
      'Nådd',
      'Bedre enn målet på 30 dager.',
      4,
    ],
    [
      'Mål 2: Flere digitale søknader',
      '86 prosent av søknadene kom digitalt.',
      'Delvis nådd',
      'Under målet på 90 prosent.',
      6,
    ],
    [
      'Mål 3: Redusere sykefravær',
      'Sykefraværet var 6,9 prosent.',
      'Ikke nådd',
      'Målet var under 6 prosent.',
      12,
    ],
    ['Mål 4: Arkiv', '', 'Ikke omtalt', 'Årsrapporten nevner ikke arkivarbeidet.', 0],
  ].map(([goal, report, assessment, reason, page]) => ({
    cells: {
      goal: { value: goal, sources: [] },
      report: {
        value: report,
        sources: page ? goalSource(page as number, report as string) : [],
      },
      assessment: {
        value: assessment,
        sources: page ? goalSource(page as number, report as string) : [],
      },
      reason: { value: reason, sources: [] },
    },
  })),
  skipped: [],
};

export const exampleConversation: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    lang: 'nb',
    text: 'Hva sier evalueringer om digital veiledning siden 2020?',
  },
  {
    id: 'a1',
    role: 'assistant',
    lang: 'nb',
    task: 'task-a1',
    text: 'Evalueringene peker på tre ting:\n1. Telefonhenvendelsene gikk ned med 18 prosent fra 2022 til 2024.\n2. Brukerne må ofte gjenta opplysninger når de går fra chat til telefon.\n3. Brukere over 67 år bruker lite de digitale kanalene.',
    sources: [
      { title: 'Evaluering av digital veiledning i Testetaten (2023), side 4–9', url: '#' },
      { title: 'Sluttrapport fra veiledningsprosjektet (2024), side 12–15', url: '#' },
    ],
  },
  {
    id: 'u2',
    role: 'user',
    lang: 'nn',
    text: 'Kva seier rapportane om ventetida på telefon?',
  },
  {
    id: 'a2',
    role: 'assistant',
    lang: 'nn',
    task: 'task-a2',
    text: 'Ventetida på telefon gjekk ned frå 9 til 4 minutt i snitt frå 2022 til 2025.',
    sources: [{ title: 'Årsrapport 2025, side 21', url: '#' }],
  },
];

const refusedExample: ChatFailure = {
  kind: 'refused',
  message:
    'Tjenesten svarer ikke på spørsmål om lønn, helse eller andre forhold for enkeltpersoner. Kontakt HR-avdelingen.',
};

const noSourcesExample: ChatFailure = {
  kind: 'no-sources',
  message:
    'Jeg fant ikke noe i rapportene som svarer på dette, så jeg svarer ikke. Prøv andre ord, eller søk direkte i Kudos.',
};

export const exampleFailures: ChatMessage[] = [
  { id: 'e1u', role: 'user', lang: 'nb', text: 'Oppsummer tilsynsrapportene fra 2025.' },
  { id: 'e1', role: 'assistant', lang: 'nb', text: '', sources: [], failure: { kind: 'quota' } },
  { id: 'e2u', role: 'user', lang: 'nb', text: 'Hva sier evalueringene om chat?' },
  {
    id: 'e2',
    role: 'assistant',
    lang: 'nb',
    text: '',
    sources: [],
    failure: { kind: 'unavailable' },
  },
  { id: 'e3u', role: 'user', lang: 'nb', text: 'Hva tjener avdelingsdirektøren?' },
  {
    id: 'e3',
    role: 'assistant',
    lang: 'nb',
    text: '',
    sources: [],
    failure: refusedExample,
  },
  { id: 'e4u', role: 'user', lang: 'nb', text: 'Hva sier rapportene om kantinedriften?' },
  {
    id: 'e4',
    role: 'assistant',
    lang: 'nb',
    text: '',
    sources: [],
    failure: noSourcesExample,
  },
];

export const exampleApprovals: Approval[] = [
  {
    id: 'g1',
    service: 'Vedtaksutkast',
    caseNumber: '2026/1432',
    title: 'Vedtak om tilskudd til Eksempel Idrettslag',
    due: 'i dag',
    dueColor: 'danger',
    assignedTo: 'Saksbehandlere tilskudd',
    text: 'Vi har behandlet søknaden fra Eksempel Idrettslag om tilskudd til aktiviteter for barn og unge. Dere får 85 000 kroner.\n\nVedtaket er gjort etter forskrift om tilskudd til frivillige organisasjoner § 4 første ledd.',
    basisUrl: 'https://portal.example.no/#/log/task-1432',
  },
  {
    id: 'g2',
    service: 'Vedtaksutkast',
    caseNumber: '2026/1440',
    title: 'Vedtak om tilskudd til Elvebakken Musikkorps',
    due: 'i morgen',
    dueColor: 'warning',
    assignedTo: 'Saksbehandlere tilskudd',
    text: 'Vi har behandlet søknaden fra Elvebakken Musikkorps. Søknaden avslås fordi vedtektene ikke er levert.\n\nDere kan søke på nytt når vedtektene er klare.',
    basisUrl: 'https://portal.example.no/#/log/task-1440',
  },
  {
    id: 'g3',
    service: 'Svar på innsynskrav',
    caseNumber: '2026/1452',
    title: 'Svar på innsynskrav fra Prøveavisa',
    due: '9. oktober',
    dueColor: 'neutral',
    assignedTo: 'Deg',
    text: 'Vi gir innsyn i dokument 3 og 4 i saken. Dokument 5 er unntatt etter offentleglova § 13 fordi det inneholder taushetsbelagte opplysninger.',
    basisUrl: 'https://portal.example.no/#/log/task-1452',
  },
];

export const exampleDraft: DocumentDraft = {
  agency: 'Testetaten',
  caseNumber: '2026/1432',
  createdAt: '2026-10-06T07:12:00Z',
  serviceName: 'Vedtaksutkast',
  sourceLabels: {
    'sak-2026-1432': 'søknaden og vedleggene i sak 2026/1432',
    'forskrift-tilskudd-4': 'forskriften § 4',
  },
  parts: [
    {
      mime: 'text/markdown',
      body: { kind: 'text', text: '# Vedtak om tilskudd til Eksempel Idrettslag' },
    },
    {
      mime: 'text/plain',
      body: {
        kind: 'text',
        text: 'Vi har behandlet søknaden fra Eksempel Idrettslag om tilskudd til aktiviteter for barn og unge. Dere får 85 000 kroner.\n\nVedtaket er gjort etter forskrift om tilskudd til frivillige organisasjoner § 4 første ledd. Søknaden oppfyller vilkårene, og alle påkrevde vedlegg er levert.\n\nTilskuddet skal brukes innen 31. desember 2027. Dere kan klage på vedtaket innen tre uker fra dere fikk det.\n\nMed hilsen\n[Navnet på saksbehandleren settes inn ved godkjenning]',
      },
    },
    {
      mime: PROVENANCE_MIME,
      body: {
        kind: 'json',
        json: {
          task: 'task-1432',
          service: {
            capability: { id: 'testetaten.vedtaksutkast', version: '7' },
            strategy: { id: 'single_step', version: '1' },
            configHash: 'c0ffee',
          },
          models: ['borealis-27b'],
          sources: ['sak-2026-1432', 'forskrift-tilskudd-4'],
          aiDisclosure: 'Utkast laget med KI',
        },
      },
    },
  ],
};

const reply = (text: string, sources: ChatReply['sources']): ChatReply => ({
  text,
  sources,
  task: `task-${Math.random().toString(36).slice(2, 10)}`,
});

export const mockWorkspaceApi = (delayMs = 0): WorkspaceApi => {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  let standard: WrittenStandard = 'user';
  let language: Locale | null = null;
  const reviews = new Map<string, TableReview>();
  const reviewOf = (task: string) =>
    reviews.get(task) ?? { edits: [], approval: { status: 'draft' as const } };
  return {
    writtenStandard: async () => {
      await wait();
      return standard;
    },
    setWrittenStandard: async (_tenant, value) => {
      await wait();
      standard = value;
    },
    language: async () => {
      await wait();
      return language;
    },
    setLanguage: async (_tenant, value) => {
      await wait();
      language = value;
    },
    tableReview: async (_tenant, task) => {
      await wait();
      return reviewOf(task);
    },
    saveTableEdits: async (_tenant, task, edits) => {
      await wait();
      const next = {
        ...reviewOf(task),
        edits: edits.map((e) => ({ ...e, byName: caseworker.name })),
      };
      reviews.set(task, next);
      return next;
    },
    approveTable: async (_tenant, task) => {
      await wait();
      const next: TableReview = {
        ...reviewOf(task),
        approval: { status: 'approved', byName: caseworker.name, at: new Date().toISOString() },
      };
      reviews.set(task, next);
      return next;
    },
    listServices: async () => {
      await wait();
      return [...exampleServices, exampleFormService];
    },
    chat: async (service, history, onDelta) => {
      await wait();
      if (service === exampleFormService.id && history.length === 1) {
        const table = tableFrom(exampleGoalTable);
        return {
          text: '',
          sources: [],
          task: `task-${Math.random().toString(36).slice(2, 10)}`,
          ...(table ? { table } : {}),
        };
      }
      const question = history[history.length - 1]?.content.toLowerCase() ?? '';
      if (/lønn|tjener/.test(question)) return { text: '', sources: [], failure: refusedExample };
      if (/kantine/.test(question)) return { text: '', sources: [], failure: noSourcesExample };
      const answer =
        'Tilsynene i 2025 fant oftest mangler i rapporteringen og i dokumentasjonen av bruken av midler.';
      const words = answer.split(' ');
      words.forEach((_, i) => onDelta(words.slice(0, i + 1).join(' ')));
      return reply(answer, [
        { title: 'Tilsynsrapport 2025/12, side 3', url: '#' },
        { title: 'Tilsynsrapport 2025/19, side 5', url: '#' },
      ]);
    },
    sendFeedback: async () => {
      await wait();
    },
    failedRuns: async () => {
      await wait();
      return exampleFailedRuns;
    },
  };
};

export const exampleFailedRuns: FailedRun[] = [
  {
    id: 'task-feil-1',
    service: 'maloppnaelse',
    serviceName: 'Vurdering av måloppnåelse',
    at: '2026-10-07T08:14:00Z',
    reason:
      'Steget «Finn dokumenter» feilet. Fant ingen årsrapport for 2025 fra Statens eksempelverk. Sjekk året og virksomheten.',
  },
  {
    id: 'task-feil-2',
    service: 'soknadsuttrekk',
    serviceName: 'Søknadsuttrekk',
    at: '2026-10-06T12:02:00Z',
    reason:
      'Steget «Les ett dokument» feilet. Filen søknad_0412.pdf er passordbeskyttet. Last opp en fil uten passord.',
  },
  {
    id: 'task-feil-3',
    service: 'rapportassistenten',
    serviceName: 'Rapportassistenten',
    at: '2026-10-05T07:30:00Z',
    reason: 'Vi fikk ikke svar fra modellen. Det var et midlertidig problem. Prøv igjen.',
  },
];

export const mockApprovalsApi = (
  items: Approval[] = exampleApprovals,
  delayMs = 0,
): ApprovalsApi => {
  let pending = [...items];
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    listPending: async () => {
      await wait();
      return pending;
    },
    resolve: async (id) => {
      await wait();
      pending = pending.filter((a) => a.id !== id);
    },
  };
};
