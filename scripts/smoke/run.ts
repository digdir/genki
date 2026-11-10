// Runs the post-deploy smoke test against genki-test; see docs/smoke-tests.md.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
  overallOutcome,
  runModelCheck,
  tiersToRun,
  type CheckResult,
  type HttpResult,
  type Plan,
  type ServiceDataset,
  type SkipReason,
  type SmokeReport,
  type Tier,
  type Verdict,
  type WantedTiers,
} from './assess.ts';
import { renderTable } from './report.ts';

const freeTimeout = 30_000;
const runTimeout = 150_000;
const retryDelay = 20_000;
const modelChecksMs = 14 * 60_000;

export const loadPlan = (): Plan =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'plan.json'), 'utf8')) as Plan;

const call = async (url: string, init: RequestInit & { timeout: number }): Promise<HttpResult> => {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeout),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      status: timedOut ? 504 : 503,
      headers: {},
      text: timedOut ? 'timed out' : 'network error',
    };
  }
};

const runsToday = async (now: Date): Promise<number | undefined> => {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!token || !repo) return 0;
  const day = now.toISOString().slice(0, 10);
  const result = await call(
    `https://api.github.com/repos/${repo}/actions/workflows/smoke.yml/runs?created=%3E%3D${day}&per_page=100`,
    {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      timeout: freeTimeout,
    },
  );
  if (result.status !== 200) return undefined;
  const runs = (JSON.parse(result.text) as { workflow_runs?: { conclusion: string | null }[] })
    .workflow_runs;
  return runs?.filter((r) => r.conclusion !== 'skipped').length;
};

