import type { z } from 'zod';

export type Layer = 'platform' | 'tenant' | 'service' | 'call' | 'dataset';

export type Axis = 'service' | 'dataset';

export interface SettingDefinition<T = unknown> {
  key: string;
  description: string;
  category: string;
  axis: Axis;
  sensitivity: 'normal' | 'secret';
  schema: z.ZodType<T>;
  default: T;
  settableAt: Layer[];
}

export type LayerValues = Partial<Record<Layer, Record<string, unknown>>>;

export interface Lock {
  reason: string;
}

export interface Pin {
  version: number;
  value: unknown;
}

export interface ResolveInput {
  values: LayerValues;
  locks?: Record<string, Lock>;
  pins?: Record<string, Pin>;
}

export interface Resolved {
  key: string;
  value: unknown;
  source: Layer | 'default' | 'pin';
  pinnedVersion?: number;
  overridden: { layer: Layer | 'default' | 'pin'; value: unknown }[];
  rejected: { layer: Layer; reason: string }[];
  locked?: string;
}

const order: Record<Axis, Layer[]> = {
  service: ['platform', 'tenant', 'service', 'call'],
  dataset: ['platform', 'dataset'],
};

const secretRef = /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const combine = (base: unknown, next: unknown) =>
  isPlainObject(base) && isPlainObject(next) ? { ...base, ...next } : next;

export const checkSettingValue = (
  definition: SettingDefinition,
  layer: Layer,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } => {
  if (!definition.settableAt.includes(layer))
    return { ok: false, reason: `cannot be set at the ${layer} layer` };
  if (definition.sensitivity === 'secret' && (typeof raw !== 'string' || !secretRef.test(raw)))
    return { ok: false, reason: 'a secret must be a secret:// reference' };
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: parsed.error.issues.map((i) => i.message).join('; ') };
  return { ok: true, value: parsed.data };
};

export const resolveSetting = (definition: SettingDefinition, input: ResolveInput): Resolved => {
  const resolved: Resolved = {
    key: definition.key,
    value: definition.default,
    source: 'default',
    overridden: [],
    rejected: [],
  };
  const lock = input.locks?.[definition.key];
  const pin = input.pins?.[definition.key];

  for (const layer of order[definition.axis]) {
    const layerValues = input.values[layer];
    if (!layerValues || !(definition.key in layerValues)) continue;
    const raw = layerValues[definition.key];
    if (lock && layer !== 'platform' && definition.settableAt.includes(layer)) {
      resolved.rejected.push({ layer, reason: `locked: ${lock.reason}` });
      continue;
    }
    const parsed = checkSettingValue(definition, layer, raw);
    if (!parsed.ok) {
      resolved.rejected.push({ layer, reason: parsed.reason });
      continue;
    }
    resolved.overridden.push({ layer: resolved.source, value: resolved.value });
    resolved.value = combine(resolved.value, parsed.value);
    resolved.source = layer;
  }

  if (pin && !lock && (resolved.source === 'platform' || resolved.source === 'default')) {
    resolved.overridden.push({ layer: resolved.source, value: resolved.value });
    resolved.value = pin.value;
    resolved.source = 'pin';
    resolved.pinnedVersion = pin.version;
  }
  if (lock) resolved.locked = lock.reason;
  return resolved;
};

export const resolveSettings = (definitions: SettingDefinition[], input: ResolveInput) =>
  Object.fromEntries(definitions.map((d) => [d.key, resolveSetting(d, input)]));
