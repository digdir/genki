import {
  categories as designCategories,
  exampleSettings,
  riskLevels,
  type RiskLevel,
  type RiskValues,
  type Scope,
  type SettingRow,
  type SettingValue,
} from '../../data/settings';
import type { Format, PlainKey, T } from '../../i18n';
import type { EffectiveSetting, SettingInfo } from '../../types';
import { settingLabels } from './labels';
import { norm, settingMinRisk, settingRule, unitText } from './text';

export type Layer = 'P' | 'V' | 'T' | 'D';
export type ContextKind = 'tenant' | 'service' | 'dataset';

export interface Ctx {
  kind: ContextKind;
  target: string;
  tenantName: string;
  highRisk: boolean;
  norwayOnly: boolean;
}

const layerKeys: Record<Layer, PlainKey> = {
  P: 'settings.layerP',
  V: 'settings.layerV',
  T: 'settings.layerT',
  D: 'settings.layerD',
};

export const layerName = (t: T, layer: Layer) => t(layerKeys[layer]);

export const sensColor = {
  Lav: 'neutral',
  Middels: 'info',
  Høy: 'warning',
  Hemmelig: 'danger',
} as const;

const sensKeys: Record<SettingRow['sens'], PlainKey> = {
  Lav: 'settings.sensLow',
  Middels: 'settings.sensMedium',
  Høy: 'settings.sensHigh',
  Hemmelig: 'settings.sensSecret',
};

export const sensText = (t: T, sens: SettingRow['sens']) => t(sensKeys[sens]);

export const layersFor = (kind: ContextKind): Layer[] =>
  kind === 'tenant' ? ['P', 'V'] : kind === 'dataset' ? ['P', 'V', 'D'] : ['P', 'V', 'T'];

export const editLayerFor = (kind: ContextKind): Layer =>
  kind === 'tenant' ? 'V' : kind === 'dataset' ? 'D' : 'T';

const scopeOf: Record<Exclude<Layer, 'P'>, Scope> = {
  V: 'virksomhet',
  T: 'tjeneste',
  D: 'datasett',
};

export const applies = (s: SettingRow, l: Layer) => l === 'P' || s.scope.includes(scopeOf[l]);

export const isSet = (v: SettingValue | null | undefined): v is SettingValue =>
  v !== null && v !== undefined;

const sharedOptionKeys: Record<string, PlainKey> = {
  blind: 'settings.optBlind',
  'corpus-aware-1hop': 'settings.optCorpusAware1',
  'corpus-aware-2hop': 'settings.optCorpusAware2',
  'weighted-sum': 'settings.optWeightedSum',
  rrf: 'settings.optRrf',
  'rrf-with-score': 'settings.optRrfWithScore',
  combmnz: 'settings.optCombmnz',
  cap: 'settings.optCap',
  interleave: 'settings.optInterleave',
  user: 'settings.optUser',
  bokmal: 'settings.optBokmal',
  nynorsk: 'settings.optNynorsk',
};

export const optionText = (t: T, s: SettingRow, v: string) => {
  const own = `settingDefs.${norm(s.id)}_opt_${norm(v)}`;
  if (t.has(own)) return t.template(own);
  const shared = sharedOptionKeys[v];
  if (shared) return t(shared);
  return s.opts?.find((o) => o[0] === v)?.[1] ?? v;
};

export const formatValue = (
  s: SettingRow,
  v: SettingValue | null | undefined,
  t: T,
  f: Format,
): string => {
  if (!isSet(v)) return '–';
  if (s.type === 'secret')
    return v === 'set' ? t('settings.valueSecretStored') : t('settings.valueNotSet');
  if (s.type === 'bool') return v ? t('settings.valueOn') : t('settings.valueOff');
  if (s.type === 'risk' && typeof v === 'object' && !Array.isArray(v)) {
    const r = v as RiskValues;
    return t('settings.valueRisk', {
      minimal: optionText(t, s, r.minimal),
      limited: optionText(t, s, r.limited),
      high: optionText(t, s, r.high),
    });
  }
  if (Array.isArray(v)) return t('settings.valueTopics', { count: v.length });
  if (s.type === 'enum') return optionText(t, s, String(v));
  if (typeof v === 'number') return f.number(v) + (s.unit ? ` ${unitText(t, s.unit)}` : '');
  if (v === '') return t('settings.valueAutomatic');
  return String(v);
};

export const layerValue = (s: SettingRow, l: Layer, target: string): SettingValue | null => {
  if (l === 'P') return s.P;
  if (l === 'V') return s.V;
  if (l === 'T') return s.svc[target] ?? null;
  return s.ds[target] ?? null;
};

