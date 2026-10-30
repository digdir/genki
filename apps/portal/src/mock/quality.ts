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
import { changedPaths, setAt, valueAt } from '../definition-path';
import type { MockHandler } from '../mock';

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
}

interface MockDraft {
  base: Record<string, unknown> | undefined;
  revision: number;
  definition: Record<string, unknown>;
  files: Record<string, string>;
  deleted: boolean;
  at: string;
  reason: string;
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
  const sets = structuredClone(options.sets ?? exampleQualitySets());
  const runs = structuredClone(options.runs ?? []);
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
      },
    ]),
  );
  const versionOf = (definition: Record<string, unknown> | undefined) =>
    (definition?.metadata as { version?: number } | undefined)?.version ?? 0;
  const ignored = ['metadata.version'];
  const draftView = (d: MockDraft, service: string) => ({
    revision: d.revision,
    definition: d.definition,
    files: d.files,
    at: d.at,
    reason: d.reason,
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
    next: Omit<MockDraft, 'revision' | 'at' | 'base'> & { base?: MockDraft['base'] },
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
    };
    drafts.set(service, saved);
    return undefined;
  };
  let next = 1;
  const newId = (prefix: string) => `${prefix}-${String(next++).padStart(3, '0')}`;

  const runOf = (service: string, set: MockSet, version: RunVersion) => {
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
      status: stay ? 'running' : 'succeeded',
      testSet: set.id,
      version,
      startedAt: now,
      endedAt: stay ? null : now,
      score: stay ? null : total ? passed / total : 0,
      passed: stay ? null : passed,
      total: stay ? null : total,
      cost: null,
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
        const body = req.body<{ testSet?: string; version?: RunVersion }>();
        const set = sets.find((s) => s.id === body.testSet && s.service === service);
        if (!set) return req.notFound();
        const run = runOf(service, set, body.version ?? 'draft');
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
              : (expected.criteria?.criteria ?? expected.referenceAnswer ?? ''),
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
