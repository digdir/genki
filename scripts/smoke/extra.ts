// Runs the extra checks the model proposed, after validating them against the toolbox.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assessCompletion,
  assessHealth,
  assessPlayground,
  assessScreen,
  assessStatus,
  assessStream,
  assessTimeline,
  Budget,
  runModelCheck,
  type CheckResult,
  type Plan,
  type Verdict,
} from './assess.ts';
import type { Browser } from './browser.ts';
import { call, createClient, freeTimeout, loadPlan, runTimeout } from './client.ts';
import type { Bundle } from './run.ts';
import type { ModelOutput } from './model-output.ts';
import { acceptProposals, type ProposedCheck, type Toolbox } from './review.ts';

export interface ExtraResult {
  proposed: number;
  rejected: { index: number; reason: string }[];
  notRun?: string;
  checks: (CheckResult & { why: string; pullRequest?: number })[];
  spentKr: number;
}

const askEstimate = 0.2;

export const readJsonFile = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

export const estimateOf = (p: ProposedCheck['proposal'], plan: Plan) =>
  p.action === 'ask'
    ? p.variant === 'retrieve-only'
      ? 0.02
      : askEstimate
    : p.action === 'playground'
      ? (plan.models.find((m) => m.model === p.model)?.playgroundKr ?? 0.4)
      : 0;

export const priceOf = (p: ProposedCheck['proposal'], plan: Plan) => {
  const model =
    p.action === 'playground'
      ? p.model
      : p.action === 'ask'
        ? (plan.models.find((m) => m.variant === p.variant)?.model ?? plan.models[0]?.model)
        : undefined;
  return model ? plan.prices[model] : undefined;
};

