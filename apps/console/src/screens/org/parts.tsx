import { intlLocale, type Format } from '@genai/i18n';
import type { ReactNode } from 'react';
import type { PlainKey, T } from '../../i18n';
import type { TenantStatus } from '../../types';

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

export const Chip = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span className="org-chip" data-tone={tone}>
    {children}
  </span>
);

const dayMs = 86_400_000;

export const daysBetween = (from: string, now: Date) =>
  Math.floor((now.getTime() - new Date(from).getTime()) / dayMs);

export const millions = (tokens: number, f: Format, digits = 0) =>
  f.number(tokens / 1_000_000, { minimumFractionDigits: digits, maximumFractionDigits: 1 });

export const parseAmount = (draft: string, f: Format) => {
  const compact = draft.replace(/[\s\u00a0\u202f]/g, '');
  const plain =
    f.locale === 'en'
      ? /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)
        ? compact.replace(/,/g, '')
        : compact
      : compact.replace(',', '.');
  return /^\d+(?:\.\d+)?$/.test(plain) ? Number(plain) : undefined;
};

export const kroner = (micro: number | null, f: Format, t: T) =>
  micro === null
    ? t('org.notPriced')
    : t('org.kr', { amount: f.number(micro / 1_000_000, { maximumFractionDigits: 0 }) });

export const shortDay = (iso: string, f: Format, now = new Date()) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(intlLocale(f.locale), {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'Europe/Oslo',
  }).format(d);
};

export const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const statusLabels: Record<TenantStatus, [PlainKey, Tone]> = {
  active: ['org.statusActive', 'success'],
  onboarding: ['org.statusOnboarding', 'info'],
  paused: ['org.statusPaused', 'neutral'],
};

const flagNames: Record<string, PlainKey> = { blockStudio: 'org.flagBlockStudio' };

export const flagName = (key: string, t: T) => {
  const named = flagNames[key];
  return named ? t(named) : key;
};

export const orgHref = (tenant: string, tab?: string) =>
  `#/support-access?${new URLSearchParams({ tenant, ...(tab ? { tab } : {}) }).toString()}`;
