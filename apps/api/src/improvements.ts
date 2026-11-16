import type { Part, Principal } from '@genai/contracts';
import { anonymousFeedback, type FeedbackRecord, type TestCase, type TestSet } from '@genai/eval';
import {
  optimiserResultMime,
  type ImprovementEvidence,
  type OptimiserResult,
} from '@genai/strategy-builder';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { restartMessage, type Leased } from './background-lease.js';
import { appendVersion, type ConfigEntry } from './config-store.js';
import { t } from './i18n/index.js';
import type { ModuleDeps } from './platform-modules.js';
import {
  defaultModelOf,
  optimiserServiceId,
  platformService,
  runPlatformService,
  runsPlatformServices,
} from './platform-services.js';
import {
  casesIn,
  runDetail,
  type CaseResult,
  type ServiceEval,
  type Subject,
} from './service-eval.js';

export const improvementKind = 'service-improvement';
export const maxExamples = 3;

export type ImprovementStatus = 'running' | 'ready' | 'failed' | 'approved' | 'rejected';

export interface InstructionsTarget {
  path: string;
  file?: string;
  language?: string;
}

export interface ImprovementScores {
  testSet: string;
  before: number | null;
  after: number | null;
  passedBefore: number;
  passedAfter: number;
  total: number;
}

