import type { ServiceDefinition, ServiceSpec } from '../../data/service-definition';
import { datasetsOf, toolRefsOf } from '../../data/service-form';
import { sharedInstructionsOf } from '../../data/service-languages';

export type SetupArea =
  | 'purpose'
  | 'sources'
  | 'input'
  | 'result'
  | 'model'
  | 'tools'
  | 'how'
  | 'variants'
  | 'guards'
  | 'risk'
  | 'limits';

export const basicAreas: SetupArea[] = ['purpose', 'sources', 'input', 'result'];
export const advancedAreas: SetupArea[] = [
  'model',
  'tools',
  'how',
  'variants',
  'guards',
  'risk',
  'limits',
];
export const setupAreas: SetupArea[] = [...basicAreas, ...advancedAreas];

export type ChangeArea = SetupArea | 'channels' | 'quality' | 'other';

export type ChangeTopic =
  | 'name'
  | 'purpose'
  | 'audience'
  | 'instructions'
  | 'examples'
  | 'languages'
  | 'riskClass'
  | 'riskConfirmation'
  | 'dataset'
  | 'knowledge'
  | 'input'
  | 'inputField'
  | 'output'
  | 'model'
  | 'fallback'
  | 'operations'
  | 'tool'
  | 'strategy'
  | 'improve'
  | 'variants'
  | 'guard'
  | 'settings'
  | 'channels'
  | 'quality'
  | 'other';

export interface DraftChange {
  area: ChangeArea;
  topic: ChangeTopic;
  kind: 'added' | 'removed' | 'changed';
  subject?: string;
  before?: string;
  after?: string;
}

type Tree = Record<string, unknown>;

const tree = (v: unknown): Tree =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Tree) : {};

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => (v as Tree)[k] !== undefined)
            .map((k) => [k, canonical((v as Tree)[k])]),
        )
      : v;

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const without = (o: Tree, keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const keyed = <T>(items: T[], keyOf: (item: T) => string) =>
  new Map(items.map((item) => [keyOf(item), item] as const));

const listChanges = <T>(
  before: T[],
  after: T[],
  keyOf: (item: T) => string,
  make: (kind: DraftChange['kind'], key: string) => DraftChange,
): DraftChange[] => {
  const was = keyed(before, keyOf);
  const now = keyed(after, keyOf);
  return [
    ...[...now.keys()].filter((k) => !was.has(k)).map((k) => make('added', k)),
    ...[...was.keys()].filter((k) => !now.has(k)).map((k) => make('removed', k)),
    ...[...now.keys()]
      .filter((k) => was.has(k) && !sameValue(was.get(k), now.get(k)))
      .map((k) => make('changed', k)),
  ];
};

const handled = new Set([
  'purpose',
  'audience',
  'languages',
  'riskClass',
  'riskConfirmation',
  'input',
  'output',
  'strategy',
  'knowledge',
  'tools',
  'skills',
  'model',
  'guardrails',
  'variants',
  'settings',
  'callOverrides',
  'exposure',
  'availableTo',
  'triggers',
  'batch',
  'evaluation',
  'improve',
]);

const otherArea: Record<string, ChangeArea> = { exampleQuestions: 'purpose' };

const specChangesOf = (was: ServiceSpec, now: ServiceSpec): DraftChange[] => {
  const out: DraftChange[] = [];
  const differs = (key: keyof ServiceSpec) => !sameValue(was[key], now[key]);
  const simple = (area: ChangeArea, topic: ChangeTopic) =>
    out.push({ area, topic, kind: 'changed' });

  if (differs('purpose')) simple('purpose', 'purpose');
  if (differs('audience')) simple('purpose', 'audience');
  if (differs('languages')) simple('purpose', 'languages');

  const instructionsBefore = tree(was.strategy.config).instructions;
  const instructionsAfter = tree(now.strategy.config).instructions;
  if (!sameValue(instructionsBefore, instructionsAfter))
    out.push({
      area: 'purpose',
      topic: 'instructions',
      kind: instructionsBefore === undefined ? 'added' : 'changed',
      before: sharedInstructionsOf(was),
      after: sharedInstructionsOf(now),
    });
  if (!sameValue(tree(was.strategy.config).examples, tree(now.strategy.config).examples))
    simple('purpose', 'examples');
  const strategyRest = (s: ServiceSpec['strategy']) => ({
    ...s,
    config: without(tree(s.config), ['instructions', 'examples']),
  });
  if (!sameValue(strategyRest(was.strategy), strategyRest(now.strategy)))
    out.push({
      area: 'how',
      topic: 'strategy',
      kind: 'changed',
      before: was.strategy.id,
      after: now.strategy.id,
    });

  if (differs('riskClass'))
    out.push({
      area: 'risk',
      topic: 'riskClass',
      kind: was.riskClass ? (now.riskClass ? 'changed' : 'removed') : 'added',
      ...(was.riskClass ? { before: was.riskClass } : {}),
      ...(now.riskClass ? { after: now.riskClass } : {}),
    });
  if (differs('riskConfirmation'))
    out.push({
      area: 'risk',
      topic: 'riskConfirmation',
      kind: was.riskConfirmation ? (now.riskConfirmation ? 'changed' : 'removed') : 'added',
    });

  out.push(
    ...listChanges(
      datasetsOf(was),
      datasetsOf(now),
      (d) => d.dataset,
      (kind, subject) => ({ area: 'sources', topic: 'dataset', kind, subject }),
    ),
  );
  if (
    !sameValue(
      without(tree(was.knowledge), ['datasets']),
      without(tree(now.knowledge), ['datasets']),
    )
  )
    simple('sources', 'knowledge');

  const fieldId = (f: { id?: unknown; label?: unknown }) =>
    typeof f.id === 'string' ? f.id : String(f.label ?? '');
  out.push(
    ...listChanges(was.input.fields ?? [], now.input.fields ?? [], fieldId, (kind, subject) => ({
      area: 'input',
      topic: 'inputField',
      kind,
      subject,
    })),
  );
  if (!sameValue(without(tree(was.input), ['fields']), without(tree(now.input), ['fields'])))
    simple('input', 'input');

  if (differs('output'))
    out.push({
      area: 'result',
      topic: 'output',
      kind: 'changed',
      before: was.output.kind,
      after: now.output.kind,
    });

  out.push(
    ...listChanges(
      toolRefsOf(was),
      toolRefsOf(now),
      (r) => r,
      (kind, subject) => ({ area: 'tools', topic: 'tool', kind, subject }),
    ),
  );
  if (differs('skills')) simple('tools', 'tool');

  if (was.model.primary !== now.model.primary)
    out.push({
      area: 'model',
      topic: 'model',
      kind: 'changed',
      before: was.model.primary,
      after: now.model.primary,
    });
  if (was.model.fallback !== now.model.fallback)
    out.push({
      area: 'model',
      topic: 'fallback',
      kind: was.model.fallback ? (now.model.fallback ? 'changed' : 'removed') : 'added',
      ...(was.model.fallback ? { before: was.model.fallback } : {}),
      ...(now.model.fallback ? { after: now.model.fallback } : {}),
    });
  if (!sameValue(was.model.operations, now.model.operations)) simple('model', 'operations');
  if (
    was.model.primary === now.model.primary &&
    !sameValue(
      without(tree(was.model), ['primary', 'fallback', 'operations']),
      without(tree(now.model), ['primary', 'fallback', 'operations']),
    )
  )
    simple('model', 'other');

  out.push(
    ...listChanges(
      Object.entries(was.guardrails ?? {}),
      Object.entries(now.guardrails ?? {}),
      ([key]) => key,
      (kind, subject) => ({ area: 'guards', topic: 'guard', kind, subject }),
    ),
  );
  if (differs('variants')) simple('variants', 'variants');
  if (differs('settings') || differs('callOverrides')) simple('limits', 'settings');
  if (differs('exposure') || differs('availableTo') || differs('triggers') || differs('batch'))
    simple('channels', 'channels');
  if (differs('evaluation')) simple('quality', 'quality');
  if (differs('improve')) simple('how', 'improve');

  const rest = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
    (key) => !handled.has(key) && !sameValue(tree(was)[key], tree(now)[key]),
  );
  rest.forEach((key) =>
    out.push({ area: otherArea[key] ?? 'other', topic: 'other', kind: 'changed', subject: key }),
  );
  return out;
};

