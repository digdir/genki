import {
  blocks,
  type BlockStep,
  type BranchStep,
  type RepeatStep,
  type Flow,
  type OnError,
  type Step,
} from '../../data/stepflows';
import { translator, type PlainKey, type T } from '../../i18n';

const nbT = translator('nb');

export type Guide = { style: 'solid' | 'dashed' | 'dotted'; color: string };

export type Row =
  | { kind: 'step'; step: BlockStep; guides: Guide[]; readonly: boolean }
  | { kind: 'control'; step: Exclude<Step, BlockStep | { kind: 'sub' }>; guides: Guide[] }
  | { kind: 'sub'; step: Extract<Step, { kind: 'sub' }>; guides: Guide[]; flow?: Flow }
  | { kind: 'case'; label: string; when: string; branch: BranchStep; guides: Guide[]; err: string }
  | { kind: 'end'; label: string; guides: Guide[] };

export interface RefInfo {
  label: string;
  type: string;
}

export interface Analysis {
  rows: Row[];
  errors: Map<string, string[]>;
  visibleAt: Record<string, string[]>;
  labels: Record<string, string>;
  refs: Record<string, RefInfo>;
  all: Step[];
  unknownParams: Record<string, string[]>;
}

export const childLists = (s: Step): Step[][] => {
  if (s.kind === 'repeat' || s.kind === 'foreach') return [s.steps];
  if (s.kind === 'branch') return [...s.cases.map((c) => c.steps), s.else];
  return [];
};

export const allSteps = (steps: Step[]): Step[] =>
  steps.flatMap((s) => [s, ...childLists(s).flatMap(allSteps)]);

export const countSteps = (steps: Step[]) => allSteps(steps).length;

export const findStep = (steps: Step[], id: string) => allSteps(steps).find((s) => s.id === id);

const withChildren = (s: Step, map: (list: Step[]) => Step[]): Step => {
  if (s.kind === 'repeat' || s.kind === 'foreach') return { ...s, steps: map(s.steps) };
  if (s.kind === 'branch')
    return { ...s, cases: s.cases.map((c) => ({ ...c, steps: map(c.steps) })), else: map(s.else) };
  return s;
};

export const replaceStep = (steps: Step[], id: string, next: Step | null): Step[] =>
  steps.flatMap((s) => {
    if (s.id === id) return next ? [next] : [];
    return [withChildren(s, (list) => replaceStep(list, id, next))];
  });

export const insertAfter = (steps: Step[], id: string, added: Step): Step[] =>
  steps.flatMap((s) => {
    const n = withChildren(s, (list) => insertAfter(list, id, added));
    return s.id === id ? [n, added] : [n];
  });

export const newBlockStep = (id: string, t: T = nbT): BlockStep => ({
  kind: 'block',
  id,
  block: '',
  label: t('stepflows.newStep'),
  in: {},
  p: {},
  err: 'stop',
});

export const nextStepId = (flow: Flow) => {
  const ids = new Set(allSteps(flow.steps).map((s) => s.id));
  let n = ids.size + 1;
  while (ids.has(`steg${n}`)) n++;
  return `steg${n}`;
};

export const omit = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as K))) as Omit<
    T,
    K
  >;

export const versionLabel = (flow: Flow, t: T = nbT) =>
  t(flow.draft ? 'stepflows.versionDraft' : 'stepflows.version', { version: flow.version });

export const maxRepeat = 100;

export const controlName = {
  repeat: 'stepflows.controlRepeat',
  foreach: 'stepflows.controlForeach',
  branch: 'stepflows.controlBranch',
  sub: 'stepflows.controlSub',
} as const satisfies Record<string, PlainKey>;

export const errorLabel = {
  stop: 'stepflows.errorStop',
  skip: 'stepflows.errorSkip',
  'use-default': 'stepflows.errorUseDefault',
} as const satisfies Record<OnError, PlainKey>;

