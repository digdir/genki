import type {
  Candidate,
  CandidateReview,
  EvalCaseResult,
  EvalRunDetail,
  Improvement,
  NewCandidate,
  NewServiceCase,
  RunVersion,
  ServiceCase,
} from '../api/quality';
import type { CaseChange } from '../api/service-tabs';
import { changedPaths, setAt, valueAt } from '../definition-path';
import type { MockHandler } from '../mock';
import {
  exampleGates,
  exampleQualityRunsFor,
  exampleQualitySetsFor,
  exampleRunningRunFor,
} from './quality-example';

interface MockSet {
  id: string;
  name: string;
  service: string;
  cases: ServiceCase[];
}

export interface QualityMockOptions {
  sets?: MockSet[];
  runs?: (EvalRunDetail & { service: string })[];
  candidates?: (Candidate & { service: string })[];
  improvements?: (Improvement & { service: string })[];
  runsStayRunning?: boolean;
  improveRefused?: boolean;
  drafts?: Record<string, { definition: Record<string, unknown>; files?: Record<string, string> }>;
  published?: (service: string) => Record<string, unknown> | undefined;
  example?: boolean;
  savedBy?: { by: string; byName: string | null };
}

const exampleServices = ['rapportassistenten', 'postsortering'];
const exampleDraftRevision = 3;

const withChangedInstructions = (definition: Record<string, unknown>) => {
  const copy = structuredClone(definition) as {
    spec?: { strategy?: { config?: Record<string, unknown> }; evaluation?: unknown };
  };
  if (copy.spec) copy.spec.evaluation = { gates: ['ingen-tilbakegang', 'avslag-uten-kilde'] };
  const config = copy.spec?.strategy?.config;
  if (config)
    config.instructions = `${typeof config.instructions === 'string' ? config.instructions : ''}\nSvar kort, i høyst tre setninger.`;
  return copy as Record<string, unknown>;
};

interface MockDraft {
  base: Record<string, unknown> | undefined;
  revision: number;
  definition: Record<string, unknown>;
  files: Record<string, string>;
  deleted: boolean;
  at: string;
  reason: string;
  by: string;
  byName: string | null;
}

export const exampleQualitySets = (): MockSet[] => [
  {
    id: 'rapport-kjerne',
    name: 'Kjernespørsmål',
    service: 'rapportassistenten',
    cases: [
      {
        id: 'tc-1',
        input: 'Hvor mange tilsyn hadde vi i 2025?',
        expected: 'Oppgir tallet for 2025 og viser til årsrapporten.',
        type: 'criteria',
        split: 'open',
      },
      {
        id: 'tc-2',
        input: 'Hva sier evalueringene om digital veiledning?',
        expected: 'Oppsummerer funnene med kilder.',
        type: 'criteria',
        split: 'open',
      },
      {
        id: 'tc-3',
        input: 'Skriv et vedtak om tilskudd.',
        expected: 'Avviser, tjenesten skriver ikke vedtak.',
        type: 'must_reject',
        split: 'locked',
      },
    ],
  },
];

export const exampleQualityCandidates = (): (Candidate & { service: string })[] => [
  {
    id: 'fb-1a2b3c4d',
    service: 'rapportassistenten',
    input: 'Hva var ventetiden på telefon i fjor?',
    expected: 'Oppgir ventetiden for 2025 med kilde.',
    origin: 'feedback',
    status: 'pending-review',
    createdAt: '2026-10-06T09:12:00Z',
  },
];

const passes = (c: ServiceCase, i: number) => c.type === 'must_reject' || i % 3 !== 1;

