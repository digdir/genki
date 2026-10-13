import type { Format } from '@genai/i18n';
import type { PlainKey, T } from './i18n';
import type {
  DefaultVersion,
  GridSetting,
  RiskLevel,
  Sensitivity,
  SettingInfo,
  SettingOverrides,
  SettingsGrid,
  SettingScope,
} from './types';
import { settingLabels } from './setting-labels';

export const riskLevels: RiskLevel[] = ['minimal', 'limited', 'high'];

export const riskLabel: Record<RiskLevel, PlainKey> = {
  minimal: 'settings.riskMinimal',
  limited: 'settings.riskLimited',
  high: 'settings.riskHigh',
};

export const sensitivityLabel: Record<
  Sensitivity,
  [PlainKey, 'neutral' | 'info' | 'warning' | 'danger']
> = {
  low: ['settings.sensitivityLow', 'neutral'],
  medium: ['settings.sensitivityMedium', 'info'],
  high: ['settings.sensitivityHigh', 'warning'],
  secret: ['settings.sensitivitySecret', 'danger'],
};

const onOff = (t: T, v: unknown) => (v ? t('settings.onLower') : t('settings.offLower'));

export const isRiskValue = (v: unknown): v is Record<RiskLevel, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'limited' in v;

export const formatValue = (s: GridSetting, v: unknown, t: T, f: Format): string => {
  if (v === null || v === undefined) return '–';
  if (v === '') return t('settings.notSet');
  if (s.type === 'secret')
    return v === 'set' ? t('settings.storedInKeyVault') : t('settings.notSet');
  if (isRiskValue(v)) {
    const values = riskLevels
      .map((l) =>
        typeof v[l] === 'boolean'
          ? onOff(t, v[l])
          : formatValue({ ...s, type: 'enum' }, v[l], t, f),
      )
      .join(' / ');
    return `${t('settings.perRiskLevel', { values })}${s.floorText ? ` ${t('settings.floorInline', { floor: s.floorText })}` : ''}`;
  }
  if (typeof v === 'boolean') return v ? t('settings.on') : t('settings.off');
  if (s.type === 'enum' && s.options)
    return s.options.find((o) => o.value === String(v))?.label ?? String(v);
  if (Array.isArray(v)) return t('settings.topics', { count: v.length });
  if (typeof v === 'number') return `${f.number(v)}${s.unit ? ` ${s.unit}` : ''}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const scopeOf = (settableAt: string[]): SettingScope[] =>
  settableAt.flatMap((l) =>
    l === 'tenant'
      ? ['tenant']
      : l === 'service'
        ? ['service']
        : l === 'dataset'
          ? ['dataset']
          : [],
  );

const typeOf = (info: SettingInfo, value: unknown): GridSetting['type'] => {
  if (info.sensitivity === 'secret') return 'secret';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object' && value !== null) return 'json';
  return 'text';
};

const optionLabels: Record<string, PlainKey> = {
  blind: 'settings.optBlind',
  'corpus-aware-1hop': 'settings.optCorpus1',
  'corpus-aware-2hop': 'settings.optCorpus2',
  'weighted-sum': 'settings.optWeightedSum',
  rrf: 'settings.optRrf',
  'rrf-with-score': 'settings.optRrfWithScore',
  combmnz: 'settings.optCombMnz',
  cap: 'settings.optCap',
  interleave: 'settings.optInterleave',
  user: 'settings.optUser',
  bokmal: 'settings.optBokmal',
  nynorsk: 'settings.optNynorsk',
  transient: 'settings.optRetentionTransient',
  standard: 'settings.optRetentionStandard',
  case: 'settings.optRetentionCase',
};

export const optionLabel = (value: string, t: T) =>
  optionLabels[value] ? t(optionLabels[value] as PlainKey) : value;

const multilineFrom = 200;

type Shape = Pick<GridSetting, 'type' | 'min' | 'max' | 'options' | 'multiline'>;

export const shapeFromSchema = (
  schema: Record<string, unknown> | undefined,
  t: T,
): Shape | undefined => {
  if (!schema) return undefined;
  const anyOf = Array.isArray(schema.anyOf) ? (schema.anyOf as Record<string, unknown>[]) : [];
  const parts = anyOf.filter((p) => p.type !== 'null');
  const s = anyOf.length > 0 && parts.length === 1 ? (parts[0] ?? schema) : schema;
  const min =
    typeof s.minimum === 'number'
      ? s.minimum
      : typeof s.exclusiveMinimum === 'number'
        ? s.exclusiveMinimum + (s.type === 'integer' ? 1 : 0)
        : undefined;
  const max = typeof s.maximum === 'number' ? s.maximum : undefined;
  const range = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  if (Array.isArray(s.enum))
    return {
      type: 'enum',
      options: s.enum.map((v) => ({
        value: String(v),
        label: optionLabel(String(v), t),
      })),
    };
  if (s.type === 'integer') return { type: 'int', ...range };
  if (s.type === 'number') return { type: 'float', ...range };
  if (s.type === 'boolean') return { type: 'bool' };
  if (s.type === 'string')
    return {
      type: 'text',
      ...(typeof s.maxLength === 'number' && s.maxLength >= multilineFrom
        ? { multiline: true }
        : {}),
    };
  if (s.type === 'object' || s.type === 'array') return { type: 'json' };
  return undefined;
};

export const gridFromCatalog = (
  catalog: SettingInfo[],
  defaults: DefaultVersion[],
  overrides: SettingOverrides | undefined,
  t: T,
): SettingsGrid => ({
  platformVersion: Math.max(1, ...defaults.map((d) => d.version)),
  platformDate: '',
  tenants: Object.keys(overrides?.tenants ?? {}),
  services: (overrides?.services ?? []).map((s) => ({ tenant: s.tenant, name: s.service })),
  settings: catalog.map((info) => {
    const current = defaults.find((d) => d.key === info.key);
    const value = current?.value ?? info.default;
    const named = settingLabels[info.key];
    const shape = info.sensitivity === 'secret' ? undefined : shapeFromSchema(info.schema, t);
    const tenants = Object.fromEntries(
      Object.entries(overrides?.tenants ?? {}).flatMap(([org, t]) =>
        info.key in t.values ? [[org, t.values[info.key]]] : [],
      ),
    );
    const services = Object.fromEntries(
      (overrides?.services ?? []).flatMap((s) =>
        info.key in s.settings ? [[`${s.tenant}/${s.service}`, s.settings[info.key]]] : [],
      ),
    );
    return {
      key: info.key,
      category: named ? t(named.cat) : info.category,
      label: named ? t(named.label) : info.key,
      description: named?.desc ? t(named.desc) : info.description,
      type: typeOf(info, value),
      ...shape,
      sensitivity: info.sensitivity === 'secret' ? 'secret' : 'low',
      scope: scopeOf(info.settableAt),
      platform: info.sensitivity === 'secret' ? null : value,
      version: current?.version ?? 1,
      tenants,
      services,
    };
  }),
});

export const parseDraft = (
  s: GridSetting,
  raw: string,
  risk: Partial<Record<RiskLevel, string>>,
  t: T,
  f: Format,
): { value: unknown } | { error: string } => {
  if (s.type === 'int' || s.type === 'float') {
    const n = Number.parseFloat(raw.replace(',', '.').replace(/\s/g, ''));
    if (Number.isNaN(n)) return { error: t('settings.errNumber') };
    if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max))
      return {
        error: t('settings.errRange', { min: f.number(s.min ?? 0), max: f.number(s.max ?? 0) }),
      };
    if (s.type === 'int' && !Number.isInteger(n)) return { error: t('settings.errInteger') };
    if (s.type === 'int' && s.step && n % s.step !== 0)
      return { error: t('settings.errStep', { step: f.number(s.step) }) };
    return { value: n };
  }
  if (s.type === 'bool') return { value: raw === 'true' };
  if (s.type === 'list') {
    const items = raw
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
    return items.length ? { value: items } : { error: t('settings.errTopic') };
  }
  if (s.type === 'json') {
    try {
      return { value: JSON.parse(raw) as unknown };
    } catch {
      return { error: t('settings.errJson') };
    }
  }
  if (s.type === 'risk') {
    const value = Object.fromEntries(riskLevels.map((l) => [l, risk[l] === 'true']));
    for (const level of riskLevels) {
      const floor = s.floor?.[level];
      if (floor !== undefined && value[level] !== floor)
        return {
          error:
            s.rule ??
            t('settings.errFloor', { level: t(riskLabel[level]), floor: onOff(t, floor) }),
        };
    }
    return { value };
  }
  return raw.trim() ? { value: raw.trim() } : { error: t('settings.errValue') };
};

export const draftOf = (s: GridSetting, v: unknown) => {
  if (s.type === 'list') return Array.isArray(v) ? v.join('\n') : '';
  if (s.type === 'json') return JSON.stringify(v ?? null);
  if (s.type === 'bool') return String(Boolean(v));
  if (s.type === 'secret' || v === null || v === undefined) return '';
  return String(v);
};

export const suggestionOf = (s: GridSetting, tenants: string[]) => {
  const values = Object.values(s.tenants);
  if (s.type === 'secret' || !tenants.length || values.length < tenants.length * 0.6)
    return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(JSON.stringify(v), (counts.get(JSON.stringify(v)) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return n >= tenants.length * 0.6 && JSON.stringify(s.platform) !== top
    ? { value: JSON.parse(top) as unknown, n }
    : undefined;
};

const settingErrors: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^unknown setting/, (_, t) => t('settings.apiUnknown')],
  [/^a reason is required/, (_, t) => t('settings.apiReason')],
  [/^locked: (.+)/, (m, t) => t('settings.apiLocked', { reason: m[1] ?? '' })],
  [/cannot be set at the \w+ layer/, (_, t) => t('settings.apiLayer')],
  [/a secret must be a secret:\/\//, (_, t) => t('settings.apiSecret')],
  [
    /Too big: expected \w+ to (?:be|have) <=?\s*([\d.]+)/,
    (m, t) => t('settings.apiTooBig', { max: m[1] ?? '' }),
  ],
  [
    /Too small: expected \w+ to (?:be|have) >=?\s*([\d.]+)/,
    (m, t) => t('settings.apiTooSmall', { min: m[1] ?? '' }),
  ],
  [/Invalid option/, (_, t) => t('settings.apiOption')],
  [/Invalid input/, (_, t) => t('settings.apiType')],
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
