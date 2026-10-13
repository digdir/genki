import type { InputField } from './types';

const yearLike = /^\d{4}$/;

export const isPlausibleYear = (value: string, now: Date = new Date()) =>
  yearLike.test(value) && Number(value) >= 1900 && Number(value) <= now.getFullYear() + 1;

export const plausibleYears = <V extends { value: string }>(values: V[], now: Date = new Date()) =>
  values
    .filter((v) => isPlausibleYear(v.value, now))
    .sort((a, b) => Number(b.value) - Number(a.value));

const looksLikeYears = (options: string[]) =>
  options.length > 0 && options.filter((o) => yearLike.test(o)).length / options.length >= 0.8;

export const withPlausibleYears = (field: InputField, now: Date = new Date()): InputField =>
  field.options && (field.kind === 'year' || looksLikeYears(field.options))
    ? {
        ...field,
        options: plausibleYears(
          field.options.map((value) => ({ value })),
          now,
        ).map((o) => o.value),
      }
    : field;
