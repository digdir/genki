import { isPlausibleYear, type InputField } from '@genai/contracts';

export interface FacetCount {
  value: string;
  count: number;
}

export type FacetSource = NonNullable<InputField['optionsFrom']>;

const yearLike = /^\d{4}$/;

const looksLikeYears = (values: FacetCount[]) =>
  values.length > 0 && values.filter((v) => yearLike.test(v.value)).length / values.length >= 0.8;

export const facetChoices = (
  field: InputField,
  values: FacetCount[],
  now: Date = new Date(),
): string[] => {
  const from = field.optionsFrom;
  const pattern = from?.pattern ? new RegExp(from.pattern) : undefined;
  const years = field.kind === 'year' || looksLikeYears(values);
  const kept = values.filter(({ value }) => {
    if (value.trim() === '') return false;
    if (pattern && !pattern.test(value)) return false;
    const n = Number(value);
    if (years && !isPlausibleYear(value, now)) return false;
    if (from?.min !== undefined && !(Number.isFinite(n) && n >= from.min)) return false;
    if (from?.max !== undefined && !(Number.isFinite(n) && n <= from.max)) return false;
    return true;
  });
  const unique = [...new Map(kept.map((v) => [v.value, v])).values()];
  const sorted = years
    ? unique.sort((a, b) => Number(b.value) - Number(a.value))
    : unique.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'nb'));
  return sorted.map((v) => v.value).slice(0, 500);
};

export const withFieldOptions = async (
  fields: InputField[],
  lookup: (from: FacetSource) => Promise<FacetCount[] | undefined>,
): Promise<InputField[]> =>
  Promise.all(
    fields.map(async (f) => {
      if (!f.optionsFrom) return f;
      const values = await lookup(f.optionsFrom).catch(() => undefined);
      const options = values ? facetChoices(f, values) : [];
      return options.length ? { ...f, options } : f;
    }),
  );
