import type { AuditEntry, TaskTimeline, TenantStatus } from './types';

export const inboxTypes = [
  'quota',
  'access',
  'catalogue',
  'work-instruction',
  'suggestion',
  'incident',
  'expiring',
] as const;
export type InboxType = (typeof inboxTypes)[number];

export interface InboxItem {
  type: InboxType;
  id: string;
  tenant: string | null;
  tenantName?: string;
  tenants?: string[];
  what: string;
  from: string | null;
  waitingSince: string;
  due?: string;
  blocks: boolean;
  action: { method: string; path: string };
  detail?: {
    monthlyTokens?: number;
    usedTokens?: number;
    currentMonthlyTokens?: number;
    kind?: string;
    block?: string;
    version?: number;
    on?: boolean;
    person?: { issuer: string; subject: string };
  };
}

export interface TenantOverview {
  orgNumber: string;
  name: string;
  status: TenantStatus;
  admin?: string;
  needsAction: InboxItem[];
  tokens: {
    usedTokens: number;
    monthlyTokens: number;
    usedPercent: number;
    forecastTokens: number;
  } | null;
  cost: { from: string; costMicroNok: number | null; priced: boolean };
  services: { total: number; inUse: number };
  failedRunsLast7Days: number;
  latestAudit: AuditEntry[];
}

export interface UsageNumbers {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costMicroNok: number | null;
}

export interface UsageWithRuns extends UsageNumbers {
  runs: number;
  failedRequests: number;
}

export interface TenantUsage {
  from: string;
  to: string;
  totals: UsageWithRuns;
  daily: { date: string; usage: UsageNumbers }[];
  byService: { service: string; title?: string; usage: UsageWithRuns }[];
  byModel: { model: string; usage: UsageNumbers }[];
  ingestion: { usage: UsageNumbers };
  testing: { usage: UsageNumbers };
  internal?: { usage: UsageWithRuns };
}

export interface FlagRowView {
  person?: { issuer: string; subject: string };
  personName?: string;
  on: boolean;
  by: string;
  byName?: string;
  at: string;
  reason: string;
  expiresAt?: string;
  expired: boolean;
}

export interface TenantFlag {
  key: string;
  description: string;
  owner: string;
  removeBy: string;
  selfService: boolean;
  on: boolean;
  source: string;
  tenant: FlagRowView | null;
  people: FlagRowView[];
}

export interface TenantHostname {
  hostname: string;
  client: string;
  service: string | null;
  state: 'pending-dns' | 'binding' | 'active' | 'failed' | 'lapsed' | 'removing' | 'removed';
}

export interface PrivateNetworks {
  tenant: string;
  entries: string[];
}

export interface TenantPerson {
  id: string;
  name: string;
  rights: string[];
  lastLogin?: string | null;
}

export interface AuditFilter {
  from?: string;
  to?: string;
  action?: string;
  by?: 'operator' | 'tenant';
}

export type QuotaDecision =
  | { decision: 'approved'; monthlyTokens?: number }
  | { decision: 'rejected' }
  | { decision: 'postponed'; until: string; note?: string };

export interface FailedRun {
  task: string;
  tenant: string;
  tenantName: string;
  service: string | null;
  serviceName: string | null;
  at: string;
  failure: { code: string; reason: string; step?: string } | null;
}

export interface Incident {
  id: string;
  title: string;
  text: string;
  tenants: string[];
  startedAt: string;
  resolvedAt?: string;
}

export interface NewIncident {
  title: string;
  text: string;
  tenants?: string[];
}

export interface AuditQuery extends AuditFilter {
  tenant?: string;
  limit?: number;
  offset?: number;
}

export interface AuditPage {
  data: AuditEntry[];
  total: number;
}

export interface RunTimeline extends Omit<TaskTimeline, 'steps'> {
  steps: (TaskTimeline['steps'][number] & { state?: string; model?: string })[];
  stats?: { byModel?: { model: string }[] };
}
