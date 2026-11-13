// The model layer: the toolbox it may pick extra checks from, and the findings it returns.
import type { Plan } from './assess.ts';
import { parse } from 'yaml';
import { inExperiment, type ChangedPr } from './changes.ts';

export const maxProposals = 8;
export const maxQuestionChars = 300;
export const maxDefinitionChars = 8000;

export type Proposal =
  | { action: 'ask'; variant: string; question: string; stream: boolean }
  | { action: 'playground'; model: string; question: string }
  | { action: 'validate'; definition: string }
  | { action: 'screen'; app: 'portal' | 'console'; path: string; language: 'nb' | 'en' }
  | { action: 'operator-read'; path: string };

export interface ProposedCheck {
  proposal: Proposal;
  why: string;
  pullRequest?: number;
}

export interface Toolbox {
  variants: string[];
  models: string[];
  screens: { portal: string[]; console: string[] };
  operatorReads: string[];
}

export const toolboxOf = (plan: Plan, variants: string[]): Toolbox => ({
  variants,
  models: plan.models.map((m) => m.model),
  screens: {
    portal: plan.screens.portal.filter((s) => !s.personal).map((s) => s.path),
    console: plan.screens.console.filter((s) => !s.personal).map((s) => s.path),
  },
  operatorReads: plan.operatorReads.filter((r) => !r.refused).map((r) => r.path),
});

export interface Rejected {
  index: number;
  reason: string;
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const definitionIdOf = (definition: string) => {
  try {
    const id = record(record(parse(definition)).metadata).id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
};

export const parseProposal = (raw: unknown, toolbox: Toolbox): Proposal | string => {
  const p = record(raw);
  switch (p.action) {
    case 'ask': {
      const question = text(p.question, maxQuestionChars);
      if (typeof p.variant !== 'string' || !toolbox.variants.includes(p.variant))
        return 'unknown variant';
      if (!question) return `a question of 1 to ${maxQuestionChars} characters`;
      return { action: 'ask', variant: p.variant, question, stream: p.stream === true };
    }
    case 'playground': {
      const question = text(p.question, maxQuestionChars);
      if (typeof p.model !== 'string' || !toolbox.models.includes(p.model)) return 'unknown model';
      if (!question) return `a question of 1 to ${maxQuestionChars} characters`;
      return { action: 'playground', model: p.model, question };
    }
    case 'validate': {
      const definition = text(p.definition, maxDefinitionChars);
      if (!definition) return `a definition of 1 to ${maxDefinitionChars} characters`;
      if (!definitionIdOf(definition)?.startsWith('smoke-'))
        return 'the definition id must start with smoke-';
      return { action: 'validate', definition };
    }
    case 'screen': {
      const app = p.app === 'portal' || p.app === 'console' ? p.app : undefined;
      if (!app) return 'app is portal or console';
      if (typeof p.path !== 'string' || !toolbox.screens[app].includes(p.path))
        return 'not a listed screen';
      return { action: 'screen', app, path: p.path, language: p.language === 'en' ? 'en' : 'nb' };
    }
    case 'operator-read':
      if (typeof p.path !== 'string' || !toolbox.operatorReads.includes(p.path))
        return 'not a listed operator read';
      return { action: 'operator-read', path: p.path };
    default:
      return 'unknown action';
  }
};

export const acceptProposals = (
  raw: unknown,
  toolbox: Toolbox,
  prs: number[],
): { accepted: ProposedCheck[]; rejected: Rejected[] } => {
  const list = Array.isArray(record(raw).checks) ? (record(raw).checks as unknown[]) : [];
  const accepted: ProposedCheck[] = [];
  const rejected: Rejected[] = [];
  list.forEach((item, index) => {
    if (accepted.length >= maxProposals) {
      rejected.push({ index, reason: `more than ${maxProposals} checks` });
      return;
    }
    const entry = record(item);
    const proposal = parseProposal(entry.check, toolbox);
    if (typeof proposal === 'string') {
      rejected.push({ index, reason: proposal });
      return;
    }
    const pr = typeof entry.pullRequest === 'number' ? entry.pullRequest : undefined;
    accepted.push({
      proposal,
      why: text(entry.why, 400) ?? '',
      ...(pr !== undefined && prs.includes(pr) ? { pullRequest: pr } : {}),
    });
  });
  return { accepted, rejected };
};

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  source: 'checks' | 'model';
  title: string;
  severity: Severity;
  evidence: string;
  checks: string[];
  suspectedPrs: number[];
}

const severities: Severity[] = ['high', 'medium', 'low'];

export const parseFindings = (raw: unknown, checkIds: string[], prs: number[]): Finding[] => {
  const list = Array.isArray(record(raw).findings) ? (record(raw).findings as unknown[]) : [];
  return list.flatMap((item) => {
    const f = record(item);
    const title = text(f.title, 200);
    const evidence = text(f.evidence, 2000);
    if (!title || !evidence) return [];
    const ids = Array.isArray(f.checks)
      ? f.checks.filter((c) => checkIds.includes(c as string))
      : [];
    const suspects = Array.isArray(f.suspectedPrs)
      ? f.suspectedPrs.filter((n): n is number => typeof n === 'number' && prs.includes(n))
      : [];
    return [
      {
        source: 'model' as const,
        title,
        severity: severities.includes(f.severity as Severity) ? (f.severity as Severity) : 'low',
        evidence,
        checks: ids as string[],
        suspectedPrs: [...new Set(suspects)],
      },
    ];
  });
};

export interface FailedCheck {
  id: string;
  group: string;
  detail: string;
}

export const checkFindings = (
  failed: FailedCheck[],
  reasons: Record<string, number[]>,
): Finding[] =>
  failed.map((c) => ({
    source: 'checks',
    title: `${c.id} failed`,
    severity: 'high',
    evidence: c.detail,
    checks: [c.id],
    suspectedPrs: reasons[c.group] ?? [],
  }));

export const modelOnly = (model: Finding[], fromChecks: Finding[]) => {
  const failing = new Set(fromChecks.flatMap((f) => f.checks));
  return model.filter((f) => f.checks.length === 0 || f.checks.some((c) => !failing.has(c)));
};

export interface EscapedCandidate {
  pullRequest: number;
  findings: string[];
}

export const escapedCandidates = (
  findings: Finding[],
  prs: Pick<ChangedPr, 'number' | 'mergedAt' | 'aiReviewed'>[],
): EscapedCandidate[] => {
  const eligible = new Set(prs.filter(inExperiment).map((p) => p.number));
  const byPr = new Map<number, string[]>();
  for (const f of findings)
    for (const pr of f.suspectedPrs)
      if (eligible.has(pr)) byPr.set(pr, [...(byPr.get(pr) ?? []), f.title]);
  return [...byPr.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pullRequest, titles]) => ({ pullRequest, findings: titles }));
};

export const layerCounts = (fromChecks: Finding[], fromModel: Finding[]) => ({
  checks: fromChecks.length,
  model: modelOnly(fromModel, fromChecks).length,
});
