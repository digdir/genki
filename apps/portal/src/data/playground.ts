import type {
  PlaygroundInput,
  PlaygroundInputField,
  PlaygroundModelOption,
  PlaygroundOptions,
  PlaygroundResult,
  PlaygroundRunRequest,
  PlaygroundRunResponse,
  PlaygroundServiceVersion,
  PlaygroundSetup,
  PlaygroundSource,
  PlaygroundStreamEvent,
  RunStats,
} from '../api/playground';
import { createFormat, type Format } from '@genai/i18n';
import { notPricedLabel } from '../format';
import { translator, type PlainKey, type T } from '../i18n';
import type { Residency, TimelineStep } from '../types';

const nbFormat = createFormat('nb');
const nbT = translator('nb');

export const sampleFileName = 'Søknad_2025_007.pdf';
export const evaluationQuestion = 'Hva sier evalueringene om digital veiledning?';
export const decisionQuestion =
  'Eksempel IL søker om 120 000 kr til nytt øvingslokale. Alle vilkår er oppfylt. Lag et vedtak.';
export const phoneQuestion = 'Hva står det i årsrapporten om ventetid på telefon?';

const draftOf = (setup: PlaygroundServiceVersion['setup'], version: number) => ({
  latestVersion: version - 1,
  versions: [
    { version, draft: true, inUse: false, setup },
    { version: version - 1, draft: false, inUse: true, setup },
  ],
});

export const examplePlaygroundOptions: PlaygroundOptions = {
  services: [
    {
      id: 'rapportassistenten',
      name: 'Rapportassistenten',
      chat: true,
      exampleQuestions: [evaluationQuestion, phoneQuestion],
      ...draftOf(
        {
          model: 'aivar/borealis-27b',
          datasets: ['digdir/kudos', '999888777/nettsider'],
          skills: [],
          blocks: ['hybridsok', 'rangering', 'personvernfilter', 'kildekrav'],
          output: 'text',
        },
        4,
      ),
    },
    {
      id: 'soknadsuttrekk',
      name: 'Søknadsuttrekk',
      ...draftOf(
        {
          model: 'aivar/qwen3-8',
          datasets: [],
          skills: [],
          blocks: ['personvernfilter', 'enhetsregisteret'],
          output: 'fields',
        },
        2,
      ),
    },
    {
      id: 'postsortering',
      name: 'Postsortering',
      ...draftOf(
        {
          model: 'aivar/qwen3-8',
          datasets: [],
          skills: ['sortere-post'],
          blocks: ['personvernfilter', 'saksnummer'],
          output: 'fields',
        },
        6,
      ),
    },
  ],
  models: [
    { id: 'aivar/borealis-27b', name: 'Borealis-27B', dataLocation: 'norway', status: 'allowed' },
    { id: 'aivar/qwen3-8', name: 'Qwen3.8-27B', dataLocation: 'norway', status: 'allowed' },
    {
      id: 'foundry-openai/gpt-4.1',
      name: 'GPT-4.1 (Azure OpenAI)',
      dataLocation: 'eu',
      status: 'requires_approval',
      policy: {
        block: 'foundry-openai/gpt-4.1',
        rule: 'Data behandles i EU/EØS, men ikke i Norge. Digdir må godkjenne at Testetaten tar modellen i bruk før den kan prøves her.',
        ownedBy: 'Digdir',
        link: '#/building-blocks',
      },
    },
    {
      id: 'openai/gpt-5',
      name: 'GPT-5 (OpenAI)',
      dataLocation: 'global',
      status: 'not_allowed',
      policy: {
        block: 'openai/gpt-5',
        rule: 'Regelen er at data skal behandles i Norge eller EU/EØS. GPT-5 behandler data i USA. Regelen er plattforminnstillingen «Tillatt datalagring», som Digdir eier. Digdir kan endre den, og administratorer hos dere kan be Digdir om et unntak. Det gjelder også i prøveområdet.',
        ownedBy: 'Digdir',
        link: '#/settings',
      },
    },
  ],
  datasets: [
    { id: 'digdir/kudos', name: 'Kudos-rapporter' },
    { id: '999888777/nettsider', name: 'Nettsidene til Testetaten' },
    { id: '999888777/tilsynsrapporter-2025', name: 'Tilsynsrapporter 2025' },
    { id: '999888777/veiledere', name: 'Veiledere fra Statens eksempelverk' },
  ],
  skills: [
    { id: 'skrive-vedtaksbrev', name: 'Skrive vedtaksbrev' },
    { id: 'svare-innsynskrav', name: 'Svare på innsynskrav' },
    { id: 'sortere-post', name: 'Sortere post etter saksområde' },
    { id: 'oppsummere-horingssvar', name: 'Oppsummere høringssvar' },
    { id: 'klarsprak', name: 'Klarspråk i brev' },
  ],
  blocks: [
    { id: 'hybridsok', name: 'Hybridsøk' },
    { id: 'rangering', name: 'Rangering av treff' },
    { id: 'grafsok', name: 'Grafsøk' },
    { id: 'personvernfilter', name: 'Filtrering av personopplysninger' },
    { id: 'kildekrav', name: 'Kildekrav' },
    { id: 'lovdata', name: 'Lovdata' },
    { id: 'enhetsregisteret', name: 'Oppslag i Enhetsregisteret' },
    { id: 'saksnummer', name: 'Maskering av saksnummer' },
  ],
  testSets: [
    {
      id: 'rapport-sporsmal',
      name: 'Spørsmål om rapporter',
      cases: 40,
      service: 'rapportassistenten',
    },
    { id: 'rapport-avvis', name: 'Skal avvise', cases: 12, service: 'rapportassistenten' },
    { id: 'soknader-2025', name: 'Søknader 2025', cases: 25, service: 'soknadsuttrekk' },
    { id: 'vedtaksbrev', name: 'Testsett', cases: 10, skill: 'skrive-vedtaksbrev' },
  ],
  defaultBlocks: ['personvernfilter'],
  quota: { usedPercent: 94, monthlyTokens: 50_000_000 },
};