export interface Improvement extends Leased {
  id: string;
  service: string;
  status: ImprovementStatus;
  testSet: string;
  baseVersion: number;
  language?: string;
  target: InstructionsTarget;
  change: { path: string; before: string; after: string } | null;
  scores: ImprovementScores | null;
  examples: { input: string; before: string; after: string }[];
  reasons: string[];
  createdAt: string;
  decision?: { approved: boolean; at: string; reason: string };
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const configOf = (definition: Record<string, unknown>) => {
  const spec = isRecord(definition.spec) ? definition.spec : undefined;
  const strategy = isRecord(spec?.strategy) ? spec.strategy : undefined;
  return isRecord(strategy?.config) ? strategy.config : undefined;
};

export const answerLanguages = ['nb', 'nn', 'en'];

const textsOf = (config: Record<string, unknown> | undefined, language: string | undefined) => {
  if (!language) return { value: config?.instructions, path: 'spec.strategy.config.instructions' };
  const texts = config?.languageInstructions;
  return {
    value: isRecord(texts) ? texts[language] : undefined,
    path: `spec.strategy.config.languageInstructions.${language}`,
  };
};

export const instructionsOf = (
  subject: Pick<Subject, 'definition' | 'files'>,
  language?: string,
): (InstructionsTarget & { text: string }) | undefined => {
  const { value, path } = textsOf(configOf(subject.definition), language);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const file = subject.files[value];
  return file === undefined
    ? { path, text: value, ...(language ? { language } : {}) }
    : { path: value, file: value, text: file, ...(language ? { language } : {}) };
};

export const withInstructions = <S extends Pick<Subject, 'definition' | 'files'>>(
  subject: S,
  target: InstructionsTarget,
  text: string,
): S => {
  if (target.file) return { ...subject, files: { ...subject.files, [target.file]: text } };
  const definition = structuredClone(subject.definition);
  const config = configOf(definition);
  if (config && target.language) {
    const texts = isRecord(config.languageInstructions) ? config.languageInstructions : {};
    config.languageInstructions = { ...texts, [target.language]: text };
  } else if (config) config.instructions = text;
  return { ...subject, definition };
};

export const allowsInstructions = (definition: Record<string, unknown>) => {
  const improve = isRecord(definition.spec) ? definition.spec.improve : undefined;
  const allow = isRecord(improve) ? improve.allow : undefined;
  return Array.isArray(allow) && allow.includes('instructions');
};

export const optimiserFailures = (
  set: TestSet,
  run: { cases: CaseResult[] } | undefined,
  language?: string,
) => {
  if (!run) return [];
  const open = new Set(
    casesIn(set, 'open')
      .filter((c) => !language || c.language === language)
      .map((c) => c.id),
  );
  return run.cases
    .filter((r) => !r.pass && open.has(r.caseId))
    .map((r) => ({
      input: r.input,
      expected: r.expected,
      output: r.output,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
};

export const optimiserFeedback = (records: FeedbackRecord[]) =>
  anonymousFeedback(records)
    .filter((f) => f.rating === 'down' && (f.comment || f.reasons?.length))
    .map((f) => ({
      ...(f.comment ? { comment: f.comment } : {}),
      ...(f.reasons?.length ? { reasons: f.reasons } : {}),
    }));

export const improvementView = (improvement: Improvement) => ({
  id: improvement.id,
  status: improvement.status,
  ...(improvement.language ? { language: improvement.language } : {}),
  change: improvement.change,
  scores: improvement.scores,
  examples: improvement.examples,
  reasons: improvement.reasons,
  createdAt: improvement.createdAt,
  ...(improvement.decision ? { decision: improvement.decision } : {}),
  ...(improvement.error ? { error: improvement.error } : {}),
});

const examplesFrom = (before: CaseResult[], after: CaseResult[]) =>
  after
    .flatMap((a) => {
      const b = before.find((x) => x.caseId === a.caseId);
      return b && b.output !== a.output
        ? [{ input: a.input, before: b.output, after: a.output, changed: b.pass !== a.pass }]
        : [];
    })
    .sort((x, y) => Number(y.changed) - Number(x.changed))
    .slice(0, maxExamples)
    .map(({ input, before: b, after: a }) => ({ input, before: b, after: a }));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const improvements = (deps: ModuleDeps, evals: ServiceEval) => {
  const { leases } = evals;

  const settled = async (entry: ConfigEntry<Improvement>) => {
    const spec = entry.spec;
    if (spec.status !== 'running') return entry;
    if (!leases.abandoned(`${entry.scope}/${spec.id}`, spec, spec.createdAt)) return entry;
    const failed: Improvement = { ...spec, status: 'failed', error: restartMessage };
    return appendVersion<Improvement>(deps.configEntries, {
      kind: improvementKind,
      scope: entry.scope,
      id: spec.id,
      spec: failed,
      deleted: false,
      by: 'platform:restart',
      reason: restartMessage,
      ifVersion: entry.version,
    }).catch(() => ({ ...entry, spec: failed }));
  };

  const current = async (tenant: string, id: string) => {
    const entry = (await deps.configEntries.history(improvementKind, tenant, id)).at(-1) as
      ConfigEntry<Improvement> | undefined;
    return entry ? settled(entry) : undefined;
  };

  const recover = async () => {
    for (const entry of await deps.configEntries.latest({ kind: improvementKind }))
      await settled(entry as ConfigEntry<Improvement>);
  };

  const save = (principal: Principal, tenant: string, improvement: Improvement, reason: string) =>
    appendVersion<Improvement>(deps.configEntries, {
      kind: improvementKind,
      scope: tenant,
      id: improvement.id,
      spec: improvement,
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
    });

  const list = async (tenant: string, service: string) =>
    (
      await Promise.all(
        (await deps.configEntries.latest({ kind: improvementKind, scope: tenant }))
          .filter((e) => (e.spec as Improvement).service === service)
          .map(async (e) => (await settled(e as ConfigEntry<Improvement>)).spec),
      )
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const negativeFeedback = async (tenant: string, service: string) => {
    const prefix = `${tenant}/${service}/`;
    const kept: FeedbackRecord[] = [];
    for (const record of await deps.evalStores.feedback.list(tenant)) {
      const capability =
        record.capability ??
        (await deps.task(record.task).catch(() => undefined))?.service.capability.id;
      if (capability?.startsWith(prefix)) kept.push(record);
    }
    return optimiserFeedback(kept);
  };

  const optimiserModel = async (tenant: string, preferred: string | undefined) => {
    const usable = (await evals.choice.usable(tenant)).filter((m) =>
      runsPlatformServices(deps, m.id),
    );
    const configured = evals.choice.settingOf(tenant, 'assistant.model');
    if (configured) return usable.find((m) => m.id === configured)?.id;
    return (usable.find((m) => m.id === preferred) ?? usable[0])?.id;
  };

  const changeOf = (parts: Part[]) => {
    const part = parts.find((p) => p.mime === optimiserResultMime);
    return part?.body.kind === 'json' ? (part.body.json as OptimiserResult) : undefined;
  };

  const propose = async (
    principal: Principal,
    tenant: string,
    service: string,
    set: TestSet,
    base: Subject & { version: number },
    evidence: ImprovementEvidence,
    model: string,
    improvement: Improvement,
    lease: ReturnType<typeof leases.hold<Improvement>>,
  ) => {
    const meter = evals.choice.meter();
    const before = evidence.instructions;
    try {
      const outcome = await runPlatformService(deps, {
        principal,
        tenant,
        service: optimiserServiceId,
        model,
        data: { evidence },
      });
      if (!outcome) throw new Error(t('services.optimiserNotPublished'));
      meter.add(outcome);
      if (!outcome.ok) throw new Error(outcome.errors.map((e) => e.message).join('; '));
      const result = changeOf(outcome.parts);
      if (!result?.changed || !result.instructions)
        throw new Error('Assistenten foreslo ingen endring i instruksjonene.');
      const change = { after: result.instructions, reasons: result.reasons };
      const proposed: Subject = {
        ...withInstructions(base, improvement.target, change.after),
        version: 'draft',
      };
      const open = casesIn(set, 'open');
      const openBefore = await evals.runCases(principal, tenant, base, open, meter);
      const openAfter = await evals.runCases(principal, tenant, proposed, open, meter);
      const locked: TestCase[] = casesIn(set, 'locked');
      const lockedBefore = await evals.runCases(principal, tenant, base, locked, meter);
      const lockedAfter = await evals.runCases(principal, tenant, proposed, locked, meter);
      await lease.update(
        () => ({
          ...improvement,
          status: 'ready',
          change: { path: improvement.target.path, before, after: change.after },
          scores: {
            testSet: set.metadata.id,
            before: lockedBefore.score,
            after: lockedAfter.score,
            passedBefore: lockedBefore.passed,
            passedAfter: lockedAfter.passed,
            total: lockedAfter.total,
          },
          examples: examplesFrom(openBefore.results, openAfter.results),
          reasons: change.reasons,
        }),
        'Forslag klart',
      );
    } catch (error) {
      await lease.update(
        () => ({ ...improvement, status: 'failed', error: messageOf(error) }),
        'Forslaget feilet',
      );
    } finally {
      lease.release();
    }
  };

  type Started =
    | { ok: true; improvement: Improvement; done: Promise<void> }
    | { ok: false; status: 400 | 404 | 409; title: string; path: string };

  const start = async (
    principal: Principal,
    tenant: string,
    service: string,
    testSetId?: string,
    language?: string,
  ): Promise<Started> => {
    const refused = (status: 400 | 404 | 409, title: string, path: string): Started => ({
      ok: false,
      status,
      title,
      path,
    });
    const base = await evals.published(tenant, service);
    if (!base || typeof base.version !== 'number')
      return refused(404, 'Tjenesten er ikke publisert', 'service');
    if (!allowsInstructions(base.definition))
      return refused(
        409,
        'Tjenesten tillater ikke forslag til instruksjonene. Slå det på under Oppsett › Arbeidsmåte.',
        'spec.improve.allow',
      );
    if (language !== undefined && !answerLanguages.includes(language))
      return refused(400, t('services.improvementLanguageUnknown'), 'language');
    const instructions = instructionsOf(base, language);
    if (!instructions)
      return language
        ? refused(409, t('services.improvementNoLanguageText', { language }), 'language')
        : refused(409, 'Tjenesten har ingen instruksjoner', 'instructions');
    const sets = await deps.evalStores.testSets.list(tenant, service);
    const set = testSetId ? sets.find((s) => s.metadata.id === testSetId) : sets[0];
    if (!set) return refused(404, 'Fant ikke testsettet', 'testSet');
    if (casesIn(set, 'locked').length === 0 || casesIn(set, 'open').length === 0)
      return refused(409, 'Testsettet trenger både låste og åpne testtilfeller', 'testSet');
    const completed = await evals.latestCompleted(tenant, service, set.metadata.id);
    const latest = completed && runDetail(completed.run, set, await evals.answersOf(completed.run));
    const evidence: ImprovementEvidence = {
      purpose: String((base.definition.spec as { purpose?: unknown }).purpose ?? ''),
      ...(language ? { language: language as 'nb' } : {}),
      instructions: instructions.text,
      feedback: await negativeFeedback(tenant, service),
      failures: optimiserFailures(set, latest, language),
    };
    if (evidence.feedback.length === 0 && evidence.failures.length === 0)
      return refused(
        409,
        'Ingen negative tilbakemeldinger eller feilede testtilfeller å lære av',
        'evidence',
      );
    const optimiser = await platformService(deps, optimiserServiceId);
    if (!optimiser) return refused(409, t('services.optimiserNotPublished'), 'optimiser');
    const model = await optimiserModel(tenant, defaultModelOf(optimiser));
    if (!model) return refused(409, 'Ingen modell er tilgjengelig', 'model');
    const improvement: Improvement = {
      id: crypto.randomUUID(),
      service,
      status: 'running',
      testSet: set.metadata.id,
      baseVersion: base.version,
      ...(language ? { language } : {}),
      target: {
        path: instructions.path,
        ...(instructions.file ? { file: instructions.file } : {}),
        ...(language ? { language } : {}),
      },
      change: null,
      scores: null,
      examples: [],
      reasons: [],
      createdAt: new Date().toISOString(),
      ...leases.stamp(),
    };
    const lease = leases.hold(`${tenant}/${improvement.id}`, improvement, (spec, reason) =>
      save(principal, tenant, spec, reason),
    );
    try {
      await lease.update((spec) => spec, 'Forbedringsforslag startet');
    } catch (error) {
      lease.release();
      throw error;
    }
    const done = propose(
      principal,
      tenant,
      service,
      set,
      { ...base, version: base.version },
      evidence,
      model,
      improvement,
      lease,
    );
    return { ok: true, improvement, done };
  };

  const failed = (target: string, path: string, message: string): AdminOutcome => ({
    ok: false,
    errors: [{ path, message }],
    target,
  });

  const decide: AdminHandler = async (input, principal) => {
    const { tenant, reason } = input;
    const id = String(input.id ?? '');
    const target = `service-improvement:${tenant}/${id}`;
    const found = await current(tenant, id);
    if (!found) return failed(target, 'improvement', `no improvement ${id}`);
    const improvement = found.spec;
    if (improvement.status !== 'ready' || !improvement.change)
      return failed(target, 'status', `the improvement is ${improvement.status}`);
    const at = new Date().toISOString();
    if (input.approve !== true) {
      const rejected: Improvement = {
        ...improvement,
        status: 'rejected',
        decision: { approved: false, at, reason },
      };
      await save(principal, tenant, rejected, reason);
      return {
        ok: true,
        value: improvementView(rejected),
        target,
        audit: { approve: false },
      };
    }
    const draft = await evals.draftOf(tenant, improvement.service);
    const base = draft
      ? draft.spec
      : await evals.published(tenant, improvement.service, improvement.baseVersion);
    if (!base) return failed(target, 'service', `no service ${improvement.service}`);
    const now = instructionsOf(base, improvement.language);
    if (now?.text !== improvement.change.before)
      return failed(
        target,
        'draft',
        'Instruksjonene i utkastet er endret siden forslaget ble laget.',
      );
    const next = withInstructions(base, improvement.target, improvement.change.after);
    await evals.saveDraft(
      principal,
      tenant,
      improvement.service,
      {
        definition: next.definition,
        files: next.files,
        baseVersion: draft?.spec.baseVersion ?? improvement.baseVersion,
      },
      reason,
      draft?.version ?? 0,
    );
    const approved: Improvement = {
      ...improvement,
      status: 'approved',
      decision: { approved: true, at, reason },
    };
    await save(principal, tenant, approved, reason);
    return {
      ok: true,
      value: improvementView(approved),
      target,
      audit: { approve: true, path: improvement.change.path },
    };
  };

  return { start, list, current, recover, handlers: { 'platform.improvement.decide': decide } };
};