const whole = /^\{\{\s*([^}]+?)\s*\}\}$/;
const template = /\{\{\s*([^}]+?)\s*\}\}/g;
const literal = /^(true|false|null|-?\d+(\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")$/;
const scopes = new Set(['input', 'config', 'vars', 'steps']);
const alwaysInput = new Set(['query', 'text', 'history', 'parts']);

export const refParts = (expression: string) =>
  expression
    .split('??')
    .map((t) => t.trim())
    .filter((t) => t && !literal.test(t));

export const templatesIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [...value.matchAll(template)].map((m) => m[1] ?? '')
    : Array.isArray(value)
      ? value.flatMap(templatesIn)
      : typeof value === 'object' && value !== null
        ? Object.values(value).flatMap(templatesIn)
        : [];

export const refVisible = (ref: string, visible: string[]) => {
  const [head = '', ...rest] = ref.split('.');
  if (head === 'config' || head === 'vars' || head === 'loop' || head === 'settings') return true;
  if (head === 'input' && alwaysInput.has(rest[0] ?? '')) return true;
  if (!scopes.has(head) && visible.includes(head)) return true;
  const canonical = scopes.has(head) ? ref : ['steps', head, ...rest].join('.');
  if (canonical.startsWith('steps.')) {
    const step = canonical.split('.').slice(0, 2).join('.');
    return visible.some((v) => v === step || v.startsWith(`${step}.`));
  }
  return visible.some((v) => canonical === v || canonical.startsWith(`${v}.`));
};

export const splitInput = (value: unknown) => {
  const refs: Record<string, string> = {};
  const raw: Record<string, unknown> = {};
  if (isRaw(value))
    for (const [k, x] of Object.entries(value)) {
      const m = typeof x === 'string' ? whole.exec(x) : null;
      if (m?.[1]) refs[k] = m[1];
      else raw[k] = x;
    }
  return { in: refs, ...(Object.keys(raw).length ? { raw } : {}) };
};

const joinInput = (refs: Record<string, string>, raw: Record<string, unknown> | undefined) => {
  const out: Record<string, unknown> = { ...raw };
  for (const [k, v] of Object.entries(refs)) if (v) out[k] = `{{${v}}}`;
  return out;
};

export const rangeText = (p: { min?: number | undefined; max?: number | undefined }, t: T) =>
  p.min !== undefined && p.max !== undefined
    ? t('stepflows.rangeBetween', { min: p.min, max: p.max })
    : p.min !== undefined
      ? t('stepflows.rangeMin', { min: p.min })
      : t('stepflows.rangeMax', { max: p.max ?? 0 });

const outputsOf = (s: Step): [string, string][] => {
  if (s.kind === 'foreach') return [['', 'liste']];
  if (s.kind === 'sub') return s.out;
  if (s.kind !== 'block') return [];
  return blocks[s.block]?.outputs ?? [];
};

export const analyse = (
  flow: Flow,
  flows: Record<string, Flow>,
  subOpen: Record<string, boolean> = {},
  t: T = nbT,
): Analysis => {
  const rows: Row[] = [];
  const errors = new Map<string, string[]>();
  const visibleAt: Record<string, string[]> = {};
  const labels: Record<string, string> = {};
  const refs: Record<string, RefInfo> = {};
  const all = allSteps(flow.steps);
  const unknownParams: Record<string, string[]> = {};
  all.forEach((s) => (labels[s.id] = s.label || s.id));
  flow.input.forEach(
    ([n, type]) => (refs[`input.${n}`] = { label: t('stepflows.refInput', { name: n }), type }),
  );
  const addErr = (id: string, message: string) =>
    errors.set(id, [...(errors.get(id) ?? []), message]);
  const register = (s: Step, visible: string[]) =>
    outputsOf(s).forEach(([o, type]) => {
      const ref = o ? `steps.${s.id}.${o}` : `steps.${s.id}`;
      refs[ref] = {
        label: t('stepflows.refOutput', {
          step: s.label || s.id,
          output: o || t('stepflows.refResults'),
        }),
        type,
      };
      visible.push(ref);
    });
  const checkRef = (id: string, ref: string | undefined, visible: string[], what: string) => {
    if (!ref) return;
    for (const part of refParts(ref)) {
      if (refVisible(part, visible)) continue;
      const ref = refs[part]?.label ?? part;
      addErr(
        id,
        what ? t('stepflows.refMissingWhat', { what, ref }) : t('stepflows.refMissing', { ref }),
      );
    }
  };
  const checkTemplates = (
    id: string,
    raw: Record<string, unknown> | undefined,
    visible: string[],
  ) =>
    Object.entries(raw ?? {}).forEach(([n, value]) =>
      templatesIn(value).forEach((expr) => checkRef(id, expr, visible, n)),
    );

  const walk = (steps: Step[], visible: string[], guides: Guide[], unreachable: string) => {
    steps.forEach((s) => {
      const v = visible.slice();
      visibleAt[s.id] = v;
      if (unreachable) addErr(s.id, unreachable);
      if (s.kind === 'block') {
        const b = blocks[s.block];
        if (!s.block) addErr(s.id, t('stepflows.chooseBlock'));
        else if (!b) addErr(s.id, t('stepflows.unknownBlock', { block: s.block }));
        if (b) {
          b.inputs.forEach(([n, , required]) => {
            const ref = s.in[n];
            if (required && !ref && s.raw?.[n] === undefined)
              addErr(s.id, t('stepflows.missingInput', { name: n }));
            else checkRef(s.id, ref, v, n);
          });
          checkTemplates(s.id, s.raw, v);
          const known = new Set(b.params.map((param) => param.name));
          const unknown = Object.keys(s.p).filter((name) => !known.has(name));
          if (unknown.length) unknownParams[s.id] = unknown;
          b.params.forEach((param) => {
            const val = s.p[param.name];
            const templated = templatesIn(val).length > 0;
            if (
              (param.type === 'int' || param.type === 'float') &&
              val !== undefined &&
              val !== '' &&
              !templated
            ) {
              const x = Number(val);
              if (Number.isNaN(x) || x < (param.min ?? -Infinity) || x > (param.max ?? Infinity))
                addErr(
                  s.id,
                  t('stepflows.paramRange', { label: param.label, range: rangeText(param, t) }),
                );
              else if (param.type === 'int' && !Number.isInteger(x))
                addErr(s.id, t('stepflows.paramInt', { label: param.label }));
            }
            if (param.required && (val === undefined || val === ''))
              addErr(s.id, t('stepflows.paramRequired', { label: param.label }));
            if (param.type === 'list' && Array.isArray(val) && val.length === 0)
              addErr(s.id, t('stepflows.paramListEmpty', { label: param.label }));
            if (param.type === 'json' && typeof val === 'string' && !templated)
              addErr(s.id, t('stepflows.paramJson', { label: param.label }));
            if (
              param.type === 'columns' &&
              Array.isArray(val) &&
              val.some((c) => !isRaw(c) || !c.key || !c.label || !c.from)
            )
              addErr(s.id, t('stepflows.paramColumns', { label: param.label.toLowerCase() }));
          });
        }
        if (s.err === 'use-default' && !s.def) addErr(s.id, t('stepflows.chooseDefault'));
        rows.push({ kind: 'step', step: s, guides, readonly: false });
        register(s, visible);
      } else if (s.kind === 'repeat') {
        const childOut = s.steps.flatMap((c) =>
          outputsOf(c).map(([o]) => (o ? `steps.${c.id}.${o}` : `steps.${c.id}`)),
        );
        const untilRef = s.until.ref.replace(/^!/, '').split(/\s*(?:==|!=|>=|<=|>|<)\s*/)[0] ?? '';
        if (s.max === '') addErr(s.id, t('stepflows.loopNoMax'));
        else if (s.max < 1 || s.max > maxRepeat || !Number.isInteger(s.max))
          addErr(s.id, t('stepflows.loopMaxRange', { max: maxRepeat }));
        if (!s.until.ref) addErr(s.id, t('stepflows.loopChooseStop'));
        else if (!refParts(untilRef).every((r) => refVisible(r, [...childOut, ...v])))
          addErr(s.id, t('stepflows.loopStopOutside'));
        rows.push({ kind: 'control', step: s, guides });
        const inner: Guide[] = [
          ...guides,
          { style: 'dashed', color: 'var(--ds-color-warning-border-default)' },
        ];
        const vin = [...v, 'loop'];
        walk(s.steps, vin, inner, unreachable);
        rows.push({
          kind: 'end',
          label: t('stepflows.loopBack', {
            label: s.label || s.id,
            max: s.max === '' ? '?' : s.max,
          }),
          guides: inner,
        });
        vin.forEach((r) => r !== 'loop' && !visible.includes(r) && visible.push(r));
      } else if (s.kind === 'foreach') {
        checkRef(s.id, s.over, v, t('stepflows.whatList'));
        if (!s.over) addErr(s.id, t('stepflows.chooseList'));
        if (!s.as) addErr(s.id, t('stepflows.nameItems'));
        rows.push({ kind: 'control', step: s, guides });
        const inner: Guide[] = [
          ...guides,
          { style: 'dashed', color: 'var(--ds-color-info-border-default)' },
        ];
        refs[s.as] = { label: t('stepflows.refItem', { name: s.as }), type: 'element' };
        walk(s.steps, [...v, s.as, 'loop'], inner, unreachable);
        rows.push({ kind: 'end', label: t('stepflows.nextItem'), guides: inner });
        register(s, visible);
      } else if (s.kind === 'branch') {
        checkRef(s.id, s.on, v, t('stepflows.whatValue'));
        if (!s.on) addErr(s.id, t('stepflows.chooseSwitch'));
        const source = /^steps\.([^.]+)\.label$/.exec(s.on)?.[1];
        const src = source ? all.find((x) => x.id === source) : undefined;
        const known =
          src?.kind === 'block' && src.block === 'classify' && Array.isArray(src.p.labels)
            ? src.p.labels
            : undefined;
        rows.push({ kind: 'control', step: s, guides });
        const inner: Guide[] = [
          ...guides,
          { style: 'solid', color: 'var(--ds-color-accent-border-default)' },
        ];
        const deeper: Guide[] = [...inner, { style: 'solid', color: 'transparent' }];
        s.cases.forEach((c) => {
          const un =
            known && !known.includes(c.when)
              ? t('stepflows.unreachable', { when: c.when, label: labels[source ?? ''] ?? '' })
              : '';
          if (un) addErr(s.id, un);
          rows.push({
            kind: 'case',
            label: t('stepflows.caseIf', { when: c.when }),
            when: c.when,
            branch: s,
            guides: inner,
            err: un ? t('stepflows.caseUnreachable') : '',
          });
          walk(c.steps, v.slice(), deeper, un || unreachable);
        });
        rows.push({
          kind: 'case',
          label: t('stepflows.caseElse'),
          when: '__else',
          branch: s,
          guides: inner,
          err: '',
        });
        walk(s.else, v.slice(), deeper, unreachable);
      } else {
        const sf = flows[s.flow];
        if (!sf) addErr(s.id, t('stepflows.subMissing', { flow: s.flow }));
        else
          sf.input.forEach(([n]) => {
            const ref = s.in[n];
            if (!ref && s.raw?.[n] === undefined)
              addErr(s.id, t('stepflows.missingInput', { name: n }));
            else checkRef(s.id, ref, v, n);
          });
        checkTemplates(s.id, s.raw, v);
        rows.push({ kind: 'sub', step: s, guides, ...(sf ? { flow: sf } : {}) });
        if (sf && subOpen[s.id]) {
          const inner: Guide[] = [
            ...guides,
            { style: 'dotted', color: 'var(--ds-color-neutral-border-strong)' },
          ];
          sf.steps.forEach((c) => {
            if (c.kind === 'block')
              rows.push({ kind: 'step', step: c, guides: inner, readonly: true });
          });
        }
        register(s, visible);
      }
    });
  };
  walk(
    flow.steps,
    flow.input.map(([n]) => `input.${n}`),
    [],
    '',
  );
  return { rows, errors, visibleAt, labels, refs, all, unknownParams };
};

const documentColumns = [
  ['document.title', 'stepflows.documentTitle'],
  ['document.id', 'stepflows.documentId'],
  ['document.url', 'stepflows.documentUrl'],
] as const satisfies readonly (readonly [string, PlainKey])[];

const propertiesOf = (schema: unknown): Record<string, unknown> =>
  isRaw(schema) && isRaw(schema.properties) ? schema.properties : {};

export const columnSources = (
  s: Step,
  a: Analysis,
  t: T = nbT,
): { value: string; label: string }[] => {
  if (s.kind !== 'block' || s.block !== 'table') return [];
  const out = documentColumns.map(([value, label]) => ({ value, label: t(label) }));
  const loopId = (s.in.items ?? '').replace(/^steps\./, '').split('.')[0];
  const loop = a.all.find((x) => x.id === loopId);
  if (loop?.kind !== 'foreach') return out;
  const source = [...loop.steps]
    .reverse()
    .find((x): x is BlockStep => x.kind === 'block' && isRaw(x.p.schema));
  if (!source) return out;
  const name = source.label || source.id;
  const top = propertiesOf(source.p.schema);
  const rows = typeof s.p.rows === 'string' ? s.p.rows : '';
  const list = top[rows];
  const own = rows ? Object.keys(propertiesOf(isRaw(list) ? list.items : undefined)) : [];
  return [
    ...out,
    ...(rows ? own : Object.keys(top)).map((k) => ({ value: k, label: `${name} › ${k}` })),
    ...(rows ? Object.keys(top).filter((k) => k !== rows) : []).map((k) => ({
      value: `item.${k}`,
      label: `${name} › ${k}`,
    })),
  ];
};

export const errorCount = (a: Analysis) =>
  [...a.errors.values()].reduce((n, list) => n + list.length, 0);

const onErrorOut: Record<OnError, string> = {
  stop: 'stop',
  skip: 'skip',
  'use-default': 'use-default',
};

const quoted = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const untilExpression = (until: RepeatStep['until']) =>
  until.raw ??
  (until.val === ''
    ? until.ref
    : `${until.ref} == ${literal.test(until.val) ? until.val : quoted(until.val)}`);

const parseUntil = (text: string): RepeatStep['until'] => {
  const legacy = /^(\S*)\s+er\s+(.*)$/.exec(text);
  if (legacy) return { ref: legacy[1] ?? '', val: legacy[2] ?? '' };
  const m = /^(.+?)\s*==\s*(.+)$/.exec(text);
  const parsed: RepeatStep['until'] = m
    ? {
        ref: m[1] ?? '',
        val: /^'.*'$|^".*"$/.test(m[2] ?? '')
          ? (m[2] ?? '').slice(1, -1).replace(/\\(.)/g, '$1')
          : (m[2] ?? ''),
      }
    : { ref: text, val: '' };
  return untilExpression(parsed) === text ? parsed : { ...parsed, raw: text };
};

const withDefault = (err: OnError | undefined, def: string | undefined, raw: unknown) =>
  err === 'use-default' ? { default: raw !== undefined ? raw : (def ?? '') } : {};

const inputOf = (refs: Record<string, string>, raw: Record<string, unknown> | undefined) => {
  const input = joinInput(refs, raw);
  return Object.keys(input).length ? { input } : {};
};

const stepToDefinition = (s: Step, flows: Record<string, Flow>): Record<string, unknown> => {
  const base = { id: s.id, name: s.label || s.id };
  if (s.kind === 'repeat')
    return {
      ...base,
      repeat: {
        until: untilExpression(s.until),
        max: s.max,
        steps: s.steps.map((c) => stepToDefinition(c, flows)),
      },
    };
  if (s.kind === 'foreach')
    return {
      ...base,
      ...(s.err ? { onError: onErrorOut[s.err] } : {}),
      ...withDefault(s.err, s.def, s.defRaw),
      forEach: { in: s.over, as: s.as, steps: s.steps.map((c) => stepToDefinition(c, flows)) },
    };
  if (s.kind === 'branch')
    return {
      ...base,
      switchOn: s.on,
      cases: s.cases.map((c) => ({
        when: c.raw !== undefined ? c.raw : c.when,
        steps: c.steps.map((x) => stepToDefinition(x, flows)),
      })),
      else: s.else.map((c) => stepToDefinition(c, flows)),
    };
  if (s.kind === 'sub')
    return {
      ...base,
      subflow: `${s.flow}@${s.version ?? flows[s.flow]?.version ?? 1}`,
      ...inputOf(s.in, s.raw),
    };
  return {
    ...base,
    block: s.block ? `${s.block}@${s.version ?? blocks[s.block]?.version ?? '1'}` : '',
    ...inputOf(s.in, s.raw),
    ...(Object.keys(s.p).length ? { params: s.p } : {}),
    onError: onErrorOut[s.err],
    ...withDefault(s.err, s.def, s.defRaw),
  };
};

export const toDefinition = (flow: Flow, tenant: string, flows: Record<string, Flow>) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant, id: flow.id, name: flow.name, version: flow.version },
  spec: {
    purpose: flow.desc,
    input: Object.fromEntries(flow.input),
    ...(flow.recipe ? { recipe: flow.recipe } : {}),
    ...(flow.settings ? { settings: flow.settings } : {}),
    steps: flow.steps.map((s) => stepToDefinition(s, flows)),
  },
});

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const unversioned = (ref: string) => ref.replace(/@[\d.]+$/, '');

