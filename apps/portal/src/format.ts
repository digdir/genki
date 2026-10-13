import { createFormat, type Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useMemo } from 'react';
import { translator, useT, type PlainKey, type T } from './i18n';

const nbFormat = createFormat('nb');
const nbT = translator('nb');

export const formatDateTime = (iso: string, f: Format = nbFormat) =>
  f.locale === 'en'
    ? f.dateTime(iso, 'medium')
    : `${f.date(iso, 'medium')}, ${f.time(iso).replace('.', ':')}`;
const oneDecimal = (f: Format, n: number) => f.number(n, { maximumFractionDigits: 1 });
export const formatNumber = (n: number, f: Format = nbFormat) => f.number(n);
export const formatSeconds = (s: number, f: Format = nbFormat, t: T = nbT) =>
  t('common.seconds', { value: oneDecimal(f, s) });
export const formatOre = (n: number, f: Format = nbFormat, t: T = nbT) =>
  t('common.ore', { value: oneDecimal(f, n) });
export const formatDate = (iso: string, f: Format = nbFormat) => f.date(iso, 'medium');
export const serviceLabel = (id: string, title?: string) => {
  if (title) return title;
  const parts = id.split('/');
  const bare = (parts.length >= 3 ? parts[parts.length - 2] : parts.at(-1)) ?? id;
  const words = bare
    .replace(/__default$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
};
export const actorLabel = (actor: string, t: T = nbT, name?: string) =>
  name
    ? name
    : /^(platform|worker):/.test(actor)
      ? t('common.actorPlatform')
      : actor.startsWith('operator:')
        ? t('common.actorOperator')
        : t('common.actorEmployee');

export const notPriced = nbT('common.notPriced');
export const notPricedLabel = (t: T) => t('common.notPriced');
export const formatKroner = (
  microNok: number | null | undefined,
  f: Format = nbFormat,
  t: T = nbT,
) =>
  microNok === null || microNok === undefined
    ? notPricedLabel(t)
    : f.currency(microNok / 1_000_000, { digits: 2 });

type StatusColor = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

const taskStatusKeys: Record<string, { key: PlainKey; color: StatusColor }> = {
  queued: { key: 'taskStatus.queued', color: 'neutral' },
  running: { key: 'taskStatus.running', color: 'info' },
  interrupted: { key: 'taskStatus.interrupted', color: 'warning' },
  completed: { key: 'taskStatus.completed', color: 'success' },
  failed: { key: 'taskStatus.failed', color: 'danger' },
  cancelled: { key: 'taskStatus.cancelled', color: 'neutral' },
};

export const taskStatus: Record<string, { text: string; color: StatusColor }> = Object.fromEntries(
  Object.entries(taskStatusKeys).map(([status, { key, color }]) => [
    status,
    { text: nbT(key), color },
  ]),
);

export const statusOf = (status: string, t: T = nbT) => {
  const known = taskStatusKeys[status];
  return known
    ? { text: t(known.key), color: known.color }
    : { text: status, color: 'neutral' as const };
};

export const usePortalFormat = () => {
  const f = useFormat();
  const t = useT();
  return useMemo(
    () => ({
      f,
      t,
      dateTime: (iso: string) => formatDateTime(iso, f),
      date: (iso: string) => formatDate(iso, f),
      number: (n: number) => formatNumber(n, f),
      seconds: (s: number) => formatSeconds(s, f, t),
      ore: (n: number) => formatOre(n, f, t),
      kroner: (microNok: number | null | undefined) => formatKroner(microNok, f, t),
      actor: (actor: string, name?: string) => actorLabel(actor, t, name),
      status: (status: string) => statusOf(status, t),
      notPriced: notPricedLabel(t),
    }),
    [f, t],
  );
};
