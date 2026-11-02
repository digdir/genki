/**
 * What genki knows of a sent run before it starts, to tell which of a project's rules reach it.
 * The run's id, its trace name and its root span's name are new for each run (the draft's
 * capability id), so no filter can name them in advance.
 */
export interface RunShape {
  tenant: string;
  /** Langfuse's id for the test set's dataset; absent while it is not made, so no filter names it. */
  dataset?: string;
  /** The environment every span carries. */
  environment: string;
  /** The experiment's name, `<test set> v<version>`. */
  experimentName: string;
}

export interface RawFilter {
  type?: string;
  column?: string;
  operator?: string;
  key?: string;
  value?: unknown;
}

/**
 * What a rule's filters do with a run's cases: leave them out, judge each once on its root span,
 * or refuse the run, because the rule would judge more spans or genki cannot tell.
 */
export type Reach =
  | { kind: 'skip' }
  | { kind: 'judge' }
  | { kind: 'refuse'; why: 'every-span' | 'root-only' | 'unreadable'; column?: string };

/**
 * A value on a span: known, new for each run (so no filter can list it), or not known before the
 * run at all.
 */
type Value = { known: unknown } | { fresh: true } | { unknown: true };

/** A filter's answer on a span: through, not through, or genki cannot tell. */
type Answer = boolean | 'maybe';

/**
 * The filter columns of Langfuse 4.72.0 and the operators each takes, as its rule API answered on
 * 2026-11-02. A filter outside this list is one genki cannot read.
 */
const schema: Record<string, { type: string; operators: string[] }> = (() => {
  const options = { type: 'stringOptions', operators: ['any of', 'none of'] };
  const text = {
    type: 'string',
    operators: ['=', 'contains', 'does not contain', 'starts with', 'ends with', 'is not empty'],
  };
  const array = { type: 'arrayOptions', operators: ['any of', 'none of', 'all of'] };
  const number = { type: 'number', operators: ['=', '>', '<', '>=', '<='] };
  const boolean = { type: 'boolean', operators: ['=', '<>'] };
  return {
    datasetId: options,
    environment: options,
    name: options,
    traceName: options,
    type: options,
    level: options,
    experimentId: options,
    experimentName: text,
    version: text,
    release: text,
    statusMessage: text,
    providedModelName: text,
    promptName: text,
    userId: text,
    sessionId: text,
    promptVersion: number,
    toolCalls: number,
    tags: array,
    calledToolNames: array,
    isRootObservation: boolean,
    isExperimentItemRootSpan: boolean,
    parentObservationId: { type: 'null', operators: ['is null', 'is not null'] },
    metadata: {
      type: 'stringObject',
      operators: [
        '=',
        'contains',
        'does not contain',
        'starts with',
        'ends with',
        'is set',
        'is not set',
      ],
    },
  };
})();

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Whether the filter's value has the type its column takes. */
const typed = (f: RawFilter, type: string) => {
  if (type === 'stringOptions' || type === 'arrayOptions') return isStrings(f.value);
  if (type === 'string') return typeof f.value === 'string';
  if (type === 'boolean') return typeof f.value === 'boolean';
  if (type === 'number') return typeof f.value === 'number';
  if (type === 'stringObject') return typeof f.key === 'string' && typeof f.value === 'string';
  return true;
};

/**
 * The observation types genki sends below a case's root span: its steps and calls, and the agent
 * span of a service the case calls.
 */
const childTypes = ['AGENT', 'SPAN', 'GENERATION', 'RETRIEVER', 'TOOL'];

const textMatch = (operator: string, actual: string, wanted: string) => {
  if (operator === '=') return actual === wanted;
  if (operator === 'contains') return actual.includes(wanted);
  if (operator === 'does not contain') return !actual.includes(wanted);
  if (operator === 'starts with') return actual.startsWith(wanted);
  if (operator === 'ends with') return actual.endsWith(wanted);
  return actual !== '';
};

