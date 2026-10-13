import type {
  SkillAssistantIntent,
  SkillAssistantRejection,
  SkillAssistantRequest,
  SkillAssistantTurn,
  SkillDefinition,
  SkillDetailResponse,
  SkillPublisher,
  SkillPublishResponse,
  SkillRequirement,
  SkillShareResponse,
  SkillSummaryResponse,
  SkillTestRunResponse,
  SkillUsageResponse,
  SkillVersionResponse,
} from '../api/skills';
import {
  assistantProposal,
  blankSpec,
  digdirTenant,
  exampleSkillRecords,
  exampleSkillTools,
  ownTenant,
  refName,
  refVersion,
  type ProposalSection,
  type SkillRecord,
} from '../data/skills';
import type { MockHandler, MockRequest } from '../mock';

export interface SkillsMockOptions {
  skills?: SkillRecord[];
  failing?: boolean;
  defaultPassThreshold?: number;
  assistant?: { status?: SkillAssistantTurn['status']; rejected?: SkillAssistantRejection[] };
}

const dailyBudget = 200_000;

const sectionOf: Record<SkillAssistantIntent, ProposalSection> = {
  'suggest-description': 'description',
  'suggest-instructions': 'instructions',
  'suggest-examples': 'examples',
  'fix-instructions': 'instructions',
};

const assistantTurn = (
  id: string,
  body: SkillAssistantRequest,
  fallback: SkillDefinition,
  options: NonNullable<SkillsMockOptions['assistant']>,
): SkillAssistantTurn => {
  const status = options.status ?? 'completed';
  const turnId = `turn-${Date.now()}`;
  const spent = status === 'budget_exhausted' ? dailyBudget : 1_200;
  const usage = {
    tokens: status === 'completed' ? 1_200 : 0,
    budgetLeftToday: dailyBudget - spent,
    dailyBudget,
  };
  if (status !== 'completed')
    return {
      turnId,
      status,
      message:
        status === 'refused'
          ? 'Jeg kan ikke foreslå dette for ferdigheten.'
          : status === 'unavailable'
            ? 'Modellen svarer ikke akkurat nå.'
            : 'Dagens kvote for assistenten er brukt opp.',
      proposals: [],
      usage,
    };
  const draft = typeof body.draft.definition === 'string' ? fallback : body.draft.definition;
  const section = sectionOf[body.intent];
  const fix = body.intent === 'fix-instructions';
  const proposal = assistantProposal(id, section, draft.spec, draft.metadata.name ?? '', fix);
  const spec = proposal.patch(draft.spec, draft.metadata.name ?? '');
  return {
    turnId,
    status,
    message: proposal.detail,
    proposals: [
      {
        id: `${turnId}-1`,
        level: 1,
        kind: 'change',
        title: proposal.title,
        detail: proposal.detail,
        section,
        patch: [{ op: 'replace', path: `/spec/${section}`, value: spec[section] }],
        after: { ...draft, spec },
        validation: { ok: true },
        requiresApproval: false,
        appliedToDraft: false,
      },
    ],
    ...(options.rejected ? { rejected: options.rejected } : {}),
    usage,
  };
};

const actor = 'Kari Nordmann';
const slugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const reservedIds = ['import', 'imports'];

const latestOf = (r: SkillRecord) => r.versions.at(-1)?.version ?? null;

const contentOf = (d: SkillDefinition | undefined) =>
  d ? JSON.stringify({ name: d.metadata.name ?? null, spec: d.spec }) : undefined;

const problem = (req: MockRequest, status: number, title: string, path?: string) =>
  req.json(
    {
      type: 'about:blank',
      title,
      status,
      errors: path ? [{ path, message: title }] : [],
    },
    status,
  );

