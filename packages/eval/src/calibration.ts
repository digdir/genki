import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { EvalError } from './evaluators.js';
import { minimumJudgeAgreement } from './gates.js';

export const judgeLabel = z.strictObject({
  item: z.string().min(1),
  judge: z.string().min(1),
  judgeLabel: z.string().min(1),
  humanLabel: z.string().min(1),
  labeller: z.string().min(1),
});
export type JudgeLabel = z.infer<typeof judgeLabel>;

export const labelFile = z.array(judgeLabel).min(1);

export interface Agreement {
  judge: string;
  kappa: number;
  observed: number;
  n: number;
  blocking: boolean;
}

export const cohensKappa = (pairs: [string, string][]): { kappa: number; observed: number } => {
  if (pairs.length === 0) throw new EvalError('kappa needs at least one labelled item');
  const categories = [...new Set(pairs.flat())];
  const n = pairs.length;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = categories.reduce((sum, c) => {
    const a = pairs.filter(([x]) => x === c).length / n;
    const b = pairs.filter(([, y]) => y === c).length / n;
    return sum + a * b;
  }, 0);
  if (expected === 1) return { kappa: observed === 1 ? 1 : 0, observed };
  return { kappa: (observed - expected) / (1 - expected), observed };
};

export const judgeAgreement = (labels: JudgeLabel[]): Agreement[] => {
  const byJudge = new Map<string, [string, string][]>();
  for (const l of labels) {
    const pairs = byJudge.get(l.judge) ?? [];
    pairs.push([l.judgeLabel, l.humanLabel]);
    byJudge.set(l.judge, pairs);
  }
  return [...byJudge]
    .map(([judge, pairs]) => {
      const { kappa, observed } = cohensKappa(pairs);
      return { judge, kappa, observed, n: pairs.length, blocking: kappa >= minimumJudgeAgreement };
    })
    .sort((a, b) => a.judge.localeCompare(b.judge));
};

export const agreementMap = (labels: JudgeLabel[]) =>
  new Map(judgeAgreement(labels).map((a) => [a.judge, a.kappa]));

export const parseLabels = (text: string): JudgeLabel[] => labelFile.parse(parseYaml(text));

export interface LabelStore {
  add(labels: JudgeLabel[]): Promise<void>;
  list(judge?: string): Promise<JudgeLabel[]>;
}

export class InMemoryLabelStore implements LabelStore {
  readonly #labels: JudgeLabel[] = [];

  async add(labels: JudgeLabel[]) {
    this.#labels.push(...labelFile.parse(labels));
  }

  async list(judge?: string) {
    return this.#labels
      .filter((l) => judge === undefined || l.judge === judge)
      .map((l) => ({ ...l }));
  }
}

/**
 * A label made in a trace sink, such as an annotation in Langfuse (ADR 0040): a person's verdict
 * on one case a run sent there, paired with the sink judge's own verdict on it. It counts only once
 * accepted; an edit at the sink comes back as a new revision, and one deleted there is gone.
 */
export const sinkLabelStates = ['pending', 'accepted', 'rejected', 'replaced', 'gone'] as const;
export type SinkLabelState = (typeof sinkLabelStates)[number];

export const sinkLabel = z.strictObject({
  /** The sink's id for the label, and its revision there. */
  id: z.string().min(1),
  revision: z.string().min(1),
  connection: z.string().min(1),
  /** The judge the label calibrates: its identity without version and model. */
  judge: z.string().min(1),
  /** The judge identity that scored the case. */
  identity: z.string().min(1),
  run: z.string().min(1),
  case: z.string().min(1),
  repeat: z.number().int(),
  humanLabel: z.string().min(1),
  /** Absent when the judge has no score on the case: the label is unpaired. */
  judgeLabel: z.string().min(1).optional(),
  labeller: z.string().min(1),
  state: z.enum(sinkLabelStates),
  fetchedAt: z.string().min(1),
  decided: z
    .strictObject({ by: z.string().min(1), reason: z.string().min(1), at: z.string().min(1) })
    .optional(),
});
export type SinkLabel = z.infer<typeof sinkLabel>;