export const main = async () => {
  const started = Date.now();
  const env = process.env;
  const plan = loadPlan();
  const api = (env.SMOKE_API_URL || 'https://api.genki-test.digdir.cloud').replace(/\/$/, '');
  const portal = env.SMOKE_PORTAL_URL || 'https://portal.genki-test.digdir.cloud';
  const consoleUrl = env.SMOKE_CONSOLE_URL || 'https://console.genki-test.digdir.cloud';
  const expected = env.SMOKE_EXPECT_SHA || undefined;
  const key = env.SMOKE_API_KEY || undefined;
  const wanted = (
    ['free', 'cheap', 'all'].includes(env.SMOKE_TIERS ?? '') ? env.SMOKE_TIERS : 'all'
  ) as WantedTiers;
  const { tiers: wantedTiers, note } = tiersToRun(
    wanted,
    await runsToday(new Date()),
    Number(env.SMOKE_MAX_RUNS_PER_DAY) || 6,
  );
  const notes = note ? [note] : [];
  if (!key) notes.push('SMOKE_API_KEY is not set, so only the checks without a key ran.');
  const budget = new Budget(plan.maxKrPerRun);
  const checks: CheckResult[] = [];
  const auth = key ? { 'x-api-key': key } : undefined;
  const headers = { 'accept-language': 'en', 'content-type': 'application/json', ...auth };

  const record = (tier: Tier, id: string, verdict: Verdict, attempts = 1) => {
    checks.push({
      id,
      tier,
      outcome: verdict.ok ? 'pass' : 'fail',
      detail: verdict.detail,
      attempts,
      tasks: verdict.task ? [verdict.task] : [],
    });
  };
  const skip = (tier: Tier, id: string, reason: SkipReason, detail: string) =>
    checks.push({ id, tier, outcome: 'skip', skipReason: reason, detail, attempts: 0, tasks: [] });

  let health = assessHealth(await call(`${api}/health`, { timeout: freeTimeout }), expected);
  for (let i = 1; i < 10 && !health.ok && expected; i++) {
    await sleep(15_000);
    health = assessHealth(await call(`${api}/health`, { timeout: freeTimeout }), expected);
  }
  record('free', 'health', health, 1);
  const sha = expected ?? health.version ?? '';
  const tiers = health.ok ? wantedTiers : wantedTiers.filter((t) => t === 'free');
  if (tiers.length < wantedTiers.length)
    notes.push('The API does not run the version under test, so no model checks ran.');
  if (health.version)
    record(
      'free',
      'openapi',
      assessOpenapi(await call(`${api}/openapi.json`, { timeout: freeTimeout }), health.version),
    );
  record('free', 'portal', assessPage(await call(portal, { timeout: freeTimeout })));
  record('free', 'console', assessPage(await call(consoleUrl, { timeout: freeTimeout })));

  const variants = ['default', 'retrieve-only', ...plan.models.map((m) => m.variant)];
  let dataset: ServiceDataset | undefined;
  if (!key) {
    skip('free', 'models', 'key', 'no key');
    skip('free', 'facets', 'key', 'no key');
  } else {
    const models = assessModels(
      await call(`${api}/v1/models`, { headers, timeout: freeTimeout }),
      plan.service,
      variants,
    );
    record('free', 'models', models);
    dataset = models.dataset;
    if (!dataset) skip('free', 'facets', 'unavailable', 'the service lists no dataset');
    else {
      const query = new URLSearchParams({
        tenant: dataset.tenant,
        'dataset-config-key': dataset.key,
        fields: plan.facets.fields.join(','),
      });
      record(
        'free',
        'facets',
        assessFacets(
          await call(`${api}/api/facets?${query}`, { headers, timeout: freeTimeout }),
          plan.facets.values,
        ),
      );
    }
  }

  const ask = (variant: string, question: string, stream: boolean) =>
    call(`${api}/v1/chat/completions`, {
      method: 'POST',
      headers,
      timeout: runTimeout,
      body: JSON.stringify({
        model: `${plan.service}__${variant}`,
        messages: [{ role: 'user', content: question }],
        ...(stream ? { stream: true, genai_steps: true } : {}),
      }),
    });

  const modelCheck = async (
    tier: Tier,
    id: string,
    estimate: number,
    model: string,
    attempt: () => Promise<Verdict>,
  ) => {
    const result = await runModelCheck(tier, id, estimate, attempt, {
      budget,
      price: plan.prices[model],
      deadline: started + modelChecksMs,
      attemptMs: runTimeout,
      retryMs: retryDelay,
      now: Date.now,
      wait: (ms) => sleep(ms),
    });
    checks.push(result);
    return result;
  };

  const needsKey = (tier: Tier, id: string) => skip(tier, id, 'key', 'no key');
  const notRun = (tier: Tier, id: string) => skip(tier, id, 'tier', 'not run in this run');

  for (const m of plan.models) {
    const id = `model:${m.model}`;
    if (!tiers.includes('cheap')) notRun('cheap', id);
    else if (!key) needsKey('cheap', id);
    else
      await modelCheck('cheap', id, m.estimateKr, m.model, async () =>
        assessCompletion(await ask(m.variant, plan.modelQuestion, false), {
          model: m.model,
          answer: true,
        }),
      );
  }

  const completed: { question: Plan['questions'][number]; task: string }[] = [];
  for (const q of plan.questions) {
    const id = `question:${q.id}`;
    if (!tiers.includes('core')) notRun('core', id);
    else if (!key) needsKey('core', id);
    else {
      const expect = {
        answer: q.stream,
        ...(q.minCitations === undefined ? {} : { minCitations: q.minCitations }),
        ...(q.minSources === undefined ? {} : { minSources: q.minSources }),
      };
      const result = await modelCheck('core', id, q.estimateKr, q.model, async () => {
        const answer = await ask(q.variant, q.question, q.stream);
        return q.stream ? assessStream(answer, expect) : assessCompletion(answer, expect);
      });
      const task = result.tasks.at(-1);
      if (task && result.outcome !== 'fail' && result.outcome !== 'skip')
        completed.push({ question: q, task });
    }
  }

  if (tiers.includes('core') && key) {
    const first = completed[0];
    if (!first) skip('core', 'feedback', 'unavailable', 'no completed run to rate');
    else {
      const rate = (body: object) =>
        call(`${api}/api/feedback`, {
          method: 'POST',
          headers,
          timeout: freeTimeout,
          body: JSON.stringify({ task: first.task, ...body }),
        });
      const up = await rate({ rating: 'up' });
      const down = up.status === 201 ? await rate({ rating: 'down', comment: 'smoke' }) : up;
      record('core', 'feedback', {
        ok: up.status === 201 && down.status === 201,
        detail: `up ${up.status}, down ${down.status}`,
        task: first.task,
      });
    }
    for (const { question, task } of completed) {
      const id = `timeline:${question.id}`;
      const verdict = assessTimeline(
        await call(`${api}/tenants/${plan.tenant}/tasks/${encodeURIComponent(task)}/timeline`, {
          headers,
          timeout: freeTimeout,
        }),
        { ...(question.detected ? { detected: question.detected } : {}), tokens: true },
      );
      if (verdict.unavailable) skip('core', id, 'unavailable', verdict.detail);
      else record('core', id, { ...verdict, task });
    }
  }

  const report: SmokeReport = {
    sha,
    api,
    tiers,
    notes,
    checks,
    spentKr: Math.round(budget.spent * 100) / 100,
    outcome: overallOutcome(checks, tiers),
    ...(env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
      ? {
          runUrl: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        }
      : {}),
  };
  const table = renderTable(report);
  console.log(table);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`);
  if (report.outcome === 'fail') process.exitCode = 1;
  return report;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
