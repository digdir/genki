import { createHmac } from 'node:crypto';
import {
  evaluatorOfJudge,
  sinkAgreement,
  type EvalRun,
  type EvalRunStore,
  type Score,
  type SinkAgreement,
  type SinkLabel,
  type SinkLabelStore,
} from '@genai/eval';
import type { SinkAnnotation, TraceConnection, TraceSinks } from './trace-connections.js';

/** A connection's labels cannot be brought back: missing, or its labels switch is off. */
export class SinkLabelsRefused extends Error {
  constructor(
    message: string,
    readonly missing = false,
  ) {
    super(message);
    this.name = 'SinkLabelsRefused';
  }
}

/** The pending labels of one connection and judge, which an operator accepts or rejects at once. */
export interface SinkLabelBatch {
  tenant: string;
  connection: string;
  judge: string;
  name: string;
  labels: {
    /** The sink's id for the label and its revision: what an operator accepts or rejects. */
    id: string;
    revision: string;
    run: string;
    case: string;
    repeat: number;
    humanLabel: string;
    judgeLabel?: string;
    labeller: string;
  }[];
  /** Labels with a judge verdict, how many of those agree with it, and those without one. */
  paired: number;
  alike: number;
  unpaired: number;
  labellers: number;
}

export interface SinkLabelDeps {
  store: SinkLabelStore;
  runs: Pick<EvalRunStore, 'list'>;
  connection(tenant: string, id: string): Promise<TraceConnection | undefined>;
  /** The tenant's connections, for the console's list of where labels can come from. */
  connections?(tenant: string): Promise<TraceConnection[]>;
  sinks: Pick<
    TraceSinks,
    'annotations' | 'calibrationKey' | 'traceIdOf' | 'isSinkJudge' | 'sharedScores'
  >;
  now?: () => Date;
}

/** A case a run sent through the connection, with the sink judges' scores on it. */
interface SentCase {
  run: EvalRun;
  result: EvalRun['results'][number];
  /** Each sink judge's data type in the run, for a score that lost it, such as one timed out. */
  dataTypes: Map<string, string>;
  /** The same for the name the sink gives each judge's scores. */
  scoreNames: Map<string, string>;
}

/**
 * The judge's own verdict on the case, as a label: split at 0.5, a number that came without a
 * range split with the label's range, or the category as it came.
 */
const verdictOf = (score: Score, bounds: SinkAnnotation['bounds']) => {
  if (score.state !== 'scored') return undefined;
  if (typeof score.value === 'number') return score.value >= 0.5 ? 'good' : 'bad';
  const asItCame = score.details?.asItCame;
  if (typeof asItCame === 'number' && bounds)
    return (asItCame - bounds.min) / (bounds.max - bounds.min) >= 0.5 ? 'good' : 'bad';
  return asItCame === undefined ? undefined : String(asItCame);
};

const nameOf = (judge: string) => judge.slice(judge.lastIndexOf('/') + 1);

/**
 * Labels people make in a tenant's trace sink, brought back as pending calibration labels for the
 * sink's judges (ADR 0040): fetched by an operator, counted once a batch is accepted.
 */
