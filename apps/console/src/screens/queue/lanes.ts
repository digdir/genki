import type { ApiClient } from '../../api';
import type { PlainKey, T } from '../../i18n';
import { tenantLabel } from '../../tenant-names';
import type {
  AccessRequest,
  BlockApprovalRequest,
  Decision,
  PlatformProposal,
  SkillShareRequest,
} from '../../types';

export type Kind = 'blocks' | 'skills' | 'proposals' | 'access';
export type Outcome = 'approved' | 'rejected' | 'planned';
export type Mode = 'approve' | 'reject' | 'review' | 'plan';

export interface Row {
  id: string;
  kind: Kind;
  title: string;
  version?: string;
  kindName?: string;
  assistant?: boolean;
  org: string;
  orgName: string;
  by: string;
  at: string;
  reason: string;
  outcome?: Outcome;
  decision?: Decision;
  block?: BlockApprovalRequest;
  skill?: SkillShareRequest;
  proposal?: PlatformProposal;
  access?: AccessRequest;
}

export interface Lane {
  kind: Kind;
  label: PlainKey;
  lower: PlainKey;
  empty: PlainKey;
  load: (api: ApiClient, signal: AbortSignal, t?: T) => Promise<Row[]>;
}

const outcomes: Record<string, Outcome> = {
  approved: 'approved',
  shared: 'approved',
  granted: 'approved',
  planned: 'planned',
  rejected: 'rejected',
  declined: 'rejected',
  denied: 'rejected',
};

const outcomeOf = (status: string | undefined) => (status ? outcomes[status] : undefined);

export const personOf = (actor: string | undefined) =>
  (actor ?? '').replace(/^(operator|employee):([a-z0-9-]+:)?/i, '');

const kindLabels: Record<string, PlainKey> = {
  model: 'queue.kindModel',
  dataset: 'queue.kindDataset',
  search_engine: 'queue.kindSearchEngine',
  tool: 'queue.kindTool',
  skill: 'queue.kindSkill',
  extension_point: 'queue.kindExtensionPoint',
  guardrail: 'queue.kindGuardrail',
  judge: 'queue.kindJudge',
  step_flow: 'queue.kindStepFlow',
  shared_service: 'queue.kindSharedService',
};

export const kindLabel = (kind: string, t: T) => {
  const key = kindLabels[kind];
  return key ? t(key) : kind;
};

export const subOf = (row: Row, t: T) => {
  if (row.kind === 'blocks')
    return t('queue.subBlock', {
      kind: kindLabel(row.kindName ?? '', t),
      version: row.version ?? '',
    });
  if (row.kind === 'skills') return t('queue.subSkill', { version: row.version ?? '' });
  return row.kind === 'proposals' ? t('queue.subProposal') : t('queue.subAccess');
};

const optional = <T extends object>(key: keyof Row, value: T | undefined) =>
  (value ? { [key]: value } : {}) as Partial<Row>;

