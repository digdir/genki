import { intlLocale, type Format } from '@genai/i18n';
import type { T } from '../../i18n';
import type { TaskActor } from '../../types';

const osloDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const actorText = (actor: TaskActor | undefined, t: T) =>
  actor?.kind === 'api-key'
    ? actor.name
      ? t('logRuns.actorApiKey', { name: actor.name })
      : t('logRuns.actorApiKeyUnnamed')
    : actor?.kind === 'system'
      ? t('logRuns.actorSystem')
      : (actor?.name ?? t('common.actorEmployee'));

export const dateKey = (d: Date) => osloDate.format(d);

const dayLabel = (d: Date, f: Format) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), {
    timeZone: 'Europe/Oslo',
    day: 'numeric',
    month: 'short',
  })
    .format(d)
    .replace('.', '')
    .replace(/\.$/, '');

export const relativeTime = (iso: string, t: T, f: Format, now = new Date()) => {
  const d = new Date(iso);
  const time = f.time(d);
  const day = dateKey(d);
  if (day === dateKey(now)) return t('log.todayAt', { time });
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dateKey(yesterday)) return t('log.yesterdayAt', { time });
  return t('log.dayAt', { day: dayLabel(d, f), time });
};

export const formatOffset = (seconds: number, f: Format) =>
  seconds < 0
    ? '–'
    : seconds < 60
      ? `+${f.decimal(seconds)} s`
      : `+${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;

export const formatDuration = (seconds: number, f: Format) =>
  seconds < 1
    ? `${Math.round(seconds * 1000)} ms`
    : seconds < 60
      ? `${f.decimal(seconds)} s`
      : seconds % 60 === 0
        ? `${seconds / 60} min`
        : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;

export const whole = (n: number, f: Format) => f.number(Math.round(n));