export const sinkLabels = (deps: SinkLabelDeps) => {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const isSinkJudge = (evaluator: string) => deps.sinks.isSinkJudge?.(evaluator) ?? false;
  const keyOf = (tenant: string, evaluator: string) =>
    deps.sinks.calibrationKey?.(tenant, evaluator) ?? evaluator;
  const identityOf = (run: EvalRun, judge: string, evaluator: string) =>
    run.provenance.judges.find((j) => evaluatorOfJudge(j) === judge) ?? evaluator;

  /** Every case trace the tenant's runs sent through the connection, by trace id. */
  const sentThrough = async (tenant: string, connection: string) => {
    const traces = new Map<string, SentCase>();
    for (const stored of await deps.runs.list({ tenant })) {
      if (stored.run.tested?.sink !== connection) continue;
      const dataTypes = new Map<string, string>();
      const scoreNames = new Map<string, string>();
      for (const s of stored.run.results.flatMap((r) => r.scores)) {
        if (!isSinkJudge(s.evaluator)) continue;
        if (typeof s.details?.dataType === 'string') dataTypes.set(s.evaluator, s.details.dataType);
        if (typeof s.details?.scoreName === 'string')
          scoreNames.set(s.evaluator, s.details.scoreName);
      }
      for (const result of stored.run.results)
        // Sent: a sink judge could read it, or it went out with an empty answer. Holdout cases and
        // ones none can read never go out.
        if (
          result.scores.some(
            (s) => isSinkJudge(s.evaluator) && (s.applicable || s.details?.sent === true),
          )
        )
          traces.set(deps.sinks.traceIdOf(result.task), {
            run: stored.run,
            result,
            dataTypes,
            scoreNames,
          });
    }
    return traces;
  };

  /** Each sink judge of a run, by evaluator, against the tenant's accepted labels. */
  const agreementsOf = (tenant: string, run: EvalRun, accepted: SinkLabel[]) => {
    const out = new Map<string, SinkAgreement>();
    const evaluators = new Set(
      run.results.flatMap((r) => r.scores.map((s) => s.evaluator).filter(isSinkJudge)),
    );
    for (const evaluator of evaluators) {
      const judge = keyOf(tenant, evaluator);
      out.set(
        evaluator,
        sinkAgreement(
          accepted.filter((l) => l.judge === judge),
          identityOf(run, judge, evaluator),
        ),
      );
    }
    return out;
  };

  /** Reads the connection's annotations and saves what changed; callers hold its lock. */
  const fetchNow = async (
    tenant: string,
    id: string,
  ): Promise<{ pending: number; shared: { name: string; rules: string[] }[] }> => {
    const connection = await deps.connection(tenant, id);
    if (!connection) throw new SinkLabelsRefused(`no connection ${id}`, true);
    if (!connection.labels)
      throw new SinkLabelsRefused(
        `the connection ${id} does not bring labels back; switch labels on first`,
      );
    const annotations = (await deps.sinks.annotations?.(tenant, connection)) ?? [];
    // A score name two rules write cannot say which rule a label is for: neither gets it.
    const shared = (await deps.sinks.sharedScores?.(tenant, connection)) ?? [];
    const sharedNames = new Set(shared.map((s) => s.name));
    const traces = await sentThrough(tenant, id);
    const known = await deps.store.list(tenant, { connection: id });
    const key = await deps.store.pseudonymKey(tenant);
    // A label without an author is someone the platform cannot tell apart: one pseudonym each.
    const pseudonymOf = (author: string | undefined, annotation: string) =>
      `pseudonym:${createHmac('sha256', key)
        .update(author ?? `annotation:${annotation}`)
        .digest('hex')
        .slice(0, 12)}`;
    const at = now();
    const changed: SinkLabel[] = [];
    const seen = new Set<string>();
    let pending = 0;
    for (const a of annotations) {
      const label = a.label;
      if (label === undefined) continue;
      // Still in the sink: a label whose case is not found here is not taken for deleted.
      seen.add(a.id);
      const sent = traces.get(a.trace);
      if (!sent || sharedNames.has(a.name)) continue;
      // The judge on this connection whose scores have the label's name and type: the name the
      // sink gave them, or the judge's own for a run that did not record one.
      const score = sent.result.scores.find(
        (s) =>
          isSinkJudge(s.evaluator) &&
          keyOf(tenant, s.evaluator).endsWith(`/${id}/${nameOf(s.evaluator)}`) &&
          (s.details?.scoreName ?? sent.scoreNames.get(s.evaluator) ?? nameOf(s.evaluator)) ===
            a.name &&
          (s.details?.dataType ?? sent.dataTypes.get(s.evaluator)) === a.dataType,
      );
      if (!score) continue;
      // Another revision still waiting is replaced; an accepted one counts until this is accepted.
      for (const older of known)
        if (older.id === a.id && older.revision !== a.revision && older.state === 'pending')
          changed.push({ ...older, state: 'replaced' });
      // Compared with the label as it stands, not its history: Langfuse keeps updatedAt on an
      // edit, so editing back to an earlier value gives a revision seen before.
      const live = (l: SinkLabel) =>
        l.id === a.id && (l.state === 'pending' || l.state === 'accepted');
      if (known.some((l) => live(l) && l.revision === a.revision)) continue;
      // A rejected label stays rejected until it is edited to something else.
      const counting = known.some((l) => l.id === a.id && l.state === 'accepted');
      if (
        !counting &&
        known.some((l) => l.id === a.id && l.revision === a.revision && l.state === 'rejected')
      )
        continue;
      const judge = keyOf(tenant, score.evaluator);
      const judgeLabel = verdictOf(score, a.bounds);
      changed.push({
        id: a.id,
        revision: a.revision,
        connection: id,
        judge,
        identity: identityOf(sent.run, judge, score.evaluator),
        run: sent.run.id,
        case: sent.result.case,
        repeat: sent.result.repeat,
        humanLabel: label,
        ...(judgeLabel ? { judgeLabel } : {}),
        labeller: pseudonymOf(a.author, a.id),
        state: 'pending',
        fetchedAt: at,
      });
      pending += 1;
    }
    for (const l of known)
      if (!seen.has(l.id) && (l.state === 'pending' || l.state === 'accepted'))
        changed.push({ ...l, state: 'gone' });
    if (changed.length > 0) await deps.store.save(tenant, changed);
    return { pending, shared };
  };

  const accepted = async (tenant: string) =>
    (await deps.store.list(tenant)).filter((l) => l.state === 'accepted');

  return {
    async connections(tenant: string) {
      return ((await deps.connections?.(tenant)) ?? []).map((c) => ({
        connection: c.id,
        labels: c.labels === true,
      }));
    },

    /**
     * Reads every label in the connection's project: a new one, or a new revision of one, on a case
     * a run sent becomes pending; one no longer there is gone. Labels on other traces are ignored.
     */
    async fetch(
      tenant: string,
      id: string,
    ): Promise<{ pending: number; shared: { name: string; rules: string[] }[] }> {
      // One fetch or decision per connection at a time, across replicas: each reads then saves.
      return deps.store.exclusive(tenant, id, () => fetchNow(tenant, id));
    },

    async batches(tenant: string): Promise<SinkLabelBatch[]> {
      const byJudge = new Map<string, SinkLabel[]>();
      for (const l of await deps.store.list(tenant)) {
        if (l.state !== 'pending') continue;
        const k = `${l.connection}\u0000${l.judge}`;
        byJudge.set(k, [...(byJudge.get(k) ?? []), l]);
      }
      return [...byJudge.values()]
        .map((labels) => {
          const first = labels[0] as SinkLabel;
          const paired = labels.filter((l) => l.judgeLabel !== undefined);
          return {
            tenant,
            connection: first.connection,
            judge: first.judge,
            name: nameOf(first.judge),
            labels: labels.map((l) => ({
              id: l.id,
              revision: l.revision,
              run: l.run,
              case: l.case,
              repeat: l.repeat,
              humanLabel: l.humanLabel,
              ...(l.judgeLabel ? { judgeLabel: l.judgeLabel } : {}),
              labeller: l.labeller,
            })),
            paired: paired.length,
            alike: paired.filter((l) => l.judgeLabel === l.humanLabel).length,
            unpaired: labels.length - paired.length,
            labellers: new Set(labels.map((l) => l.labeller)).size,
          };
        })
        .sort((a, b) => `${a.connection}/${a.judge}`.localeCompare(`${b.connection}/${b.judge}`));
    },

    /**
     * Accepts or rejects the pending labels of the connection and judge, with the reason: the ones
     * the operator was shown, when named, so a label fetched since is not decided unseen.
     */
    async decide(
      tenant: string,
      connection: string,
      judge: string,
      decision: 'accept' | 'reject',
      by: string,
      reason: string,
      shown?: { id: string; revision: string }[],
    ): Promise<{ accepted?: number; rejected?: number }> {
      return deps.store.exclusive(tenant, connection, async () => {
        const labels = await deps.store.list(tenant, { connection, judge });
        const seen = shown && new Set(shown.map((l) => `${l.id}\u0000${l.revision}`));
        const pending = labels.filter(
          (l) => l.state === 'pending' && (!seen || seen.has(`${l.id}\u0000${l.revision}`)),
        );
        if (pending.length === 0) return {};
        const decided = { by, reason, at: now() };
        const ids = new Set(pending.map((l) => l.id));
        const changed: SinkLabel[] = pending.map((l) => ({
          ...l,
          state: decision === 'accept' ? 'accepted' : 'rejected',
          decided,
        }));
        // An accepted edit replaces the revision that counted before it.
        if (decision === 'accept')
          for (const l of labels)
            if (ids.has(l.id) && l.state === 'accepted') changed.push({ ...l, state: 'replaced' });
        await deps.store.save(tenant, changed);
        return decision === 'accept' ? { accepted: pending.length } : { rejected: pending.length };
      });
    },

    /** Each sink judge of the run, by evaluator: its agreement with its accepted labels. */
    async agreements(tenant: string, run: EvalRun): Promise<Map<string, SinkAgreement>> {
      return agreementsOf(tenant, run, await accepted(tenant));
    },

    /** The same for many runs of one tenant, reading its labels once. */
    async agreementsFor(tenant: string) {
      const labels = await accepted(tenant);
      return (run: EvalRun) => agreementsOf(tenant, run, labels);
    },
  };
};
export type SinkLabels = ReturnType<typeof sinkLabels>;
