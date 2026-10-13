import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import {
  InMemoryCandidateStore,
  InMemoryEvalRunStore,
  InMemoryFeedbackStore,
  InMemoryTestSetStore,
  parseTestSet,
  type FeedbackRecord,
  type TestCaseCandidate,
} from '@genai/eval';
import { KernelError, type Kernel } from '@genai/kernel';
import { InMemoryConnections } from '@genai/providers-mcp-client';
import type { Admin } from './admin.js';
import {
  InMemoryTenantSecrets,
  mountExtensions,
  TenantDirectory,
  TenantSecretVault,
} from './extensions.js';
import { digdir, other } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  per: { kind: 'employee', issuer: 'test', subject: 'per', tenant: digdir },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  nokkel: { kind: 'agency-system', issuer: 'legacy-key', subject: 'key-1', tenant: digdir },
};

const session = { id: 'support-1', operator: 'operator:test:drift', tenant: digdir };

const testSet = (id: string) =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant: digdir, id, name: id, version: 1 },
    spec: {
      service: 'svar',
      cases: [
        { id: 'c1', split: 'validation', input: 'Hei', expected: { referenceAnswer: 'Hei' } },
      ],
    },
  });

const tracked = [
  { task: 'a', tenant: digdir, status: 'running', at: '2026-10-12T10:00:00Z' },
  { task: 'b', tenant: digdir, status: 'failed', at: '2026-10-12T09:00:00Z' },
  { task: 'c', tenant: other, status: 'queued', at: '2026-10-12T11:00:00Z' },
];

