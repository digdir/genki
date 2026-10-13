import { appendVersion, type ConfigEntry, type ConfigEntryStore } from './config-store.js';

export const projectReviewKind = 'project-run-review';

export type ReviewDecision = 'approved' | 'rejected';
export type ApprovalStatus = 'pending' | ReviewDecision;

export interface ProjectRunReview {
  project: string;
  run: string;
  decision: ReviewDecision;
  changedBy?: string;
}

export interface Approval {
  status: ApprovalStatus;
  by?: string;
  byName?: string;
  at?: string;
  reason?: string;
}

interface RunLink {
  project: string;
  run: string;
  trigger: 'manual' | 'subscription';
}

const approvalFrom = (review: ConfigEntry<ProjectRunReview> | undefined): Approval =>
  review && !review.deleted
    ? {
        status: review.spec.decision,
        by: review.by,
        ...(review.spec.changedBy ? { byName: review.spec.changedBy } : {}),
        at: review.at,
        reason: review.reason,
      }
    : { status: 'pending' };

export const approvalsOf = async (store: ConfigEntryStore, tenant: string) => {
  const reviews = new Map(
    (
      (await store.latest({
        kind: projectReviewKind,
        scope: tenant,
      })) as ConfigEntry<ProjectRunReview>[]
    ).map((e) => [e.id, e]),
  );
  const out = new Map<string, Approval>();
  for (const entry of await store.latest({ kind: 'project-run', scope: tenant })) {
    const link = entry.spec as RunLink;
    if (link.trigger !== 'subscription') continue;
    out.set(link.run, approvalFrom(reviews.get(link.run)));
  }
  return out;
};

export const approvalOf = async (store: ConfigEntryStore, tenant: string, run: string) =>
  (await approvalsOf(store, tenant)).get(run);

export const recordReview = (
  store: ConfigEntryStore,
  tenant: string,
  review: ProjectRunReview,
  by: string,
  reason: string,
  at?: string,
) =>
  appendVersion<ProjectRunReview>(store, {
    kind: projectReviewKind,
    scope: tenant,
    id: review.run,
    spec: review,
    deleted: false,
    by,
    reason,
    ...(at ? { at } : {}),
  });

export const reviewHistory = async (store: ConfigEntryStore, tenant: string, project: string) =>
  (
    await Promise.all(
      (await store.latest({ kind: projectReviewKind, scope: tenant }))
        .filter((e) => (e.spec as ProjectRunReview).project === project)
        .map((e) => store.history(projectReviewKind, tenant, e.id)),
    )
  ).flat();
