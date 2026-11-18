/**
 * Benchmarks one dataset on two search engines with the platform's own evaluators: the same
 * test set and judges run against two services that differ only in the dataset they name, for
 * example `digdir/kudos` on Typesense and `digdir/kudos-pg` copied into the knowledge database
 * (issues 366 and 393). Dev tooling: it calls the public API as you, nothing more.
 *
 *   tsx scripts/engine-benchmark.ts dataset --from digdir/kudos --to digdir/kudos-pg --reason "..."
 *   tsx scripts/engine-benchmark.ts service --from kunnskapsassistenten --to kunnskapsassistenten-pg \
 *     --dataset digdir/kudos=digdir/kudos-pg --reason "..."
 *   tsx scripts/engine-benchmark.ts run --baseline kunnskapsassistenten \
 *     --candidate kunnskapsassistenten-pg --test-set ka-kudos-draft [--evaluators retrieval,answer-quality]
 *     [--repeats 3] [--splits train,validation]
 *   tsx scripts/engine-benchmark.ts compare --baseline-run <id> --candidate-run <id>
 *
 * `dataset` copies a catalog entry under a new id (without its aliases), on the same engine; move
 * it to the knowledge database in the console afterwards, which shows the cost first. `service`
 * publishes a copy of a service with one dataset swapped and its risk class confirmed by you.
 * `run` starts one eval run per service, waits for both, and compares every metric they share:
 * each run's mean, the paired difference per case with a 95% bootstrap interval, and per-case
 * wins and losses. Search can answer differently from one run to the next (the same runs gave
 * recall@10 0.67 and 0.75 on Typesense), so use `--repeats` for a number to act on. The report goes to stdout and, as JSON and CSV, to `--out` (default
 * `.data/engine-benchmark/<time>`). The API's own comparison refuses runs on different data, so the
 * script compares them itself.
 *
 * Login: against genki-test, set GENKI_API_BASE (https) and ADMIN_MCP_CLIENT_ID (the console's
 * client id), and the browser opens for Ansattporten, as for the genki-admin MCP server
 * (apps/admin-mcp/README.md; ANSATTPORTEN_ISSUER, GENKI_AUDIENCE, GENKI_ALTINN_RESOURCE and
 * ADMIN_MCP_REDIRECT_URI as there). Locally, GENKI_DEV_LOGIN=kari (or another mock person) uses
 * the API's mock login. GENKI_TENANT defaults to Digdir, 991825827.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireSafeUrl } from '../apps/admin-mcp/src/client.js';
import { sessionToken } from '../apps/admin-mcp/src/login.js';

const env = (name: string) => process.env[name]?.trim() || undefined;
const required = (name: string) => {
  const value = env(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const apiBase = requireSafeUrl('GENKI_API_BASE', env('GENKI_API_BASE') ?? 'http://localhost:8080');
const api = apiBase.replace(/\/+$/, '');
const tenant = env('GENKI_TENANT') ?? '991825827';

const openBrowser = (url: string) => {
  console.error(`log in to genki in the browser: ${url}`);
  const [command, ...args] = process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  spawn(command as string, args, { stdio: 'ignore', detached: true }).unref();
};

const tokenSource = (() => {
  const devLogin = env('GENKI_DEV_LOGIN');
  if (devLogin) {
    let token: Promise<string> | undefined;
    return async () =>
      (token ??= fetch(`${api}/mock/dev-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ as: devLogin }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`dev login answered ${r.status}; it exists only on a local API`);
        return ((await r.json()) as { token: string }).token;
      }));
  }
  const session = sessionToken({
    issuer: requireSafeUrl(
      'ANSATTPORTEN_ISSUER',
      env('ANSATTPORTEN_ISSUER') ?? 'https://test.ansattporten.no',
    ),
    clientId: required('ADMIN_MCP_CLIENT_ID'),
    audience: env('GENKI_AUDIENCE') ?? 'digdir:genai',
    altinnResource:
      env('GENKI_ALTINN_RESOURCE') ?? 'urn:altinn:resource:digdir-genai-platform-test',
    redirectUri: env('ADMIN_MCP_REDIRECT_URI') ?? 'http://localhost:5173/callback',
    open: openBrowser,
  });
  return () => session.get();
})();

const call = async <T>(
  method: string,
  path: string,
  options: { body?: unknown; reason?: string } = {},
): Promise<T> => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await tokenSource()}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.reason ? { 'change-reason': encodeURIComponent(options.reason) } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const reasonOf = (value: string | undefined) => {
  if (!value || value.trim().length < 10)
    throw new Error('--reason is required, at least 10 characters; it goes to the audit log');
  return value;
};

// --- dataset -------------------------------------------------------------------------------

const copyDataset = async (from: string, to: string, reason: string) => {
  const source = await call<{ spec: Record<string, unknown> }>(
    'GET',
    `/operator/catalog/dataset/${enc(from)}`,
  );
  const { aliases: _aliases, ...spec } = source.spec;
  void _aliases;
  const created = await call<{ id: string; version: number; spec: { endpoint: string } }>(
    'PUT',
    `/operator/catalog/dataset/${enc(to)}`,
    { body: { ...spec, name: `${String(spec.name)} (benchmark)` }, reason },
  );
  console.log(
    `${created.id} version ${created.version} on ${created.spec.endpoint}. Move it to the knowledge database in the console: Katalog, Datasett, ${created.id}.`,
  );
};

// --- service -------------------------------------------------------------------------------

interface Definition {
  kind: string;
  metadata: Record<string, unknown> & { id: string; name?: string };
  spec: Record<string, unknown> & {
    riskClass?: string;
    knowledge?: { datasets?: { dataset: string }[] };
  };
}

const copyService = async (from: string, to: string, swaps: string[], reason: string) => {
  const found = await call<{ latest?: { definition: Definition } }>(
    'GET',
    `/tenants/${tenant}/definitions/services/${enc(from)}`,
  );
  if (!found.latest) throw new Error(`no published service ${from}`);
  const definition = structuredClone(found.latest.definition);
  const datasets = definition.spec.knowledge?.datasets ?? [];
  for (const swap of swaps) {
    const [old, next] = swap.split('=');
    const entry = datasets.find((d) => d.dataset === old);
    if (!entry || !next) throw new Error(`${from} names no dataset ${old}`);
    entry.dataset = next;
  }
  definition.metadata = {
    ...definition.metadata,
    id: to,
    name: `${definition.metadata.name ?? from} (benchmark)`,
  };
  delete definition.metadata.version;
  const riskClass = definition.spec.riskClass;
  if (riskClass === 'limited' || riskClass === 'high') {
    await call('POST', `/tenants/${tenant}/services/${enc(to)}/risk-confirmations`, {
      body: { riskClass, reasons: [`A copy of ${from} for an engine benchmark`] },
      reason,
    });
    definition.spec.riskConfirmation = { riskClass };
  }
  const draft = await call<{ revision: number }>(
    'PUT',
    `/tenants/${tenant}/services/${enc(to)}/draft`,
    { body: { definition, files: {} }, reason },
  );
  await call('POST', '/definitions', {
    body: { definition, files: {}, draftRevision: draft.revision },
    reason,
  });
  console.log(
    `${to} published, naming ${datasets.map((d) => d.dataset).join(', ')}. List the same test sets as ${from} in its evaluation if the portal should show them.`,
  );
};

// --- run and compare -----------------------------------------------------------------------

interface Score {
  metric: string;
  value: number | null;
  applicable?: boolean;
}
interface CaseResult {
  case: string;
  split?: string;
  repeat?: number;
  scores: Score[];
}
interface Run {
  id: string;
  capability: string;
  provenance: Record<string, unknown>;
  metrics?: Record<string, { mean: number; n: number; ci?: [number, number] }>;
  results: CaseResult[];
}

const startRun = async (
  service: string,
  variant: string,
  testSet: string,
  evaluators: string[],
  splits: string[] | undefined,
  repeats: number,
  reason: string,
) => {
  const started = await call<{ task: string }>('POST', `/tenants/${tenant}/eval-runs`, {
    body: {
      capability: `${tenant}/${service}/${variant}`,
      testSet: { id: testSet },
      evaluators,
      provenance: { commit: env('GENKI_COMMIT') ?? 'engine-benchmark', data: service },
      ...(splits ? { splits } : {}),
      ...(repeats > 1 ? { repeats } : {}),
    },
    reason,
  });
  console.error(`${service}: eval task ${started.task}`);
  return started.task;
};

const waitFor = async (task: string) => {
  for (;;) {
    const status = await call<{ state: string; run?: string; error?: string }>(
      'GET',
      `/eval-tasks/${task}`,
    );
    if (status.state === 'completed' && status.run) return status.run;
    if (status.state !== 'running' && status.state !== 'queued')
      throw new Error(`eval task ${task} ${status.state}: ${status.error ?? ''}`);
    await sleep(10_000);
  }
};

const readRun = async (id: string) => {
  const found = await call<Run | { run: Run }>('GET', `/eval-runs/${id}`);
  return 'run' in found ? found.run : found;
};

/** Each case's mean on one metric over its repeats, cases where the metric did not apply left out. */
const perCase = (run: Run, metric: string) => {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const result of run.results)
    for (const score of result.scores) {
      if (score.metric !== metric || typeof score.value !== 'number') continue;
      const at = sums.get(result.case) ?? { sum: 0, n: 0 };
      sums.set(result.case, { sum: at.sum + score.value, n: at.n + 1 });
    }
  return new Map([...sums].map(([k, { sum, n }]) => [k, sum / n]));
};

