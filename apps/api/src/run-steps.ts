import type { Event, Part } from '@genai/contracts';
import { intlLocale } from '@genai/i18n';
import { failureOf, failureReason } from './failures.js';
import { requestLocale, t, type ApiKey } from './i18n/index.js';

export interface TimelineBlock {
  kind: 'quote' | 'kv' | 'list' | 'tags' | 'answer' | 'note' | 'error' | 'reasoning';
  label?: string;
  text?: string;
  rows?: [string, string][];
  items?: string[] | [string, string][];
  sources?: string[];
  calls?: true;
  usage?: true;
}

export type StepState = 'running' | 'failed' | 'skipped' | 'partial' | 'waiting';

export interface TimelineStep {
  id: string;
  type: string;
  title: string;
  summary: string;
  at: number;
  durationSeconds?: number;
  blocks: TimelineBlock[];
  state?: StepState;
  depth?: number;
  tokens?: number;
  model?: string;
  iteration?: number;
  warning?: true;
  raw?: unknown;
}

export interface ModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costMicroNok?: number;
}

export interface RunStats {
  iterations: number;
  toolCalls: number;
  chunksRead: number;
  documents: number;
  warnings: string[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costMicroNok: number;
  unpricedTokens: number;
  byModel: ModelTokens[];
}

export interface HitView {
  id: string;
  document?: string;
  position?: number;
  score?: number;
  title?: string;
}

export type RunChange =
  | { kind: 'step'; step: TimelineStep }
  | { kind: 'remove'; id: string }
  | { kind: 'delta'; text: string; channel: 'answer' | 'reasoning' }
  | { kind: 'retract'; reason: 'discarded' }
  | { kind: 'status'; status: string };

export const retrievalMime = 'application/vnd.genai.retrieval+json';
export const sourcesMime = 'application/vnd.genai.sources+json';

type Data = Record<string, unknown>;

const record = (v: unknown): Data =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {};

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : [];

const numberFormat = () => new Intl.NumberFormat(intlLocale(requestLocale()));
export const nbCount = (n: number) => numberFormat().format(n);
const decimal = (n: number) =>
  new Intl.NumberFormat(intlLocale(requestLocale()), { maximumFractionDigits: 2 }).format(n);

const plain = t as unknown as (key: ApiKey) => string;

const round = (seconds: number) => Math.max(0, Math.round(seconds * 100) / 100);

const counted = (
  key: 'steps.hits' | 'steps.searches' | 'steps.chunks' | 'steps.documents' | 'steps.sources',
  n: number,
) => t(key, { count: n });

const quoted = (texts: string[], max = 3) =>
  texts
    .slice(0, max)
    .map((x) => `«${x}»`)
    .join(', ') + (texts.length > max ? ', …' : '');

const skipReasons: Record<string, ApiKey> = {
  unsupported_type: 'runs.skipUnsupportedType',
  outside_access: 'runs.skipOutsideAccess',
  conversion_failed: 'runs.skipConversionFailed',
  no_chunks: 'runs.skipNoChunks',
};

const reasonText = (document: string, reason: string) => {
  if (reason === 'no_text')
    return /\.pdf$/i.test(document) ? t('runs.skipScannedPdf') : t('runs.skipNoText');
  const key = skipReasons[reason];
  return key ? plain(key) : reason;
};

const warningTexts: [RegExp, (m: RegExpMatchArray) => string][] = [
  [
    /^skipped org auto-filter on (.+): dataset lacks a multiselect field$/,
    (m) => t('runs.warnOrgField', { field: m[1] ?? '' }),
  ],
  [/^skipped org auto-filter: (engine lacks facets|no facets)$/, () => t('runs.warnOrgFacets')],
  [
    /^skipped (.+) search: dataset lacks profile (.+)$/,
    (m) => t('runs.warnProfileMissing', { search: m[1] ?? '', profile: m[2] ?? '' }),
  ],
  [
    /^no configured profile on dataset, searching (.+)$/,
    (m) => t('runs.warnNoProfile', { profile: m[1] ?? '' }),
  ],
  [/^skipped doc-title fan-out: engine lacks range$/, () => t('runs.warnDocTitles')],
  [
    /^skipped auto-filter on (.+): engine lacks (.+)$/,
    (m) => t('runs.warnAutoFilter', { field: m[1] ?? '' }),
  ],
];

export const warningText = (warning: string) => {
  for (const [pattern, text] of warningTexts) {
    const m = warning.match(pattern);
    if (m) return text(m);
  }
  return undefined;
};

const stepStatus: Record<string, ApiKey> = {
  started: 'steps.running',
  done: 'runs.stepDone',
  skipped: 'runs.stepSkipped',
  defaulted: 'runs.stepDefaulted',
};

const depthOf = (path: unknown) =>
  typeof path === 'string' ? (path.match(/#\d+/g)?.length ?? 0) : 0;

const loopOf = (path: unknown) => (typeof path === 'string' ? path.replace(/#\d+$/, '') : '');

const toolTitles: Record<string, [string, ApiKey]> = {
  search: ['search', 'steps.toolSearch'],
  read_chunks: ['read', 'steps.toolRead'],
  plan_queries: ['plan', 'steps.toolPlan'],
  rerank_results: ['tool', 'steps.toolRerank'],
  generate_response: ['model', 'steps.toolGenerate'],
  inspect_filters: ['tool', 'steps.toolInspect'],
  use_skill: ['tool', 'steps.toolSkill'],
};

const toolKind = (name: string): [string, string] => {
  const known = toolTitles[name];
  return known ? [known[0], plain(known[1])] : ['tool', t('steps.toolOther', { name })];
};

const lookup = (keys: Record<string, ApiKey>, value: string) => {
  const key = keys[value];
  return key ? plain(key) : value;
};

const readSignals: Record<string, ApiKey> = {
  'support-found': 'steps.readSupport',
  'gap-remaining': 'steps.readGap',
  conflicting: 'steps.readConflicting',
  unclear: 'steps.readUnclear',
};

const gateStatus: Record<string, ApiKey> = {
  sufficient: 'steps.gateSufficient',
  insufficient: 'steps.gateInsufficient',
  partial: 'steps.gatePartial',
};

const nextMoves: Record<string, ApiKey> = {
  're-search': 'steps.nextReSearch',
  'read-more': 'steps.nextReadMore',
  finalize: 'steps.nextFinalize',
  'ask-clarification': 'steps.nextClarify',
  grounding: 'steps.nextGrounding',
};

const citationActions: Record<string, ApiKey> = {
  keep: 'steps.citationsKeep',
  'carry-through': 'steps.citationsCarry',
};

const hitsOf = (value: unknown): HitView[] =>
  (Array.isArray(value) ? value : []).flatMap((h) => {
    const r = record(h);
    const id = str(r.id) ?? str(r.chunkId);
    if (!id) return [];
    const document = str(r.document);
    const position = num(r.position);
    const score = num(r.score);
    const title = str(r.title);
    return [
      {
        id,
        ...(document ? { document } : {}),
        ...(position === undefined ? {} : { position }),
        ...(score === undefined ? {} : { score }),
        ...(title ? { title } : {}),
      },
    ];
  });

const filterTags = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).flatMap((f) => {
    const r = record(f);
    const field = str(r.field);
    const values = [
      ...strings(r.selectedOptions),
      ...strings(r.selected_options),
      ...strings(r.values),
    ];
    return field ? [`${field}: ${values.join(', ')}`] : [];
  });

const hitLabel = (h: HitView) => h.title ?? h.document ?? h.id;

const hitMeta = (h: HitView) =>
  [
    h.score === undefined ? '' : t('steps.relevance', { score: decimal(h.score) }),
    h.position === undefined ? '' : t('steps.part', { part: h.position + 1 }),
  ]
    .filter(Boolean)
    .join(' · ');

const textOf = (parts: Part[]) =>
  parts
    .flatMap((p) => (p.body.kind === 'text' && p.mime !== sourcesMime ? [p.body.text] : []))
    .join('');

const jsonOf = (parts: Part[], mime: string) => {
  const part = parts.find((p) => p.mime === mime && p.body.kind === 'json');
  return part?.body.kind === 'json' ? part.body.json : undefined;
};

const sourceTitles = (parts: Part[]) =>
  (Array.isArray(record(jsonOf(parts, sourcesMime)).sources)
    ? (record(jsonOf(parts, sourcesMime)).sources as unknown[])
    : []
  ).flatMap((s) => {
    const r = record(s);
    const title = str(r.title) ?? strings(r.headers)[0] ?? str(r.document) ?? str(r.chunkId);
    return title ? [title.replace(/^#+\s*/, '')] : [];
  });

const fieldRows = (value: unknown): [string, string][] =>
  Object.entries(record(value)).map(([k, v]) => [
    k,
    typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(', ') : JSON.stringify(v),
  ]);

export interface RunMapperOptions {
  details?: boolean;
  usage?: boolean;
  startedAt?: string;
}

export class RunMapper {
  readonly steps: TimelineStep[] = [];
  readonly hits = new Map<string, HitView>();
  private readonly details: boolean;
  private readonly usageShown: boolean;
  private start: number | undefined;
  private prev: number | undefined;
  private out: RunChange[] = [];
  private turn: TimelineStep | undefined;
  private readonly turns = new Map<number, TimelineStep>();
  private openTools: TimelineStep[] = [];
  private pendingUsage: TimelineStep[] = [];
  private readonly flow = new Map<string, TimelineStep>();
  private readonly skippedItems = new Map<string, number>();
  private readonly skippedDocs = new Set<string>();
  private readonly documents = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly byModel = new Map<string, ModelTokens>();
  private errorStep: TimelineStep | undefined;
  private readonly errors: Event[] = [];
  private trigger: TimelineStep | undefined;
  private channel: 'answer' | 'reasoning' = 'answer';
  private iterations = 0;
  private toolCalls = 0;
  private chunksRead = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private costMicroNok = 0;
  private unpricedTokens = 0;

  constructor(options: RunMapperOptions = {}) {
    this.details = options.details ?? false;
    this.usageShown = options.usage ?? true;
    if (options.startedAt) this.start = Date.parse(options.startedAt);
  }

  stats(): RunStats {
    return {
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      chunksRead: this.chunksRead,
      documents: this.documents.size,
      warnings: [...this.warnings],
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cachedInputTokens ? { cachedInputTokens: this.cachedInputTokens } : {}),
      costMicroNok: this.costMicroNok,
      unpricedTokens: this.unpricedTokens,
      byModel: [...this.byModel.values()],
    };
  }

  push(e: Event): RunChange[] {
    this.out = [];
    const ts = Date.parse(e.ts);
    this.start ??= ts;
    const prev = this.prev ?? this.start;
    const data = record(e.data);
    switch (e.type) {
      case 'kernel.task.status':
        this.status(e, ts, data);
        break;
      case 'kernel.task.input':
        this.input(e, data);
        break;
      case 'kernel.notice':
        this.notice(e, ts, prev, data);
        break;
      case 'kernel.part.delta':
        if (typeof data.text === 'string' && data.text)
          this.out.push({ kind: 'delta', text: data.text, channel: this.channel });
        break;
      case 'kernel.usage':
        this.usage(e, ts, prev, data);
        break;
      case 'kernel.interrupt':
        this.add({
          id: `e${e.seq}`,
          type: 'approval',
          title: t('runs.waiting'),
          summary: String(data.reason ?? ''),
          at: this.offset(ts),
          state: 'waiting',
          blocks: textOf(Array.isArray(data.prompt) ? (data.prompt as Part[]) : [])
            ? [{ kind: 'quote', text: textOf(data.prompt as Part[]) }]
            : [],
        });
        break;
      case 'kernel.result':
        this.result(e, ts, prev);
        break;
      case 'kernel.error':
        this.error(e, ts);
        break;
      default:
        break;
    }
    if (e.type !== 'kernel.part.delta') this.prev = ts;
    return this.out;
  }

  private offset(ms: number) {
    return round((ms - (this.start ?? ms)) / 1000);
  }

  private emit(step: TimelineStep) {
    this.out.push({ kind: 'step', step });
  }

  private add(step: TimelineStep, absorb = false) {
    if (absorb && this.pendingUsage.length) {
      const [first, ...rest] = this.pendingUsage;
      const host = first as TimelineStep;
      const tokens = this.pendingUsage.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
      for (const r of rest) {
        this.steps.splice(this.steps.indexOf(r), 1);
        this.out.push({ kind: 'remove', id: r.id });
      }
      const end = step.at + (step.durationSeconds ?? 0);
      const modelBlocks = host.blocks.filter((b) => b.usage);
      Object.assign(host, step, {
        id: host.id,
        blocks: [...step.blocks, ...modelBlocks],
        at: host.at,
        durationSeconds: round(end - host.at),
        ...(tokens ? { tokens } : {}),
        ...(host.model ? { model: host.model } : {}),
      });
      if (!step.state) delete host.state;
      this.pendingUsage = [];
      this.emit(host);
      return host;
    }
    this.pendingUsage = [];
    this.steps.push(step);
    this.emit(step);
    return step;
  }

  private completed(e: Event, ts: number, prev: number, step: Omit<TimelineStep, 'id' | 'at'>) {
    return {
      id: `e${e.seq}`,
      at: this.offset(prev),
      durationSeconds: round((ts - prev) / 1000),
      ...step,
    } as TimelineStep;
  }

  private warn(text: string) {
    this.warnings.push(text);
  }

  private close(step: TimelineStep, ts: number) {
    if (step.state !== 'running') return;
    delete step.state;
    step.durationSeconds ??= round(this.offset(ts) - step.at);
    this.emit(step);
  }

  private closeAll(ts: number) {
    for (const s of this.steps) this.close(s, ts);
    this.turn = undefined;
    this.openTools = [];
  }

  private status(e: Event, ts: number, data: Data) {
    const status = String(data.status ?? '');
    if (status === 'queued') {
      this.trigger = this.add({
        id: `e${e.seq}`,
        type: 'trigger',
        title: t('runs.started'),
        summary: t('runs.received'),
        at: this.offset(ts),
        blocks: this.trigger?.blocks ?? [],
      });
      return;
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) this.closeAll(ts);
    this.out.push({ kind: 'status', status });
  }

  private input(e: Event, data: Data) {
    const input = record(data.input);
    const payload = record(input.data);
    const parts = Array.isArray(input.parts) ? (input.parts as Part[]) : [];
    const question = str(payload.query) ?? textOf(parts);
    const history = Array.isArray(payload.history) ? payload.history.length : 0;
    const blocks: TimelineBlock[] = [
      ...(question ? [{ kind: 'quote' as const, text: question.slice(0, 2000) }] : []),
      ...(history
        ? [
            {
              kind: 'kv' as const,
              rows: [[t('steps.earlierMessages'), nbCount(history)]] as [string, string][],
            },
          ]
        : []),
    ];
    if (!blocks.length) return;
    if (this.trigger) {
      this.trigger.blocks = blocks;
      if (question) this.trigger.summary = t('steps.questionReceived');
      this.emit(this.trigger);
      return;
    }
    this.trigger = this.add({
      id: `e${e.seq}`,
      type: 'trigger',
      title: t('runs.started'),
      summary: t('steps.questionReceived'),
      at: 0,
      blocks,
    });
  }

  private rawOf(value: unknown) {
    return this.details ? { raw: value } : {};
  }

  private notice(e: Event, ts: number, prev: number, data: Data) {
    const event = str(data.event);
    const stage = str(data.stage);
    const kind = str(data.kind);
    this.attributionSteps(e, ts, [data]);
    if (event === 'agent/iteration-started') return this.iterationStarted(e, ts, data);
    if (event === 'agent/thinking') return this.thinking(data);
    if (event === 'agent/turn-completed') return this.turnCompleted(ts, data);
    if (event === 'agent/finalized') return;
    if (stage === 'tool') return this.toolStarted(e, ts, data);
    if (kind === 'retrieval') return this.retrieval(e, ts, prev, data);
    if (kind === 'read') return this.read(e, ts, prev, data);
    if (kind === 'plan') return this.plan(e, ts, prev, data);
    if (kind === 'rerank') return this.rerank(e, ts, prev, data);
    if (stage === 'rerank-failed') return this.rerankFailed(e, ts, data);
    if (kind === 'external-step') return this.externalStep(e, ts, data);
    if (kind === 'step') return this.flowStep(e, ts, data);
    if (stage === 'read-signal') return this.readSignal(e, ts, prev, data);
    if (stage === 'gate') return this.gate(e, ts, prev, data);
    if (stage === 'citations') return this.citations(e, ts, prev, data);
    if (stage === 'answer-discarded') return this.discarded(e, ts, data);
    if (stage === 'exhausted' || stage === 'recovered-empty') return this.exhausted(e, ts, data);
    if (kind === 'documents')
      return void this.add(
        this.completed(e, ts, prev, {
          type: 'read',
          title: t('steps.documentsFound'),
          summary: counted('steps.documents', num(data.count) ?? 0),
          blocks: [],
          ...this.rawOf(data),
        }),
      );
    if (kind === 'route')
      return void this.add({
        id: `e${e.seq}`,
        type: 'note',
        title: t('steps.routed'),
        summary: str(data.queue)
          ? t('steps.toQueue', { queue: String(data.queue) })
          : t('steps.routed'),
        at: this.offset(ts),
        blocks: [],
        ...this.rawOf(data),
      });
    const message = str(data.message) ?? str(data.text);
    if (message)
      return void this.add({
        id: `e${e.seq}`,
        type: 'note',
        title: t('runs.message'),
        summary: message,
        at: this.offset(ts),
        blocks: [],
      });
    if (Array.isArray(data.warnings) || Array.isArray(data.skipped)) return;
    this.add({
      id: `e${e.seq}`,
      type: event ?? stage ?? kind ?? 'notice',
      title: t('steps.unknownEvent'),
      summary: event ?? stage ?? kind ?? t('steps.unnamedEvent'),
      at: this.offset(ts),
      blocks: [],
      ...this.rawOf(data),
    });
  }

  private iterationStarted(e: Event, ts: number, data: Data) {
    this.closeAll(ts);
    const iteration = num(data.iteration) ?? this.iterations;
    this.iterations = Math.max(this.iterations, iteration + 1);
    this.channel = 'reasoning';
    this.turn = this.add({
      id: `e${e.seq}`,
      type: 'model',
      title: t('steps.modelRound', { round: iteration + 1 }),
      summary: t('steps.thinking'),
      at: this.offset(ts),
      state: 'running',
      iteration,
      blocks: [],
      ...this.rawOf(data),
    });
    this.turns.set(iteration, this.turn);
  }

  private thinking(data: Data) {
    const iteration = num(data.iteration);
    const step = (iteration === undefined ? undefined : this.turns.get(iteration)) ?? this.turn;
    const reasoning = str(data.reasoning);
    if (!step || !reasoning) return;
    step.blocks = [
      ...step.blocks.filter((b) => b.kind !== 'reasoning'),
      { kind: 'reasoning', label: t('steps.reasoning'), text: reasoning },
    ];
    this.emit(step);
  }

  private toolStarted(e: Event, ts: number, data: Data) {
    if (this.turn) this.close(this.turn, ts);
    const name = str(data.tool) ?? 'tool';
    const [type, title] = toolKind(name);
    this.toolCalls += 1;
    this.channel = 'answer';
    const iteration = num(data.iteration);
    const step = this.add({
      id: `e${e.seq}`,
      type,
      title,
      summary: t('steps.running'),
      at: this.offset(ts),
      state: 'running',
      ...(iteration === undefined ? {} : { iteration }),
      blocks: [],
    });
    this.openTools.push(step);
  }

  private openOf(...types: string[]) {
    return [...this.openTools]
      .reverse()
      .find((s) => s.state === 'running' && types.includes(s.type));
  }

  private searchBlocks(step: TimelineStep, hits: HitView[], queries: string[], filters: string[]) {
    const blocks: TimelineBlock[] = [
      ...(queries.length === 1
        ? [{ kind: 'quote' as const, label: t('steps.searchLabel'), text: queries[0] as string }]
        : queries.length
          ? [{ kind: 'list' as const, label: t('steps.searchLabel'), items: queries }]
          : []),
      ...(filters.length
        ? [{ kind: 'tags' as const, label: t('steps.filterLabel'), items: filters }]
        : []),
      ...(hits.length
        ? [
            {
              kind: 'list' as const,
              label: t('steps.topHits'),
              items: hits.slice(0, 5).map((h): [string, string] => [hitLabel(h), hitMeta(h)]),
            },
          ]
        : []),
    ];
    step.blocks = blocks;
    const found = counted('steps.hits', hits.length);
    step.summary =
      queries.length === 1
        ? t('steps.searchOne', { query: queries[0] as string, hits: found })
        : queries.length
          ? t('steps.searchMany', {
              searches: counted('steps.searches', queries.length),
              queries: quoted(queries),
              hits: found,
            })
          : found;
  }

  private remember(hits: HitView[]) {
    for (const h of hits) {
      const known = this.hits.get(h.id);
      this.hits.set(h.id, { ...known, ...h });
    }
  }

  private retrieval(e: Event, ts: number, prev: number, data: Data) {
    const hits = hitsOf(data.hits);
    this.remember(hits);
    const queries = strings(data.queries);
    const filters = filterTags(data.filters);
    const open = this.openOf('search');
    const step =
      open ??
      this.completed(e, ts, prev, {
        type: 'search',
        title: t('steps.toolSearch'),
        summary: '',
        blocks: [],
      });
    this.searchBlocks(step, hits, queries, filters);
    if (data.fellBack === true) {
      step.state = 'partial';
      step.warning = true;
      step.blocks.push({ kind: 'note', text: t('steps.filterFellBack') });
      this.warn(t('steps.warnFellBack'));
    }
    if (this.details) step.raw = { ...record(step.raw), retrieval: data };
    if (open) this.emit(open);
    else this.add(step);
  }

  private read(e: Event, ts: number, prev: number, data: Data) {
    const chunks = hitsOf(data.chunks);
    this.remember(chunks);
    this.chunksRead += chunks.length;
    const perDocument = new Map<string, number>();
    for (const c of chunks) {
      const doc = c.title ?? c.document ?? c.id;
      if (c.document) this.documents.add(c.document);
      perDocument.set(doc, (perDocument.get(doc) ?? 0) + 1);
    }
    const open = this.openOf('read', 'search');
    const auto = data.auto === true;
    const step =
      open ??
      this.completed(e, ts, prev, {
        type: 'read',
        title: t('steps.toolRead'),
        summary: '',
        blocks: [],
      });
    const block: TimelineBlock = {
      kind: 'list',
      label: auto ? t('steps.readAuto') : t('steps.readDocuments'),
      items: [...perDocument].map((entry): [string, string] => [
        entry[0],
        counted('steps.chunks', entry[1]),
      ]),
    };
    step.blocks = [...step.blocks, block];
    const summary = t('steps.readSummary', {
      chunks: counted('steps.chunks', chunks.length),
      documents: counted('steps.documents', perDocument.size),
    });
    step.summary =
      open && open.type === 'search'
        ? t('steps.searchAndRead', { search: open.summary, read: summary })
        : summary;
    if (open) this.emit(open);
    else this.add(step);
  }

  private plan(e: Event, ts: number, prev: number, data: Data) {
    const queries = strings(data.queries);
    const intent = str(data.userIntent);
    const ms = num(data.ms);
    const open = this.openOf('plan');
    const step = this.completed(e, ts, prev, {
      type: 'plan',
      title: t('steps.planTitle'),
      summary: queries.length
        ? t('steps.planGenerated', {
            searches: counted('steps.searches', queries.length),
            queries: quoted(queries),
          })
        : t('steps.planAsIs'),
      blocks: [
        ...(intent
          ? [{ kind: 'quote' as const, label: t('steps.interpretedAs'), text: intent }]
          : []),
        ...(queries.length
          ? [{ kind: 'list' as const, label: t('steps.searchLabel'), items: queries }]
          : []),
      ],
      ...this.rawOf(data),
    });
    if (open) {
      open.summary = step.summary;
      open.blocks = [...step.blocks, ...open.blocks.filter((b) => b.usage)];
      if (this.details) open.raw = { ...record(open.raw), plan: data };
      this.emit(open);
      return;
    }
    if (ms !== undefined) {
      step.at = round(this.offset(ts) - ms / 1000);
      step.durationSeconds = round(ms / 1000);
    }
    this.add(step, true);
  }

  private rerank(e: Event, ts: number, prev: number, data: Data) {
    const ms = num(data.ms);
    const fallback = data.fallback === true;
    const hits = hitsOf(data.hits);
    this.remember(hits);
    const step = this.completed(e, ts, prev, {
      type: 'search',
      title: t('steps.rerankTitle'),
      summary: fallback
        ? t('steps.rerankFallback')
        : t('steps.rerankRanked', { hits: counted('steps.hits', num(data.count) ?? hits.length) }),
      blocks: hits.length
        ? [
            {
              kind: 'list',
              label: t('steps.topHits'),
              items: hits.slice(0, 5).map((h): [string, string] => [hitLabel(h), hitMeta(h)]),
            },
          ]
        : [],
      ...(fallback ? { state: 'partial' as const, warning: true as const } : {}),
      ...this.rawOf(data),
    });
    if (ms !== undefined) {
      step.at = round(this.offset(ts) - ms / 1000);
      step.durationSeconds = round(ms / 1000);
    }
    if (fallback) this.warn(t('steps.warnRerank'));
    this.add(step, true);
  }

  private rerankFailed(e: Event, ts: number, data: Data) {
    this.warn(t('steps.warnRerank'));
    this.add({
      id: `e${e.seq}`,
      type: 'note',
      title: t('steps.rerankFailedTitle'),
      summary: t('steps.rerankFailedSummary'),
      at: this.offset(ts),
      state: 'partial',
      warning: true,
      blocks: [],
      ...this.rawOf(data),
    });
  }

  private externalStep(e: Event, ts: number, data: Data) {
    const ok = data.ok !== false;
    const fromTool = data.origin === 'tool';
    if (fromTool) this.toolCalls += 1;
    const title =
      str(data.title) ??
      (fromTool
        ? toolKind(str(data.tool) ?? 'tool')[1]
        : t('steps.remoteAgent', { host: str(data.host) ?? '' }));
    const ms = num(data.ms);
    const seconds = ms === undefined ? undefined : round(ms / 1000);
    const sent = strings(data.arguments);
    this.add({
      id: `e${e.seq}`,
      type: ok ? 'tool' : 'error',
      title,
      summary:
        str(data.summary) ??
        (data.skipped === true
          ? t('steps.externalSkipped')
          : ok
            ? plain('runs.stepDone')
            : t('steps.externalFailed')),
      at: Math.max(0, round(this.offset(Date.parse(e.ts)) - (seconds ?? 0))),
      ...(seconds === undefined ? {} : { durationSeconds: seconds }),
      ...(ok ? {} : { state: 'failed' as const }),
      blocks: sent.length
        ? [{ kind: 'tags' as const, label: t('steps.argumentsLabel'), items: sent }]
        : [],
      ...this.rawOf(data),
    });
  }

  private flowStep(e: Event, ts: number, data: Data) {
    const stage = str(data.stage);
    if (stage) {
      if (stage !== 'agent')
        this.add({
          id: `e${e.seq}`,
          type: str(data.step) ? 'step' : 'note',
          title: t('runs.stepTitle', { step: String(data.step ?? ''), block: '' }),
          summary: stage,
          at: this.offset(ts),
          blocks: [],
          ...this.rawOf(data),
        });
      return;
    }
    const name = String(data.step ?? '');
    const key = typeof data.path === 'string' ? data.path : name;
    const block = typeof data.block === 'string' ? ` (${data.block})` : '';
    const depth = depthOf(data.path);
    const nested = depth > 0 ? { depth } : {};
    const quoted =
      this.details && typeof data.error === 'string'
        ? [{ kind: 'quote' as const, text: data.error }]
        : [];
    const at = this.offset(ts);
    const ms = num(data.ms);
    const timing = ms === undefined ? {} : { durationSeconds: round(ms / 1000) };
    if (data.status === 'failed' && typeof data.item === 'number') {
      const loop = loopOf(data.path);
      this.skippedItems.set(loop, (this.skippedItems.get(loop) ?? 0) + 1);
      this.add({
        id: `e${e.seq}`,
        type: 'step',
        title: t('runs.itemTitle', { item: data.item + 1, step: name }),
        summary: t('runs.itemFailed'),
        at,
        state: 'skipped',
        ...nested,
        blocks: quoted,
      });
      return;
    }
    if (data.status === 'failed') {
      const open = this.flow.get(key);
      if (open) {
        this.steps.splice(this.steps.indexOf(open), 1);
        this.out.push({ kind: 'remove', id: open.id });
        this.flow.delete(key);
      }
      this.add({
        id: `e${e.seq}`,
        type: 'error',
        title: t('runs.stepFailed', { step: name }),
        summary: t('runs.flowContinued'),
        at,
        state: 'failed',
        ...nested,
        blocks: quoted,
      });
      return;
    }
    const skipped = this.skippedItems.get(key) ?? 0;
    const statusKey = stepStatus[String(data.status)];
    if (!statusKey) return;
    const status = plain(statusKey);
    const open = this.flow.get(key);
    const step: TimelineStep = {
      id: open?.id ?? `e${e.seq}`,
      type: 'step',
      title: t('runs.stepTitle', { step: name, block }),
      summary:
        data.status === 'done' && skipped > 0
          ? t('runs.doneWithSkipped', { count: skipped })
          : status,
      at: open?.at ?? at,
      ...(data.status === 'started' ? { state: 'running' as const } : {}),
      ...(data.status === 'skipped' ? { state: 'skipped' as const } : {}),
      ...(data.status === 'done' && skipped > 0 ? { state: 'partial' as const } : {}),
      ...nested,
      ...(open && ms === undefined && data.status !== 'started'
        ? { durationSeconds: round(at - open.at) }
        : timing),
      blocks: [],
    };
    if (open) {
      this.steps[this.steps.indexOf(open)] = step;
      this.emit(step);
      if (data.status === 'started') this.flow.set(key, step);
      else this.flow.delete(key);
      return;
    }
    const added = this.add(step);
    if (data.status === 'started') this.flow.set(key, added);
  }

  private readSignal(e: Event, ts: number, prev: number, data: Data) {
    const status = String(data.status ?? '');
    this.add(
      this.completed(e, ts, prev, {
        type: 'guard',
        title: t('steps.readSignalTitle'),
        summary:
          data.degraded === true
            ? t('steps.readUnsure', { status: lookup(readSignals, status) })
            : lookup(readSignals, status),
        blocks: [],
        ...this.rawOf(data),
      }),
      true,
    );
  }

  private gate(e: Event, ts: number, prev: number, data: Data) {
    const status = String(data.status ?? '');
    const strategy = str(data.strategy);
    const move = strategy ? lookup(nextMoves, strategy) : undefined;
    this.add(
      this.completed(e, ts, prev, {
        type: 'guard',
        title:
          data.source === 'response-validation'
            ? t('steps.checkedAnswer')
            : t('steps.checkedSources'),
        summary: [lookup(gateStatus, status), move ? t('steps.next', { move }) : '']
          .filter(Boolean)
          .join(' · '),
        blocks: [],
        ...this.rawOf(data),
      }),
      true,
    );
  }

  private citations(e: Event, ts: number, prev: number, data: Data) {
    const action = String(data.action ?? '');
    const summary =
      action === 'backfill'
        ? data.adopted === true
          ? t('steps.citationsAdded')
          : t('steps.citationsNone')
        : lookup(citationActions, action);
    this.add(
      this.completed(e, ts, prev, {
        type: 'guard',
        title: t('steps.citationsTitle'),
        summary,
        blocks: [],
        ...this.rawOf(data),
      }),
      true,
    );
  }

  private discarded(e: Event, ts: number, data: Data) {
    const uncited = data.reason === 'uncited';
    const text = uncited ? t('steps.discardedUncited') : t('steps.discardedGate');
    this.warn(text);
    this.out.push({ kind: 'retract', reason: 'discarded' });
    this.add({
      id: `e${e.seq}`,
      type: 'note',
      title: t('steps.discardedTitle'),
      summary: text,
      at: this.offset(ts),
      warning: true,
      blocks: [],
      ...this.rawOf(data),
    });
  }

  private exhausted(e: Event, ts: number, data: Data) {
    const exhausted = data.stage === 'exhausted';
    const text = exhausted
      ? t('steps.exhausted', { count: num(data.iterations) ?? this.iterations })
      : t('steps.empty');
    this.warn(text);
    this.channel = 'answer';
    this.add({
      id: `e${e.seq}`,
      type: 'note',
      title: exhausted ? t('steps.exhaustedTitle') : t('steps.emptyTitle'),
      summary: text,
      at: this.offset(ts),
      state: 'partial',
      warning: true,
      blocks: [],
      ...this.rawOf(data),
    });
  }

  private turnCompleted(ts: number, data: Data) {
    const iteration = num(data.iteration);
    const calls = Array.isArray(data['tool-calls']) ? (data['tool-calls'] as unknown[]) : [];
    const open = this.openTools.filter((s) => iteration === undefined || s.iteration === iteration);
    const items: [string, string][] = [];
    calls.forEach((c, i) => {
      const call = record(c);
      const name = str(call.tool) ?? '';
      const args = record(call.args);
      const step = open[i];
      const queries = strings(args.queries);
      items.push([toolKind(name)[1], queries.length ? quoted(queries) : '']);
      if (!step) return;
      const ms = num(call['duration-ms']);
      if (ms !== undefined) step.durationSeconds = round(ms / 1000);
      if (step.state === 'running') delete step.state;
      if (call['ok?'] === false) step.state = 'failed';
      const pending = step.summary === t('steps.running');
      if (
        step.type === 'search' &&
        !step.blocks.some((b) => b.label === t('steps.searchLabel')) &&
        queries.length
      ) {
        const hits = step.blocks.find((b) => b.label === t('steps.topHits'));
        const found = pending ? '' : step.summary;
        this.searchBlocks(step, [], queries, filterTags(record(args.filter_by).fields));
        if (hits) step.blocks.push(hits);
        if (found) step.summary = found;
      } else if (pending)
        step.summary =
          name === 'read_chunks' && Array.isArray(args.chunk_ids)
            ? t('steps.askedFor', { chunks: counted('steps.chunks', args.chunk_ids.length) })
            : call['ok?'] === false
              ? t('steps.failed')
              : t('runs.stepDone');
      if (this.details) step.raw = { ...record(step.raw), call };
      this.emit(step);
    });
    const turn = iteration === undefined ? this.turn : this.turns.get(iteration);
    if (turn && items.length) {
      turn.blocks = [
        ...turn.blocks.filter((b) => !b.calls),
        {
          kind: 'list',
          label: t('steps.toolCalls', { count: items.length }),
          items,
          calls: true,
        },
      ];
      this.emit(turn);
    }
    for (const s of this.openTools) this.close(s, ts);
    this.openTools = [];
    this.turn = undefined;
  }

  private usage(e: Event, ts: number, prev: number, data: Data) {
    const usage = record(data.usage);
    const input = num(usage.inputTokens) ?? 0;
    const output = num(usage.outputTokens) ?? 0;
    const cached = num(usage.cachedInputTokens) ?? 0;
    const model = str(record(data.model).id) ?? str(record(data.ref).id) ?? t('steps.unknownModel');
    this.inputTokens += input;
    this.outputTokens += output;
    this.cachedInputTokens += cached;
    const cost = num(usage.costMicroNok);
    if (cost === undefined) this.unpricedTokens += input + output;
    else this.costMicroNok += cost;
    const seen = this.byModel.get(model) ?? { model, inputTokens: 0, outputTokens: 0, calls: 0 };
    const modelCost = cost === undefined ? seen.costMicroNok : (seen.costMicroNok ?? 0) + cost;
    this.byModel.set(model, {
      model,
      inputTokens: seen.inputTokens + input,
      outputTokens: seen.outputTokens + output,
      calls: seen.calls + 1,
      ...(modelCost === undefined ? {} : { costMicroNok: modelCost }),
    });
    if (data.port !== undefined && data.port !== 'model') return;
    const tokens = this.usageShown ? input + output : undefined;
    const tokenText = this.usageShown
      ? t('steps.modelTokens', { model, input: nbCount(input), output: nbCount(output) })
      : model;
    const host =
      (this.turn?.state === 'running' ? this.turn : undefined) ??
      this.openOf('model', 'plan', 'tool', 'search', 'read');
    const kv = (step: TimelineStep): TimelineBlock => ({
      kind: 'kv',
      rows: [
        [t('steps.model'), step.model ?? model],
        ...(this.usageShown
          ? [
              [
                t('steps.tokens'),
                t('steps.tokenCounts', { input: nbCount(input), output: nbCount(output) }),
              ] as [string, string],
              ...(cached ? [[t('steps.cached'), nbCount(cached)] as [string, string]] : []),
            ]
          : []),
      ],
      usage: true,
    });
    if (host) {
      if (tokens !== undefined) host.tokens = (host.tokens ?? 0) + tokens;
      host.model = model;
      host.blocks = [...host.blocks.filter((b) => !b.usage), kv(host)];
      if (host === this.turn) {
        host.summary = tokenText;
        this.close(host, ts);
        this.emit(host);
      } else this.emit(host);
      return;
    }
    const step = this.completed(e, ts, prev, {
      type: 'model',
      title: t('steps.modelCall'),
      summary: tokenText,
      ...(tokens === undefined ? {} : { tokens }),
      model,
      blocks: [],
      ...this.rawOf(data),
    });
    step.blocks = [kv(step)];
    this.steps.push(step);
    this.emit(step);
    this.pendingUsage.push(step);
  }

  private attributionSteps(e: Event, ts: number, sources: Data[]) {
    const items: [string, string][] = [];
    for (const a of sources)
      for (const item of Array.isArray(a.skipped) ? (a.skipped as unknown[]) : []) {
        const { document, reason } = record(item);
        if (
          typeof document === 'string' &&
          typeof reason === 'string' &&
          !this.skippedDocs.has(document)
        ) {
          this.skippedDocs.add(document);
          items.push([document, reasonText(document, reason)]);
        }
      }
    if (items.length) {
      const summary = t('runs.documentsSkipped', { count: items.length });
      this.warn(
        t('steps.warnSkippedDocs', { documents: counted('steps.documents', items.length) }),
      );
      this.add({
        id: `e${e.seq}s`,
        type: 'searchnote',
        title: t('runs.searchNote'),
        summary,
        at: this.offset(ts),
        warning: true,
        blocks: [{ kind: 'list', label: t('runs.engineSkipped'), items }],
      });
    }
    sources
      .flatMap((a) => strings(a.warnings))
      .forEach((warning, i) => {
        const text = warningText(warning);
        this.warn(text ?? t('runs.searchAdjusted'));
        this.add({
          id: `e${e.seq}w${i}`,
          type: 'note',
          title: t('runs.searchNote'),
          summary: text ?? t('runs.searchAdjusted'),
          at: this.offset(ts),
          warning: true,
          blocks: text ? [] : [{ kind: 'quote', text: warning }],
        });
      });
  }

  private result(e: Event, ts: number, prev: number) {
    const parts = Array.isArray(e.data) ? (e.data as Part[]) : [];
    const retrieval = record(jsonOf(parts, retrievalMime));
    const attribution = record(retrieval.attribution);
    this.attributionSteps(e, ts, [attribution]);
    const queries = strings(retrieval.queries);
    if (queries.length && !this.steps.some((s) => s.type === 'plan' || s.type === 'search'))
      this.add(
        this.completed(e, ts, prev, {
          type: 'search',
          title: t('steps.toolSearch'),
          summary: `${counted('steps.searches', queries.length)}: ${quoted(queries)}`,
          blocks: [{ kind: 'list', label: t('steps.searchLabel'), items: queries }],
        }),
      );
    for (const s of this.steps) this.close(s, ts);
    const sources = sourceTitles(parts);
    const clarification = record(record(jsonOf(parts, sourcesMime)).clarification);
    const question = str(clarification.question);
    const fields = jsonOf(parts, 'application/json');
    const text = textOf(parts);
    const blocks: TimelineBlock[] = question
      ? [
          { kind: 'quote', label: t('steps.clarifyQuestion'), text: question },
          ...(strings(clarification.options).length
            ? [
                {
                  kind: 'tags' as const,
                  label: t('steps.clarifyOptions'),
                  items: strings(clarification.options),
                },
              ]
            : []),
        ]
      : fields !== undefined && !text.trim()
        ? [{ kind: 'kv', label: t('steps.fields'), rows: fieldRows(fields) }]
        : [{ kind: 'answer', text, ...(sources.length ? { sources } : {}) }];
    this.add({
      id: `e${e.seq}`,
      type: 'result',
      title: question ? t('steps.clarifyTitle') : t('runs.answer'),
      summary: question
        ? t('steps.clarifySummary')
        : sources.length
          ? t('steps.answerWithSources', { sources: counted('steps.sources', sources.length) })
          : t('runs.delivered'),
      at: this.offset(ts),
      blocks,
    });
  }

  private error(e: Event, ts: number) {
    this.errors.push(e);
    const failure = failureOf(this.errors);
    if (!failure) return;
    const step: TimelineStep = {
      id: this.errorStep?.id ?? `e${e.seq}f`,
      type: 'error',
      title: failure.step ? t('runs.stepFailed', { step: failure.step }) : t('runs.runFailed'),
      summary: failureReason(failure),
      at: this.errorStep?.at ?? this.offset(ts),
      state: 'failed',
      blocks: this.details && failure.message ? [{ kind: 'quote', text: failure.message }] : [],
    };
    if (this.errorStep) {
      Object.assign(this.errorStep, step);
      this.emit(this.errorStep);
      return;
    }
    this.closeAll(ts);
    this.errorStep = this.add(step);
  }
}

export const mapRun = (events: Event[], options: RunMapperOptions = {}) => {
  const mapper = new RunMapper(options);
  for (const e of events) mapper.push(e);
  return mapper;
};