export const lanes: Lane[] = [
  {
    kind: 'blocks',
    label: 'queue.laneBlocks',
    lower: 'queue.laneBlocksLower',
    empty: 'queue.laneBlocksEmpty',
    load: async (api, signal, t) =>
      (await api.blockApprovalRequests(signal))
        .filter((r) => (r.status ?? r.state) !== 'withdrawn')
        .map((r) => {
          const outcome = outcomeOf(r.status ?? r.state);
          return {
            id: r.id,
            kind: 'blocks',
            title: r.block.name ?? r.block.id,
            version: String(r.block.version),
            kindName: r.block.kind,
            org: r.tenant,
            orgName: tenantLabel(r.tenant, r.tenantName, t),
            by: r.requestedBy ?? '',
            at: r.requestedAt,
            reason: r.reason ?? '',
            block: r,
            ...(outcome ? { outcome } : {}),
            ...optional('decision', r.decision),
          };
        }),
  },
  {
    kind: 'skills',
    label: 'queue.laneSkills',
    lower: 'queue.laneSkillsLower',
    empty: 'queue.laneSkillsEmpty',
    load: async (api, signal, t) =>
      (await api.skillShares(signal))
        .filter((s) => s.state !== 'none')
        .map((s) => {
          const outcome = outcomeOf(s.state);
          return {
            id: s.id,
            kind: 'skills',
            title: s.skillName ?? s.skill,
            version: String(s.version),
            org: s.tenant,
            orgName: tenantLabel(s.tenant, s.tenantName, t),
            by: s.byName ?? personOf(s.by),
            at: s.at,
            reason: s.reason ?? '',
            skill: s,
            ...(outcome ? { outcome } : {}),
            ...optional('decision', s.decision),
          };
        }),
  },
  {
    kind: 'proposals',
    label: 'queue.laneProposals',
    lower: 'queue.laneProposalsLower',
    empty: 'queue.laneProposalsEmpty',
    load: async (api, signal, t) =>
      (await api.platformProposals(signal)).map((p) => {
        const outcome = outcomeOf(
          p.status === 'approved' ? 'planned' : (p.platformChange?.status ?? p.status),
        );
        return {
          id: p.id,
          kind: 'proposals',
          title: p.title,
          org: p.tenant,
          orgName: tenantLabel(p.tenant, p.tenantName, t),
          by:
            p.createdBy && p.createdBy !== 'assistant'
              ? personOf(p.createdBy)
              : (p.requestedByName ?? ''),
          ...(p.createdBy && p.createdBy !== 'assistant' ? {} : { assistant: true }),
          at: p.createdAt,
          reason: p.summary ?? '',
          proposal: p,
          ...(outcome && outcome !== 'approved' ? { outcome } : {}),
          ...optional('decision', p.decision),
        };
      }),
  },
  {
    kind: 'access',
    label: 'queue.laneAccess',
    lower: 'queue.laneAccessLower',
    empty: 'queue.laneAccessEmpty',
    load: async (api, signal, t) =>
      (await api.accessRequests(signal)).map((r) => {
        const orgName = tenantLabel(r.org, r.orgName, t);
        const outcome = outcomeOf(r.status);
        return {
          id: r.id,
          kind: 'access',
          title: orgName,
          org: r.org,
          orgName,
          by: r.requesterName ?? r.requestedBy ?? r.contactName ?? '',
          at: r.requestedAt,
          reason: r.purpose ?? '',
          access: r,
          ...(outcome ? { outcome } : {}),
          ...optional('decision', r.decision),
        };
      }),
  },
];

export const laneOf = (kind: string | undefined) =>
  lanes.find((l) => l.kind === kind) ?? (lanes[0] as Lane);

export const pendingCount = async (api: ApiClient, signal: AbortSignal) => {
  const loaded = await Promise.allSettled(lanes.map((l) => l.load(api, signal)));
  return loaded.reduce(
    (n, r) => n + (r.status === 'fulfilled' ? r.value.filter((x) => !x.outcome).length : 0),
    0,
  );
};

export const workingDaysSince = (iso: string, now = new Date()) => {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  let days = 0;
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  while (day < end) {
    day.setDate(day.getDate() + 1);
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
};

export const decisionLabel = (row: Row): [PlainKey, 'success' | 'danger' | 'info'] =>
  row.outcome === 'planned'
    ? ['queue.decPlanned', 'info']
    : row.outcome === 'approved'
      ? ['queue.decApproved', 'success']
      : [row.kind === 'proposals' ? 'queue.decDeclined' : 'queue.decRejected', 'danger'];

export const deciderOf = (decision: Decision | undefined, t: T) => {
  const name = decision?.byName ?? personOf(decision?.by);
  return name ? t('queue.decider', { name }) : t('queue.deciderUnknown');
};

export const apiPath = (row: Row, mode: Mode) => {
  const id = encodeURIComponent(row.id);
  if (mode === 'review') return `/operator/proposals/${id}/status`;
  return {
    blocks: `/operator/building-blocks/approval-requests/${id}/decision`,
    skills: `/operator/skills/shares/${id}/decision`,
    proposals: `/operator/proposals/${id}/decision`,
    access: `/operator/onboarding/requests/${id}/decision`,
  }[row.kind];
};

export const decide = (
  api: ApiClient,
  row: Row,
  mode: Mode,
  reason: string,
  caseId: string | undefined,
) => {
  if (mode === 'review') return api.setProposalStatus(row.id, 'under_review', reason);
  const approve = mode === 'approve' || mode === 'plan';
  if (row.kind === 'blocks') return api.decideBlockApproval(row.id, approve, reason);
  if (row.kind === 'skills') return api.decideSkillShare(row.id, approve, reason);
  if (row.kind === 'proposals') return api.decideProposal(row.id, approve, reason, caseId);
  return api.decideAccessRequest(row.id, approve, reason);
};

export const lineDiff = (before: string, after: string) => {
  const a = before.split('\n').filter((l) => l.trim());
  const b = after.split('\n').filter((l) => l.trim());
  return [
    ...a.filter((l) => !b.includes(l)).map((text) => ({ sign: '-' as const, text })),
    ...b.filter((l) => !a.includes(l)).map((text) => ({ sign: '+' as const, text })),
  ];
};