const metricsOf = (run: Run) =>
  new Set(
    run.results.flatMap((r) =>
      r.scores.filter((s) => typeof s.value === 'number').map((s) => s.metric),
    ),
  );

// A seeded generator, so a report can be computed again with the same interval.
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const bootstrap = (diffs: number[], rounds = 10_000) => {
  const random = seeded(366);
  const means: number[] = [];
  for (let i = 0; i < rounds; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++)
      sum += diffs[Math.floor(random() * diffs.length)] as number;
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(rounds * 0.025)] as number, means[Math.floor(rounds * 0.975)] as number];
};

const fixed = (n: number) => n.toFixed(3);

const compare = async (baselineId: string, candidateId: string, out: string) => {
  const [baseline, candidate] = await Promise.all([readRun(baselineId), readRun(candidateId)]);
  const shared = [...metricsOf(baseline)].filter((m) => metricsOf(candidate).has(m)).sort();
  if (shared.length === 0) throw new Error('the two runs share no scored metric');
  const rows = shared.map((metric) => {
    const a = perCase(baseline, metric);
    const b = perCase(candidate, metric);
    const cases = [...a.keys()].filter((k) => b.has(k)).sort();
    const diffs = cases.map((k) => (b.get(k) as number) - (a.get(k) as number));
    const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
    return {
      metric,
      cases: cases.length,
      baseline: mean(cases.map((k) => a.get(k) as number)),
      candidate: mean(cases.map((k) => b.get(k) as number)),
      difference: mean(diffs),
      ci: bootstrap(diffs),
      better: diffs.filter((d) => d > 0).length,
      worse: diffs.filter((d) => d < 0).length,
      same: diffs.filter((d) => d === 0).length,
      perCase: cases.map((k) => ({ case: k, baseline: a.get(k), candidate: b.get(k) })),
    };
  });

  console.log(`baseline  ${baseline.capability}  (run ${baseline.id})`);
  console.log(`candidate ${candidate.capability}  (run ${candidate.id})\n`);
  console.log(
    ['metric', 'cases', 'baseline', 'candidate', 'difference', '95% CI', 'better/worse/same'].join(
      '\t',
    ),
  );
  for (const r of rows)
    console.log(
      [
        r.metric,
        r.cases,
        fixed(r.baseline),
        fixed(r.candidate),
        (r.difference >= 0 ? '+' : '') + fixed(r.difference),
        `[${fixed(r.ci[0] as number)}, ${fixed(r.ci[1] as number)}]`,
        `${r.better}/${r.worse}/${r.same}`,
      ].join('\t'),
    );
  console.log(
    '\nDifference is candidate minus baseline per case; an interval that holds 0 is no clear difference.',
  );

  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, 'report.json'),
    JSON.stringify(
      {
        baseline: {
          run: baseline.id,
          capability: baseline.capability,
          provenance: baseline.provenance,
        },
        candidate: {
          run: candidate.id,
          capability: candidate.capability,
          provenance: candidate.provenance,
        },
        metrics: rows,
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(out, 'cases.csv'),
    [
      'metric,case,baseline,candidate',
      ...rows.flatMap((r) =>
        r.perCase.map((c) => `${r.metric},${c.case},${c.baseline},${c.candidate}`),
      ),
    ].join('\n'),
  );
  console.log(`\nreport.json and cases.csv in ${out}`);
};

