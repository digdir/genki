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
  PlaygroundStrategy,
  PlaygroundVariant,
  PlaygroundStreamEvent,
  RunStats,
} from '../api/playground';
import { createFormat, type Format } from '@genai/i18n';
import { notPricedLabel } from '../format';
import { isFree, kronerDigits } from '../models';
import { translator, type PlainKey, type T } from '../i18n';
import type { CatalogModel } from '../api/models';
import type { Residency, TimelineStep } from '../types';

const nbFormat = createFormat('nb');
const nbT = translator('nb');

export const sampleFileName = 'Søknad_2025_007.pdf';
export const evaluationQuestion = 'Hva sier evalueringene om digital veiledning?';
export const decisionQuestion =
  'Eksempel IL søker om 120 000 kr til nytt øvingslokale. Alle vilkår er oppfylt. Lag et vedtak.';
export const phoneQuestion = 'Hva står det i årsrapporten om ventetid på telefon?';

const draftOf = (
  setup: PlaygroundServiceVersion['setup'],
  version: number,
  strategy: PlaygroundStrategy,
) => ({
  latestVersion: version - 1,
  versions: [
    { version, draft: true, inUse: false, setup, strategy },
    { version: version - 1, draft: false, inUse: true, setup, strategy },
  ],
});

const agentLoop: PlaygroundStrategy = {
  id: 'agent-loop',
  version: 1,
  title: { nb: 'Agent (søker selv)', en: 'Agent (searches by itself)' },
  takesInstructions: true,
};