const answerOn = (f: RawFilter, value: Value, kind: 'root' | 'child'): Answer => {
  const operator = f.operator as string;
  if ('unknown' in value) return 'maybe';
  const listed = isStrings(f.value) ? f.value : [];
  if ('fresh' in value) {
    // A value new for this run is in no list a person wrote before it.
    if (operator === 'any of') return false;
    if (operator === 'none of') return true;
    return 'maybe';
  }
  const known = value.known;
  if (f.column === 'type' && kind === 'child') {
    const hits = childTypes.filter((t) => listed.includes(t)).length;
    const some: Answer = hits === 0 ? false : hits === childTypes.length ? true : 'maybe';
    if (operator === 'any of') return some;
    return some === 'maybe' ? 'maybe' : !some;
  }
  if (Array.isArray(known)) {
    const has = (x: string) => (known as string[]).includes(x);
    if (operator === 'any of') return listed.some(has);
    if (operator === 'none of') return !listed.some(has);
    return listed.every(has);
  }
  if (operator === 'any of') return typeof known === 'string' && listed.includes(known);
  if (operator === 'none of') return !(typeof known === 'string' && listed.includes(known));
  if (operator === 'is null') return known === null;
  if (operator === 'is not null') return known !== null;
  if (typeof f.value === 'boolean') return operator === '=' ? known === f.value : known !== f.value;
  // Langfuse compares text with letter case (InMemoryFilterService, 4.72.0).
  if (typeof known === 'string' && typeof f.value === 'string')
    return textMatch(operator, known, f.value);
  return 'maybe';
};

const valueOn = (column: string, run: RunShape, kind: 'root' | 'child'): Value => {
  const root = kind === 'root';
  switch (column) {
    case 'datasetId':
      return run.dataset === undefined ? { known: null } : { known: run.dataset };
    case 'environment':
      return { known: run.environment };
    case 'experimentName':
      return { known: run.experimentName };
    case 'experimentId':
    case 'traceName':
      return { fresh: true };
    case 'name':
      return root ? { fresh: true } : { unknown: true };
    case 'type':
      return root ? { known: 'AGENT' } : { known: 'child' };
    case 'tags':
      // The service's tag holds the draft's id, new for each run, so no filter can name it.
      // Langfuse reads tags per span, and genki tags only the root.
      return { known: root ? [`tenant:${run.tenant}`] : [] };
    case 'isExperimentItemRootSpan':
    case 'isRootObservation':
      return { known: root };
    case 'parentObservationId':
      return { known: root ? null : 'parent' };
    default:
      return { unknown: true };
  }
};

/** All of a rule's filters on a span: Langfuse lets a span through only when every one does. */
const allOn = (filters: RawFilter[], run: RunShape, kind: 'root' | 'child'): Answer => {
  let answer: Answer = true;
  for (const f of filters) {
    const one = answerOn(f, valueOn(f.column as string, run, kind), kind);
    if (one === false) return false;
    if (one === 'maybe') answer = 'maybe';
  }
  return answer;
};

/** The filter that makes a rule judge each experiment item once, on its root span. */
export const isItemRoot = (f: RawFilter) =>
  f.column === 'isExperimentItemRootSpan' &&
  ((f.operator === '=' && f.value === true) || (f.operator === '<>' && f.value === false));

/** The first filter outside Langfuse's measured schema, which genki cannot read at all. */
export const unreadFilter = (filters: RawFilter[]) =>
  filters.find((f) => {
    const column = schema[f.column ?? ''];
    return !column || !column.operators.includes(f.operator ?? '') || !typed(f, column.type);
  });

/** The first column genki cannot know on a case's root span before a run, such as `level`. */
export const unknownBeforeRun = (filters: RawFilter[], run: RunShape) =>
  filters.find((f) => f.column !== 'name' && 'unknown' in valueOn(f.column ?? '', run, 'root'))
    ?.column;

export const reachOf = (filters: RawFilter[], run: RunShape): Reach => {
  const unread = unreadFilter(filters);
  if (unread)
    return {
      kind: 'refuse',
      why: 'unreadable',
      ...(unread.column ? { column: unread.column } : {}),
    };
  const child = allOn(filters, run, 'child');
  const root = allOn(filters, run, 'root');
  if (child === false && root === false) return { kind: 'skip' };
  const unknownColumn = () => unknownBeforeRun(filters, run);
  if (child !== false) {
    // A span below the root may be judged: on every span, or by a value genki cannot know.
    const column = unknownColumn();
    return column && child === 'maybe'
      ? { kind: 'refuse', why: 'unreadable', column }
      : { kind: 'refuse', why: 'every-span' };
  }
  if (root === 'maybe') {
    const column = unknownColumn();
    return { kind: 'refuse', why: 'unreadable', ...(column ? { column } : {}) };
  }
  return filters.some(isItemRoot) ? { kind: 'judge' } : { kind: 'refuse', why: 'root-only' };
};