// --- main ----------------------------------------------------------------------------------

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    dataset: { type: 'string', multiple: true },
    reason: { type: 'string' },
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    variant: { type: 'string', default: 'default' },
    'test-set': { type: 'string' },
    evaluators: { type: 'string', default: 'retrieval' },
    splits: { type: 'string' },
    repeats: { type: 'string', default: '1' },
    'baseline-run': { type: 'string' },
    'candidate-run': { type: 'string' },
    out: { type: 'string' },
  },
});

const out =
  values.out ?? join('.data', 'engine-benchmark', new Date().toISOString().replace(/[:.]/g, '-'));
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== 'string' || !value) throw new Error(`--${name} is required`);
  return value;
};

const command = positionals[0];
if (command === 'dataset') {
  await copyDataset(need('from'), need('to'), reasonOf(values.reason));
} else if (command === 'service') {
  await copyService(need('from'), need('to'), values.dataset ?? [], reasonOf(values.reason));
} else if (command === 'run') {
  const evaluators = (values.evaluators ?? 'retrieval').split(',').filter(Boolean);
  const splits = values.splits?.split(',').filter(Boolean);
  const reason = values.reason ?? 'Benchmark: one dataset on two search engines';
  const repeats = Number(values.repeats ?? '1');
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error('--repeats is a whole number, 1 or more');
  const services = [need('baseline'), need('candidate')];
  const tasks = await Promise.all(
    services.map((s) =>
      startRun(
        s,
        values.variant ?? 'default',
        need('test-set'),
        evaluators,
        splits,
        repeats,
        reason,
      ),
    ),
  );
  const [baselineRun, candidateRun] = await Promise.all(tasks.map(waitFor));
  await compare(baselineRun as string, candidateRun as string, out);
} else if (command === 'compare') {
  await compare(need('baseline-run'), need('candidate-run'), out);
} else {
  console.error(
    'usage: tsx scripts/engine-benchmark.ts dataset | service | run | compare (see the comment at the top)',
  );
  process.exitCode = 2;
}
