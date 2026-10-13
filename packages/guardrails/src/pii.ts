export const piiCategories = [
  'national-id',
  'd-number',
  'phone',
  'email',
  'account-number',
  'health',
] as const;
export type PiiCategory = (typeof piiCategories)[number];

export interface PiiMatch {
  category: PiiCategory;
  start: number;
  end: number;
  value: string;
}

const digitsOf = (value: string) => value.replace(/\D/g, '');

const checkDigit = (digits: number[], weights: number[]) => {
  const sum = weights.reduce((acc, w, i) => acc + w * (digits[i] ?? 0), 0);
  const rest = 11 - (sum % 11);
  if (rest === 11) return 0;
  return rest === 10 ? undefined : rest;
};

const personWeights1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const personWeights2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const accountWeights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

const validMonth = (month: number) =>
  (month >= 1 && month <= 12) || (month >= 41 && month <= 52) || (month >= 81 && month <= 92);

export const personNumberKind = (value: string): 'national-id' | 'd-number' | undefined => {
  const raw = digitsOf(value);
  if (raw.length !== 11) return undefined;
  const d = [...raw].map(Number);
  const k1 = checkDigit(d, personWeights1);
  if (k1 === undefined || k1 !== d[9]) return undefined;
  const k2 = checkDigit(d, personWeights2);
  if (k2 === undefined || k2 !== d[10]) return undefined;
  const day = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  if (!validMonth(month)) return undefined;
  if (day >= 1 && day <= 31) return 'national-id';
  if (day >= 41 && day <= 71) return 'd-number';
  return undefined;
};

export const isAccountNumber = (value: string) => {
  const raw = digitsOf(value);
  if (raw.length !== 11) return false;
  const d = [...raw].map(Number);
  const k = checkDigit(d, accountWeights);
  return k !== undefined && k === d[10];
};

const elevenDigits = /(?<![\d.])\d{6} ?\d{5}(?![\d])|(?<![\d.])\d{4}[ .]\d{2}[ .]\d{5}(?!\d)/g;
const phone =
  /(?<![\d+])(?:(?:\+|00)47[\s-]?)?(?:[2-9]\d{7}|[2-9]\d{2}[\s-]\d{2}[\s-]\d{3}|[2-9]\d[\s-]\d{2}[\s-]\d{2}[\s-]\d{2})(?![\d])/g;
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const icd10 = /\b[A-TV-Z]\d{2}(?:\.\d{1,2})?\b/g;

const overlaps = (a: PiiMatch, b: PiiMatch) => a.start < b.end && b.start < a.end;

export const findPii = (text: string, categories: readonly PiiCategory[]): PiiMatch[] => {
  const wanted = new Set(categories);
  const found: PiiMatch[] = [];
  const add = (match: PiiMatch) => {
    if (!found.some((f) => overlaps(f, match))) found.push(match);
  };
  for (const m of text.matchAll(elevenDigits)) {
    const value = m[0];
    const at = { start: m.index, end: m.index + value.length, value };
    const person = personNumberKind(value);
    if (person) {
      if (wanted.has(person)) add({ category: person, ...at });
    } else if (wanted.has('account-number') && isAccountNumber(value)) {
      add({ category: 'account-number', ...at });
    }
  }
  if (wanted.has('email'))
    for (const m of text.matchAll(email))
      add({ category: 'email', start: m.index, end: m.index + m[0].length, value: m[0] });
  if (wanted.has('phone'))
    for (const m of text.matchAll(phone))
      add({ category: 'phone', start: m.index, end: m.index + m[0].length, value: m[0] });
  if (wanted.has('health'))
    for (const m of text.matchAll(icd10))
      add({ category: 'health', start: m.index, end: m.index + m[0].length, value: m[0] });
  return found.sort((a, b) => a.start - b.start);
};

const labels: Record<PiiCategory, string> = {
  'national-id': 'NATIONAL_ID',
  'd-number': 'D_NUMBER',
  phone: 'PHONE',
  email: 'EMAIL',
  'account-number': 'ACCOUNT',
  health: 'HEALTH_CODE',
};

export interface PiiVault {
  mask(text: string): string;
  unmask(text: string): string;
  size(): number;
}

export const createVault = (categories: readonly PiiCategory[]): PiiVault => {
  const byValue = new Map<string, string>();
  const byToken = new Map<string, string>();
  const counters = new Map<PiiCategory, number>();
  const tokenFor = (match: PiiMatch) => {
    const known = byValue.get(match.value);
    if (known) return known;
    const n = (counters.get(match.category) ?? 0) + 1;
    counters.set(match.category, n);
    const token = `«${labels[match.category]}_${n}»`;
    byValue.set(match.value, token);
    byToken.set(token, match.value);
    return token;
  };
  return {
    mask: (text) => {
      let out = '';
      let last = 0;
      for (const match of findPii(text, categories)) {
        out += text.slice(last, match.start) + tokenFor(match);
        last = match.end;
      }
      return out + text.slice(last);
    },
    unmask: (text) => text.replace(/«[A-Z_]+_\d+»/g, (token) => byToken.get(token) ?? token),
    size: () => byToken.size,
  };
};

export const redactText = (text: string, categories: readonly PiiCategory[]) => {
  let out = '';
  let last = 0;
  for (const match of findPii(text, categories)) {
    out += `${text.slice(last, match.start)}[REDACTED:${match.category}]`;
    last = match.end;
  }
  return out + text.slice(last);
};

export const redactPii = <T>(value: T, categories: readonly PiiCategory[]): T => {
  if (categories.length === 0) return value;
  if (typeof value === 'string') return redactText(value, categories) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactPii(v, categories)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactPii(v, categories)]),
    ) as T;
  }
  return value;
};