const modelFacts: Record<string, { pricePer1k: number; seconds: number }> = {
  'aivar/borealis-27b': { pricePer1k: 0.09, seconds: 3.4 },
  'aivar/qwen3-8': { pricePer1k: 0.05, seconds: 2.1 },
  'foundry-openai/gpt-4.1': { pricePer1k: 0.32, seconds: 5.1 },
  'openai/gpt-5': { pricePer1k: 0.6, seconds: 4.0 },
};

export const formatKr = (n: number | null, f: Format = nbFormat, t: T = nbT) =>
  n === null ? notPricedLabel(t) : f.currency(n, { digits: 2 });
export const addCost = (...costs: (number | null | undefined)[]) =>
  costs.some((c) => c === null) ? null : costs.reduce<number>((a, c) => a + (c ?? 0), 0);
export const formatSecondsShort = (ms: number, f: Format = nbFormat, t: T = nbT) =>
  t('common.seconds', { value: f.decimal(ms / 1000) });
export const formatCount = (n: number, f: Format = nbFormat) => f.number(Math.round(n));

export const locationShort = {
  norway: 'playground.locationNorway',
  eu: 'playground.locationEu',
  global: 'playground.locationGlobal',
} as const satisfies Record<Residency, PlainKey>;

export const shortModelName = (name: string) => name.replace(/\s*\(.*\)$/, '');

export const versionLabel = (v: PlaygroundServiceVersion, t: T = nbT) =>
  t(
    v.draft
      ? 'playground.versionDraft'
      : v.inUse
        ? 'playground.versionInUse'
        : 'playground.version',
    {
      version: v.version,
    },
  );

export const versionOf = (options: PlaygroundOptions, setup: PlaygroundSetup) => {
  const service = options.services.find((s) => s.id === setup.service?.id);
  const version = service?.versions.find((v) =>
    setup.service?.version === 'draft' ? v.draft : !v.draft && v.version === setup.service?.version,
  );
  return service && version ? { service, version } : undefined;
};

