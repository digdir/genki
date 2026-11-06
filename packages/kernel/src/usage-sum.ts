import type { Usage } from '@genai/contracts';

export const usageKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'requests',
  'costMicroNok',
] as const;

export const countedKeys = [
  ...usageKeys,
  'audioSeconds',
  'images',
  'videoSeconds',
  'characters',
] as const;

export const addUsage = (a: Usage, b: Usage): Usage => {
  const sum: Usage = {};
  for (const k of countedKeys) {
    const total = (a[k] ?? 0) + (b[k] ?? 0);
    if (total) sum[k] = total;
  }
  const units: Record<string, number> = { ...a.units };
  for (const [name, count] of Object.entries(b.units ?? {}))
    units[name] = (units[name] ?? 0) + count;
  if (Object.keys(units).length > 0) sum.units = units;
  return sum;
};