export interface Effective {
  v: SettingValue | null;
  L: Layer | 'pin';
  src: string;
  color: 'neutral' | 'warning' | 'accent';
  pinVersion?: string;
}

export const effectiveOf = (s: SettingRow, ctx: Ctx, t: T): Effective => {
  const pin = ctx.kind !== 'tenant' ? s.pins?.[ctx.target] : undefined;
  if (pin)
    return {
      v: pin[1],
      L: 'pin',
      src: t('settings.srcPinned', { version: pin[0] }),
      color: 'warning',
      pinVersion: pin[0],
    };
  const layers = layersFor(ctx.kind).filter((l) => applies(s, l));
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i] as Layer;
    const v = layerValue(s, l, ctx.target);
    if (isSet(v)) {
      const src =
        l === 'P'
          ? t('settings.srcPlatform')
          : l === 'V'
            ? ctx.kind === 'tenant'
              ? t('settings.srcTenantSet')
              : t('settings.srcTenantOverride')
            : l === 'T'
              ? t('settings.srcService')
              : t('settings.srcDataset');
      return { v, L: l, src, color: l === 'P' ? 'neutral' : l === 'V' ? 'warning' : 'accent' };
    }
  }
  return { v: null, L: 'P', src: t('settings.srcNone'), color: 'neutral' };
};

export const visibleIn = (s: SettingRow, kind: ContextKind) => {
  const last: Scope =
    kind === 'dataset' ? 'datasett' : kind === 'tenant' ? 'virksomhet' : 'tjeneste';
  const inScope = kind === 'tenant' || s.scope.includes(last) || s.scope.includes('virksomhet');
  const datasetFit =
    kind !== 'dataset' ||
    s.scope.includes('datasett') ||
    s.cat === 'Innlesing' ||
    (s.scope.includes('virksomhet') && s.cat !== 'Svar' && s.cat !== 'Modell');
  return inScope && datasetFit;
};

export const isOverridden = (s: SettingRow, ctx: Ctx) =>
  layersFor(ctx.kind)
    .slice(1)
    .some((l) => isSet(layerValue(s, l, ctx.target))) ||
  (ctx.kind !== 'tenant' && !!s.pins?.[ctx.target]);

export type Parsed = { v: SettingValue } | { err: string };

export const parseDraft = (
  s: SettingRow,
  raw: string,
  t: T,
  f: Format,
  risk?: RiskValues,
): Parsed => {
  if (s.type === 'int' || s.type === 'float') {
    const n = parseFloat(raw.replace(',', '.').replace(/\s/g, ''));
    if (Number.isNaN(n)) return { err: t('settings.errNumber') };
    const capped = s.max !== undefined && s.max < Number.MAX_SAFE_INTEGER;
    if (s.min !== undefined && s.max !== undefined && capped && (n < s.min || n > s.max))
      return { err: t('settings.errBetween', { min: f.number(s.min), max: f.number(s.max) }) };
    if (s.min !== undefined && !capped && n < s.min)
      return { err: t('settings.errTooSmall', { min: f.number(s.min) }) };
    if (s.type === 'int' && !Number.isInteger(n)) return { err: t('settings.errInteger') };
    if (s.step && s.type === 'int' && n % s.step !== 0)
      return { err: t('settings.errStep', { step: f.number(s.step) }) };
    return { v: n };
  }
  if (s.type === 'bool') return { v: raw === 'true' };
  if (s.type === 'list') {
    const items = raw
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    return items.length ? { v: items } : { err: t('settings.errTopic') };
  }
  if (s.type === 'secret') return raw.length < 20 ? { err: t('settings.errSecret') } : { v: 'set' };
  if (s.type === 'risk' && risk) {
    const floor = s.floor ?? 0;
    const below = riskLevels.some(([level]) => Number(risk[level]) < floor);
    return below ? { err: t('settings.errRiskFloor', { floor }) } : { v: { ...risk } };
  }
  return { v: raw };
};

const typeKeys: Record<SettingRow['type'], PlainKey> = {
  int: 'settings.typeInt',
  float: 'settings.typeFloat',
  enum: 'settings.typeEnum',
  bool: 'settings.typeBool',
  list: 'settings.typeList',
  secret: 'settings.typeSecret',
  risk: 'settings.typeRisk',
  text: 'settings.typeText',
};

export const typeText = (t: T, type: SettingRow['type']) => t(typeKeys[type]);