const legacyErr: Record<string, OnError> = {
  stop: 'stop',
  stopp: 'stop',
  skip: 'skip',
  hopp_over: 'skip',
  'use-default': 'use-default',
  useDefault: 'use-default',
  standardverdi: 'use-default',
};

const pick = (y: Raw, ...keys: string[]) => {
  for (const k of keys) if (y[k] !== undefined) return y[k];
  return undefined;
};

const versionOf = (ref: string) => /@([\d.]+)$/.exec(ref)?.[1];

const defaultOf = (def: unknown) =>
  def === undefined || def === null
    ? {}
    : typeof def === 'string'
      ? { def }
      : { def: JSON.stringify(def), defRaw: def };

const stepsFrom = (list: unknown, path: string, t: T): Step[] => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(t('stepflows.listRequired', { path }));
  return list.map((y, i): Step => {
    if (!isRaw(y) || !y.id) throw new Error(t('stepflows.stepNoId', { n: i + 1, path }));
    const id = str(y.id);
    const label = str(pick(y, 'name', 'navn')) || id;
    const repeat = pick(y, 'repeat', 'gjenta');
    if (isRaw(repeat)) {
      const max = pick(repeat, 'max', 'maks');
      return {
        kind: 'repeat',
        id,
        label,
        until: parseUntil(str(pick(repeat, 'until', 'til'))),
        max:
          typeof max === 'number'
            ? max
            : max === '' || max === undefined || max === null
              ? ''
              : Number(max),
        steps: stepsFrom(pick(repeat, 'steps', 'steg'), id, t),
      };
    }
    const each = pick(y, 'forEach', 'for_hver');
    if (isRaw(each)) {
      const err = legacyErr[str(pick(y, 'onError', 'ved_feil'))];
      return {
        kind: 'foreach',
        id,
        label,
        over: str(pick(each, 'in', 'i')),
        as: str(pick(each, 'as', 'som')),
        steps: stepsFrom(pick(each, 'steps', 'steg'), id, t),
        ...(err ? { err } : {}),
        ...defaultOf(pick(y, 'default', 'standardverdi')),
      };
    }
    const on = pick(y, 'switchOn', 'velg_etter');
    if (on !== undefined) {
      const cases = pick(y, 'cases', 'tilfeller');
      return {
        kind: 'branch',
        id,
        label,
        on: str(on),
        cases: (Array.isArray(cases) ? cases : []).map((c) => {
          const when = isRaw(c) ? pick(c, 'when', 'nar') : '';
          return {
            when: str(when),
            ...(typeof when === 'string' ? {} : { raw: when }),
            steps: stepsFrom(isRaw(c) ? pick(c, 'steps', 'steg') : [], id, t),
          };
        }),
        else: stepsFrom(pick(y, 'else', 'ellers'), id, t),
      };
    }
    const sub = pick(y, 'subflow', 'delflyt');
    if (sub !== undefined)
      return {
        kind: 'sub',
        id,
        label,
        flow: unversioned(str(sub)),
        ...(versionOf(str(sub)) ? { version: Number(versionOf(str(sub))) } : {}),
        ...splitInput(y.input),
        out: [['dokumenter', 'liste']],
      };
    const ref = str(pick(y, 'block', 'byggekloss'));
    const block = unversioned(ref);
    const version = versionOf(ref);
    const err = legacyErr[str(pick(y, 'onError', 'ved_feil'))] ?? 'stop';
    const params = pick(y, 'params', 'parametre');
    return {
      kind: 'block',
      id,
      label,
      block,
      ...(version && version !== (blocks[block]?.version ?? '1') ? { version } : {}),
      ...splitInput(y.input),
      p: isRaw(params) ? { ...params } : {},
      err,
      ...defaultOf(pick(y, 'default', 'standardverdi')),
    };
  });
};