const boot = async (options: { quotaExhausted?: boolean } = {}) => {
  const testSets = new InMemoryTestSetStore();
  await testSets.put(testSet('svar-sporsmal'));
  await testSets.put(testSet('annet-sett'));
  const candidates = new InMemoryCandidateStore();
  const feedback = new InMemoryFeedbackStore();
  const app = new Hono();
  const adminTasks: { action: string; target: string; stored: number }[] = [];
  const kernel = {
    task: async (principal: Principal, id: string) => {
      if (principal.subject !== 'kari') throw new KernelError('not_found', `task ${id} not found`);
      return { id, tenant: digdir, service: { capability: { id: `${digdir}/svar/default` } } };
    },
    annotate: async () => undefined,
  } as unknown as Kernel;
  mountExtensions(app, {
    admin: {
      supportSession: (id: string | undefined, operator: Principal, tenant: string) =>
        id === session.id && tenant === session.tenant && operator.subject === 'drift'
          ? session
          : undefined,
      supportSessions: () => [session],
      within: async (
        _principal: Principal,
        action: string,
        _data: unknown,
        work: () => Promise<{ value: unknown; target: string }>,
      ) => {
        const done = await work();
        adminTasks.push({
          action,
          target: done.target,
          stored: (await candidates.list(digdir)).length,
        });
        return { value: done.value, task: `oppgave-${adminTasks.length}` };
      },
      perform: async () => ({
        ok: false,
        task: 'oppgave-1',
        errors: [{ path: 'principal', message: 'mangler rett' }],
        problem: {
          type: 'about:blank',
          title: 'Du trenger rettigheten «Registrere byggeklosser»',
          status: 403,
          errors: [{ path: 'right', message: 'register-building-blocks' }],
        },
      }),
    } as unknown as Admin,
    authenticate: async (request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    vault: new TenantSecretVault(),
    connections: new InMemoryConnections(),
    directory: new TenantDirectory(),
    tasks: async () => tracked.filter((t) => t.status === 'queued' || t.status === 'running'),
    allTasks: async () => tracked,
    catalogSkips: [],
    eval: {
      kernel,
      evalCapability: 'platform/eval',
      testSets,
      runs: new InMemoryEvalRunStore(),
      feedback,
      candidates,
      quotaExhausted: async () => options.quotaExhausted ?? false,
    },
  });
  const call = async (
    path: string,
    body: unknown,
    who = 'kari',
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const read = async (path: string, who = 'kari', headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      headers: { authorization: `Bearer ${who}`, ...headers },
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const propose = (body: Record<string, unknown>, who = 'kari', headers = {}) =>
    call(
      `/tenants/${digdir}/testcase-candidates`,
      { task: 't1', question: 'Hei', ...body },
      who,
      headers,
    );
  return { app, testSets, candidates, feedback, call, read, propose, adminTasks };
};

describe('test-case candidates', () => {
  it('a candidate proposed by the assistant keeps its origin', async () => {
    const { candidates, propose } = await boot();

    const saved = await propose({ testSet: 'svar-sporsmal', origin: 'assistant' });
    const unknown = await propose({ testSet: 'svar-sporsmal', origin: 'noe-annet' });

    expect(saved.status).toBe(201);
    expect(await candidates.get(saved.body.id as string)).toMatchObject({
      origin: 'assistant',
      targetTestSet: 'svar-sporsmal',
    });
    expect(unknown.body).not.toHaveProperty('origin');
  });

  it('proposing and reviewing a test-case candidate are admin tasks that carry the write', async () => {
    const { adminTasks, call, propose } = await boot();

    const proposed = await propose({ testSet: 'svar-sporsmal' });
    await call(
      `/testcase-candidates/${String(proposed.body.id)}/review`,
      { decision: 'accept' },
      'per',
    );

    expect(adminTasks.map((t) => [t.action, t.target])).toEqual([
      ['platform.testcase.propose', `testcase-candidate:${String(proposed.body.id)}`],
      ['platform.testcase.review', `testcase-candidate:${String(proposed.body.id)}`],
    ]);
    expect(adminTasks[0]?.stored).toBe(1);
  });

  it('a candidate for a test set that does not exist is refused when it is proposed', async () => {
    const { propose } = await boot();

    const refused = await propose({ testSet: 'finnes-ikke', origin: 'assistant' });
    const named = await propose({ targetTestSet: 'finnes-ikke' });

    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([
      {
        path: 'testSet',
        message:
          'Testsettet «finnes-ikke» finnes ikke. Opprett testsettet før du foreslår testtilfeller til det.',
      },
    ]);
    expect(named.status).toBe(400);
  });

  it('reviewing a candidate without a test set uses the one chosen when it was proposed', async () => {
    const { testSets, call, propose } = await boot();
    const proposed = await propose({ targetTestSet: 'svar-sporsmal', origin: 'playground' });

    const reviewed = await call(
      `/testcase-candidates/${String(proposed.body.id)}/review`,
      { decision: 'accept' },
      'per',
    );

    expect(reviewed.status).toBe(200);
    expect((reviewed.body as unknown as TestCaseCandidate).testSet).toMatchObject({
      id: 'svar-sporsmal',
      version: 2,
    });
    expect((await testSets.get(digdir, 'svar-sporsmal'))?.spec.cases).toHaveLength(2);
  });

  it('a test set named at review wins over the one chosen when it was proposed', async () => {
    const { testSets, call, propose } = await boot();
    const proposed = await propose({ testSet: 'svar-sporsmal' });

    const reviewed = await call(
      `/testcase-candidates/${String(proposed.body.id)}/review`,
      { decision: 'accept', testSet: 'annet-sett' },
      'per',
    );

    expect(reviewed.status).toBe(200);
    expect((await testSets.get(digdir, 'annet-sett'))?.spec.cases).toHaveLength(2);
    expect((await testSets.get(digdir, 'svar-sporsmal'))?.spec.cases).toHaveLength(1);
  });
});

describe('tenant secrets', () => {
  it('the in-memory store lists the names of one tenant only', async () => {
    const store = new InMemoryTenantSecrets();
    await store.set(digdir, 'lovdata-token', 'hemmelig');
    await store.set(digdir, 'api-key', 'hemmelig');
    await store.set(other, 'annen', 'hemmelig');

    expect(await store.list(digdir)).toEqual(['api-key', 'lovdata-token']);
    expect(await new TenantSecretVault(store).names(other)).toEqual(['annen']);
  });
});

describe('tenant access', () => {
  it('a member without manage-services cannot propose test-case candidates', async () => {
    const { propose } = await boot();

    const refused = await propose({ testSet: 'svar-sporsmal' }, 'erik');

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ errors: [{ path: 'right', message: 'manage-services' }] });
  });

  it('a refused admin action answers with the named right, not a bare Forbidden', async () => {
    const { call } = await boot();

    const refused = await call(`/tenants/${digdir}/tool-connections`, { id: 'arkiv' }, 'kari', {
      'change-reason': 'Nytt verktøy',
    });

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      title: 'Du trenger rettigheten «Registrere byggeklosser»',
      errors: [{ path: 'right', message: 'register-building-blocks' }],
    });
  });

  it('an operator reaches tenant eval data only through a support session', async () => {
    const { propose, read, call } = await boot();
    const proposed = await propose({ testSet: 'svar-sporsmal' });
    const inSession = { 'support-session': session.id };

    expect((await propose({}, 'drift')).status).toBe(404);
    expect((await read(`/tenants/${digdir}/test-sets`, 'drift')).status).toBe(404);
    expect((await read(`/tenants/${digdir}/feedback`, 'drift')).status).toBe(404);
    expect((await read(`/tenants/${digdir}/tool-connections`, 'drift')).status).toBe(404);
    expect(
      (
        await call(
          `/testcase-candidates/${String(proposed.body.id)}/review`,
          { decision: 'reject' },
          'drift',
        )
      ).status,
    ).toBe(404);
    expect((await read(`/tenants/${digdir}/test-sets`, 'drift', inSession)).status).toBe(200);
  });

  it("an operator in a support session reads tenant data and may change it on the tenant's behalf", async () => {
    const { propose, read, call } = await boot();
    const proposed = await propose({ testSet: 'svar-sporsmal' });
    const inSession = { 'support-session': session.id };

    expect((await read(`/tenants/${digdir}/feedback`, 'drift', inSession)).status).toBe(200);
    expect((await read(`/tenants/${digdir}/tool-connections`, 'drift', inSession)).status).toBe(
      200,
    );
    expect((await propose({}, 'drift', inSession)).status).toBe(201);
    expect(
      (
        await call(
          `/testcase-candidates/${String(proposed.body.id)}/review`,
          { decision: 'reject' },
          'drift',
          inSession,
        )
      ).status,
    ).toBe(200);
  });

  it('an operator without a support session cannot reach tenant secrets and gets 404', async () => {
    const { app } = await boot();

    const res = await app.request(`/tenants/${digdir}/secrets/lovdata`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer drift',
        'content-type': 'application/json',
        'change-reason': 'Ny nøkkel til Lovdata',
      },
      body: JSON.stringify({ value: 'hemmelig' }),
    });

    expect(res.status).toBe(404);
  });
});