export interface SinkLabelStore {
  /** The tenant's sink labels, every revision and state. */
  list(tenant: string, filter?: { connection?: string; judge?: string }): Promise<SinkLabel[]>;
  /** Adds labels, or replaces the ones with the same id and revision. */
  save(tenant: string, labels: SinkLabel[]): Promise<void>;
  /** The tenant's own key for labeller pseudonyms, made on first use and never shown. */
  pseudonymKey(tenant: string): Promise<string>;
  /** Runs work on one connection's labels alone, across replicas, as fetching and deciding read then save. */
  exclusive<T>(tenant: string, connection: string, work: () => Promise<T>): Promise<T>;
}

/** Labels are kept per connection: two connections to one project see the same annotation ids. */
const sinkLabelKey = (l: Pick<SinkLabel, 'connection' | 'id' | 'revision'>) =>
  `${l.connection}\u0000${l.id}\u0000${l.revision}`;

export class InMemorySinkLabelStore implements SinkLabelStore {
  readonly #labels = new Map<string, Map<string, SinkLabel>>();
  readonly #keys = new Map<string, string>();

  async list(tenant: string, filter: { connection?: string; judge?: string } = {}) {
    return [...(this.#labels.get(tenant)?.values() ?? [])]
      .filter(
        (l) =>
          (filter.connection === undefined || l.connection === filter.connection) &&
          (filter.judge === undefined || l.judge === filter.judge),
      )
      .map((l) => ({ ...l }));
  }

  async save(tenant: string, labels: SinkLabel[]) {
    const own = this.#labels.get(tenant) ?? new Map<string, SinkLabel>();
    for (const l of labels) own.set(sinkLabelKey(l), sinkLabel.parse(l));
    this.#labels.set(tenant, own);
  }

  async pseudonymKey(tenant: string) {
    const key = this.#keys.get(tenant) ?? randomBytes(32).toString('hex');
    this.#keys.set(tenant, key);
    return key;
  }

  readonly #queues = new Map<string, Promise<unknown>>();

  async exclusive<T>(tenant: string, connection: string, work: () => Promise<T>): Promise<T> {
    const key = `${tenant}\u0000${connection}`;
    const turn = (this.#queues.get(key) ?? Promise.resolve()).then(work, work);
    this.#queues.set(
      key,
      turn.catch(() => undefined),
    );
    return turn;
  }
}

/** A sink judge's agreement with its accepted labels, for one of its identities. */
export interface SinkAgreement {
  /** Accepted labels paired with a judge verdict. */
  n: number;
  kappa?: number;
  observed?: number;
  /** Of n, the labels another identity of the same judge scored, such as an earlier version. */
  otherVersions: number;
  /** Accepted labels without a judge verdict to pair with. */
  unpaired: number;
}

/**
 * Agreement over the accepted labels of one judge (ADR 0003): a new identity of the judge takes
 * them over, and says how many another identity scored. Unpaired labels are counted, never paired.
 */
export const sinkAgreement = (labels: SinkLabel[], identity: string): SinkAgreement => {
  const accepted = labels.filter((l) => l.state === 'accepted');
  const paired = accepted.filter(
    (l): l is SinkLabel & { judgeLabel: string } => l.judgeLabel !== undefined,
  );
  const unpaired = accepted.length - paired.length;
  if (paired.length === 0) return { n: 0, otherVersions: 0, unpaired };
  const { kappa, observed } = cohensKappa(paired.map((l) => [l.judgeLabel, l.humanLabel]));
  return {
    n: paired.length,
    kappa,
    observed,
    otherVersions: paired.filter((l) => l.identity !== identity).length,
    unpaired,
  };
};
