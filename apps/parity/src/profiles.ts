import type { KnowledgePort } from '@genai/port-knowledge';
import { recallAt, type QualityCase } from './quality.js';

export interface ProfileCaseResult {
  id: string;
  recall: Record<string, number>;
  union: number;
}

export interface ProfileSummary {
  profiles: string[];
  limit: number;
  cases: number;
  recall: Record<string, number>;
  union: number;
  onlyFoundBy: Record<string, number>;
  perCase: ProfileCaseResult[];
}

export const measureProfiles = async (
  cases: QualityCase[],
  knowledge: KnowledgePort,
  profiles: string[],
  limit: number,
): Promise<ProfileSummary> => {
  const withSources = cases.filter((c) => c.sources.length > 0);
  const perCase: ProfileCaseResult[] = [];
  for (const c of withSources) {
    const results = await knowledge.searchMany(
      profiles.map((profile) => ({ query: c.question, profile, limit })),
    );
    const recall: Record<string, number> = {};
    const found = new Set<string>();
    profiles.forEach((profile, i) => {
      const chunks = (results[i]?.hits ?? []).map((h) => ({
        chunkId: h.id,
        ...(h.document ? { document: h.document } : {}),
        ...(h.position !== undefined ? { position: h.position } : {}),
      }));
      recall[profile] = recallAt(chunks, c.sources, limit) ?? 0;
      if ((recall[profile] ?? 0) > 0) found.add(profile);
    });
    perCase.push({ id: c.id, recall, union: found.size > 0 ? 1 : 0 });
  }
  const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    profiles,
    limit,
    cases: perCase.length,
    recall: Object.fromEntries(
      profiles.map((p) => [p, average(perCase.map((r) => r.recall[p] ?? 0))]),
    ),
    union: average(perCase.map((r) => r.union)),
    onlyFoundBy: Object.fromEntries(
      profiles.map((p) => [
        p,
        perCase.filter(
          (r) =>
            (r.recall[p] ?? 0) > 0 && profiles.every((o) => o === p || (r.recall[o] ?? 0) === 0),
        ).length,
      ]),
    ),
    perCase,
  };
};
