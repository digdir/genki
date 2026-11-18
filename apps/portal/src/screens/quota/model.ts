import type { QuotaRequestView } from '../../api/quota-requests';
import type { UsageReport } from '../../types';

export interface QuotaFacts {
  quota: number;
  used: number;
  pct: number;
  alert: boolean;
}

export const defaultAlertPercent = 80;

export const quotaFacts = (
  report: UsageReport,
  settingsQuota: number | null,
  usedThisMonth: number,
): QuotaFacts | undefined => {
  if (report.quota)
    return {
      quota: report.quota.monthlyTokens,
      used: report.quota.usedTokens,
      pct: Math.round(report.quota.usedPercent),
      alert: report.quota.alert,
    };
  if (settingsQuota === null) return undefined;
  const pct = Math.round((usedThisMonth / settingsQuota) * 100);
  return { quota: settingsQuota, used: usedThisMonth, pct, alert: pct >= defaultAlertPercent };
};

const million = 1_000_000;

export const extraOptions = (quota: number) => {
  const current = quota / million;
  return [...new Set([1, 1.5, 2].map((share) => Math.max(1, Math.round(current * share))))];
};

export const parseMillions = (text: string) => {
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : undefined;
};

export type AmountChoice = { kind: 'extra'; millions: number } | { kind: 'other'; text: string };

export const requestedTokens = (quota: number, choice: AmountChoice | undefined) => {
  if (!choice) return { error: 'pick' as const };
  if (choice.kind === 'extra') return { tokens: quota + choice.millions * million };
  const total = parseMillions(choice.text);
  if (total === undefined || total * million <= quota) return { error: 'tooLow' as const };
  return { tokens: Math.round(total * million) };
};

export const pendingRequest = (requests: readonly QuotaRequestView[]) =>
  requests.find((r) => r.state === 'pending');