const stepFlow = (id: string, version: number, nb: string, en: string): PlaygroundStrategy => ({
  id: 'step-flow',
  version: 1,
  title: { nb: 'Fast arbeidsflyt', en: 'Fixed workflow' },
  takesInstructions: false,
  flow: { ref: `${id}@${version}`, id, version, title: { nb, en } },
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
          datasets: ['digdir/kudos'],
          skills: [],
          blocks: ['hybridsok', 'rangering', 'personvernfilter', 'kildekrav'],
          output: 'text',
        },
        8,
        agentLoop,
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
        stepFlow('les-soknad', 2, 'Les søknaden', 'Read the application'),
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
        stepFlow('postsortering-flyt', 1, 'Sorter posten', 'Sort the mail'),
      ),
    },
  ],
  models: [
    {
      id: 'aivar/borealis-27b',
      name: 'Borealis-27B',
      dataLocation: 'norway',
      status: 'allowed',
      price: { inputPerThousand: 0.0119, outputPerThousand: 0.0952 },
    },
    {
      id: 'aivar/qwen3-8',
      name: 'Qwen3.8-27B',
      dataLocation: 'norway',
      status: 'allowed',
      price: { inputPerThousand: 0.0076, outputPerThousand: 0.0459 },
    },
    {
      id: 'foundry-openai/gpt-4.1',
      name: 'GPT-4.1 (Azure OpenAI)',
      dataLocation: 'eu',
      status: 'requires_approval',
      price: { inputPerThousand: 0.0184, outputPerThousand: 0.0736 },
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
      price: null,
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

export const variantLabel = (variant: PlaygroundVariant, t: T = nbT) =>
  variant.title ?? (variant.id === 'default' ? t('playground.variantDefault') : variant.id);

export const variantOf = (options: PlaygroundOptions, setup: PlaygroundSetup) => {
  const variants = versionOf(options, setup)?.version.variants ?? [];
  return variants.find((v) => v.id === setup.service?.variant) ?? variants[0];
};

const serviceName = (options: PlaygroundOptions, setup: PlaygroundSetup, name: string, t: T) => {
  const variant = variantOf(options, setup);
  return variant ? `${name} (${variantLabel(variant, t)})` : name;
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
        name: serviceName(options, setup, found.service.name, t),
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
    ? `${model} · ${serviceName(options, setup, found.service.name, t)}, ${versionLabel(found.version, t).toLowerCase()}`
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

/** The source's PDF at its page, from an http(s) file address only. */
export const sourcePageLink = (source: PlaygroundSource) => {
  const file = source.fileUrl?.trim();
  if (source.page === undefined || !file || !/^https?:\/\//i.test(file)) return undefined;
  return `${file.split('#', 1)[0]}#page=${source.page}`;
};

export const sourceExcerpt = (source: PlaygroundSource) =>
  (source.excerpt ?? source.text ?? '').trim() || undefined;

export const sourceFacts = (source: PlaygroundSource, f: Format = nbFormat, t: T = nbT) => {
  const date = source.publishedAt ? new Date(source.publishedAt) : undefined;
  return date && !Number.isNaN(date.getTime())
    ? t('playground.sourcePublished', { date: f.date(date, 'long') })
    : undefined;
};

export const sourceDataset = (source: PlaygroundSource) => {
  const qualifiedId = [source.document, source.chunkId].find((id) => id?.includes('::'));
  return qualifiedId?.split('::')[0];
};

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

type StepLanguage = 'nb' | 'en';

const stepWords = {
  nb: {
    trigger: 'Spørsmål i prøveområdet',
    received: 'Oppgaven ble mottatt',
    plan: 'Planla søket',
    planned: (n: number, list: string) => `Genererte ${n} søk: ${list}`,
    searches: 'Søk',
    search: 'Søk',
    hits: (n: number) => `${n} treff`,
    best: 'Beste treff',
    relevance: (n: string) => `relevans ${n}`,
    note: 'Søkemerknad',
    skipped: (n: number) => `${n} dokumenter hoppet over`,
    skippedBy: 'Søkemotoren hoppet over',
    read: (n: number) => `Leste ${n} tekstbiter`,
    from: (n: number) => `fra ${n} ${n === 1 ? 'dokument' : 'dokumenter'}`,
    readFile: 'Leste filen',
    pages: '4 sider',
    model: 'Modellkall',
    modelLabel: 'Modell',
    inOut: (i: string, o: string) => `${i} inn, ${o} ut`,
    answer: 'Svar',
    withSources: (n: number) => `Svar med ${n} ${n === 1 ? 'kilde' : 'kilder'}`,
    delivered: 'Svaret ble levert',
  },
  en: {
    trigger: 'Question in the playground',
    received: 'The task was received',
    plan: 'Planned the search',
    planned: (n: number, list: string) =>
      `Generated ${n} ${n === 1 ? 'search' : 'searches'}: ${list}`,
    searches: 'Searches',
    search: 'Search',
    hits: (n: number) => `${n} hits`,
    best: 'Best hits',
    relevance: (n: string) => `relevance ${n}`,
    note: 'Search note',
    skipped: (n: number) => `${n} documents skipped`,
    skippedBy: 'The search engine skipped',
    read: (n: number) => `Read ${n} chunks`,
    from: (n: number) => `from ${n} ${n === 1 ? 'document' : 'documents'}`,
    readFile: 'Read the file',
    pages: '4 pages',
    model: 'Model call',
    modelLabel: 'Model',
    inOut: (i: string, o: string) => `${i} in, ${o} out`,
    answer: 'Answer',
    withSources: (n: number) => `Answer with ${n} ${n === 1 ? 'source' : 'sources'}`,
    delivered: 'The answer was delivered',
  },
};

const exampleSteps = (
  result: PlaygroundResult,
  question: string,
  modelName: string,
  extract: boolean,
  language: StepLanguage,
): { steps: TimelineStep[]; stats: RunStats } => {
  const w = stepWords[language];
  const total = result.timeMs / 1000;
  const sources = result.sources;
  const documents = new Set(sources.map((s) => s.title ?? s.chunkId)).size;
  const steps: TimelineStep[] = [
    {
      id: 'e0',
      type: 'trigger',
      title: w.trigger,
      summary: w.received,
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
        title: w.plan,
        summary: w.planned(queries.length, queries.map((q) => `«${q}»`).join(', ')),
        at: 0.1,
        durationSeconds: 0.4,
        tokens: 220,
        model: modelName,
        blocks: [{ kind: 'list', label: w.searches, items: queries }],
        raw: { kind: 'plan', queries },
      },
      {
        id: 'e2',
        type: 'search',
        title: w.search,
        summary: `«${queries[0]}» · ${w.hits(sources.length * 4 + 2)}`,
        at: 0.5,
        durationSeconds: 0.3,
        blocks: [
          { kind: 'quote', text: queries[0] ?? '' },
          {
            kind: 'list',
            label: w.best,
            items: sources.map((s): [string, string] => [
              sourceTitle(s),
              s.score === undefined ? '' : w.relevance(decimal(s.score)),
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
        title: w.note,
        summary: w.skipped(result.searchNotes.length),
        at: 0.8,
        warning: true,
        blocks: [
          {
            kind: 'list',
            label: w.skippedBy,
            items: result.searchNotes.map((n): [string, string] => [n.document, n.reason]),
          },
        ],
      });
    steps.push({
      id: 'e4',
      type: 'read',
      title: w.read(sources.length * 3),
      summary: w.from(documents),
      at: 0.8,
      durationSeconds: 0.2,
      blocks: [],
    });
  }
  if (extract)
    steps.push({
      id: 'e4',
      type: 'read',
      title: w.readFile,
      summary: w.pages,
      at: 0.1,
      durationSeconds: 0.5,
      blocks: [],
    });
  const modelAt = Math.min(1, total / 3);
  steps.push(
    {
      id: 'e5',
      type: 'model',
      title: w.model,
      summary: `${modelName} · ${w.inOut(formatCount(result.tokensIn), formatCount(result.tokensOut))}`,
      at: modelAt,
      durationSeconds: Math.round((total - modelAt) * 10) / 10,
      tokens: result.tokensIn + result.tokensOut,
      model: modelName,
      blocks: [
        {
          kind: 'kv',
          rows: [
            [w.modelLabel, modelName],
            ['Tokens', w.inOut(formatCount(result.tokensIn), formatCount(result.tokensOut))],
          ],
        },
      ],
    },
    {
      id: 'e6',
      type: 'result',
      title: w.answer,
      summary: sources.length ? w.withSources(sources.length) : w.delivered,
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
  language: StepLanguage = 'nb',
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
    ...exampleSteps(base, question, modelName, setup.output === 'fields', language),
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
  language: StepLanguage = 'nb',
): PlaygroundStreamEvent[] => {
  const response = exampleRun(options, request, language);
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
  language: StepLanguage = 'nb',
): PlaygroundRunResponse => ({
  ...exampleResult(options, request.setup, request.input, undefined, language),
  ...(request.compareWith
    ? { compare: exampleResult(options, request.compareWith, request.input, undefined, language) }
    : {}),
  quota: options.quota,
});

export const quotaTokensText = (tokens: number, f: Format = nbFormat, t: T = nbT) =>
  tokens >= 1_000_000
    ? t('playground.quotaMillions', { value: formatCount(tokens / 1_000_000, f) })
    : t('playground.quotaTokens', { value: formatCount(tokens, f) });

const versionKeyOf = (v: { version: number; draft: boolean }) =>
  v.draft ? 'draft' : String(v.version);

export const emptyStart = '';

export const startKeyOf = (setup: PlaygroundSetup) =>
  setup.service
    ? `${encodeURIComponent(setup.service.id)}/${String(setup.service.version)}`
    : emptyStart;

export const startChoices = (options: PlaygroundOptions, t: T = nbT) => [
  ...options.services.flatMap((service) =>
    service.versions.map((version) => ({
      key: `${encodeURIComponent(service.id)}/${versionKeyOf(version)}`,
      label: version.draft
        ? t('playground.startDraft', { name: service.name })
        : t('playground.startVersion', { name: service.name, version: version.version }),
    })),
  ),
  { key: emptyStart, label: t('playground.startEmpty') },
];

export const startLabel = (options: PlaygroundOptions, setup: PlaygroundSetup, t: T = nbT) =>
  startChoices(options, t).find((c) => c.key === startKeyOf(setup))?.label ??
  t('playground.startEmpty');

export const setupFromStart = (
  options: PlaygroundOptions,
  key: string,
  current: PlaygroundSetup,
): PlaygroundSetup => {
  const [id, version] = key.split('/');
  const service = id ? options.services.find((s) => s.id === decodeURIComponent(id)) : undefined;
  const chosen = service?.versions.find((v) => versionKeyOf(v) === version);
  const fromService = service && chosen ? serviceSetup(options, service.id, chosen) : undefined;
  return (
    fromService ?? {
      model: current.model,
      datasets: [],
      skills: [],
      blocks: options.defaultBlocks ?? [],
      output: 'text',
    }
  );
};

const startModel = (options: PlaygroundOptions, setup: PlaygroundSetup) =>
  variantOf(options, setup)?.model ?? versionOf(options, setup)?.version.setup.model;

export type SetupChange =
  | { kind: 'model'; to: string }
  | { kind: 'instructions' }
  | { kind: 'dataset'; id: string; on: boolean };

export const instructionsChanged = (setup: PlaygroundSetup, base: string | undefined) =>
  setup.instructions !== undefined &&
  setup.instructions.trim() !== '' &&
  setup.instructions !== (base ?? '');

export const changedFromStart = (
  options: PlaygroundOptions,
  setup: PlaygroundSetup,
  base?: string,
): SetupChange[] => {
  const found = versionOf(options, setup);
  if (!found) return [];
  const model = startModel(options, setup);
  const before = found.version.setup.datasets;
  return [
    ...(model !== undefined && model !== setup.model
      ? [{ kind: 'model' as const, to: setup.model }]
      : []),
    ...(instructionsChanged(setup, base) ? [{ kind: 'instructions' as const }] : []),
    ...setup.datasets
      .filter((d) => !before.includes(d))
      .map((id) => ({ kind: 'dataset' as const, id, on: true })),
    ...before
      .filter((d) => !setup.datasets.includes(d))
      .map((id) => ({ kind: 'dataset' as const, id, on: false })),
  ];
};

export const changeText = (options: PlaygroundOptions, change: SetupChange, t: T = nbT) =>
  change.kind === 'model'
    ? t('playground.changeModel', { name: shortModelName(modelOf(options, change.to).name) })
    : change.kind === 'instructions'
      ? t('playground.changeInstructions')
      : t(change.on ? 'playground.changeDatasetOn' : 'playground.changeDatasetOff', {
          name: nameIn(options.datasets, change.id),
        });

export const startWord = (options: PlaygroundOptions, setup: PlaygroundSetup, t: T = nbT) => {
  const found = versionOf(options, setup);
  if (!found) return t('playground.startEmpty').toLowerCase();
  return found.version.draft
    ? t('playground.fromDraft')
    : t('playground.fromVersion', { version: found.version.version });
};

export const changesLine = (
  options: PlaygroundOptions,
  setup: PlaygroundSetup,
  base: string | undefined,
  t: T = nbT,
) => {
  const changes = changedFromStart(options, setup, base);
  return changes.length
    ? t('playground.changesFromStart', {
        count: changes.length,
        start: startWord(options, setup, t),
        list: changes.map((c) => changeText(options, c, t)).join(', '),
      })
    : undefined;
};

export const strategyOf = (options: PlaygroundOptions, setup: PlaygroundSetup) =>
  variantOf(options, setup)?.strategy ?? versionOf(options, setup)?.version.strategy;

export const takesInstructions = (options: PlaygroundOptions, setup: PlaygroundSetup) =>
  strategyOf(options, setup)?.takesInstructions !== false;

export const workText = (
  strategy: PlaygroundStrategy,
  language: 'nb' | 'en',
  t: T = nbT,
  short = false,
) => {
  const title = strategy.title[language];
  const flow = strategy.flow;
  if (!flow) return title;
  const name = flow.title[language];
  return short
    ? t('playground.workFlowShort', { flow: name, version: flow.version })
    : t('playground.workFlow', { strategy: title, flow: name, version: flow.version });
};

export const priceText = (model: PlaygroundModelOption, f: Format = nbFormat, t: T = nbT) =>
  isFree(model.price)
    ? t('modelWords.free')
    : model.price
      ? t('playground.pricePerMillion', {
          input: f.number(model.price.inputPerThousand * 1000, kronerDigits),
          output: f.number(model.price.outputPerThousand * 1000, kronerDigits),
        })
      : notPricedLabel(t);

export type SetupPart = 'model' | 'instructions' | 'knowledge';

const sameList = (x: string[], y: string[]) =>
  x.length === y.length && x.every((v) => y.includes(v));

export const effectiveInstructions = (setup: PlaygroundSetup, base: string | undefined) =>
  setup.instructions !== undefined && setup.instructions.trim() !== ''
    ? setup.instructions
    : (base ?? '');

export const setupDifferences = (
  a: PlaygroundSetup,
  b: PlaygroundSetup,
  baseA?: string,
  baseB?: string,
): SetupPart[] => [
  ...(a.model === b.model ? [] : ['model' as const]),
  ...(effectiveInstructions(a, baseA) === effectiveInstructions(b, baseB)
    ? []
    : ['instructions' as const]),
  ...(sameList(a.datasets, b.datasets) ? [] : ['knowledge' as const]),
];

export const sentenceCount = (text: string) => {
  let count = 0;
  let open = false;
  for (const char of text) {
    if (char === '.' || char === '!' || char === '?') {
      if (open) count += 1;
      open = false;
    } else if (char.trim()) open = true;
  }
  return count + (open ? 1 : 0);
};

export const pickerModelsOf = (
  options: PlaygroundOptions,
  catalog: CatalogModel[] = [],
  t: T = nbT,
): CatalogModel[] =>
  options.models.map((m) => {
    const known = catalog.find((c) => c.id === m.id);
    const name = known?.name ?? m.name;
    return {
      capabilities: [],
      ...known,
      id: m.id,
      name: m.candidate ? t('playground.candidateName', { name }) : name,
      residency: known?.residency ?? m.dataLocation,
      available: m.status === 'allowed',
      ...(m.status === 'allowed' ? {} : { reason: m.status }),
    };
  });

export interface TimelineBar {
  step: TimelineStep;
  left: number;
  width: number;
}

export const timelineBars = (steps: TimelineStep[]): TimelineBar[] => {
  const total = Math.max(0, ...steps.map((s) => s.at + (s.durationSeconds ?? 0)));
  const share = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0);
  return steps.map((step) => {
    const left = share(Math.max(0, step.at));
    return {
      step,
      left,
      width: Math.max(1, Math.min(100 - left, share(step.durationSeconds ?? 0))),
    };
  });
};

export const timedSteps = (steps: TimelineStep[]) =>
  steps.filter((s) => (s.durationSeconds ?? 0) > 0);

export const withInstructions = (setup: PlaygroundSetup, text: string): PlaygroundSetup => {
  const next = { ...setup };
  delete next.instructions;
  return text.trim() || setup.service ? { ...next, instructions: text } : next;
};

export const runnableSetup = (setup: PlaygroundSetup): PlaygroundSetup => {
  if (setup.instructions === undefined || setup.instructions.trim()) return setup;
  const next = { ...setup };
  delete next.instructions;
  return next;
};
