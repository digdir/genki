import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalRanking,
  compareRanked,
  overlapAt,
  type Difference,
  type RankedHit,
} from './compare.js';
import { send } from './http.js';
import { mcp } from './scenarios/mcp.js';
import { toolName } from './scope.js';
import type { Captured, JsonValue, Request, Target } from './types.js';

export interface Question {
  id: string;
  question: string;
  dataset?: string;
}

export interface RetrievalProbe {
  name: string;
  request(question: Question): Request;
  extract(response: Captured): RankedHit[];
}

export interface BaselineEntry {
  id: string;
  question: string;
  ids: string[];
  scores?: number[];
  error?: string;
}

export interface Baseline {
  dataset: string;
  target: string;
  probe: string;
  questions: BaselineEntry[];
}

const record = (v: JsonValue | string | undefined): Record<string, JsonValue> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;

export const mcpRetrieveOnly = (tool = toolName('probe', 'old')): RetrievalProbe => ({
  name: `mcp:${tool}`,
  request: (q) =>
    mcp('tools/call', { name: tool, arguments: { query: q.question } }, { name: tool }),
  extract: (response) => {
    const result = record(record(response.body)?.result);
    const chunks = record(result?.structuredContent)?.chunks;
    if (!Array.isArray(chunks))
      throw new Error(`no structuredContent.chunks in the response (HTTP ${response.status})`);
    return chunks.flatMap((c) => {
      const chunk = record(c);
      const id = chunk?.chunk_id;
      if (typeof id !== 'string') return [];
      const score = chunk?.score;
      return [{ id, ...(typeof score === 'number' ? { score } : {}) }];
    });
  },
});

export const parseQuestions = (input: unknown): Question[] => {
  const list = Array.isArray(input) ? input : (input as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) throw new Error('questions must be a list or { questions: [...] }');
  return list.map((q: Record<string, unknown>, i) => {
    if (typeof q.question !== 'string' || q.question === '')
      throw new Error(`question ${i} has no text`);
    return {
      id: typeof q.id === 'string' || typeof q.id === 'number' ? String(q.id) : String(i + 1),
      question: q.question,
      ...(typeof q.dataset === 'string' ? { dataset: q.dataset } : {}),
    };
  });
};

const byId = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id, 'en', { numeric: true });

export const runBaseline = async (
  target: Target,
  questions: Question[],
  probe: RetrievalProbe = mcpRetrieveOnly(),
): Promise<Baseline[]> => {
  const datasets = new Map<string, BaselineEntry[]>();
  for (const q of [...questions].sort(byId)) {
    const dataset = q.dataset ?? 'default';
    let entry: BaselineEntry;
    try {
      const hits = probe.extract(await send(target, probe.request(q)));
      const ids = canonicalRanking(hits);
      const scoreOf = new Map(hits.map((h) => [h.id, h.score]));
      const scores = ids.map((id) => scoreOf.get(id));
      entry = {
        id: q.id,
        question: q.question,
        ids,
        ...(scores.every((s) => typeof s === 'number') && scores.length > 0
          ? { scores: scores as number[] }
          : {}),
      };
    } catch (error) {
      entry = { id: q.id, question: q.question, ids: [], error: (error as Error).message };
    }
    datasets.set(dataset, [...(datasets.get(dataset) ?? []), entry]);
  }
  return [...datasets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dataset, entries]) => ({
      dataset,
      target: target.name,
      probe: probe.name,
      questions: entries,
    }));
};

export const writeBaselines = async (dir: string, baselines: Baseline[]) => {
  await mkdir(dir, { recursive: true });
  for (const b of baselines) {
    await writeFile(join(dir, `${b.dataset}.json`), `${JSON.stringify(b, null, 2)}\n`);
  }
  return baselines.map((b) => join(dir, `${b.dataset}.json`));
};

export const readBaseline = async (path: string) =>
  JSON.parse(await readFile(path, 'utf8')) as Baseline;

const hits = (e: BaselineEntry): RankedHit[] =>
  e.ids.map((id, i) => ({ id, ...(e.scores ? { score: e.scores[i] as number } : {}) }));

export interface BaselineComparison {
  question: string;
  differences: Difference[];
  overlapAt10: number;
}

export const compareBaselines = (old: Baseline, next: Baseline): BaselineComparison[] => {
  const fresh = new Map(next.questions.map((q) => [q.id, q]));
  return old.questions.map((q) => {
    const n = fresh.get(q.id);
    if (!n)
      return {
        question: q.id,
        differences: [{ severity: 'fail', path: '$', old: 'present', new: 'missing' }],
        overlapAt10: 0,
      };
    return {
      question: q.id,
      differences: compareRanked(hits(q), hits(n), `$.${q.id}`),
      overlapAt10: overlapAt(hits(q), hits(n), 10),
    };
  });
};