const nameIn = (list: { id: string; name: string; ref?: string }[], id: string) =>
  list.find((x) => x.id === id || x.ref === id)?.name ?? id;

export const modelOf = (options: PlaygroundOptions, id: string): PlaygroundModelOption =>
  options.models.find((m) => m.id === id) ?? {
    id,
    name: id,
    dataLocation: 'norway',
    status: 'allowed',
  };

export const setupChips = (options: PlaygroundOptions, setup: PlaygroundSetup, t: T = nbT) => {
  const chips: string[] = [];
  const found = versionOf(options, setup);
  if (found)
    chips.push(
      t('playground.chipService', {
        name: found.service.name,
        version: versionLabel(found.version, t).toLowerCase(),
      }),
    );
  chips.push(t('playground.chipModel', { name: modelOf(options, setup.model).name }));
  if (setup.datasets.length)
    chips.push(
      t('playground.chipDatasets', {
        names: setup.datasets.map((d) => nameIn(options.datasets, d)).join(', '),
      }),
    );
  if (setup.skills.length)
    chips.push(
      t('playground.chipSkills', {
        names: setup.skills.map((s) => nameIn(options.skills, s)).join(', '),
      }),
    );
  if (setup.blocks.length) chips.push(t('playground.chipBlocks', { count: setup.blocks.length }));
  chips.push(t(setup.output === 'fields' ? 'playground.chipExtract' : 'playground.chipChat'));
  return chips;
};

export const resultLabel = (options: PlaygroundOptions, setup: PlaygroundSetup, t: T = nbT) => {
  const found = versionOf(options, setup);
  const model = modelOf(options, setup.model).name;
  return found
    ? `${model} · ${found.service.name}, ${versionLabel(found.version, t).toLowerCase()}`
    : model;
};

export const serviceSetup = (
  options: PlaygroundOptions,
  serviceId: string,
  version?: PlaygroundServiceVersion,
): PlaygroundSetup | undefined => {
  const service = options.services.find((s) => s.id === serviceId);
  const chosen = version ?? service?.versions[0];
  if (!service || !chosen) return undefined;
  return {
    service: { id: service.id, version: chosen.draft ? 'draft' : chosen.version },
    ...structuredClone(chosen.setup),
  };
};

const findId = (list: { id: string; name: string }[], idOrName: string) =>
  list.find((x) => x.id === idOrName || x.name === idOrName)?.id ?? idOrName;

const firstAllowed = (options: PlaygroundOptions) =>
  options.models.find((m) => m.status === 'allowed')?.id ?? options.models[0]?.id ?? '';

const defaultService = (options: PlaygroundOptions) =>
  options.services.find((s) => s.chat) ?? options.services[0];

export type PlaygroundContextKind = 'free' | 'service' | 'skill' | 'dataset';

export const initialSetup = (
  options: PlaygroundOptions,
  context: PlaygroundContextKind,
  name?: string,
): PlaygroundSetup => {
  const own = (patch: Partial<PlaygroundSetup>): PlaygroundSetup => ({
    model: firstAllowed(options),
    datasets: [],
    skills: [],
    blocks: options.defaultBlocks ?? [],
    output: 'text',
    ...patch,
  });
  if (context === 'skill' && name) return own({ skills: [findId(options.skills, name)] });
  if (context === 'dataset' && name) {
    const hybrid = options.blocks.find((b) => b.id === 'hybridsok');
    return own({
      datasets: [findId(options.datasets, name)],
      blocks: [...(hybrid ? [hybrid.id] : []), ...(options.defaultBlocks ?? [])],
    });
  }
  const wanted =
    context === 'service' && name ? findId(options.services, name) : defaultService(options)?.id;
  return (wanted ? serviceSetup(options, wanted) : undefined) ?? own({});
};

