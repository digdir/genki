import type { Captured, JsonValue, Mode, SseFrame } from './types.js';

export interface Difference {
  severity: 'fail' | 'warn';
  path: string;
  old: string;
  new: string;
}

import { withinScope } from './scope.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const volatileKeys = new Set([
  'conversation_id',
  'conversation-id',
  'created-at',
  'updated-at',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
  'created',
  'elapsed',
  'elapsed_ms',
  'latency_ms',
  'duration_ms',
  'request_id',
  'request-id',
]);

const generatedIds: [RegExp, string][] = [
  [/^chatcmpl-[A-Za-z0-9_-]+$/, '<completion-id>'],
  [/^(call|toolu)_[A-Za-z0-9_-]+$/, '<tool-call-id>'],
  [/^(msg|run|thread)_[A-Za-z0-9_-]+$/, '<generated-id>'],
  [/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{21}$/, '<generated-id>'],
];

export const normalize = (value: JsonValue | string | undefined): JsonValue | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (uuid.test(value)) return '<uuid>';
    if (timestamp.test(value)) return '<timestamp>';
    for (const [pattern, label] of generatedIds) if (pattern.test(value)) return label;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v) ?? null);
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = volatileKeys.has(k) ? '<volatile>' : (normalize(v) ?? null);
    }
    return out;
  }
  return value;
};

export const shape = (value: JsonValue | string | undefined): JsonValue => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const shapes = [...new Map(value.map((v) => [JSON.stringify(shape(v)), shape(v)])).values()];
    return shapes.length === 0 ? '[]' : shapes;
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(value).sort()) out[k] = shape(value[k]);
    return out;
  }
  return typeof value;
};

const show = (value: JsonValue | undefined) => {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

export const diff = (
  a: JsonValue | undefined,
  b: JsonValue | undefined,
  path = '$',
  severity: Difference['severity'] = 'fail',
): Difference[] => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const bothObjects =
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b);
  if (bothObjects) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diff(a[k], b[k], `${path}.${k}`, severity));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((v, i) => diff(v, b[i], `${path}[${i}]`, severity));
  }
  return [{ severity, path, old: show(a), new: show(b) }];
};

const dataFrames = (frames: SseFrame[] | undefined) =>
  (frames ?? []).flatMap((f) => (f.kind === 'data' ? [f.data] : []));

const eventName = (frame: JsonValue | string) => {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return undefined;
  const params = frame.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const meta = params._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  return typeof meta.event === 'string' ? meta.event : undefined;
};

const compareFrames = (
  old: SseFrame[] | undefined,
  next: SseFrame[] | undefined,
  mode: Mode,
): Difference[] => {
  const a = dataFrames(old);
  const b = dataFrames(next);
  if (a.length === 0 && b.length === 0) return [];
  const finalA = a.at(-1);
  const finalB = b.at(-1);
  const final =
    mode === 'exact'
      ? diff(normalize(finalA), normalize(finalB), '$.final')
      : diff(shape(finalA), shape(finalB), '$.final');
  const eventsA = [...new Set(a.flatMap((f) => eventName(f) ?? []))].sort();
  const eventsB = [...new Set(b.flatMap((f) => eventName(f) ?? []))].sort();
  return [...final, ...diff(eventsA, eventsB, '$.progressEvents', 'warn')];
};

export const compareCaptured = (
  old: Captured,
  next: Captured,
  mode: Mode,
  headers: string[] = ['content-type'],
  scope?: Set<string>,
): Difference[] => {
  const scoped = (body: JsonValue | string | undefined) =>
    scope && typeof body !== 'string' ? withinScope(body, scope) : body;
  const differences: Difference[] = [];
  if (old.status !== next.status) {
    differences.push({
      severity: 'fail',
      path: '$.status',
      old: String(old.status),
      new: String(next.status),
    });
  }
  for (const name of headers) {
    const a = old.headers[name]?.replace(/\s+/g, '').toLowerCase();
    const b = next.headers[name]?.replace(/\s+/g, '').toLowerCase();
    if (a !== b)
      differences.push({
        severity: 'fail',
        path: `$.headers.${name}`,
        old: String(a),
        new: String(b),
      });
  }
  const body =
    mode === 'exact'
      ? diff(normalize(scoped(old.body)), normalize(scoped(next.body)), '$.body')
      : diff(shape(scoped(old.body)), shape(scoped(next.body)), '$.body');
  return [...differences, ...body, ...compareFrames(old.frames, next.frames, mode)];
};

export interface RankedHit {
  id: string;
  score?: number;
}

const tieKey = (score: number | undefined, index: number) =>
  score === undefined ? `rank:${index}` : `score:${Number(score.toPrecision(12))}`;

export const tieGroups = (hits: RankedHit[]): string[][] => {
  const groups: { key: string; ids: string[] }[] = [];
  hits.forEach((hit, i) => {
    const key = tieKey(hit.score, i);
    const last = groups.at(-1);
    if (last && last.key === key) last.ids.push(hit.id);
    else groups.push({ key, ids: [hit.id] });
  });
  return groups.map((g) => [...g.ids].sort());
};

export const canonicalRanking = (hits: RankedHit[]): string[] => tieGroups(hits).flat();

export const compareRanked = (
  old: RankedHit[],
  next: RankedHit[],
  path = '$.hits',
): Difference[] => {
  const a = tieGroups(old);
  const b = tieGroups(next);
  const same =
    a.length === b.length && a.every((group, i) => JSON.stringify(group) === JSON.stringify(b[i]));
  return same ? [] : [{ severity: 'fail', path, old: show(a.flat()), new: show(b.flat()) }];
};

export const overlapAt = (old: RankedHit[], next: RankedHit[], k: number) => {
  const a = new Set(old.slice(0, k).map((h) => h.id));
  const b = next.slice(0, k).map((h) => h.id);
  return a.size === 0 ? 1 : b.filter((id) => a.has(id)).length / a.size;
};
