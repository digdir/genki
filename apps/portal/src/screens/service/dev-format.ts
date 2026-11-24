import { intlLocale, type Format } from '@genai/i18n';
import { productionEnvironment } from '../../api/environments';
import type { T } from '../../i18n';

const parts = (iso: string, f: Format, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), { timeZone: 'Europe/Oslo', ...options }).format(
    new Date(iso),
  );

const osloDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

export const shortDay = (iso: string, f: Format) =>
  parts(iso, f, { day: 'numeric', month: 'short' }).replace(/\.$/, '');

export const clock = (iso: string, f: Format) => f.time(iso);

export const clockSeconds = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));

export const shortWhen = (iso: string, f: Format) => `${shortDay(iso, f)} ${clock(iso, f)}`;

export const sameDay = (iso: string, now: Date) => osloDay(new Date(iso)) === osloDay(now);

export const placeName = (t: T, name: string) =>
  name === productionEnvironment ? t('serviceEnvironments.inUseName') : name;