export const withNamedOptions = (
  options: PlaygroundOptions,
  context: PlaygroundContextKind,
  name?: string,
): PlaygroundOptions => {
  if (!name) return options;
  if (context === 'skill' && !options.skills.some((s) => s.id === name || s.name === name))
    return { ...options, skills: [...options.skills, { id: name, name }] };
  if (context === 'dataset' && !options.datasets.some((d) => d.id === name || d.name === name))
    return { ...options, datasets: [...options.datasets, { id: name, name }] };
  return options;
};

export const suggestionsFor = (options: PlaygroundOptions, setup: PlaygroundSetup) =>
  options.services.find((s) => s.id === setup.service?.id)?.exampleQuestions ?? [];

export const fileNameOf = (input: Extract<PlaygroundInput, { file: unknown }>) =>
  typeof input.file === 'string'
    ? input.file.slice(input.file.lastIndexOf('/') + 1)
    : (input.file.name ?? sampleFileName);

export const questionOf = (input: PlaygroundInput, t: T = nbT) =>
  'fields' in input
    ? [
        Object.values(input.fields)
          .map((v) => (Array.isArray(v) ? v.join(', ') : String(v)))
          .join(' · '),
        input.text ?? '',
      ]
        .filter(Boolean)
        .join('\n')
    : 'text' in input
      ? input.text
      : t('playground.extractQuestion', { file: fileNameOf(input) });

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const inputFieldsOf = (definition: unknown): PlaygroundInputField[] => {
  const fields = asObject(asObject(asObject(definition).spec).input).fields;
  return Array.isArray(fields)
    ? fields
        .map(asObject)
        .filter((f) => typeof f.id === 'string' && typeof f.kind === 'string')
        .map((f) => f as unknown as PlaygroundInputField)
    : [];
};

export const withOptionsFrom = (
  fields: PlaygroundInputField[],
  resolved: PlaygroundInputField[] | undefined,
) =>
  fields.map((f) => {
    const options = f.optionsFrom && resolved?.find((r) => r.id === f.id)?.options;
    return options?.length ? { ...f, options } : f;
  });

export const sourceTitle = (source: PlaygroundSource) =>
  source.title ?? source.document ?? source.chunkId;

