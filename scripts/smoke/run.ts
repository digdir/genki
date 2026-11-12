// Runs the deterministic post-deploy smoke test against genki-test; see docs/smoke-tests.md.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assessCompletion,
  assessFacets,
  assessHealth,
  assessKeyAdmission,
  assessModels,
  assessOpenapi,
  assessPage,
  assessPlayground,
  assessPlaygroundScreen,
  assessProblemLanguage,
  assessRefusal,
  assessScopeRefusal,
  assessScreen,
  assessSignedOut,
  assessSourcesUnique,
  assessStatus,
  assessStream,
  assessTimeline,
  Budget,
  fileNameOf,
  parseJsonOr,
  runFailedOf,
  overallOutcome,
  runModelCheck,
  sourcesOfAnswer,
  tiersToRun,
  withKnownIssue,
  type CheckResult,
  type HttpResult,
  type ServiceDataset,
  type SkipReason,
  type SmokeReport,
  type Tier,
  type Verdict,
  type WantedTiers,
} from './assess.ts';
import type { Browser } from './browser.ts';
import {
  changedPrs,
  github,
  historyOf,
  loadGroups,
  suspectRange,
  targetsOf,
  type ChangedPr,
  type SuspectRange,
  type Targets,
} from './changes.ts';
import {
  call,
  createClient,
  freeTimeout,
  loadPlan,
  runTimeout,
  serviceYaml,
  withId,
} from './client.ts';
import { renderTable } from './report.ts';
import { toolboxOf } from './review.ts';

const retryDelay = 20_000;
const modelChecksMs = 14 * 60_000;
const maxDiffChars = 40_000;
const maxPrs = 30;

export interface Bundle {
  report: SmokeReport;
  targets: Targets;
  range?: SuspectRange;
  prs: Omit<ChangedPr, 'diff' | 'body'>[];
  review: boolean;
  reviewNote?: string;
}

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

export const reviewDecision = (input: {
  asked: boolean;
  prs: number;
  healthy: boolean;
  runsToday: number | undefined;
  maxPerDay: number;
}): { review: boolean; note?: string } => {
  if (!input.asked) return { review: false, note: 'The model review was not asked for.' };
  if (!input.healthy)
    return { review: false, note: 'genki-test does not run the version under test.' };
  if (input.prs === 0)
    return { review: false, note: 'No pull request was merged since the last green run.' };
  if (input.runsToday === undefined || input.runsToday > input.maxPerDay)
    return {
      review: false,
      note: `Over the daily cap of ${input.maxPerDay} model reviews, or the count is unknown.`,
    };
  return { review: true };
};

export const finalOutcome = (
  outcome: SmokeReport['outcome'],
  healthyAtStart: boolean,
  healthyAtEnd: boolean,
): SmokeReport['outcome'] =>
  outcome === 'pass' && healthyAtStart && !healthyAtEnd ? 'partial' : outcome;

