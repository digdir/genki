import type { Format } from '@genai/i18n';
import type { PlainKey, T } from '../../i18n';
import type { InboxItem, InboxType } from '../../operator-types';
import { daysBetween, flagName, millions, orgHref, shortDay, type Tone } from '../org/parts';

export const typeLabels: Record<InboxType, PlainKey> = {
  quota: 'inbox.typeQuota',
  access: 'inbox.typeAccess',
  catalogue: 'inbox.typeCatalogue',
  'work-instruction': 'inbox.typeWorkInstruction',
  suggestion: 'inbox.typeSuggestion',
  incident: 'inbox.typeIncident',
  expiring: 'inbox.typeExpiring',
};

export const isQuotaLimit = (item: InboxItem) =>
  item.type === 'quota' && item.id.startsWith('quota-limit:');

const percentOf = (used: number | undefined, quota: number | undefined) =>
  used !== undefined && quota ? Math.round((used / quota) * 100) : undefined;

export const itemText = (item: InboxItem, t: T, f: Format) => {
  const d = item.detail ?? {};
  switch (item.type) {
    case 'quota': {
      const percent = percentOf(d.usedTokens, d.currentMonthlyTokens);
      if (isQuotaLimit(item)) return t('inbox.quotaLimit', { percent: percent ?? 0 });
      const asked = millions(d.monthlyTokens ?? 0, f);
      return percent === undefined || d.currentMonthlyTokens === undefined
        ? t('inbox.quotaRequestShort', { asked })
        : t('inbox.quotaRequest', { asked, has: millions(d.currentMonthlyTokens, f), percent });
    }
    case 'access':
      return t('inbox.access', { what: item.what });
    case 'catalogue':
      return d.version === undefined
        ? t('inbox.catalogueBlock', { what: item.what })
        : t('inbox.catalogueShare', { what: item.what, version: d.version });
    case 'work-instruction':
      return t('inbox.workInstruction', { what: item.what });
    case 'expiring':
      return t('inbox.expiring', {
        flag: flagName(item.what, t),
        date: item.due ? shortDay(item.due, f) : '',
      });
    default:
      return item.what;
  }
};

export const verbOf = (item: InboxItem): PlainKey => {
  if (isQuotaLimit(item)) return 'inbox.verbChangeLimit';
  switch (item.type) {
    case 'catalogue':
      return 'inbox.verbReview';
    case 'suggestion':
      return 'inbox.verbConsider';
    case 'incident':
      return 'inbox.verbUpdate';
    case 'expiring':
      return 'inbox.verbOpen';
    default:
      return 'inbox.verbHandle';
  }
};

export const quotaRequestHref = (item: InboxItem) =>
  `#/queue?${new URLSearchParams({ request: `${item.tenant ?? ''}/${item.id}` }).toString()}`;

export const hrefOf = (item: InboxItem) => {
  const tenant = item.tenant ?? '';
  switch (item.type) {
    case 'quota':
      return isQuotaLimit(item) ? orgHref(tenant, 'limits') : quotaRequestHref(item);
    case 'access':
      return '#/queue?tab=access';
    case 'catalogue':
      return item.detail?.kind === 'block-share' ? '#/block-reviews' : '#/queue?tab=blocks';
    case 'work-instruction':
      return '#/queue?tab=skills';
    case 'suggestion':
      return '#/queue?tab=proposals';
    case 'incident':
      return '#/operations';
    case 'expiring':
      return orgHref(tenant, 'flags');
  }
};

export const ageOf = (item: InboxItem, t: T, now: Date): { text: string; tone: Tone } => {
  if (item.due) {
    const left = Math.max(
      0,
      Math.ceil((new Date(item.due).getTime() - now.getTime()) / 86_400_000),
    );
    return { text: t('inbox.inDays', { count: left }), tone: 'neutral' };
  }
  const days = daysBetween(item.waitingSince, now);
  if (days < 1) {
    const hours = Math.max(
      0,
      Math.floor((now.getTime() - new Date(item.waitingSince).getTime()) / 3_600_000),
    );
    return { text: t('inbox.hours', { count: hours }), tone: 'neutral' };
  }
  return {
    text: t('inbox.days', { count: days }),
    tone: days >= 7 ? 'danger' : days >= 2 ? 'warning' : 'neutral',
  };
};