const kudosDocument =
  /^(?:digdir:\/\/doc\/|https:\/\/kudos\.dfo\.no\/dokument\/)(\d{1,10})(?:[/?#].*)?$/;

export const sourceUrl = (source: PlaygroundSource) => {
  const url = source.url?.trim();
  const legacy = url ? kudosDocument.exec(url)?.[1] : source.document;
  if (legacy && /^\d{1,10}$/.test(legacy))
    return source.title
      ? `https://kudos.dfo.no/dokumenter?query=${encodeURIComponent(source.title)}`
      : undefined;
  if (url && /^https?:\/\//.test(url)) return url;
  return undefined;
};

export const sourceExcerpt = (source: PlaygroundSource, max = 300) => {
  const flat = (source.excerpt ?? source.text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat || undefined;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export const sourceFacts = (source: PlaygroundSource, f: Format = nbFormat, t: T = nbT) => {
  const date = source.publishedAt ? new Date(source.publishedAt) : undefined;
  return [
    ...(source.version !== undefined && source.version !== ''
      ? [t('playground.sourceVersion', { version: source.version })]
      : []),
    ...(date && !Number.isNaN(date.getTime()) ? [f.date(date, 'long')] : []),
  ].join(', ');
};

export const sourceLocation = (source: PlaygroundSource) =>
  [
    ...(source.document && source.document !== sourceTitle(source) ? [source.document] : []),
    ...(source.headers ?? []),
  ].join(', ');

const valueText = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(valueText).join(', ')
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

export const fieldEntries = (fields: Record<string, unknown>) =>
  Object.entries(fields).map(([name, value]) => ({ name, value: valueText(value) }));

export const searchNoteText = (count: number, t: T = nbT) =>
  t('playground.searchNoteText', { count });

let runCounter = 0;

const source = (chunkId: string, title: string, document: string, page: number, score: number) => ({
  chunkId,
  title,
  document,
  headers: [`side ${page}`],
  position: page,
  score,
});

const decimal = (n: number) => n.toFixed(2).replace('.', ',');

const exampleSteps = (
  result: PlaygroundResult,
  question: string,
  modelName: string,
  extract: boolean,
): { steps: TimelineStep[]; stats: RunStats } => {
  const total = result.timeMs / 1000;
  const sources = result.sources;
  const documents = new Set(sources.map((s) => s.title ?? s.chunkId)).size;
  const steps: TimelineStep[] = [
    {
      id: 'e0',
      type: 'trigger',
      title: 'Spørsmål i prøveområdet',
      summary: 'Oppgaven ble mottatt',
      at: 0,
      blocks: question ? [{ kind: 'quote', text: question }] : [],
    },
  ];
  if (sources.length && !extract) {
    const queries = [question.toLowerCase().replace(/\?$/, ''), 'evaluering veiledning'];
    steps.push(
      {
        id: 'e1',
        type: 'plan',
        title: 'Planla søket',
        summary: `Genererte ${queries.length} søk: ${queries.map((q) => `«${q}»`).join(', ')}`,
        at: 0.1,
        durationSeconds: 0.4,
        tokens: 220,
        model: modelName,
        blocks: [{ kind: 'list', label: 'Søk', items: queries }],
        raw: { kind: 'plan', queries },
      },
      {
        id: 'e2',
        type: 'search',
        title: 'Søk',
        summary: `«${queries[0]}» · ${sources.length * 4 + 2} treff`,
        at: 0.5,
        durationSeconds: 0.3,
        blocks: [
          { kind: 'quote', text: queries[0] ?? '' },
          {
            kind: 'list',
            label: 'Beste treff',
            items: sources.map((s): [string, string] => [
              sourceTitle(s),
              s.score === undefined ? '' : `relevans ${decimal(s.score)}`,
            ]),
          },
        ],
        raw: { kind: 'retrieval', hits: sources.map((s) => ({ id: s.chunkId, score: s.score })) },
      },
    );
    if (result.searchNotes.length)
      steps.push({
        id: 'e3',
        type: 'searchnote',
        title: 'Søkemerknad',
        summary: `${result.searchNotes.length} dokumenter hoppet over`,
        at: 0.8,
        warning: true,
        blocks: [
          {
            kind: 'list',
            label: 'Søkemotoren hoppet over',
            items: result.searchNotes.map((n): [string, string] => [n.document, n.reason]),
          },
        ],
      });
    steps.push({
      id: 'e4',
      type: 'read',
      title: `Leste ${sources.length * 3} tekstbiter`,
      summary: `fra ${documents} ${documents === 1 ? 'dokument' : 'dokumenter'}`,
      at: 0.8,
      durationSeconds: 0.2,
      blocks: [],
    });
  }
  if (extract)
    steps.push({
      id: 'e4',
      type: 'read',
      title: 'Leste filen',
      summary: '4 sider',
      at: 0.1,
      durationSeconds: 0.5,
      blocks: [],
    });
  const modelAt = Math.min(1, total / 3);
  steps.push(
    {
      id: 'e5',
      type: 'model',
      title: 'Modellkall',
      summary: `${modelName} · ${formatCount(result.tokensIn)} inn, ${formatCount(result.tokensOut)} ut`,
      at: modelAt,
      durationSeconds: Math.round((total - modelAt) * 10) / 10,
      tokens: result.tokensIn + result.tokensOut,
      model: modelName,
      blocks: [
        {
          kind: 'kv',
          rows: [
            ['Modell', modelName],
            ['Tokens', `${formatCount(result.tokensIn)} inn, ${formatCount(result.tokensOut)} ut`],
          ],
        },
      ],
    },
    {
      id: 'e6',
      type: 'result',
      title: 'Svar',
      summary: sources.length
        ? `Svar med ${sources.length} ${sources.length === 1 ? 'kilde' : 'kilder'}`
        : 'Svaret ble levert',
      at: total,
      blocks: [],
    },
  );
  return {
    steps,
    stats: {
      iterations: 0,
      toolCalls: 0,
      chunksRead: extract ? 0 : sources.length * 3,
      documents: extract ? 1 : documents,
      warnings: result.searchNotes.length ? [searchNoteText(result.searchNotes.length)] : [],
      inputTokens: result.tokensIn,
      outputTokens: result.tokensOut,
      byModel: [
        {
          model: modelName,
          inputTokens: result.tokensIn,
          outputTokens: result.tokensOut,
          calls: 1,
        },
      ],
    },
  };
};

export const exampleResult = (
  options: PlaygroundOptions,
  setup: PlaygroundSetup,
  input: PlaygroundInput,
  runId = `tp${++runCounter}`,
): PlaygroundResult => {
  const model = modelOf(options, setup.model);
  const facts = modelFacts[setup.model] ?? { pricePer1k: 0.1, seconds: 3 };
  const short = setup.model === 'aivar/qwen3-8';
  const question = questionOf(input);
  const datasetName = setup.datasets[0] ? nameIn(options.datasets, setup.datasets[0]) : '';
  let result: Pick<PlaygroundResult, 'text' | 'fields' | 'sources' | 'searchNotes' | 'citations'> =
    {
      sources: [],
      searchNotes: [],
    };
  let tokensIn: number;
  let tokensOut: number;
  if (setup.output === 'fields') {
    result.fields = {
      'Søkers navn': 'Eksempel IL',
      Organisasjonsnummer: '912 345 678',
      'Omsøkt beløp': short ? '1 200 000 kr (usikker: tallet står to steder)' : '1 200 000 kr',
      Formål: 'Nytt øvingslokale',
      Kontaktperson: 'Holdes utenfor loggen',
    };
    tokensIn = 2980;
    tokensOut = 140;
  } else if (
    setup.skills.includes('skrive-vedtaksbrev') &&
    /vedtak|søker|tilskudd/i.test(question)
  ) {
    result.text = short
      ? 'Vedtak om tilskudd til Eksempel IL\n\nDere får 120 000 kroner i tilskudd til nytt øvingslokale. Alle vilkår i forskriften § 4 er oppfylt.\n\nDere kan klage innen tre uker.'
      : 'Vedtak om tilskudd til Eksempel IL, sak 2026/1234\n\nDere får 120 000 kroner i tilskudd til nytt øvingslokale.\n\nVi har lagt vekt på at alle vilkårene i forskrift om tilskudd § 4 er oppfylt.\n\nDere kan klage på vedtaket. Klagefristen er tre uker fra dere mottok dette brevet.';
    result.sources = [
      { chunkId: 'lovdata-1', title: 'Forskrift om tilskudd § 4', document: 'Lovdata' },
    ];
    tokensIn = 3120;
    tokensOut = short ? 180 : 320;
  } else if (setup.datasets.length && /veiledning|evaluer/i.test(question)) {
    result.text = short
      ? 'Evalueringene peker på to ting:\n1. Digital veiledning virker best sammen med mulighet for å snakke med en person [1].\n2. Brukerne vil ha korte svar med lenke til regelverket [2].'
      : 'Evalueringene peker på tre ting:\n1. Digital veiledning virker best når den kombineres med mulighet for å snakke med en person [1].\n2. Brukerne vil ha korte svar med lenke til regelverket [2].\n3. Ventetiden på telefon gikk ned der chat ble innført, men bare når chatten kunne svare på de vanligste spørsmålene [3].';
    result.sources = [
      source(
        'ev-12',
        'Evaluering av digital veiledning i Testetaten (2023)',
        datasetName,
        12,
        0.91,
      ),
      source('ks-4', 'Kanalstrategi for veiledning 2021–2025', datasetName, 4, 0.88),
      ...(short ? [] : [source('bu-7', 'Brukerundersøkelse om chat (2022)', datasetName, 7, 0.74)]),
    ];
    result.citations = result.sources.map((s, i) => ({ index: i + 1, chunkId: s.chunkId }));
    result.searchNotes = [
      { document: 'Skannet årsrapport 2019.pdf', reason: 'no_text' },
      { document: 'Budsjett 2024.xlsx', reason: 'unsupported_type' },
      { document: 'Personalsak 2023.docx', reason: 'outside_access' },
    ];
    tokensIn = 4380;
    tokensOut = short ? 290 : 410;
  } else if (setup.datasets.length) {
    result.text = `Jeg fant to dokumenter som handler om dette. ${short ? 'Kort oppsummert: ' : ''}Begge anbefaler å samle veiledningen i én kanal og måle hvor mange som får svar første gang.`;
    result.sources = [
      source('ar-18', 'Årsrapport 2024', datasetName, 18, 0.82),
      source('uk-3', 'Utredning om kanalvalg (2022)', datasetName, 3, 0.69),
    ];
    tokensIn = 3600;
    tokensOut = short ? 160 : 240;
  } else {
    result = {
      ...result,
      text: 'Oppsettet har ingen datasett, så svaret bygger bare på modellen og har ingen kilder. Legg til et datasett under «Endre oppsett» for svar med kilder.',
    };
    tokensIn = 900;
    tokensOut = 80;
  }
  const tokens = tokensIn + tokensOut;
  const costNok = (tokens / 1000) * facts.pricePer1k;
  const modelName = shortModelName(model.name);
  const base: PlaygroundResult = {
    runId,
    ...result,
    timeMs: Math.round((facts.seconds * (tokens / 4790) + 0.4) * 1000),
    tokensIn,
    tokensOut,
    costNok,
    dataLocation: model.dataLocation,
    byModel: [{ model: modelName, inputTokens: tokensIn, outputTokens: tokensOut, costNok }],
  };
  return {
    ...base,
    ...exampleSteps(base, question, modelName, setup.output === 'fields'),
  };
};

const chunksOf = (text: string, size = 40) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

export const exampleStreamEvents = (
  options: PlaygroundOptions,
  request: PlaygroundRunRequest,
): PlaygroundStreamEvent[] => {
  const response = exampleRun(options, request);
  const { compare, quota, ...first } = response;
  const runs: ['setup' | 'compareWith', PlaygroundResult][] = [
    ['setup', first],
    ...(compare ? [['compareWith', compare] as ['compareWith', PlaygroundResult]] : []),
  ];
  const events: PlaygroundStreamEvent[] = [];
  for (const [setup, result] of runs) {
    events.push(
      { event: 'started', setup, runId: result.runId, startedAt: new Date().toISOString() },
      { event: 'status', setup, status: 'running' },
    );
    for (const step of result.steps ?? []) {
      if (step.type === 'result') continue;
      if (step.type === 'model')
        events.push({ event: 'step', setup, step: { ...step, state: 'running' } });
      for (const text of step.type === 'model' ? chunksOf(result.text ?? '') : [])
        events.push({ event: 'delta', setup, text, channel: 'answer' });
      events.push({ event: 'step', setup, step });
    }
    const last = result.steps?.at(-1);
    if (last?.type === 'result') events.push({ event: 'step', setup, step: last });
    if (result.stats) events.push({ event: 'stats', setup, stats: result.stats });
    events.push(
      { event: 'result', setup, result },
      { event: 'status', setup, status: 'completed' },
    );
  }
  events.push({ event: 'done', quota });
  return events;
};

export const sseOf = (events: PlaygroundStreamEvent[]) =>
  events.map(({ event, ...data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

export const exampleRun = (
  options: PlaygroundOptions,
  request: PlaygroundRunRequest,
): PlaygroundRunResponse => ({
  ...exampleResult(options, request.setup, request.input),
  ...(request.compareWith
    ? { compare: exampleResult(options, request.compareWith, request.input) }
    : {}),
  quota: options.quota,
});

export const quotaTokensText = (tokens: number, f: Format = nbFormat, t: T = nbT) =>
  tokens >= 1_000_000
    ? t('playground.quotaMillions', { value: formatCount(tokens / 1_000_000, f) })
    : t('playground.quotaTokens', { value: formatCount(tokens, f) });