export const main = async () => {
  const env = process.env;
  const out = env.SMOKE_OUT || 'smoke-out';
  mkdirSync(join(out, 'extra'), { recursive: true });
  const plan = loadPlan();
  const bundle = JSON.parse(readFileSync(join(out, 'bundle.json'), 'utf8')) as Bundle;
  const toolbox = JSON.parse(readFileSync(join(out, 'toolbox.json'), 'utf8')) as Toolbox;
  const raw = readJsonFile<ModelOutput>(join(out, 'model', 'proposals.json'))?.output ?? {};
  const { accepted, rejected } = acceptProposals(
    raw,
    toolbox,
    bundle.prs.map((p) => p.number),
  );
  const api = (env.SMOKE_API_URL || 'https://api.genki-test.digdir.cloud').replace(/\/$/, '');
  const key = env.SMOKE_API_KEY || undefined;
  const redact = (text: string) => (key ? text.split(key).join('[key]') : text);
  const client = createClient(api, key, plan);
  const budget = new Budget(plan.maxKrExtra);
  const started = Date.now();
  const checks: ExtraResult['checks'] = [];
  const save = (name: string, text: string) =>
    writeFileSync(join(out, 'extra', name), redact(text).slice(0, 20_000));

  const deployed = assessHealth(
    await call(`${api}/health`, { timeout: freeTimeout }),
    bundle.report.sha || undefined,
  );
  if (!deployed.ok) {
    const result: ExtraResult = {
      proposed: accepted.length + rejected.length,
      rejected,
      notRun: `${accepted.length} accepted checks not run: ${deployed.detail}`,
      checks: [],
      spentKr: 0,
    };
    writeFileSync(join(out, 'extra', 'extra.json'), JSON.stringify(result, null, 2));
    return result;
  }

  let browser: Browser | undefined;
  if (accepted.some((a) => a.proposal.action === 'screen'))
    try {
      const { openBrowser } = await import('./browser.ts');
      const { portalClientIdOf } = await import('./run.ts');
      const portal = (env.SMOKE_PORTAL_URL || 'https://portal.genki-test.digdir.cloud').replace(
        /\/$/,
        '',
      );
      browser = await openBrowser({
        portal,
        console: (env.SMOKE_CONSOLE_URL || 'https://console.genki-test.digdir.cloud').replace(
          /\/$/,
          '',
        ),
        tenant: plan.tenant,
        key,
        portalClientId: portalClientIdOf(
          (await call(`${portal}/config.js`, { timeout: freeTimeout })).text,
        ),
        out: join(out, 'extra'),
        redact,
      });
    } catch {
      browser = undefined;
    }

  const version = async () =>
    (
      JSON.parse((await client.playgroundOptions()).text || '{}') as {
        services?: { id: string; latestVersion: number }[];
      }
    ).services?.find((s) => s.id === plan.service)?.latestVersion;

  try {
    for (const [i, item] of accepted.entries()) {
      const id = `extra:${i + 1}:${item.proposal.action}`;
      const p = item.proposal;
      const meta = {
        why: item.why,
        ...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
      };
      const once = async (attempt: () => Promise<Verdict>) =>
        runModelCheck('core', id, estimateOf(p, plan), attempt, {
          budget,
          price: priceOf(p, plan),
          deadline: started + 8 * 60_000,
          attemptMs: runTimeout,
          retryMs: 20_000,
          now: Date.now,
          wait: (ms) => sleep(ms),
        });
      let result: CheckResult;
      if (p.action === 'ask')
        result = await once(async () => {
          const reply = await client.ask(p.variant, p.question, p.stream);
          save(`${i + 1}-answer.json`, reply.text);
          const verdict = p.stream
            ? assessStream(reply, { answer: true })
            : assessCompletion(reply, { answer: false });
          if (verdict.task) {
            const timeline = await client.timeline(verdict.task);
            save(`${i + 1}-timeline.json`, timeline.text);
            const t = assessTimeline(timeline, { tokens: true, failed: !verdict.ok });
            if (!t.unavailable && !t.ok)
              return { ...verdict, ok: false, detail: `${verdict.detail}; timeline: ${t.detail}` };
          }
          return verdict;
        });
      else if (p.action === 'playground') {
        const v = await version();
        result =
          v === undefined
            ? {
                id,
                tier: 'core',
                outcome: 'skip',
                skipReason: 'credential',
                detail: 'no playground',
                attempts: 0,
                tasks: [],
              }
            : await once(async () => {
                const reply = await client.playground(v, p.model, p.question);
                save(`${i + 1}-playground.json`, reply.text);
                return assessPlayground(reply);
              });
      } else if (p.action === 'validate') {
        const reply = await client.validate(p.definition);
        save(`${i + 1}-validate.json`, reply.text);
        const verdict = assessStatus(reply, [200, 422], 'validate');
        result = {
          id,
          tier: 'free',
          outcome: verdict.ok ? 'pass' : 'fail',
          detail: verdict.detail,
          attempts: 1,
          tasks: [],
        };
      } else if (p.action === 'operator-read') {
        const reply = await client.get(p.path);
        save(`${i + 1}-operator.json`, reply.text);
        const verdict = assessStatus(reply, [200], p.path);
        result = {
          id,
          tier: 'free',
          outcome: verdict.ok ? 'pass' : 'fail',
          detail: verdict.detail,
          attempts: 1,
          tasks: [],
        };
      } else if (browser) {
        const verdict = assessScreen(
          await browser.visit(p.app, p.path, { token: 'key', locale: p.language }),
          plan,
        );
        result = {
          id,
          tier: 'free',
          outcome: verdict.ok ? 'pass' : 'fail',
          detail: verdict.detail,
          attempts: 1,
          tasks: [],
        };
      } else
        result = {
          id,
          tier: 'free',
          outcome: 'skip',
          skipReason: 'unavailable',
          detail: 'no browser',
          attempts: 0,
          tasks: [],
        };
      checks.push({ ...result, group: 'extra', detail: redact(result.detail), ...meta });
    }
  } finally {
    await browser?.close();
  }
  const result: ExtraResult = {
    proposed: accepted.length + rejected.length,
    rejected,
    checks,
    spentKr: Math.round(budget.spent * 100) / 100,
  };
  writeFileSync(join(out, 'extra', 'extra.json'), JSON.stringify(result, null, 2));
  return result;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