export const draftChanges = (
  published: ServiceDefinition,
  draft: ServiceDefinition,
): DraftChange[] => [
  ...((published.metadata.name ?? '') === (draft.metadata.name ?? '')
    ? []
    : [
        {
          area: 'purpose' as const,
          topic: 'name' as const,
          kind: 'changed' as const,
          before: published.metadata.name ?? '',
          after: draft.metadata.name ?? '',
        },
      ]),
  ...specChangesOf(published.spec, draft.spec),
];

export interface SentencePart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const sentences = (text: string) =>
  text
    .split('\n')
    .flatMap((line) => line.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((s) => s.trim())
    .filter(Boolean);

export const sentenceDiff = (before: string, after: string): SentencePart[] => {
  const a = sentences(before);
  const b = sentences(after);
  const width = b.length + 1;
  const lcs = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const parts: SentencePart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const was = a[i] ?? '';
    const now = b[j] ?? '';
    if (was === now) {
      parts.push({ kind: 'same', text: was });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      parts.push({ kind: 'removed', text: was });
      i += 1;
    } else {
      parts.push({ kind: 'added', text: now });
      j += 1;
    }
  }
  a.slice(i).forEach((text) => parts.push({ kind: 'removed', text }));
  b.slice(j).forEach((text) => parts.push({ kind: 'added', text }));
  return parts;
};

const areaPatterns: [RegExp, SetupArea][] = [
  [/^metadata\.name/, 'purpose'],
  [/^spec\.(purpose|audience|languages|exampleQuestions)/, 'purpose'],
  [/^spec\.strategy\.config\.(instructions|examples)/, 'purpose'],
  [/^spec\.(riskClass|riskConfirmation)/, 'risk'],
  [/^spec\.knowledge/, 'sources'],
  [/^spec\.input/, 'input'],
  [/^spec\.output/, 'result'],
  [/^spec\.model/, 'model'],
  [/^spec\.(tools|skills)/, 'tools'],
  [/^spec\.(strategy|improve)/, 'how'],
  [/^spec\.variants/, 'variants'],
  [/^spec\.guardrails/, 'guards'],
  [/^spec\.(settings|callOverrides)/, 'limits'],
];

export const areaOfPath = (path: string): SetupArea | undefined =>
  areaPatterns.find(([pattern]) => pattern.test(path))?.[1];