describe('feedback privacy', () => {
  const given = (i: number, rating: 'up' | 'down', comment = `kommentar ${i}`): FeedbackRecord => ({
    task: `t${i}`,
    rating,
    comment,
    by: { kind: 'employee', id: `test:ansatt-${i}` },
    at: `2026-10-07T08:1${i}:00.000Z`,
    tenant: digdir,
    capability: `${digdir}/svar/default`,
  });

  it('redacts the comment when feedback is given and never lists who gave it', async () => {
    const { call, read, feedback } = await boot();

    const saved = await call('/tasks/t1/feedback', {
      rating: 'down',
      comment: 'Ring Ola på 912 34 567, svaret var feil',
    });
    const [stored] = await feedback.list(digdir);
    const listed = await read(`/tenants/${digdir}/feedback?service=svar`);

    expect(saved.status).toBe(201);
    expect(stored?.comment).toBe('Ring Ola på [phone], svaret var feil');
    expect(JSON.stringify(listed.body)).not.toContain('kari');
    expect(listed.body).toEqual({ data: [{ rating: 'down', at: stored?.at.slice(0, 10) }] });
  });

  it('shows comments only for ratings given at least five times', async () => {
    const { read, feedback } = await boot();
    for (const i of [1, 2, 3, 4, 5]) await feedback.save(given(i, 'up'));
    await feedback.save(given(6, 'down', 'Per Hansen fikk feil svar'));

    const listed = (
      (await read(`/tenants/${digdir}/feedback?service=svar`)).body as {
        data: { rating: string; comment?: string; by?: unknown }[];
      }
    ).data;

    expect(listed).toHaveLength(6);
    expect(listed.filter((f) => f.rating === 'up' && f.comment)).toHaveLength(5);
    expect(listed.find((f) => f.rating === 'down')).toEqual({ rating: 'down', at: '2026-10-07' });
    expect(listed.some((f) => 'by' in f)).toBe(false);
  });

  it('tells an API key why it cannot give feedback on a run instead of answering not found', async () => {
    const { call } = await boot();

    const refused = await call('/api/feedback', { task: 't1', rating: 'up' }, 'nokkel');
    const stranger = await call('/tasks/t1/feedback', { rating: 'up' }, 'per');

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ title: 'Feedback is not available for this run' });
    expect(stranger.status).toBe(404);
  });
});

