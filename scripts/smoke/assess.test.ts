import { describe, expect, it } from 'vitest';
import {
  assessCompletion,
  assessFacets,
  assessHealth,
  assessModels,
  assessOpenapi,
  assessPage,
  assessStream,
  assessTimeline,
  Budget,
  clip,
  costOf,
  isTransient,
  outcomeOf,
  overallOutcome,
  parseSse,
  runModelCheck,
  tiersToRun,
  type CheckResult,
  type HttpResult,
  type ModelCheckDeps,
  type Tier,
  type Verdict,
} from './assess.ts';

const sha = '96305c019aafa0db6f985cea5e6499a7f0fee357';
const allTiers: Tier[] = ['free', 'cheap', 'core'];

const http = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResult => ({
  status,
  headers,
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

const mini = 'foundry-openai/gpt-5.4-mini';

const completion = (over: Record<string, unknown> = {}) => ({
  choices: [{ message: { role: 'assistant', content: 'Svar [1].' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
  sources: [{ index: 1, title: 'Rapport' }, { title: 'Annen' }],
  ...over,
});

const sse = (...frames: unknown[]) =>
  [...frames.map((f) => `data: ${JSON.stringify(f)}`), 'data: [DONE]', ''].join('\n\n');

const check = (over: Partial<CheckResult>): CheckResult => ({
  id: 'x',
  tier: 'free',
  outcome: 'pass',
  detail: '',
  attempts: 1,
  tasks: [],
  ...over,
});

describe('health', () => {
  it('passes when /health reports the deployed SHA', () => {
    const v = assessHealth(http(200, { status: 'ok', version: sha, lockdown: true }), sha);
    expect(v).toMatchObject({
      ok: true,
      version: sha,
      lockdown: true,
      detail: '96305c01, lockdown',
    });
  });

  it('fails when /health reports another SHA than the one deployed', () => {
    const v = assessHealth(http(200, { status: 'ok', version: 'a'.repeat(40) }), sha);
    expect(v).toMatchObject({ ok: false, detail: '/health reports aaaaaaaa, expected 96305c01' });
  });

  it('takes whatever SHA /health reports when none is expected', () => {
    expect(assessHealth(http(200, { status: 'ok', version: sha }), undefined).ok).toBe(true);
  });

  it('fails when /health reports a version that is not a commit', () => {
    expect(assessHealth(http(200, { status: 'ok', version: 'bootstrap' }), undefined).ok).toBe(
      false,
    );
  });

  it('fails when /health does not answer 200 ok', () => {
    expect(assessHealth(http(503, 'down'), sha)).toMatchObject({
      ok: false,
      detail: '/health answered 503',
    });
  });
});

describe('OpenAPI and pages', () => {
  it('passes an OpenAPI document with the same version and the completions route', () => {
    const doc = { info: { version: sha }, paths: { '/v1/chat/completions': {}, '/health': {} } };
    expect(assessOpenapi(http(200, doc), sha)).toEqual({ ok: true, detail: '2 routes' });
  });

  it('fails when the OpenAPI document has another version than /health', () => {
    const doc = { info: { version: 'b'.repeat(40) }, paths: { '/v1/chat/completions': {} } };
    expect(assessOpenapi(http(200, doc), sha).ok).toBe(false);
  });

  it('fails when the OpenAPI document lacks the route the smoke test calls', () => {
    expect(assessOpenapi(http(200, { info: { version: sha }, paths: {} }), sha).ok).toBe(false);
  });

  it('fails when the OpenAPI document does not answer', () => {
    expect(assessOpenapi(http(500, ''), sha).ok).toBe(false);
  });

  it('passes a page only on 200', () => {
    expect(assessPage(http(200, '<html>')).ok).toBe(true);
    expect(assessPage(http(302, '')).ok).toBe(false);
  });
});

describe('models', () => {
  const rows = (ids: string[], extra: Record<string, unknown> = {}) => ({
    data: ids.map((id) => ({
      id,
      _datasets: [{ tenant: '312521172', 'dataset-config-key': 'kudos' }],
      ...extra,
    })),
  });

  it('passes when the key sees every variant, and reads the first variant’s dataset', () => {
    const v = assessModels(http(200, rows(['smoke__default', 'smoke__retrieve-only'])), 'smoke', [
      'default',
      'retrieve-only',
    ]);
    expect(v).toMatchObject({ ok: true, dataset: { tenant: '312521172', key: 'kudos' } });
  });

  it('names a variant the key does not see', () => {
    const v = assessModels(http(200, rows(['smoke__default'])), 'smoke', ['default', 'model-x']);
    expect(v).toMatchObject({ ok: false, detail: 'missing smoke__model-x' });
  });

  it('names a paused variant', () => {
    const v = assessModels(http(200, rows(['smoke__default'], { status: 'paused' })), 'smoke', [
      'default',
    ]);
    expect(v).toMatchObject({ ok: false, detail: 'paused: default' });
  });

  it('gives no dataset for a service that searches none', () => {
    const v = assessModels(http(200, { data: [{ id: 'smoke__default' }] }), 'smoke', ['default']);
    expect(v.ok).toBe(true);
    expect(v.dataset).toBeUndefined();
  });

  it('fails when the key is refused', () => {
    expect(assessModels(http(401, {}), 'smoke', ['default']).ok).toBe(false);
  });
});

describe('facets', () => {
  it('accepts a value found in any of the facet fields', () => {
    const body = {
      fields: [
        { field: 'orgs_short', options: [{ value: 'DFØ', count: 3 }] },
        { field: 'orgs_long', options: [{ value: 'Datatilsynet', count: 9 }] },
      ],
    };
    expect(assessFacets(http(200, body), ['DFØ', 'Datatilsynet'])).toEqual({
      ok: true,
      detail: 'DFØ in orgs_short; Datatilsynet in orgs_long',
    });
  });

  it('fails when an organisation a question names is in no facet field', () => {
    const body = {
      fields: [{ field: 'orgs_long', options: [{ value: 'Datatilsynet', count: 9 }] }],
    };
    expect(assessFacets(http(200, body), ['DFØ', 'Datatilsynet'])).toMatchObject({
      ok: false,
      detail: 'no facet value DFØ',
    });
  });

  it('fails when the facets do not answer', () => {
    expect(assessFacets(http(404, {}), ['DFØ']).ok).toBe(false);
  });
});

describe('which failures are transient', () => {
  it.each([429, 502, 503, 504])('retries a %i', (status) => {
    expect(isTransient(http(status, ''))).toBe(true);
  });

  it('retries a 500 that says the model failed', () => {
    expect(isTransient(http(500, { error: { model_failed: true } }))).toBe(true);
  });

  it('does not retry a 500 that is not a model failure', () => {
    expect(isTransient(http(500, { error: { failure_code: 'strategy_error' } }))).toBe(false);
  });

  it.each([400, 401, 403, 404])('does not retry a %i', (status) => {
    expect(isTransient(http(status, ''))).toBe(false);
  });
});

describe('completions', () => {
  const asked = { answer: true, minCitations: 1, model: mini };
  const served = { 'genai-task': 't-1', 'genai-model': mini };

  it('passes a completed answer with a cited source, tokens and the expected model', () => {
    expect(assessCompletion(http(200, completion(), served), asked)).toMatchObject({
      ok: true,
      task: 't-1',
      tokens: { input: 900, output: 40 },
    });
  });

  it('fails a model that refuses its parameters, and retries it as a possible provider blip', () => {
    const refused = http(500, {
      error: { message: 'the service failed', failure_code: 'model_error', model_failed: true },
    });
    expect(assessCompletion(refused, asked)).toMatchObject({
      ok: false,
      retry: true,
      detail: '500 model_error: the service failed',
    });
  });

  it('never retries a refusal of the key', () => {
    expect(
      assessCompletion(http(403, { error: { code: 'agent_not_authorized' } }), asked),
    ).toMatchObject({ ok: false, retry: false });
  });

  it('fails an answer that did not finish with stop', () => {
    const body = completion({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] });
    expect(assessCompletion(http(200, body, served), asked).ok).toBe(false);
  });

  it('fails an empty answer where one is expected', () => {
    const body = completion({ choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] });
    expect(assessCompletion(http(200, body, served), asked).detail).toBe('empty answer');
  });

  it('fails an answer without token usage', () => {
    const body = completion({ usage: undefined });
    expect(assessCompletion(http(200, body, served), asked).detail).toBe('no token usage');
  });

  it('fails an answer without a cited source', () => {
    const body = completion({ sources: [{ title: 'uncited' }] });
    expect(assessCompletion(http(200, body, served), asked)).toMatchObject({
      ok: false,
      retry: true,
    });
  });

  it('fails when another model answered than the variant names, without retrying', () => {
    const v = assessCompletion(http(200, completion(), { 'genai-model': 'other' }), asked);
    expect(v).toMatchObject({ ok: false });
    expect(v.retry).toBeUndefined();
  });

  it('passes but says so when genki names no single model, as when the run also embedded', () => {
    const v = assessCompletion(http(200, completion(), { 'genai-task': 't-1' }), asked);
    expect(v).toMatchObject({
      ok: true,
      detail: '2 sources, 900/40 tokens, model not named by genai-model',
    });
  });

  it('accepts a retrieve-only run with sources and no answer text', () => {
    const body = completion({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      no_answer: true,
    });
    expect(assessCompletion(http(200, body), { answer: false, minSources: 1 }).ok).toBe(true);
  });

  it('fails a retrieve-only run with fewer sources than expected', () => {
    const body = completion({ sources: [] });
    expect(assessCompletion(http(200, body), { answer: false, minSources: 1 }).ok).toBe(false);
  });
});

describe('streams', () => {
  const ok = [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: {} }], genai_step: { stage: 'search', tool: 'search' } },
    { choices: [{ delta: {} }], sources: [{ index: 1, title: 'R' }] },
    { choices: [{ delta: { content: 'Svar [1].' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];

  it('reads every data frame and the end marker, ignoring keep-alive comments', () => {
    const parsed = parseSse(`: keep-alive\n\n${sse(...ok)}`);
    expect(parsed.done).toBe(true);
    expect(parsed.frames).toHaveLength(5);
  });

  it('passes a stream with steps, a cited source and stop', () => {
    expect(assessStream(http(200, sse(...ok)), { answer: true, minCitations: 1 }).ok).toBe(true);
  });

  it('fails a stream that ends in error', () => {
    const failed = [
      ok[0],
      { choices: [{ delta: {}, finish_reason: 'error' }], error: { failure_code: 'model_error' } },
    ];
    expect(assessStream(http(200, sse(...failed)), { answer: true })).toMatchObject({
      ok: false,
      detail: 'stream ended in error model_error',
    });
  });

  it('fails a stream cut off before the end marker', () => {
    const cut = ok.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n');
    expect(assessStream(http(200, cut), { answer: true }).detail).toBe(
      'stream did not finish with stop',
    );
  });

  it('fails a stream without an answer', () => {
    const silent = ok.filter((f) => !JSON.stringify(f).includes('Svar'));
    expect(assessStream(http(200, sse(...silent)), { answer: true }).detail).toBe('empty answer');
  });

  it('fails a stream without step frames', () => {
    const noSteps = ok.filter((f) => !('genai_step' in f));
    expect(assessStream(http(200, sse(...noSteps)), { answer: true }).detail).toBe(
      'no step frames',
    );
  });

  it('fails a stream with fewer cited sources than expected', () => {
    expect(assessStream(http(200, sse(...ok)), { answer: true, minCitations: 2 }).ok).toBe(false);
  });

  it('fails a stream the API refused', () => {
    expect(assessStream(http(403, {}), { answer: true })).toMatchObject({
      ok: false,
      retry: false,
    });
  });
});

describe('timelines', () => {
  const timeline = (items: string[], label = 'Found in the search') => ({
    status: 'completed',
    inputTokens: 1200,
    steps: [{ type: 'search', blocks: items.length ? [{ kind: 'tags', label, items }] : [] }],
  });

  it.each([401, 403])('is unavailable, not failed, when the key gets %i', (status) => {
    expect(assessTimeline(http(status, {}), { tokens: true })).toMatchObject({ unavailable: true });
  });

  it('fails on another error status', () => {
    const v = assessTimeline(http(404, {}), { tokens: true });
    expect(v).toMatchObject({ ok: false });
    expect(v.unavailable).toBeUndefined();
  });

  it('passes when every expected organisation is detected', () => {
    const t = timeline([
      'orgs_long: Datatilsynet, suggested to the agent',
      'orgs_short: DFØ, suggested to the agent',
    ]);
    expect(
      assessTimeline(http(200, t), { detected: ['Datatilsynet', 'DFØ'], tokens: true }).ok,
    ).toBe(true);
  });

  it('reads the detection label in bokmål too', () => {
    const t = timeline(['orgs_long: Datatilsynet, foreslått for agenten'], 'Gjenkjent i søket');
    expect(assessTimeline(http(200, t), { detected: ['Datatilsynet'], tokens: true }).ok).toBe(
      true,
    );
  });

  it('fails when an expected organisation is not detected', () => {
    const t = timeline(['orgs_long: Datatilsynet, suggested to the agent']);
    expect(
      assessTimeline(http(200, t), { detected: ['Datatilsynet', 'DFØ'], tokens: true }),
    ).toMatchObject({ ok: false, detail: 'not detected: DFØ' });
  });

  it('fails a detection on a question that names nothing', () => {
    const t = timeline(['concerned_years: 2000, ranked higher']);
    expect(assessTimeline(http(200, t), { detected: [], tokens: true }).ok).toBe(false);
  });

  it('fails a run that did not complete', () => {
    const t = { ...timeline([]), status: 'failed' };
    expect(assessTimeline(http(200, t), { tokens: true }).detail).toBe('status failed');
  });

  it('fails a timeline without steps', () => {
    const t = { ...timeline([]), steps: [] };
    expect(assessTimeline(http(200, t), { tokens: true }).detail).toBe('no steps');
  });

  it('fails a timeline without input tokens', () => {
    const t = { ...timeline([]), inputTokens: undefined };
    expect(assessTimeline(http(200, t), { tokens: true }).ok).toBe(false);
  });
});

describe('outcomes', () => {
  it('calls a first-try pass a pass', () => {
    expect(outcomeOf([true])).toBe('pass');
  });

  it('calls a pass on retry flaky', () => {
    expect(outcomeOf([false, true])).toBe('flaky');
  });

  it('calls two failures a failure', () => {
    expect(outcomeOf([false, false])).toBe('fail');
  });

  it('counts a flaky check as passed in the run', () => {
    expect(overallOutcome([check({ outcome: 'flaky' })], allTiers)).toBe('pass');
  });

  it('fails the run on any failed check', () => {
    expect(overallOutcome([check({ outcome: 'fail' }), check({})], allTiers)).toBe('fail');
  });

  it('does not count a timeline the key cannot read against a green run', () => {
    const unread = check({ outcome: 'skip', skipReason: 'unavailable' });
    expect(overallOutcome([check({}), unread], allTiers)).toBe('pass');
  });

  it.each(['budget', 'time', 'key', 'tier'] as const)(
    'calls a run with a check skipped for %s partial',
    (skipReason) => {
      expect(overallOutcome([check({ outcome: 'skip', skipReason })], allTiers)).toBe('partial');
    },
  );

  it('calls a run without the core tier partial', () => {
    expect(overallOutcome([check({})], ['free', 'cheap'])).toBe('partial');
  });
});

describe('daily cap', () => {
  it('runs every tier up to the cap', () => {
    expect(tiersToRun('all', 6, 6)).toEqual({ tiers: allTiers });
  });

  it('runs only the free tier past the cap, and says why', () => {
    expect(tiersToRun('all', 7, 6)).toEqual({
      tiers: ['free'],
      note: '7 smoke runs today, over the cap of 6, so only the free tier ran.',
    });
  });

  it('runs only the free tier when it cannot count today’s runs', () => {
    expect(tiersToRun('cheap', undefined, 6).tiers).toEqual(['free']);
  });

  it('runs the free and cheap tiers when only those are asked for', () => {
    expect(tiersToRun('cheap', 0, 6).tiers).toEqual(['free', 'cheap']);
  });

  it('needs no note for a free run, whatever the count', () => {
    expect(tiersToRun('free', undefined, 6)).toEqual({ tiers: ['free'] });
    expect(tiersToRun('free', 99, 6)).toEqual({ tiers: ['free'] });
  });
});

describe('budget', () => {
  it('prices input and output tokens separately', () => {
    expect(costOf({ input: 1000, output: 100 }, { input: 0.001, output: 0.01 })).toBeCloseTo(2);
  });

  it('has no cost without a price or without tokens', () => {
    expect(costOf({ input: 1, output: 1 }, undefined)).toBeUndefined();
    expect(costOf(undefined, { input: 1, output: 1 })).toBeUndefined();
  });

  it('counts the measured cost when it is higher than the estimate', () => {
    const budget = new Budget(1);
    budget.add(0.2, 0.7);
    expect(budget.spent).toBeCloseTo(0.7);
  });

  it('counts the estimate when the measured cost is lower', () => {
    const budget = new Budget(1);
    budget.add(0.2, 0.05);
    expect(budget.spent).toBeCloseTo(0.2);
  });

  it('allows a check that brings the run exactly to the cap', () => {
    const budget = new Budget(1);
    budget.add(0.5);
    expect(budget.allows(0.5)).toBe(true);
    expect(budget.allows(0.51)).toBe(false);
  });
});

describe('a model check', () => {
  const deps = (over: Partial<ModelCheckDeps> = {}): ModelCheckDeps => ({
    budget: new Budget(2.5),
    price: { input: 0.0001, output: 0.001 },
    deadline: 1_000_000,
    attemptMs: 150_000,
    retryMs: 20_000,
    now: () => 0,
    wait: async () => undefined,
    ...over,
  });
  const attempts = (...verdicts: Verdict[]) => {
    const queue = [...verdicts];
    return async () => queue.shift() ?? { ok: false, detail: 'called too often' };
  };
  const blip: Verdict = { ok: false, detail: '503', retry: true, task: 't-1' };
  const passed: Verdict = {
    ok: true,
    detail: 'ok',
    task: 't-2',
    tokens: { input: 1000, output: 100 },
  };
  const refused: Verdict = { ok: false, detail: '403', retry: false };

  it('passes on the first try without waiting', async () => {
    let waited = 0;
    const r = await runModelCheck(
      'cheap',
      'm',
      0.1,
      attempts(passed),
      deps({ wait: async () => void waited++ }),
    );
    expect(r).toMatchObject({ outcome: 'pass', attempts: 1, tasks: ['t-2'] });
    expect(waited).toBe(0);
  });

  it('retries a retryable failure once, keeping both runs, and calls it flaky', async () => {
    const r = await runModelCheck('cheap', 'm', 0.1, attempts(blip, passed), deps());
    expect(r).toMatchObject({ outcome: 'flaky', attempts: 2, tasks: ['t-1', 't-2'] });
  });

  it('never retries a failure that is not retryable', async () => {
    const r = await runModelCheck('cheap', 'm', 0.1, attempts(refused, passed), deps());
    expect(r).toMatchObject({ outcome: 'fail', attempts: 1, detail: '403' });
  });

  it('fails after two retryable failures', async () => {
    const r = await runModelCheck('cheap', 'm', 0.1, attempts(blip, blip), deps());
    expect(r).toMatchObject({ outcome: 'fail', attempts: 2 });
  });

  it('skips a check whose first try would pass the budget', async () => {
    const budget = new Budget(0.05);
    const r = await runModelCheck('cheap', 'm', 0.1, attempts(passed), deps({ budget }));
    expect(r).toMatchObject({ outcome: 'skip', skipReason: 'budget', attempts: 0 });
  });

  it('fails without a retry when the retry would pass the budget', async () => {
    const budget = new Budget(0.15);
    const r = await runModelCheck('cheap', 'm', 0.1, attempts(blip, passed), deps({ budget }));
    expect(r).toMatchObject({ outcome: 'fail', attempts: 1 });
  });

  it('skips a check that could not finish before the run’s deadline', async () => {
    const r = await runModelCheck(
      'cheap',
      'm',
      0.1,
      attempts(passed),
      deps({ now: () => 900_000 }),
    );
    expect(r).toMatchObject({ outcome: 'skip', skipReason: 'time', attempts: 0 });
  });

  it('fails without a retry when the retry could not finish before the deadline', async () => {
    const r = await runModelCheck(
      'cheap',
      'm',
      0.1,
      attempts(blip, passed),
      deps({ now: () => 840_000 }),
    );
    expect(r).toMatchObject({ outcome: 'fail', attempts: 1 });
  });

  it('reports the measured cost and charges the budget at least the estimate', async () => {
    const budget = new Budget(2.5);
    const r = await runModelCheck('cheap', 'm', 0.1, attempts(passed), deps({ budget }));
    expect(r.costKr).toBeCloseTo(0.2);
    expect(budget.spent).toBeCloseTo(0.2);
  });
});

describe('text from genki', () => {
  it('stays on one table row', () => {
    expect(clip('a|b\nc')).toBe('a\\|b c');
  });

  it('mentions nobody', () => {
    expect(clip('@someone')).not.toMatch(/@[a-z]/);
  });

  it('is cut short', () => {
    expect(clip('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it('cleans a long adversarial string in linear time', () => {
    const started = performance.now();
    clip(`${' \n|@'.repeat(200_000)}x`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