export const allowedText = (s: SettingRow, t: T, f: Format) => {
  if (s.type === 'enum' || s.type === 'risk')
    return (s.opts ?? []).map((o) => optionText(t, s, o[0])).join(', ');
  if ((s.type === 'int' || s.type === 'float') && s.min !== undefined) {
    const max = s.max !== undefined && s.max < Number.MAX_SAFE_INTEGER ? s.max : undefined;
    const range =
      max === undefined
        ? s.step
          ? t('settings.allowedFromStep', { min: f.number(s.min), step: f.number(s.step) })
          : t('settings.allowedFrom', { min: f.number(s.min) })
        : s.step
          ? t('settings.allowedRangeStep', {
              min: f.number(s.min),
              max: f.number(max),
              step: f.number(s.step),
            })
          : t('settings.allowedRange', { min: f.number(s.min), max: f.number(max) });
    return range + (s.unit ? ` ${unitText(t, s.unit)}` : '');
  }
  if (s.type === 'int' || s.type === 'float') return t('settings.allowedNumber');
  if (s.type === 'bool') return t('settings.allowedBool');
  if (s.type === 'list') return t('settings.allowedList');
  if (s.type === 'secret') return t('settings.allowedSecret');
  return t('settings.allowedText');
};

const scopeLayer: Record<Scope, Layer> = { virksomhet: 'V', tjeneste: 'T', datasett: 'D' };

export const scopeText = (s: SettingRow, t: T) =>
  [layerName(t, 'P'), ...s.scope.map((x) => layerName(t, scopeLayer[x]))].join(', ');

export type Change =
  { kind: 'value'; v: SettingValue } | { kind: 'reset' } | { kind: 'pin' } | { kind: 'unpin' };

export interface PreviewGroup {
  title: string;
  n: number;
  color: 'warning' | 'neutral' | 'info' | 'danger';
  items: string[];
}

export interface Preview {
  change: Change;
  before: string;
  after: string;
  groups: PreviewGroup[];
  blocked: string;
}

const isEuModel = (v: SettingValue | undefined) => typeof v === 'string' && /gpt|mini/.test(v);

export const buildPreview = (
  s: SettingRow,
  change: Change,
  ctx: Ctx,
  names: { services: string[]; datasets: string[] },
  t: T,
  f: Format,
): Preview => {
  const el = editLayerFor(ctx.kind);
  const e = effectiveOf(s, ctx, t);
  const show = (v: SettingValue | null | undefined) => formatValue(s, v, t, f);
  const after =
    change.kind === 'reset'
      ? el === 'V' || !isSet(s.V)
        ? t('settings.pvInheritPlatform', { value: show(s.P) })
        : t('settings.pvInheritTenant', { value: show(s.V) })
      : change.kind === 'pin'
        ? t('settings.pvPinned', { value: show(s.P) })
        : change.kind === 'unpin'
          ? t('settings.pvInheritPlatform', { value: show(s.P) })
          : s.type === 'secret'
            ? t('settings.pvNewSecret')
            : show(change.v);
  const before = t('settings.pvBefore', { value: show(e.v), source: e.src.toLowerCase() });
  const afterV = change.kind === 'value' ? change.v : undefined;
  const groups: PreviewGroup[] = [];
  const none = [t('settings.pvNone')];
  let blocked = '';
  if (el === 'V') {
    const datasetOnly = s.scope.includes('datasett') && !s.scope.includes('tjeneste');
    const list = datasetOnly ? names.datasets : names.services;
    const own = datasetOnly ? s.ds : s.svc;
    const change_ = list.filter((n) => own[n] === undefined && !s.pins?.[n]);
    const keep = list.filter((n) => own[n] !== undefined);
    const pins = list.filter((n) => s.pins?.[n]);
    groups.push({
      title: t('settings.pvChanges'),
      n: change_.length,
      color: 'warning',
      items: change_.length ? change_ : none,
    });
    groups.push({
      title: t('settings.pvKeep'),
      n: keep.length,
      color: 'neutral',
      items: keep.length
        ? keep.map((n) => t('settings.pvNamedValue', { name: n, value: show(own[n]) }))
        : none,
    });
    if (pins.length)
      groups.push({
        title: t('settings.pvPinnedGroup'),
        n: pins.length,
        color: 'info',
        items: pins.map((n) =>
          t('settings.pvPinnedItem', { name: n, version: s.pins?.[n]?.[0] ?? '' }),
        ),
      });
    if (s.needs && typeof afterV === 'number') {
      const breaks = change_.filter((n) => (s.needs?.[n] ?? 0) > afterV);
      if (breaks.length) {
        groups.push({
          title: t('settings.pvBroken'),
          n: breaks.length,
          color: 'danger',
          items: breaks.map((n) =>
            t('settings.pvNeedsItem', { name: n, tokens: f.number(s.needs?.[n] ?? 0) }),
          ),
        });
        blocked = t('settings.blockStops', { names: f.list(breaks) });
      }
    }
    if (s.id === 'model.primary' && isEuModel(afterV)) {
      groups.push({
        title: t('settings.pvEuMove'),
        n: change_.length,
        color: 'warning',
        items: change_,
      });
      const nor = change_.filter((n) => ['Møtereferat'].includes(n));
      if (nor.length) blocked = t('settings.blockNorway', { names: f.list(nor) });
    }
  } else {
    groups.push({ title: t('settings.pvChanges'), n: 1, color: 'warning', items: [ctx.target] });
    const need = s.needs?.[ctx.target];
    if (need && typeof afterV === 'number' && afterV < need) {
      blocked = t('settings.blockNeedsRun', { name: ctx.target, tokens: f.number(need) });
      groups.push({ title: t('settings.pvBroken'), n: 1, color: 'danger', items: [ctx.target] });
    }
    if (s.id === 'guard.human_approval' && afterV === 'av' && ctx.highRisk)
      blocked = settingRule(t, s) ?? '';
    if (s.minRisk && afterV === false && ctx.highRisk) blocked = settingMinRisk(t, s) ?? '';
    if (s.id === 'model.primary' && isEuModel(afterV) && ctx.norwayOnly)
      blocked = t('settings.blockNorway', { names: ctx.target });
  }
  return { change, before, after, groups, blocked };
};