describe('test-case candidates for review', () => {
  const ola: Principal = { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other };
  people.ola = ola;

  it('keeps the reasons chosen with feedback, redacted', async () => {
    const { call, feedback } = await boot();

    await call('/tasks/t1/feedback', {
      rating: 'down',
      reasons: ['Feil svar', 'Ring 912 34 567', 3],
    });

    expect((await feedback.list(digdir))[0]?.reasons).toEqual(['Feil svar', 'Ring [phone]']);
  });

  it('saves a candidate from feedback without a task and lists it without person ids', async () => {
    const { call, read } = await boot();

    const saved = await call(`/tenants/${digdir}/testcase-candidates`, {
      service: 'svar',
      input: 'Kan Ola på 912 34 567 få svar?',
      expected: 'Ja',
      testSet: 'svar-sporsmal',
      origin: 'feedback',
    });
    const listed = await read(`/tenants/${digdir}/testcase-candidates?service=svar`);
    const elsewhere = await read(`/tenants/${digdir}/testcase-candidates?service=annen`);

    expect(saved.status).toBe(201);
    expect(listed.body).toEqual({
      data: [
        {
          id: saved.body.id,
          input: 'Kan Ola på [phone] få svar?',
          expected: 'Ja',
          origin: 'feedback',
          status: 'new',
          createdAt: expect.any(String),
          service: 'svar',
          testSet: 'svar-sporsmal',
        },
      ],
    });
    expect(JSON.stringify([saved.body, listed.body])).not.toMatch(/kari|proposedBy/);
    expect(elsewhere.body).toEqual({ data: [] });
  });

  it('the person who proposed a case can accept it, which adds it with its type to the test set', async () => {
    const { call, testSets } = await boot();
    const saved = await call(`/tenants/${digdir}/testcase-candidates`, {
      service: 'svar',
      input: 'Hva koster det?',
      testSet: 'svar-sporsmal',
      origin: 'playground',
    });

    const reviewed = await call(
      `/tenants/${digdir}/testcase-candidates/${String(saved.body.id)}/review`,
      { decision: 'accept', expected: 'gratis', type: 'exact' },
    );

    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      status: 'accepted',
      case: { id: saved.body.id, input: 'Hva koster det?', expected: 'gratis', type: 'exact' },
    });
    expect(JSON.stringify(reviewed.body)).not.toMatch(/kari|per|reviewedBy/);
    expect((await testSets.get(digdir, 'svar-sporsmal'))?.spec.cases).toHaveLength(2);
  });

  it('another tenant cannot list or review the candidates', async () => {
    const { call, read } = await boot();
    const saved = await call(`/tenants/${digdir}/testcase-candidates`, {
      service: 'svar',
      input: 'Hei',
      testSet: 'svar-sporsmal',
    });

    expect((await read(`/tenants/${digdir}/testcase-candidates`, 'ola')).status).toBe(404);
    expect(
      (
        await call(
          `/tenants/${other}/testcase-candidates/${String(saved.body.id)}/review`,
          { decision: 'reject' },
          'ola',
        )
      ).status,
    ).toBe(404);
  });

  it('an operator in a support session can read and review candidates', async () => {
    const { call, read } = await boot();
    const saved = await call(`/tenants/${digdir}/testcase-candidates`, {
      service: 'svar',
      input: 'Hei',
      testSet: 'svar-sporsmal',
    });
    const inSession = { 'support-session': session.id };

    expect((await read(`/tenants/${digdir}/testcase-candidates`, 'drift', inSession)).status).toBe(
      200,
    );
    expect(
      (
        await call(
          `/tenants/${digdir}/testcase-candidates/${String(saved.body.id)}/review`,
          { decision: 'reject' },
          'drift',
          inSession,
        )
      ).status,
    ).toBe(200);
  });
});

describe('eval runs and the monthly token quota', () => {
  it('refuses to start an eval run with 409 when the month is used up', async () => {
    const { call } = await boot({ quotaExhausted: true });

    const res = await call(`/tenants/${digdir}/eval-runs`, { service: 'svar' });

    expect(res.status).toBe(409);
    expect(res.body.errors).toEqual([expect.objectContaining({ path: 'quota' })]);
  });
});

describe('lists and statuses', () => {
  it('answers test sets, eval runs and feedback as an object holding data', async () => {
    const { read } = await boot();

    for (const list of ['test-sets', 'eval-runs', 'feedback'])
      expect((await read(`/tenants/${digdir}/${list}`)).body).toEqual({
        data: expect.any(Array),
      });
  });

  it('filters operator tasks on any task status and refuses an unknown status with 400', async () => {
    const { read } = await boot();
    const ids = async (query: string) =>
      (
        (await read(`/operator/tasks${query}`, 'drift')).body as { data: { task: string }[] }
      ).data.map((t) => t.task);

    expect(await ids('')).toEqual(['a', 'c']);
    expect(await ids('?status=running')).toEqual(['a', 'c']);
    expect(await ids('?status=failed')).toEqual(['b']);
    expect(await ids('?status=completed')).toEqual([]);
    expect((await read('/operator/tasks?status=ferdig', 'drift')).status).toBe(400);
  });

  it('refuses to start an eval run without capability, test set, evaluators and provenance with 400', async () => {
    const { call } = await boot();

    const res = await call(`/tenants/${digdir}/eval-runs`, {}, 'kari');

    expect(res.status).toBe(400);
    expect((res.body.errors as { path: string }[]).map((e) => e.path)).toEqual([
      'capability',
      'testSet',
      'evaluators',
      'provenance',
    ]);
  });
});