export const assertUniqueIds = (steps: Step[], t: T = nbT) => {
  const seen = new Set<string>();
  allSteps(steps).forEach((s) => {
    if (seen.has(s.id)) throw new Error(t('stepflows.duplicateId', { id: s.id }));
    seen.add(s.id);
  });
};

export const fromDefinition = (raw: unknown, base?: Partial<Flow>, t: T = nbT): Flow => {
  if (!isRaw(raw)) throw new Error(t('stepflows.expectedFlow'));
  if (raw.apiVersion !== 'genai/v1') throw new Error(t('stepflows.apiVersionMust'));
  if (raw.kind !== undefined && raw.kind !== 'StepFlow') throw new Error(t('stepflows.kindMust'));
  const meta = isRaw(raw.metadata) ? raw.metadata : {};
  const spec = isRaw(raw.spec) ? raw.spec : {};
  const rawSteps = pick(spec, 'steps', 'steg');
  if (rawSteps === undefined || rawSteps === null) throw new Error(t('stepflows.missingSteps'));
  const steps = stepsFrom(rawSteps, 'steps', t);
  assertUniqueIds(steps, t);
  const input = pick(spec, 'input', 'inn');
  return {
    id: str(meta.id) || base?.id || 'ny-flyt',
    name: str(pick(meta, 'name', 'navn')) || base?.name || str(meta.id),
    desc: str(pick(spec, 'purpose', 'formal')) || base?.desc || '',
    version: typeof meta.version === 'number' ? meta.version : (base?.version ?? 1),
    changed: base?.changed ?? '',
    usedBy: base?.usedBy ?? [],
    input: isRaw(input) ? Object.entries(input).map(([k, v]) => [k, str(v)]) : (base?.input ?? []),
    ...(isRaw(spec.recipe) ? { recipe: spec.recipe } : {}),
    ...(isRaw(spec.settings) ? { settings: spec.settings } : {}),
    steps,
    ...(base?.draft ? { draft: true } : {}),
    ...(base?.sub ? { sub: true } : {}),
    ...(base?.run ? { run: base.run } : {}),
  };
};