export const qualityMock = (options: QualityMockOptions = {}): MockHandler => {
  const example = options.example ?? import.meta.env.MODE !== 'test';
  const versionOfService = (service: string) =>
    (options.published?.(service)?.metadata as { version?: number } | undefined)?.version ?? 0;
  const exampleSets = exampleServices.flatMap((s) => exampleQualitySetsFor(s));
  const exampleRuns = () =>
    exampleServices.flatMap((s, i) => [
      ...(i === 1 ? [exampleRunningRunFor(s)] : []),
      ...exampleQualityRunsFor(s, Math.max(1, versionOfService(s)), exampleDraftRevision - 1),
    ]);
  const sets = structuredClone(options.sets ?? (example ? exampleSets : exampleQualitySets()));
  const runs = structuredClone(options.runs ?? (example ? exampleRuns() : []));
  const candidates = structuredClone(options.candidates ?? exampleQualityCandidates());
  const improvements = structuredClone(options.improvements ?? []);
  const drafts = new Map<string, MockDraft>(
    Object.entries(options.drafts ?? {}).map(([service, d]) => [
      service,
      {
        base: options.published?.(service),
        revision: 1,
        definition: structuredClone(d.definition),
        files: { ...(d.files ?? {}) },
        deleted: false,
        at: '2026-10-07T10:00:00Z',
        reason: 'Forbedringsforslag godkjent',
        ...(options.savedBy ?? { by: 'employee:991825827:per', byName: 'Per Hansen' }),
      },
    ]),
  );
  if (example && !options.drafts)
    for (const service of exampleServices) {
      const published = options.published?.(service);
      if (!published) continue;
      const at = new Date();
      at.setHours(14, 2, 0, 0);
      drafts.set(service, {
        base: published,
        revision: exampleDraftRevision,
        definition: withChangedInstructions(published),
        files: {},
        deleted: false,
        at: at.toISOString(),
        reason: 'La til dato på kildene',
        by: 'employee:ansattporten:kari',
        byName: 'Kari Nordmann',
      });
    }
  const versionOf = (definition: Record<string, unknown> | undefined) =>
    (definition?.metadata as { version?: number } | undefined)?.version ?? 0;
  const ignored = ['metadata.version'];
  const draftView = (d: MockDraft, service: string) => ({
    revision: d.revision,
    definition: d.definition,
    files: d.files,
    at: d.at,
    reason: d.reason,
    by: d.by,
    byName: d.byName,
    baseVersion: versionOf(d.base),
    latestVersion: versionOf(options.published?.(service)),
  });
  const outdated = (service: string) => {
    const draft = drafts.get(service);
    const latest = options.published?.(service);
    if (!draft || draft.deleted || !latest || versionOf(draft.base) >= versionOf(latest))
      return undefined;
    return changedPaths(draft.base, latest, ignored);
  };
  const rebase = (service: string, draft: MockDraft) => {
    const latest = options.published?.(service) ?? draft.definition;
    const theirs = changedPaths(draft.base, latest, ignored);
    const conflicts: { path: string; published: unknown; draft: unknown }[] = [];
    let merged = structuredClone(latest);
    changedPaths(draft.base, draft.definition, ignored).forEach((path) => {
      const mine = valueAt(draft.definition, path);
      const published = valueAt(latest, path);
      if (theirs.includes(path) && JSON.stringify(mine) !== JSON.stringify(published))
        conflicts.push({ path, published, draft: mine });
      merged = setAt(merged, path, mine);
    });
    return { merged, conflicts };
  };
  const conflict = (current: number) =>
    new Response(
      JSON.stringify({
        title: 'Konflikt',
        status: 409,
        errors: [{ path: 'revision', message: `the entry is at version ${current}` }],
      }),
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    );
  const writeDraft = (
    service: string,
    revision: number | undefined,
    next: Omit<MockDraft, 'revision' | 'at' | 'base' | 'by' | 'byName'> & {
      base?: MockDraft['base'];
    },
  ) => {
    const found = drafts.get(service);
    const current = found?.revision ?? 0;
    const expected = revision === 0 && found?.deleted ? current : revision;
    if (expected !== undefined && expected !== current) return conflict(current);
    const base = found && !found.deleted ? found.base : options.published?.(service);
    const saved: MockDraft = {
      ...next,
      base: next.base ?? base,
      revision: current + 1,
      at: new Date().toISOString(),
      by: 'employee:991825827:kari',
      byName: 'Kari Nordmann',
    };
    drafts.set(service, saved);
    return undefined;
  };
  let next = 1;
  const newId = (prefix: string) => `${prefix}-${String(next++).padStart(3, '0')}`;

  const runOf = (
    service: string,
    set: MockSet,
    version: RunVersion,
    model = 'foundry-openai/gpt-4o-2m-tps',
  ) => {
    const results: EvalCaseResult[] = set.cases.map((c, i) => {
      const pass = passes(c, i);
      return {
        caseId: c.id,
        input: c.input,
        expected: c.expected,
        output: pass
          ? `Svar som oppfyller kravet: ${c.expected}`
          : 'Svaret bruker tall fra et eldre år.',
        pass,
        reason: pass ? 'Svaret oppfyller kriteriene.' : 'Svaret oppgir ikke riktig år.',
      };
    });
    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    const now = new Date().toISOString();
    const stay = options.runsStayRunning ?? false;
    return {
      id: newId('run'),
      service,
      status: stay ? 'running' : 'completed',
      testSet: set.id,
      version,
      model,
      startedAt: now,
      endedAt: stay ? null : now,
      score: stay ? null : total ? passed / total : 0,
      passed: stay ? null : passed,
      total: stay ? null : total,
      cost: null,
      ...(stay
        ? {}
        : {
            metrics: {
              'judge.criteria': {
                mean: total ? passed / total : 0,
                ci: [
                  Math.max(0, passed / Math.max(total, 1) - 0.2),
                  Math.min(1, passed / Math.max(total, 1) + 0.1),
                ],
                n: total,
              },
            },
            judges: ['judge:criteria@1+foundry-openai/gpt-41-dommer'],
          }),
      cases: stay ? [] : results,
    } satisfies EvalRunDetail & { service: string };
  };

  const strip = <T extends { service: string }>(item: T): Omit<T, 'service'> => {
    const copy: Partial<T> = { ...item };
    delete copy.service;
    return copy as Omit<T, 'service'>;
  };
  const summary = (run: (typeof runs)[number]) => {
    const copy: Partial<EvalRunDetail> = strip(run);
    delete copy.cases;
    return copy;
  };

  return (req) => {
    if (req.path === '/definitions' && req.method === 'POST') {
      const body = req.body<{
        definition?: { metadata?: { id?: string } };
        draftRevision?: number;
      }>();
      const service = body.definition?.metadata?.id;
      const paths =
        typeof body.draftRevision === 'number' && service ? outdated(service) : undefined;
      if (!paths) return undefined;
      return req.json(
        {
          type: 'urn:genai:problem:draft-outdated',
          title: 'Utkastet bygger på en eldre versjon',
          status: 409,
          errors: paths.map((path) => ({ path, message: 'changed in a newer published version' })),
        },
        409,
      );
    }
    const tenantRoute = /^\/tenants\/([^/]+)\/(.+)$/.exec(req.path);
    if (!tenantRoute) return undefined;
    const rest = tenantRoute[2] ?? '';
    const parts = rest.split('/').map(decodeURIComponent);

    if (rest === 'service-drafts' && req.method === 'GET')
      return req.json({
        data: [...drafts.entries()]
          .filter(([, d]) => !d.deleted)
          .sort(([, a], [, b]) => b.at.localeCompare(a.at))
          .map(([service, d]) => {
            const metadata = (d.definition.metadata ?? {}) as { name?: unknown };
            const spec = (d.definition.spec ?? {}) as {
              purpose?: unknown;
              output?: { kind?: unknown };
            };
            const published = options.published?.(service);
            return {
              id: service,
              name:
                typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : null,
              purpose: typeof spec.purpose === 'string' ? spec.purpose : '',
              outputKind: typeof spec.output?.kind === 'string' ? spec.output.kind : 'answer',
              latestVersion: published ? versionOf(published) : null,
              revision: d.revision,
              at: d.at,
              by: 'employee:ansattporten:kari',
              byName: 'Kari Nordmann',
            };
          }),
      });

    if (
      parts[0] === 'services' &&
      parts[1] &&
      parts[2] === 'draft' &&
      parts[3] === 'rebase' &&
      req.method === 'POST'
    ) {
      const service = parts[1];
      const found = drafts.get(service);
      if (!found || found.deleted) return req.notFound();
      const { merged, conflicts } = rebase(service, found);
      if (req.body<{ onlyIfClean?: boolean }>().onlyIfClean && conflicts.length > 0)
        return req.json({ draft: draftView(found, service), conflicts, applied: false });
      const saved: MockDraft = {
        ...found,
        base: options.published?.(service),
        definition: merged,
        revision: found.revision + 1,
        at: new Date().toISOString(),
        reason: req.reason ?? 'Utkast oppdatert',
      };
      drafts.set(service, saved);
      return req.json({ draft: draftView(saved, service), conflicts, applied: true });
    }
    if (example && rest === 'gates' && req.method === 'GET')
      return req.json({ data: exampleGates });

    if (
      example &&
      parts[0] === 'services' &&
      parts[1] &&
      parts[2] === 'draft' &&
      parts[3] === 'checks' &&
      parts.length === 4 &&
      req.method === 'GET'
    ) {
      const draft = drafts.get(parts[1]);
      if (!draft || draft.deleted) return req.notFound();
      const tested = runs.find(
        (r) =>
          r.service === parts[1] &&
          r.version === 'draft' &&
          r.status === 'completed' &&
          r.draftRevision === draft.revision,
      );
      const refused = (tested?.metrics?.refusal?.mean ?? 1) < 0.9;
      const subject = `draft-${parts[1]}-${draft.revision}`;
      const problems =
        tested && !refused
          ? []
          : [
              {
                path: 'spec.evaluation',
                message: tested
                  ? `refused by evaluation gates (avslag-uten-kilde); run the test sets with subject ${subject} first`
                  : `refused by evaluation gates (andel-bestatt, ingen-tilbakegang, avslag-uten-kilde); run the test sets with subject ${subject} first`,
              },
            ];
      return req.json({
        service: parts[1],
        revision: draft.revision,
        ready: problems.length === 0,
        problems,
      });
    }

    if (
      parts[0] === 'services' &&
      parts[1] &&
      parts[2] === 'eval-runs' &&
      parts[3] === 'compare' &&
      parts.length === 4 &&
      req.method === 'GET'
    ) {
      const service = parts[1];
      const q = req.url.searchParams;
      const own = runs.filter((r) => r.service === service);
      const candidate = own.find((r) => r.id === q.get('candidate'));
      if (!candidate) return req.notFound();
      const wanted = q.get('baseline');
      const published = versionOfService(service);
      const baseline =
        wanted && wanted !== 'published'
          ? own.find((r) => r.id === wanted)
          : own
              .filter(
                (r) =>
                  r.testSet === candidate.testSet &&
                  r.status === 'completed' &&
                  r.version === published &&
                  !r.selected,
              )
              .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
      if (!baseline) return req.notFound();
      if (baseline.testSet !== candidate.testSet)
        return req.json(
          {
            type: 'urn:genai:problem:eval-compare-invalid',
            title: 'Kjøringene kan ikke sammenlignes',
            status: 400,
            errors: [{ path: 'baseline', message: 'the runs are of different test sets' }],
          },
          400,
        );
      const set = sets.find((x) => x.id === candidate.testSet);
      const running = (r: typeof candidate) =>
        r.status === 'running' || r.status === 'waiting-for-scores';
      const outcome = (r: EvalCaseResult | undefined) =>
        r
          ? { pass: r.pass, score: r.pass ? 1 : 0, ...(r.reason ? { reason: r.reason } : {}) }
          : null;
      const rows = (set?.cases ?? []).flatMap((c) => {
        const b = baseline.cases.find((x) => x.caseId === c.id);
        const n = candidate.cases.find((x) => x.caseId === c.id);
        const change: CaseChange | undefined =
          b && n
            ? b.pass === n.pass
              ? 'same'
              : n.pass
                ? 'better'
                : 'worse'
            : n
              ? running(baseline)
                ? 'pending'
                : 'new'
              : b
                ? running(candidate)
                  ? 'pending'
                  : 'missing'
                : running(candidate) || running(baseline)
                  ? 'pending'
                  : undefined;
        return change
          ? [
              {
                case: c.id,
                input: c.input,
                type: c.type,
                split: c.split,
                change,
                baseline: outcome(b),
                candidate: outcome(n),
              },
            ]
          : [];
      });
      const counts = Object.fromEntries(
        (['better', 'worse', 'same', 'new', 'missing', 'pending'] as const).map((k) => [
          k,
          rows.filter((r) => r.change === k).length,
        ]),
      );
      const change = q.get('change');
      const matching = change ? rows.filter((r) => r.change === change) : rows;
      const limit = Number(q.get('limit') ?? 50);
      const offset = Number(q.get('offset') ?? 0);
      const side = (r: typeof candidate) => ({
        id: r.id,
        status: r.status,
        version: r.version,
        testSetVersion: 1,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        score: r.score ?? null,
        passed: r.cases.filter((x) => x.pass).length,
        cases: r.cases.length,
        judges: r.judges ?? [],
      });
      return req.json({
        testSet: candidate.testSet,
        baseline: { ...side(baseline), published: !wanted || wanted === 'published' },
        candidate: side(candidate),
        counts,
        data: matching.slice(offset, offset + limit),
        total: matching.length,
        offset,
        limit,
      });
    }

    if (
      parts[0] === 'services' &&
      parts[1] &&
      parts[2] === 'eval-runs' &&
      parts[3] &&
      parts[4] === 'cancel' &&
      parts.length === 5 &&
      req.method === 'POST'
    ) {
      if (!req.reason) return req.reasonMissing();
      const found = runs.find((r) => r.id === parts[3] && r.service === parts[1]);
      if (!found) return req.notFound();
      if (found.status === 'cancelled') return req.json({ id: found.id, status: 'cancelled' });
      if (found.status !== 'running' && found.status !== 'waiting-for-scores')
        return req.json(
          {
            type: 'urn:genai:problem:run-finished',
            title: 'Kjøringen er allerede ferdig',
            status: 409,
            errors: [{ path: 'status', message: `the run has already ended as ${found.status}` }],
          },
          409,
        );
      found.status = 'cancelled';
      found.endedAt = new Date().toISOString();
      delete found.current;
      delete found.endsAt;
      delete found.startedBy;
      delete found.startedByName;
      delete found.startedByYou;
      return req.json({ id: found.id, status: 'cancelled' });
    }

    if (parts[0] === 'services' && parts.length === 3 && parts[1]) {
      const service = parts[1];
      if (parts[2] === 'draft') {
        const found = drafts.get(service);
        const live = found && !found.deleted ? found : undefined;
        if (req.method === 'GET' && live && req.url.searchParams.get('rebase') === 'clean') {
          const behind = versionOf(live.base) < versionOf(options.published?.(service));
          if (!behind) return req.json({ ...draftView(live, service), behind, conflicts: [] });
          const { merged, conflicts } = rebase(service, live);
          if (conflicts.length > 0)
            return req.json({ ...draftView(live, service), behind, conflicts });
          const saved: MockDraft = {
            ...live,
            base: options.published?.(service),
            definition: merged,
            revision: live.revision + 1,
            at: new Date().toISOString(),
            reason: req.reason ?? 'Utkast oppdatert med publiserte endringer',
          };
          drafts.set(service, saved);
          return req.json({
            ...draftView(saved, service),
            behind: false,
            conflicts: [],
            rebasedFrom: versionOf(live.base),
          });
        }
        if (req.method === 'GET') return req.json(live ? draftView(live, service) : null);
        const body = req.body<{
          definition?: Record<string, unknown>;
          files?: Record<string, string>;
          revision?: number;
        }>();
        if (req.method === 'PUT') {
          if (!body.definition) return req.json({ title: 'Ugyldig forespørsel', status: 400 }, 400);
          const refused = writeDraft(service, body.revision, {
            definition: body.definition,
            files: body.files ?? {},
            deleted: false,
            reason: req.reason ?? 'Utkast lagret',
          });
          const saved = drafts.get(service);
          return refused ?? (saved ? req.json(draftView(saved, service)) : req.notFound());
        }
        if (req.method === 'DELETE') {
          if (!live) return req.notFound();
          const refused = writeDraft(service, body.revision, {
            ...live,
            deleted: true,
            reason: req.reason ?? 'Utkast slettet',
          });
          return refused ?? req.json({ revision: drafts.get(service)?.revision, deleted: true });
        }
      }
      if (parts[2] === 'test-sets' && req.method === 'GET')
        return req.json({
          data: sets
            .filter((s) => s.service === service)
            .map((s) => ({
              id: s.id,
              name: s.name,
              cases: s.cases.length,
              split: {
                locked: s.cases.filter((c) => c.split === 'locked').length,
                open: s.cases.filter((c) => c.split === 'open').length,
              },
            })),
        });
      if (parts[2] === 'eval-runs' && req.method === 'GET')
        return req.json({
          data: runs
            .filter((r) => r.service === service)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .map(summary),
        });
      if (parts[2] === 'eval-runs' && req.method === 'POST') {
        if (!req.reason) return req.reasonMissing();
        const body = req.body<{
          testSet?: string;
          version?: RunVersion;
          cases?: string[];
        }>();
        const set = sets.find((s) => s.id === body.testSet && s.service === service);
        if (!set) return req.notFound();
        // Like the API: a list of cases is non-empty and names only cases in the set.
        if (
          body.cases !== undefined &&
          (body.cases.length === 0 || body.cases.some((id) => !set.cases.some((c) => c.id === id)))
        )
          return req.json({ title: 'Ugyldig forespørsel', status: 400 }, 400);
        const cases = set.cases.filter((c) => !body.cases || body.cases.includes(c.id));
        const version = body.version ?? 'draft';
        const saved = drafts.get(service);
        if (version === 'draft' && (!saved || saved.deleted))
          return req.json({ title: 'Tjenesten har ikke noe lagret utkast', status: 404 }, 404);
        const run = {
          ...runOf(service, { ...set, cases }, version),
          ...(version === 'draft' && saved && !saved.deleted
            ? { draftRevision: saved.revision }
            : {}),
        };
        runs.unshift(run);
        return req.json({ id: run.id }, 202);
      }
      if (parts[2] === 'improvements' && req.method === 'GET')
        return req.json({
          data: improvements.filter((p) => p.service === service).map(strip),
        });
      if (parts[2] === 'improvements' && req.method === 'POST') {
        if (!req.reason) return req.reasonMissing();
        if (options.improveRefused)
          return req.json(
            {
              type: 'about:blank',
              title:
                'Tjenesten tillater ikke forslag til instruksjonene. Slå det på under Oppsett › Arbeidsmåte.',
              status: 409,
              errors: [{ path: 'spec.improve.allow', message: 'not allowed' }],
            },
            409,
          );
        const set = sets.find((s) => s.service === service);
        const total = set?.cases.length ?? 0;
        const proposal: Improvement & { service: string } = {
          id: newId('imp'),
          service,
          status: 'ready',
          change: {
            path: 'spec.instructions',
            before: 'Svar kort og vis til kildene.',
            after:
              'Svar kort og vis til kildene.\nBruk tall fra den nyeste rapporten når spørsmålet gjelder et bestemt år.',
          },
          scores: {
            testSet: set?.id ?? '',
            before: total ? (total - 1) / total : 0,
            after: total ? 1 : 0,
            passedBefore: Math.max(0, total - 1),
            passedAfter: total,
            total,
          },
          examples: [
            {
              input: 'Hvor mange tilsyn hadde vi i 2025?',
              before: 'Vi hadde 212 tilsyn (årsrapport 2023).',
              after: 'Vi hadde 238 tilsyn i 2025 (årsrapport 2025).',
            },
            {
              input: 'Hva var ventetiden på telefon i fjor?',
              before: 'Ventetiden var 6 minutter (2023).',
              after: 'Ventetiden var 4 minutter i 2025.',
            },
          ],
          reasons: ['Tre tilbakemeldinger sier at svaret bruker gamle tall.'],
          createdAt: new Date().toISOString(),
        };
        improvements.unshift(proposal);
        return req.json({ id: proposal.id }, 202);
      }
    }

    if (
      parts[0] === 'services' &&
      parts.length === 5 &&
      parts[2] === 'improvements' &&
      parts[4] === 'decision' &&
      req.method === 'POST'
    ) {
      if (!req.reason) return req.reasonMissing();
      const found = improvements.find((p) => p.id === parts[3] && p.service === parts[1]);
      if (!found) return req.notFound();
      const { approve } = req.body<{ approve?: boolean }>();
      found.status = approve ? 'approved' : 'rejected';
      found.decision = {
        approved: approve === true,
        at: new Date().toISOString(),
        reason: req.reason ?? '',
      };
      const service = parts[1] ?? '';
      const current = drafts.get(service);
      const base =
        current && !current.deleted
          ? { definition: current.definition, files: current.files }
          : (() => {
              const published = options.published?.(service);
              return published ? { definition: published, files: {} } : undefined;
            })();
      if (approve && base && found.change) {
        const definition = structuredClone(base.definition) as {
          spec?: { strategy?: { config?: Record<string, unknown> } };
        };
        const spec = (definition.spec ??= {});
        const strategy = (spec.strategy ??= {});
        strategy.config = { ...strategy.config, instructions: found.change.after };
        writeDraft(service, undefined, {
          definition: definition as Record<string, unknown>,
          files: base.files,
          deleted: false,
          reason: req.reason ?? 'Forbedringsforslag godkjent',
        });
      }
      return req.json(strip(found));
    }

    if (parts[0] === 'test-sets' && parts.length === 1 && req.method === 'POST') {
      if (!req.reason) return req.reasonMissing();
      const body = req.body<{ id?: string; name?: string; service?: string }>();
      if (!body.name?.trim() || !body.service)
        return req.json({ title: 'Testsettet mangler navn', status: 422, errors: [] }, 422);
      const id = body.id ?? '';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
        return req.json(
          {
            title: 'Ugyldig forespørsel',
            status: 400,
            errors: [{ path: 'id', message: 'ikke en gyldig id' }],
          },
          400,
        );
      if (sets.some((s) => s.id === id))
        return req.json({ title: 'Testsettet finnes allerede', status: 409, errors: [] }, 409);
      sets.push({ id, name: body.name.trim(), service: body.service, cases: [] });
      return req.json({ id, name: body.name.trim(), cases: 0 }, 201);
    }

    const caseSet =
      parts[0] === 'test-sets' && parts[2] === 'cases'
        ? sets.find((s) => s.id === parts[1])
        : undefined;
    if (caseSet) {
      if (parts.length === 3 && req.method === 'GET') return req.json({ data: caseSet.cases });
      if (parts.length === 3 && req.method === 'POST') {
        if (!req.reason) return req.reasonMissing();
        const body = req.body<NewServiceCase>();
        if (!body.input?.trim())
          return req.json({ title: 'Testtilfellet mangler input', status: 422, errors: [] }, 422);
        const { expected } = body;
        // The view shows one text, as the API's caseView does.
        const created: ServiceCase = {
          id: newId('tc'),
          ...body,
          expected:
            typeof expected === 'string'
              ? expected
              : body.type === 'criteria'
                ? (expected.criteria?.criteria ?? expected.referenceAnswer ?? '')
                : (expected.referenceAnswer ?? ''),
        };
        caseSet.cases.push(created);
        return req.json(created, 201);
      }
      if (parts.length === 4 && req.method === 'DELETE') {
        if (!req.reason) return req.reasonMissing();
        const at = caseSet.cases.findIndex((c) => c.id === parts[3]);
        if (at < 0) return req.notFound();
        caseSet.cases.splice(at, 1);
        return req.json({ ok: true });
      }
    }

    if (parts[0] === 'eval-runs' && parts.length === 2 && req.method === 'GET') {
      const found = runs.find((r) => r.id === parts[1]);
      if (!found) return req.notFound();
      return req.json(strip(found));
    }

    if (parts[0] === 'testcase-candidates' && parts.length === 1) {
      if (req.method === 'GET') {
        const service = req.url.searchParams.get('service');
        return req.json({
          data: candidates.filter((c) => !service || c.service === service).map(strip),
        });
      }
      if (req.method === 'POST') {
        if (!req.reason) return req.reasonMissing();
        const body = req.body<NewCandidate>();
        if (!body.input?.trim())
          return req.json({ title: 'Forslaget mangler input', status: 400, errors: [] }, 400);
        const created = {
          id: newId('fb'),
          service: body.service,
          input: body.input.trim(),
          ...(body.expected ? { expected: body.expected } : {}),
          origin: body.origin,
          status: 'pending-review',
          createdAt: new Date().toISOString(),
        };
        candidates.unshift(created);
        return req.json(strip(created), 201);
      }
    }

    if (
      parts[0] === 'testcase-candidates' &&
      parts.length === 3 &&
      parts[2] === 'review' &&
      req.method === 'POST'
    ) {
      if (!req.reason) return req.reasonMissing();
      const found = candidates.find((c) => c.id === parts[1]);
      if (!found) return req.notFound();
      const body = req.body<CandidateReview>();
      if (body.decision === 'accept') {
        const set = sets.find((s) => s.id === body.testSet);
        if (!set)
          return req.json(
            { title: 'Velg et testsett for testtilfellet', status: 400, errors: [] },
            400,
          );
        set.cases.push({
          id: newId('tc'),
          input: found.input,
          expected: body.expected ?? found.expected ?? '',
          type: body.type ?? 'criteria',
          split: 'open',
        });
      }
      found.status = body.decision === 'accept' ? 'accepted' : 'rejected';
      return req.json(strip(found));
    }

    return undefined;
  };
};