const valueAliases: Record<string, Record<string, string>> = {
  'answer.language': { same: 'samme' },
};

export const fromApiValue = (s: SettingRow, v: unknown): SettingValue | null => {
  if (v === undefined || v === null) return null;
  const alias = valueAliases[s.id]?.[String(v)];
  if (alias) return alias;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(String);
  return JSON.stringify(v);
};

export const toApiValue = (s: SettingRow, v: SettingValue): unknown => {
  const reverse = Object.entries(valueAliases[s.id] ?? {}).find(([, d]) => d === v);
  if (reverse) return reverse[0];
  if (s.json && typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return v;
};

type Shape = Pick<SettingRow, 'type' | 'min' | 'max' | 'opts' | 'json'>;

const optionLabels: Record<string, string> = {
  blind: 'Uten blikk på innholdet',
  'corpus-aware-1hop': 'Med blikk på innholdet, ett steg',
  'corpus-aware-2hop': 'Med blikk på innholdet, to steg',
  'weighted-sum': 'Vektet sum',
  rrf: 'Resiprok rangfusjon',
  'rrf-with-score': 'Rangfusjon med poeng',
  combmnz: 'CombMNZ',
  cap: 'Sikre et antall plasser',
  interleave: 'Fletting',
  user: 'Samme som spørsmålet',
  bokmal: 'Bokmål',
  nynorsk: 'Nynorsk',
};

export const shapeFromSchema = (schema: Record<string, unknown> | undefined): Shape | undefined => {
  if (!schema) return undefined;
  const anyOf = Array.isArray(schema.anyOf) ? (schema.anyOf as Record<string, unknown>[]) : [];
  const parts = anyOf.filter((p) => p.type !== 'null');
  const s = anyOf.length > 0 && parts.length === 1 ? (parts[0] ?? schema) : schema;
  const bound = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const min =
    bound(s.minimum) ??
    (typeof s.exclusiveMinimum === 'number'
      ? s.exclusiveMinimum + (s.type === 'integer' ? 1 : 0)
      : undefined);
  const max = bound(s.maximum);
  const range = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  if (Array.isArray(s.enum))
    return {
      type: 'enum',
      opts: s.enum.map((v) => [String(v), optionLabels[String(v)] ?? String(v)]),
    };
  if (s.type === 'integer') return { type: 'int', ...range };
  if (s.type === 'number') return { type: 'float', ...range };
  if (s.type === 'boolean') return { type: 'bool' };
  if (s.type === 'string') return { type: 'text' };
  if (s.type === 'object' || s.type === 'array') return { type: 'text', json: true };
  return undefined;
};

const scopeFromLayer: Record<string, Scope | undefined> = {
  tenant: 'virksomhet',
  service: 'tjeneste',
  dataset: 'datasett',
};

const typeFromDefault = (info: SettingInfo): SettingRow['type'] => {
  if (info.sensitivity === 'secret') return 'secret';
  if (typeof info.default === 'boolean') return 'bool';
  if (typeof info.default === 'number') return Number.isInteger(info.default) ? 'int' : 'float';
  if (Array.isArray(info.default)) return 'list';
  return 'text';
};

export const mergeRows = (
  catalog: SettingInfo[],
  effective: Record<string, EffectiveSetting> | undefined,
  target: string,
  live = false,
): { rows: SettingRow[]; categories: string[] } => {
  const known = new Set(catalog.map((info) => info.key));
  const rows: SettingRow[] = live
    ? structuredClone(exampleSettings)
        .filter((r) => known.has(r.apiKey ?? r.id))
        .map((r) => ({ ...r, V: null, svc: {}, ds: {}, pins: {} }))
    : structuredClone(exampleSettings);
  const find = (key: string) => rows.find((r) => r.apiKey === key || r.id === key);
  for (const info of catalog) {
    const found = find(info.key);
    if (found) {
      found.apiKey = info.key;
      const scope = info.settableAt.flatMap((l) => scopeFromLayer[l] ?? []);
      if (scope.length) found.scope = scope;
      const p = fromApiValue(found, info.default);
      if (isSet(p) && typeof p === typeof found.P) found.P = p;
      continue;
    }
    const named = settingLabels[info.key];
    const shape = shapeFromSchema(info.schema);
    rows.push({
      id: info.key,
      apiKey: info.key,
      cat: named?.cat ?? info.category,
      label: named?.label ?? info.key,
      desc: named?.desc ?? info.description,
      type: typeFromDefault(info),
      ...shape,
      sens: info.sensitivity === 'secret' ? 'Hemmelig' : 'Lav',
      scope: info.settableAt.flatMap((l) => scopeFromLayer[l] ?? []),
      P:
        info.sensitivity === 'secret'
          ? null
          : (fromApiValue({ id: info.key } as SettingRow, info.default) ?? null),
      ...(info.sensitivity === 'secret' ? { type: 'secret' as const } : {}),
      V: null,
      svc: {},
      ds: {},
    });
  }
  for (const setting of Object.values(effective ?? {})) {
    const row = find(setting.key);
    if (!row) continue;
    const layerValue_ = (layer: string) =>
      setting.source === layer
        ? setting.value
        : setting.overridden.find((o) => o.layer === layer)?.value;
    const platformValue = fromApiValue(row, layerValue_('platform'));
    if (isSet(platformValue)) row.P = platformValue;
    const tenantValue = fromApiValue(row, layerValue_('tenant'));
    const serviceValue = fromApiValue(row, layerValue_('service'));
    if (isSet(tenantValue)) row.V = tenantValue;
    if (isSet(serviceValue)) row.svc[target] = serviceValue;
    if (setting.source === 'pin') {
      const pinned = fromApiValue(row, setting.value);
      if (isSet(pinned))
        row.pins = { ...row.pins, [target]: [`v${setting.pinnedVersion ?? ''}`, pinned] };
    }
  }
  const used = new Set(rows.map((r) => r.cat));
  const categories = [...designCategories.filter((c) => used.has(c)), ...used].filter(
    (c, i, all) => all.indexOf(c) === i,
  );
  return { rows, categories };
};

const riskKeys: Record<RiskLevel, PlainKey> = {
  minimal: 'settings.riskMinimal',
  limited: 'settings.riskLimited',
  high: 'settings.riskHigh',
};

export const riskLabel = (t: T, level: RiskLevel) => t(riskKeys[level]);

const settingErrors: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^unknown setting/, (_, t) => t('settings.errUnknown')],
  [/^a reason is required/, (_, t) => t('settings.errReasonNeeded')],
  [/^locked: (.+)/, (m, t) => t('settings.errLocked', { why: m[1] ?? '' })],
  [/cannot be set at the \w+ layer/, (_, t) => t('settings.errLayer')],
  [/a secret must be a secret:\/\//, (_, t) => t('settings.errSecretRef')],
  [
    /Too big: expected \w+ to (?:be|have) <=?\s*([\d.]+)/,
    (m, t) => t('settings.errTooBig', { max: m[1] ?? '' }),
  ],
  [
    /Too small: expected \w+ to (?:be|have) >=?\s*([\d.]+)/,
    (m, t) => t('settings.errTooSmall', { min: m[1] ?? '' }),
  ],
  [/Invalid option/, (_, t) => t('settings.errOption')],
  [/Invalid input/, (_, t) => t('settings.errType')],
];

export const settingErrorText = (message: string, t: T) =>
  message
    .split('; ')
    .map((part) => {
      for (const [pattern, text] of settingErrors) {
        const m = part.match(pattern);
        if (m) return text(m, t);
      }
      return part;
    })
    .join(' ');