export const portalClientIdOf = (configJs: string) =>
  /["']?OIDC_CLIENT_ID["']?\s*:\s*["']([^"']+)["']/.exec(configJs)?.[1] ?? 'local-portal';

export const main = async () => {
  const started = Date.now();
  const env = process.env;
  const plan = loadPlan();
  const groups = loadGroups();
  const out = env.SMOKE_OUT || 'smoke-out';
  for (const dir of ['answers', 'timelines', 'changes', 'screens'])
    mkdirSync(join(out, dir), { recursive: true });
  const api = (env.SMOKE_API_URL || 'https://api.genki-test.digdir.cloud').replace(/\/$/, '');
  const portal = (env.SMOKE_PORTAL_URL || 'https://portal.genki-test.digdir.cloud').replace(
    /\/$/,
    '',
  );
  const consoleUrl = (env.SMOKE_CONSOLE_URL || 'https://console.genki-test.digdir.cloud').replace(
    /\/$/,
    '',
  );
  const expected = env.SMOKE_EXPECT_SHA || undefined;
  const key = env.SMOKE_API_KEY || undefined;
  const redact = (text: string) => (key ? text.split(key).join('[key]') : text);
  const save = (path: string, text: string, max = 40_000) =>
    writeFileSync(join(out, path), redact(text).slice(0, max));
  const wanted = (
    ['free', 'cheap', 'all'].includes(env.SMOKE_TIERS ?? '') ? env.SMOKE_TIERS : 'all'
  ) as WantedTiers;
  const today = await runsToday(new Date());
  const { tiers: wantedTiers, note } = tiersToRun(
    wanted,
    today,
    Number(env.SMOKE_MAX_RUNS_PER_DAY) || 6,
  );
  const notes = note ? [note] : [];
  if (!key) notes.push('SMOKE_API_KEY is not set, so only the checks without a key ran.');
  const budget = new Budget(plan.maxKrPerRun);
  const checks: CheckResult[] = [];
  const client = createClient(api, key, plan);

  const record = (group: string, tier: Tier, id: string, verdict: Verdict, attempts = 1) => {
    checks.push({
      id,
      tier,
      group,
      outcome: verdict.ok ? 'pass' : 'fail',
      detail: redact(verdict.detail),
      attempts,
      tasks: verdict.task ? [verdict.task] : [],
    });
  };
  const skip = (group: string, tier: Tier, id: string, reason: SkipReason, detail: string) =>
    checks.push({
      id,
      tier,
      group,
      outcome: 'skip',
      skipReason: reason,
      detail,
      attempts: 0,
      tasks: [],
    });

  let health = assessHealth(await call(`${api}/health`, { timeout: freeTimeout }), expected);
  for (let i = 1; i < 10 && !health.ok && expected; i++) {
    await sleep(15_000);
    health = assessHealth(await call(`${api}/health`, { timeout: freeTimeout }), expected);
  }
  record('platform', 'free', 'health', health);
  const sha = expected ?? health.version ?? '';
  const tiers = health.ok ? wantedTiers : wantedTiers.filter((t) => t === 'free');
  if (tiers.length < wantedTiers.length)
    notes.push('The API does not run the version under test, so no model checks ran.');

  let range: SuspectRange | undefined;
  let prs: ChangedPr[] = [];
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (token && repo && /^[0-9a-f]{40}$/.test(sha)) {
    try {
      const gh = github(token);
      const nodes = await historyOf(gh, repo, sha);
      range = nodes ? suspectRange(nodes) : undefined;
      prs = range
        ? await changedPrs(gh, repo, range.pullRequests, { diffChars: maxDiffChars, prs: maxPrs })
        : [];
    } catch (error) {
      notes.push(`The pull requests since the last green run could not be read: ${String(error)}`);
    }
  } else
    notes.push('No GitHub token or SHA, so no pull requests were read and only baselines ran.');
  const targets = targetsOf(groups, prs);
  const everything = env.SMOKE_FULL === 'all';
  const full = new Set(everything ? Object.keys(groups.groups) : targets.full);
  const runs = (group: string, baseline: boolean) => baseline || full.has(group);
  for (const pr of prs)
    save(
      `changes/${pr.number}.md`,
      [
        `<pull-request number="${pr.number}" merged="${pr.mergedAt}" ai-reviewed="${pr.aiReviewed}">`,
        `<title>${pr.title}</title>`,
        `<body>\n${pr.body}\n</body>`,
        `<files>\n${pr.files.join('\n')}\n</files>`,
        `<diff>\n${pr.diff}\n</diff>`,
        '</pull-request>',
      ].join('\n'),
      maxDiffChars + 20_000,
    );

  if (health.version)
    record(
      'platform',
      'free',
      'openapi',
      assessOpenapi(await call(`${api}/openapi.json`, { timeout: freeTimeout }), health.version),
    );
  const portalPage = await call(portal, { timeout: freeTimeout });
  record('platform', 'free', 'portal', assessPage(portalPage));
  record(
    'platform',
    'free',
    'console',
    assessPage(await call(consoleUrl, { timeout: freeTimeout })),
  );
  record(
    'access',
    'free',
    'access:no-key',
    assessStatus(await client.askWithoutKey(), [401], 'no key'),
  );
  record(
    'language',
    'free',
    'language:problem',
    assessProblemLanguage(
      await call(`${api}/api/smoke-missing-route`, {
        headers: { 'accept-language': 'nb' },
        timeout: freeTimeout,
      }),
      await call(`${api}/api/smoke-missing-route`, {
        headers: { 'accept-language': 'en' },
        timeout: freeTimeout,
      }),
    ),
  );

  const variants = ['default', 'retrieve-only', ...plan.models.map((m) => m.variant)];
  let browser: Browser | undefined;
  try {
    const { openBrowser } = await import('./browser.ts');
    const config = await call(`${portal}/config.js`, { timeout: freeTimeout });
    browser = await openBrowser({
      portal,
      console: consoleUrl,
      tenant: plan.tenant,
      key,
      portalClientId: portalClientIdOf(config.text),
      out,
      redact,
    });
  } catch (error) {
    notes.push(
      `No browser, so no screen checks ran: ${redact(String(error).split('\n')[0] ?? '').slice(0, 200)}`,
    );
  }

  try {
    if (browser) {
      record(
        'access',
        'free',
        'session:portal-expired',
        assessSignedOut(await browser.visit('portal', '#/overview', { token: 'expired' }), plan),
      );
      record(
        'access',
        'free',
        'session:console-expired',
        assessSignedOut(await browser.visit('console', '#/tenants', { token: 'expired' }), plan),
      );
    } else {
      skip('access', 'free', 'session:portal-expired', 'unavailable', 'no browser');
      skip('access', 'free', 'session:console-expired', 'unavailable', 'no browser');
    }

    let dataset: ServiceDataset | undefined;
    let granted = false;
    if (!key) {
      skip('platform', 'free', 'models', 'key', 'no key');
      skip('retrieval', 'free', 'facets', 'key', 'no key');
    } else {
      const models = assessModels(await client.get('/v1/models'), plan.service, variants);
      record('platform', 'free', 'models', models);
      dataset = models.dataset;
      if (!dataset)
        skip('retrieval', 'free', 'facets', 'unavailable', 'the service lists no dataset');
      else {
        const query = new URLSearchParams({
          tenant: dataset.tenant,
          'dataset-config-key': dataset.key,
          fields: plan.facets.fields.join(','),
        });
        record(
          'retrieval',
          'free',
          'facets',
          assessFacets(await client.get(`/api/facets?${query}`), plan.facets.values),
        );
      }
      const probe = await client.playgroundOptions();
      granted = probe.status === 200;
      if (!granted)
        notes.push(
          `The key has no test-runner grant (playground options answered ${probe.status}), so the checks that need it were skipped.`,
        );
    }
    const needsGrant = (group: string, tier: Tier, id: string) =>
      !key
        ? (skip(group, tier, id, 'key', 'no key'), false)
        : !granted
          ? (skip(group, tier, id, 'credential', 'needs the test-runner grant'), false)
          : true;

    const modelCheck = async (
      group: string,
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
      const tagged = { ...result, group, detail: redact(result.detail) };
      checks.push(tagged);
      return tagged;
    };
    if (needsGrant('access', 'free', 'access:models-in-lockdown') && key) {
      const admission = assessKeyAdmission(
        [
          await client.get(`/tenants/${plan.tenant}/services/${plan.service}/api-keys`),
          await client.get(`/tenants/${plan.tenant}/access`),
        ],
        key,
        health.lockdown,
      );
      if (admission.unavailable)
        skip('access', 'free', 'access:models-in-lockdown', 'credential', admission.detail);
      else record('access', 'free', 'access:models-in-lockdown', admission);
    }
    const notRun = (group: string, tier: Tier, id: string) =>
      skip(group, tier, id, 'tier', 'not run in this run');

    const timelines: {
      id: string;
      task: string;
      failed: boolean;
      detected?: string[];
      knownIssue?: string;
    }[] = [];
    const answer = (id: string) => async (result: HttpResult) => {
      save(`answers/${fileNameOf(id)}.json`, result.text, 20_000);
      return result;
    };

    for (const m of plan.models) {
      for (const stream of runs('models', false) ? [false, true] : [false]) {
        const id = `model:${m.model}${stream ? ':stream' : ''}`;
        if (!tiers.includes('cheap')) notRun('models', 'cheap', id);
        else if (!key) skip('models', 'cheap', id, 'key', 'no key');
        else {
          let reply: HttpResult | undefined;
          const result = await modelCheck(
            'models',
            'cheap',
            id,
            m.estimateKr,
            m.model,
            async () => {
              reply = await answer(id)(await client.ask(m.variant, plan.modelQuestion, stream));
              return stream
                ? assessStream(reply, { answer: true })
                : assessCompletion(reply, { model: m.model, answer: true });
            },
          );
          const task = result.tasks.at(-1);
          if (task && result.outcome !== 'skip' && (!stream || runs('timeline', false)))
            timelines.push({ id, task, failed: reply ? runFailedOf(reply, stream) : false });
        }
      }
    }

    for (const q of plan.questions) {
      const id = `question:${q.id}`;
      if (!tiers.includes('core')) notRun('runs', 'core', id);
      else if (!key) skip('runs', 'core', id, 'key', 'no key');
      else {
        const expect = {
          answer: q.stream,
          ...(q.minCitations === undefined ? {} : { minCitations: q.minCitations }),
          ...(q.minSources === undefined ? {} : { minSources: q.minSources }),
        };
        let reply: HttpResult | undefined;
        const result = await modelCheck('runs', 'core', id, q.estimateKr, q.model, async () => {
          reply = await answer(id)(await client.ask(q.variant, q.question, q.stream));
          return q.stream ? assessStream(reply, expect) : assessCompletion(reply, expect);
        });
        if (reply && reply.status === 200 && q.minCitations)
          record(
            'runs',
            'core',
            `sources:${q.id}`,
            assessSourcesUnique(sourcesOfAnswer(reply, q.stream)),
          );
        const task = result.tasks.at(-1);
        if (task && result.outcome !== 'skip')
          timelines.push({
            id: q.id,
            task,
            failed: reply ? runFailedOf(reply, q.stream) : false,
            ...(q.detected ? { detected: q.detected } : {}),
            ...(q.knownIssue ? { knownIssue: q.knownIssue } : {}),
          });
      }
    }

    for (const t of timelines) {
      const id = `timeline:${t.id}`;
      if (!needsGrant('timeline', 'core', id)) continue;
      const result = await client.timeline(t.task);
      save(`timelines/${fileNameOf(t.id)}.json`, result.text);
      const verdict = assessTimeline(result, {
        tokens: true,
        failed: t.failed,
        ...(t.detected && !t.failed ? { detected: t.detected } : {}),
      });
      if (verdict.unavailable) skip('timeline', 'core', id, 'credential', verdict.detail);
      else {
        record('timeline', 'core', id, { ...verdict, task: t.task });
        const last = checks.at(-1);
        if (last && !t.failed) checks[checks.length - 1] = withKnownIssue(last, t.knownIssue);
      }
    }
    let version: number | undefined;
    if (tiers.includes('cheap') && needsGrant('playground', 'cheap', 'playground:options')) {
      const options = await client.playgroundOptions();
      const smoke = parseJsonOr<{ services?: { id: string; latestVersion: number }[] }>(
        options.status === 200 ? options.text : '',
        {},
      ).services?.find((s) => s.id === plan.service);
      version = smoke?.latestVersion;
      record('playground', 'cheap', 'playground:options', {
        ok: version !== undefined,
        detail:
          version === undefined
            ? 'the smoke service is not in the playground'
            : `version ${version}`,
      });
    }
    for (const m of plan.models) {
      const id = `playground:${m.model}`;
      if (!tiers.includes('cheap')) notRun('playground', 'cheap', id);
      else if (version === undefined)
        skip(
          'playground',
          'cheap',
          id,
          !key ? 'key' : granted ? 'unavailable' : 'credential',
          'no playground',
        );
      else {
        const v = version;
        await modelCheck('playground', 'cheap', id, m.playgroundKr, m.model, async () => {
          const reply = await answer(id)(await client.playground(v, m.model, plan.modelQuestion));
          return assessPlayground(reply);
        });
      }
    }

    if (needsGrant('definitions', 'free', 'validate:smoke')) {
      record(
        'definitions',
        'free',
        'validate:smoke',
        assessStatus(await client.validate(serviceYaml()), [200], 'validate'),
      );
      for (const r of plan.refusals) {
        const id = `validate:${r.id}`;
        if (!runs('definitions', r.baseline)) continue;
        const yaml = withId(serviceYaml(), plan.service, 'smoke-refusal').replace(
          r.replace[0],
          r.replace[1],
        );
        record('definitions', 'free', id, assessRefusal(await client.validate(yaml), r.path));
      }
    }

    const published: string[] = [];
    try {
      if (needsGrant('definitions', 'free', 'lifecycle:throwaway')) {
        const yaml = withId(serviceYaml(), plan.service, plan.throwaway);
        const publish = await client.publish(yaml);
        if (publish.status < 300) published.push(plan.throwaway);
        const active =
          publish.status < 300 ? await client.lifecycle(plan.throwaway, 'active') : publish;
        const read = await client.get(
          `/tenants/${plan.tenant}/services/${plan.throwaway}/lifecycle`,
        );
        record('definitions', 'free', 'lifecycle:throwaway', {
          ok: publish.status < 300 && active.status === 200 && read.status === 200,
          detail: `publish ${publish.status}, activate ${active.status}, read ${read.status}`,
        });
      }
      if (needsGrant('access', 'free', 'access:outside-prefix')) {
        const outside = 'refused-by-smoke-test';
        const publish = await client.publish(withId(serviceYaml(), plan.service, outside));
        if (publish.status < 300) published.push(outside);
        record(
          'access',
          'free',
          'access:outside-prefix',
          assessStatus(publish, [403], 'publish without the smoke- prefix'),
        );
        const first = timelines[0];
        if (first)
          record(
            'access',
            'free',
            'access:other-tenant',
            assessStatus(
              await client.timeline(first.task, true),
              [403, 404],
              'another tenant’s timeline',
            ),
          );
        record(
          'access',
          'free',
          'access:operator-write',
          assessStatus(await client.operatorWrite(), [403], 'an operator write'),
        );
        for (const r of plan.operatorReads.filter((x) => runs('console', x.baseline)))
          record(
            'console',
            'free',
            `operator:${r.path}`,
            r.refused
              ? assessScopeRefusal(await client.get(r.path), plan.scopeRefusal, r.path)
              : assessStatus(await client.get(r.path), [200], r.path),
          );
      }
    } finally {
      for (const id of published) {
        const archived = await client.lifecycle(id, 'archived');
        if (archived.status !== 200)
          notes.push(`Could not archive ${id} (${archived.status}); archive it by hand.`);
      }
    }

    if (tiers.includes('core') && key) {
      const first = timelines.find((t) => !t.failed);
      if (!first) skip('feedback', 'core', 'feedback', 'unavailable', 'no completed run to rate');
      else {
        const up = await client.feedback(first.task, { rating: 'up' });
        const down =
          up.status === 201
            ? await client.feedback(first.task, { rating: 'down', comment: 'smoke' })
            : up;
        record('feedback', 'core', 'feedback', {
          ok: up.status === 201 && down.status === 201,
          detail: `up ${up.status}, down ${down.status}`,
          task: first.task,
        });
      }
    }

    if (browser) {
      for (const app of ['portal', 'console'] as const)
        for (const s of plan.screens[app].filter((x) => runs(app, x.baseline))) {
          const id = `screen:${app}/${s.path}`;
          if (!needsGrant(app, 'free', id)) continue;
          record(
            app,
            'free',
            id,
            assessScreen(
              await browser.visit(app, s.path, { token: 'key', personal: s.personal === true }),
              plan,
            ),
          );
        }
      if (runs('language', false) && granted)
        for (const path of ['#/overview', '#/services/smoke/test'])
          record(
            'language',
            'free',
            `screen:portal/${path}:en`,
            assessScreen(await browser.visit('portal', path, { token: 'key', locale: 'en' }), plan),
          );
      const playgroundScreen = 'screen:portal/playground-run';
      if (!tiers.includes('core')) notRun('playground', 'core', playgroundScreen);
      else if (needsGrant('playground', 'core', playgroundScreen) && browser) {
        const b = browser;
        await modelCheck(
          'playground',
          'core',
          playgroundScreen,
          0.1,
          plan.models[0]?.model ?? '',
          async () =>
            assessPlaygroundScreen(
              await b.visit('portal', '#/services/smoke/test', {
                token: 'key',
                act: b.runPlayground(plan.modelQuestion),
              }),
              plan,
            ),
        );
      }
    } else
      for (const app of ['portal', 'console'] as const)
        for (const s of plan.screens[app].filter((x) => runs(app, x.baseline)))
          skip(app, 'free', `screen:${app}/${s.path}`, 'unavailable', 'no browser');
  } finally {
    await browser?.close();
  }

  const closing = assessHealth(
    await call(`${api}/health`, { timeout: freeTimeout }),
    sha || undefined,
  );
  if (health.ok && !closing.ok)
    notes.push(
      `genki-test changed during the run (${closing.detail}), so the results mix versions.`,
    );

  const outcome = overallOutcome(checks, tiers);
  const report: SmokeReport = {
    sha,
    api,
    tiers,
    notes,
    full: [...full],
    checks,
    spentKr: Math.round(budget.spent * 100) / 100,
    outcome: finalOutcome(outcome, health.ok, closing.ok),
    ...(env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
      ? {
          runUrl: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        }
      : {}),
  };
  const decision = reviewDecision({
    asked: env.SMOKE_REVIEW !== 'false',
    prs: prs.length,
    healthy: health.ok,
    runsToday: today,
    maxPerDay: Number(env.SMOKE_REVIEW_MAX_PER_DAY) || 3,
  });
  const toolbox = toolboxOf(plan, variants);
  const bundle: Bundle = {
    report,
    targets,
    ...(range ? { range } : {}),
    prs: prs.map(({ diff: _diff, body: _body, ...rest }) => rest),
    review: decision.review,
    ...(decision.note ? { reviewNote: decision.note } : {}),
  };
  writeFileSync(join(out, 'bundle.json'), redact(JSON.stringify(bundle, null, 2)));
  writeFileSync(join(out, 'toolbox.json'), JSON.stringify(toolbox, null, 2));
  const table = renderTable(report);
  console.log(table);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `review=${decision.review}\noutcome=${report.outcome}\n`);
  return report;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