export const skillsMock = (options: SkillsMockOptions = {}): MockHandler => {
  const failing = options.failing ?? false;
  const defaultThreshold = options.defaultPassThreshold ?? 0.9;
  const records = structuredClone(options.skills ?? exampleSkillRecords());

  const thresholdOf = (r: SkillRecord) => r.draft.spec.testset.passThreshold ?? defaultThreshold;

  const runOf = (r: SkillRecord): SkillTestRunResponse => {
    const instructions = r.draft.spec.instructions.toLowerCase();
    const at = new Date().toISOString();
    const cases = r.draft.spec.testset.cases.map((c, index) => {
      const failure = r.failures[c.input];
      const fails = failing && failure && !instructions.includes(failure.unless);
      return {
        index,
        input: c.input,
        expected: c.expected,
        type: c.type,
        passed: !fails,
        answer: fails ? 'Utkast som mangler noe.' : 'Utkast som oppfyller kravet.',
        score: fails ? 0 : 1,
        ...(fails ? { reason: failure.reason } : {}),
        costNok: 0.02,
      };
    });
    const passed = cases.filter((c) => c.passed).length;
    return {
      id: r.runs.length + 1,
      skill: r.id,
      draftRevision: r.revision,
      startedAt: at,
      endedAt: at,
      by: actor,
      model: 'foundry-openai/gpt-4o-2m-tps',
      judge: cases.some((c) => c.type === 'criteria') ? 'foundry-openai/gpt-41-dommer' : null,
      passed,
      total: cases.length,
      passRate: cases.length ? passed / cases.length : 0,
      threshold: thresholdOf(r),
      costNok: cases.length * 0.02,
      cases,
    };
  };

  if (failing) {
    const vedtak = records.find((r) => r.id === 'skrive-vedtaksbrev');
    if (vedtak) vedtak.runs.push(runOf(vedtak));
  }

  const publisherOf = (owner: string): SkillPublisher => ({
    type: owner === ownTenant ? 'own' : owner === digdirTenant ? 'digdir' : 'shared',
    name: owner,
  });

  const requirementsOf = (r: SkillRecord) => {
    const threshold = thresholdOf(r);
    const current = r.runs.filter((run) => run.draftRevision === r.revision).at(-1);
    const leaked = current?.cases.filter((c) => c.type === 'must_reject' && !c.passed) ?? [];
    const unpublished = r.draft.spec.tools.filter((ref) => {
      const tool = exampleSkillTools.find((t) => t.id === refName(ref));
      return !tool?.versions.includes(refVersion(ref));
    });
    const notRun =
      r.draft.spec.testset.cases.length === 0
        ? ('no_cases' as const)
        : r.runs.length
          ? ('stale' as const)
          : ('not_run' as const);
    const requirements: SkillRequirement[] = [
      {
        id: 'tested-on-draft',
        label: 'Testsettet har kjørt på utkastet',
        met: Boolean(current),
        ...(current
          ? {}
          : { detail: 'Kjør testsettet på denne versjonen av utkastet.', reason: notRun }),
      },
      {
        id: 'pass-rate',
        label: `Minst ${Math.round(threshold * 100)} prosent av testtilfellene består`,
        met: Boolean(current && current.passRate >= threshold),
        threshold,
        ...(current
          ? {
              detail: `${current.passed} av ${current.total} bestått`,
              passedCases: current.passed,
              total: current.total,
            }
          : { detail: 'Ingen testkjøring på utkastet.' }),
      },
      {
        id: 'must-reject',
        label: 'Alle tilfeller som skal avvises, blir avvist',
        met: Boolean(current) && leaked.length === 0,
        ...(leaked.length ? { detail: `${leaked.length} tilfeller ble ikke avvist` } : {}),
      },
      {
        id: 'published-tools',
        label: 'Verktøyene peker på publiserte versjoner',
        met: unpublished.length === 0,
        ...(unpublished.length
          ? { detail: unpublished.join(', '), unpublishedTools: unpublished }
          : {}),
      },
    ];
    return { threshold, requirements, current };
  };

  const summary = (viewer: string, r: SkillRecord): SkillSummaryResponse => {
    const own = r.owner === viewer;
    const latest = latestOf(r);
    const shown = r.published ?? r.draft;
    return {
      id: r.id,
      owner: r.owner,
      name: shown.metadata.name ?? r.id,
      description: shown.spec.description,
      version: latest,
      draftRevision: own ? r.revision : null,
      hasChanges: own && contentOf(r.draft) !== contentOf(r.published),
      status: latest ? 'published' : 'draft',
      share: r.share,
      sharedWith: new Set(r.usedBy.map((u) => u.tenant).filter((t) => t !== r.owner)).size,
      publisher: publisherOf(r.owner),
      usedBy: r.usedBy.length,
      services: r.usedBy
        .filter((u) => u.tenant === viewer)
        .map((u) => ({ service: u.service, name: u.name, version: u.version })),
      readOnly: !own,
    };
  };

  const detail = (viewer: string, r: SkillRecord): SkillDetailResponse => {
    const own = r.owner === viewer;
    const gates = requirementsOf(r);
    const lastTestRun = own ? (r.runs.at(-1) ?? null) : null;
    const shown = own ? r.draft : (r.published ?? r.draft);
    return {
      ...summary(viewer, r),
      draft: own
        ? {
            revision: r.revision,
            definition: r.draft,
            by: actor,
            at: '2026-10-06T09:00:00+02:00',
            reason: 'Utkast lagret',
            problems: [],
          }
        : null,
      published: r.published ?? null,
      versions: r.versions,
      lastTestRun,
      stale: Boolean(lastTestRun && lastTestRun.draftRevision !== r.revision),
      threshold: gates.threshold,
      requirements: gates.requirements,
      shareRequest: own ? (r.shareRequest ?? null) : null,
      attachmentSizes: Object.fromEntries(
        shown.spec.attachments
          .filter((a) => r.attachmentSizes[a.blob] !== undefined)
          .map((a) => [a.blob, r.attachmentSizes[a.blob] ?? 0]),
      ),
    };
  };

  const newRecord = (id: string, draft: SkillDefinition, extra: Partial<SkillRecord> = {}) => {
    const record: SkillRecord = {
      id,
      owner: ownTenant,
      draft,
      revision: 1,
      versions: [],
      usedBy: [],
      share: 'none',
      runs: [],
      attachmentSizes: {},
      failures: {},
      ...extra,
    };
    records.unshift(record);
    return record;
  };

  const blank = (id: string, name: string): SkillDefinition => ({
    apiVersion: 'genai/v1',
    kind: 'Skill',
    metadata: { tenant: ownTenant, id, name },
    spec: blankSpec(),
  });

  const fixes = new Map<string, { skill: string; after: string }>();

  const visible = (viewer: string, r: SkillRecord) => r.owner === viewer || r.share === 'shared';
  const ownRecord = (viewer: string, id: string) =>
    records.find((r) => r.owner === viewer && r.id === id);

  return (req) => {
    const turn = /^\/tenants\/([^/]+)\/skills\/([^/]+)\/assistant\/turns$/.exec(req.path);
    if (turn && req.method === 'POST') {
      const tenant = decodeURIComponent(turn[1] ?? '');
      const record = ownRecord(tenant, decodeURIComponent(turn[2] ?? ''));
      if (!record) return req.notFound();
      return req.json(
        assistantTurn(
          record.id,
          req.body<SkillAssistantRequest>(),
          record.draft,
          options.assistant ?? {},
        ),
      );
    }
    const fixRoute = /^\/tenants\/([^/]+)\/skills\/([^/]+)\/fix(?:\/([^/]+)\/apply)?$/.exec(
      req.path,
    );
    if (fixRoute && req.method === 'POST') {
      const record = ownRecord(
        decodeURIComponent(fixRoute[1] ?? ''),
        decodeURIComponent(fixRoute[2] ?? ''),
      );
      if (!record) return req.notFound();
      if (!fixRoute[3]) {
        const spec = record.draft.spec;
        const name = record.draft.metadata.name ?? '';
        const after = assistantProposal(record.id, 'instructions', spec, name, true).patch(
          spec,
          name,
        ).instructions;
        const fixId = `fix-${fixes.size + 1}`;
        fixes.set(fixId, { skill: record.id, after });
        return req.json({ fixId, before: spec.instructions, after });
      }
      const fix = fixes.get(decodeURIComponent(fixRoute[3]));
      if (!fix || fix.skill !== record.id) return req.notFound();
      if (!req.reason) return req.reasonMissing();
      record.draft = {
        ...record.draft,
        spec: { ...record.draft.spec, instructions: fix.after },
      };
      record.revision += 1;
      fixes.delete(decodeURIComponent(fixRoute[3]));
      return req.json(detail(record.owner, record));
    }
    const caseRoute = /^\/tenants\/([^/]+)\/skills\/([^/]+)\/testcases\/(\d+)$/.exec(req.path);
    if (caseRoute && req.method === 'DELETE') {
      const record = ownRecord(
        decodeURIComponent(caseRoute[1] ?? ''),
        decodeURIComponent(caseRoute[2] ?? ''),
      );
      if (!record) return req.notFound();
      const expected = new Headers(req.init?.headers).get('if-match')?.replace(/"/g, '');
      if (expected && Number(expected) !== record.revision)
        return problem(req, 409, 'Conflict', 'if-match');
      const index = Number(caseRoute[3]);
      const cases = record.draft.spec.testset.cases;
      if (index >= cases.length) return req.notFound();
      record.draft = {
        ...record.draft,
        spec: {
          ...record.draft.spec,
          testset: { ...record.draft.spec.testset, cases: cases.filter((_, i) => i !== index) },
        },
      };
      record.revision += 1;
      return req.json(detail(record.owner, record));
    }
    const tools = /^\/tenants\/([^/]+)\/skill-tools$/.exec(req.path);
    if (tools && req.method === 'GET') return req.json({ data: exampleSkillTools });
    const match = /^\/tenants\/([^/]+)\/skills(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(req.path);
    if (!match) return undefined;
    const [, rawTenant = '', rawId, sub] = match;
    const tenant = decodeURIComponent(rawTenant);
    const id = rawId ? decodeURIComponent(rawId) : undefined;

    if (!id) {
      if (req.method === 'GET')
        return req.json({
          data: records.filter((r) => visible(tenant, r)).map((r) => summary(tenant, r)),
        });
      if (req.method === 'POST') {
        const data = req.body<{ id?: string; name?: string }>();
        const newId = data.id ?? '';
        if (!slugPattern.test(newId) || reservedIds.includes(newId))
          return problem(req, 422, 'Invalid skill', 'id');
        if (ownRecord(tenant, newId)) return problem(req, 409, 'Conflict', 'id');
        return req.json(detail(tenant, newRecord(newId, blank(newId, data.name ?? ''))), 201);
      }
      return req.notFound();
    }

    if (id === 'import' && !sub && req.method === 'POST') {
      const pkg = req.body<{ fileName: string; contentBase64: string }>();
      const words = pkg.fileName.replace(/\.(zip|skill)$/i, '').replace(/[-_]+/g, ' ');
      const name = words.charAt(0).toUpperCase() + words.slice(1);
      const newId = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      if (ownRecord(tenant, newId)) return problem(req, 409, 'Conflict', 'id');
      const draft = blank(newId, name);
      draft.spec.description = `Importert fra ${pkg.fileName}.`;
      draft.spec.instructions = `# ${name}\n\nInstruksjonene fra SKILL.md i pakken.`;
      draft.spec.attachments = [{ name: 'ordliste.txt', blob: `skills/${newId}/ordliste.txt` }];
      const record = newRecord(newId, draft, {
        attachmentSizes: { [`skills/${newId}/ordliste.txt`]: 3_000 },
      });
      return req.json(detail(tenant, record), 201);
    }

    if (sub === 'copy' && req.method === 'POST') {
      const data = req.body<{ owner?: string; version?: number; id?: string }>();
      const source = records.find((r) => r.owner === (data.owner ?? tenant) && r.id === id);
      if (!source?.published || !visible(tenant, source)) return req.notFound();
      const newId = data.id ?? id;
      if (!slugPattern.test(newId) || reservedIds.includes(newId))
        return problem(req, 422, 'Invalid skill', 'id');
      if (ownRecord(tenant, newId)) return problem(req, 409, 'Conflict', 'id');
      const draft = structuredClone(source.published);
      draft.metadata = {
        tenant,
        id: newId,
        ...(source.published.metadata.name ? { name: source.published.metadata.name } : {}),
      };
      const copy = newRecord(newId, draft, { attachmentSizes: { ...source.attachmentSizes } });
      return req.json(detail(tenant, copy), 201);
    }

    const owner = req.url.searchParams.get('owner') ?? tenant;
    const record = records.find((r) => r.owner === owner && r.id === id);
    if (!record || !visible(tenant, record)) return req.notFound();
    const own = record.owner === tenant;

    if (!sub && req.method === 'GET') return req.json(detail(tenant, record));

    if (sub === 'versions' && req.method === 'GET') return req.json({ data: record.versions });

    if (sub === 'usage' && req.method === 'GET') {
      const usage: SkillUsageResponse = {
        latestVersion: latestOf(record),
        usedBy: own ? record.usedBy : record.usedBy.filter((u) => u.tenant === tenant),
      };
      return req.json(usage);
    }

    if (sub === 'export' && req.method === 'GET')
      return req.json({ fileName: `${record.id}.zip`, contentBase64: btoa('PK mock') });

    if (!own) return req.notFound();

    if (!sub && req.method === 'PUT') {
      const expected = new Headers(req.init?.headers).get('if-match')?.replace(/"/g, '');
      if (expected && Number(expected) !== record.revision)
        return problem(req, 409, 'Conflict', 'if-match');
      const { definition } = req.body<{ definition: SkillDefinition }>();
      record.draft = {
        ...structuredClone(definition),
        apiVersion: 'genai/v1',
        kind: 'Skill',
        metadata: { ...definition.metadata, tenant, id: record.id },
      };
      record.revision += 1;
      return req.json(detail(tenant, record));
    }

    if (sub === 'test-runs' && req.method === 'GET')
      return req.json({ data: [...record.runs].reverse() });

    if (sub === 'test-runs' && req.method === 'POST') {
      if (record.draft.spec.testset.cases.length === 0)
        return problem(req, 422, 'The test set cannot run', 'spec.testset.cases');
      const run = runOf(record);
      record.runs.push(run);
      return req.json(run);
    }

    if (sub === 'requirements' && req.method === 'GET') {
      const { threshold, requirements } = requirementsOf(record);
      return req.json({ threshold, requirements });
    }

    if (sub === 'publish' && req.method === 'POST') {
      if (!req.reason) return req.reasonMissing();
      if (record.published && contentOf(record.draft) === contentOf(record.published))
        return problem(req, 409, 'Ingen endringer å publisere');
      const gates = requirementsOf(record);
      if (gates.requirements.some((r) => !r.met))
        return req.json(
          { ok: false, requirements: gates.requirements } satisfies SkillPublishResponse,
          422,
        );
      const next = (latestOf(record) ?? 0) + 1;
      const run = gates.current;
      const published: SkillVersionResponse = {
        version: next,
        publishedAt: new Date().toISOString(),
        by: actor,
        reason: req.reason,
        score: run ? run.passRate : null,
        ...(run ? { passed: run.passed, total: run.total } : {}),
      };
      record.versions.push(published);
      record.published = structuredClone({
        ...record.draft,
        metadata: { ...record.draft.metadata, version: next },
      });
      record.draft = structuredClone(record.published);
      return req.json({
        ok: true,
        version: next,
        publishedAt: published.publishedAt,
        task: `task-publish-${record.id}-${next}`,
        requirements: gates.requirements,
      } satisfies SkillPublishResponse);
    }

    if (sub === 'share' && req.method === 'POST') {
      const data = req.body<{ confirm?: boolean }>();
      if (data.confirm !== true)
        return problem(req, 422, 'Bekreft at ferdigheten ikke inneholder personopplysninger');
      if (!req.reason) return req.reasonMissing();
      const latest = latestOf(record);
      if (!latest) return problem(req, 422, 'Publiser ferdigheten før du deler den', 'version');
      if (record.share !== 'none') return problem(req, 409, 'Conflict', 'share');
      record.share = 'pending_digdir';
      const share: SkillShareResponse = {
        id: `${tenant}-${record.id}`,
        tenant,
        skill: record.id,
        version: latest,
        state: 'pending_digdir',
        by: actor,
        at: new Date().toISOString(),
        reason: req.reason,
      };
      record.shareRequest = share;
      return req.json(share, 202);
    }

    if (sub === 'share' && req.method === 'DELETE') {
      if (record.share === 'none' || !record.shareRequest) return req.notFound();
      record.share = 'none';
      record.shareRequest = {
        ...record.shareRequest,
        state: 'none',
        by: actor,
        at: new Date().toISOString(),
        reason: req.reason ?? 'Trakk tilbake delingen',
      };
      return req.json(record.shareRequest);
    }

    if (sub === 'attachments' && req.method === 'POST') {
      const { name, contentBase64 } = req.body<{ name: string; contentBase64: string }>();
      const blob = `skills/${record.id}/${name.replace(/[^A-Za-z0-9æøåÆØÅ._-]+/g, '-')}`;
      const size = atob(contentBase64).length;
      record.attachmentSizes[blob] = size;
      return req.json({ name, blob, size }, 201);
    }

    return req.notFound();
  };
};
