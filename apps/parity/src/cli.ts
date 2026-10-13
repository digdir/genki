import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  compareBaselines,
  mcpRetrieveOnly,
  parseQuestions,
  readBaseline,
  runBaseline,
  writeBaselines,
} from './baseline.js';
import { envSecrets } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import { typesense } from '@genai/providers-typesense';
import { parse as parseYaml } from 'yaml';
import { startPlayback } from './playback.js';
import { measureProfiles } from './profiles.js';
import { autoFilterDetections, compareToggle, renderScore, scoreRetrieval } from './bench.js';
import {
  debugAccessFromEnv,
  headlessRetriever,
  operatorAccessFromEnv,
  platformAttributor,
  platformRetriever,
} from './diagnostics.js';
import {
  loadRecords,
  runQuality,
  servedModels,
  summarizeAnswers,
  summarizeRetrieval,
  type Kind,
} from './quality.js';
import { loadTestSet } from './testsets.js';
import { renderMarkdown, type QualityReport } from './quality-report.js';
import { compare, mergeReports, record, type ScenarioReport } from './runner.js';
import { allScenarios } from './scenarios/index.js';
import { toolName } from './scope.js';
import { anthropicJudge, openAiAsker, openAiJudge, runSweep, type SweepCase } from './sweep.js';
import type { Needs, Side, Target } from './types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envFile = join(root, '.env.parity');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string', default: 'old' },
    only: { type: 'string' },
    skip: { type: 'string', multiple: true, default: [] },
    fixtures: { type: 'string', default: join(root, 'apps', 'parity', 'fixtures') },
    playback: { type: 'boolean', default: false },
    questions: { type: 'string' },
    out: { type: 'string' },
    against: { type: 'string' },
    mode: { type: 'string', default: 'replay' },
    cassette: {
      type: 'string',
      default: join(root, 'apps', 'parity', 'fixtures', 'llm-cassette.json'),
    },
    port: { type: 'string', default: '8790' },
    model: { type: 'string' },
    testset: {
      type: 'string',
      default: join(root, 'apps', 'parity', 'testsets', 'ka-kudos-draft.json'),
    },
    reports: { type: 'string' },
    rerank: { type: 'string' },
    'auto-filter': { type: 'string' },
    'max-acceptable-rank': { type: 'string', default: '10' },
    'fail-on-gate': { type: 'boolean', default: false },
    'relaxed-tool': { type: 'string' },
    kinds: { type: 'string', default: 'retrieval,answer' },
    concurrency: { type: 'string', default: '4' },
    limit: { type: 'string' },
    repeats: { type: 'string', default: '3' },
  },
});

const usage = `usage:
  parity record|compare [--target old|new] [--only <prefix>] [--skip llm|dataset|wave3] [--playback]
  parity baseline --questions <file> --out <dir> [--target old|new]
  parity baseline --out <dir> --against <old-baseline.json> [--target new]
  parity playback --mode record|replay [--cassette <file>] [--port 8790]
  parity sweep --questions <file> [--model <platform agent>] [--repeats 3]
  parity quality [--testset <file>] [--kinds retrieval,answer] [--repeats 3] [--concurrency 4] [--limit N]
  parity quality-profiles [--testset <file>]
  parity quality-report [--testset <file>]
  parity retrieval-score [--testset <file>] [--target old|new|both] [--rerank true|false] [--auto-filter true|false]
  parity rerank-benchmark [--testset <file>] [--target old|new|both] [--max-acceptable-rank 10] [--fail-on-gate]
  parity auto-filter-eval [--testset <file>] [--target old|new|both] [--fail-on-gate]
  parity agent-budget-benchmark [--testset <file>] [--relaxed-tool <tool>] [--repeats 3] [--fail-on-gate]

--testset takes the JSON drafts in apps/parity/testsets or the TestSet YAML files in packages/eval/testsets;
apps/parity/testsets/targets.json says which tools and datasets each set uses on each system.`;

const reportsFor = (testSet: string) =>
  values.reports ??
  (testSet === 'ka-kudos-draft'
    ? join(root, 'apps', 'parity', 'reports')
    : join(root, 'apps', 'parity', 'reports', testSet));

const writeJson = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const targetFor = (name: string): Target => {
  const prefix = name === 'new' ? 'PARITY_NEW' : 'PARITY_OLD';
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!apiKey) fail(`${prefix}_API_KEY is not set; put it in .env.parity`);
  return {
    name,
    baseUrl:
      process.env[`${prefix}_URL`] ??
      (name === 'old' ? 'http://127.0.0.1:8099' : 'http://127.0.0.1:8080'),
    apiKey: apiKey as string,
  };
};

const command = positionals[0];
const side: Side = values.target === 'new' ? 'new' : 'old';

if (command === 'record' || command === 'compare') {
  const target = targetFor(values.target);
  const skipped = new Set(values.skip as Needs[]);
  const scenarios = allScenarios.filter(
    (s) =>
      (!values.only || s.id.startsWith(values.only)) &&
      !(s.needs ?? []).some((n) => skipped.has(n)),
  );
  if (command === 'record') {
    const outcomes = await record(target, scenarios, values.fixtures, side);
    for (const o of outcomes) console.log(`${o.scenario.padEnd(36)} ${o.status}`);
    console.log(
      `\nrecorded ${outcomes.length} scenarios from ${target.baseUrl} into ${values.fixtures}`,
    );
  } else {
    const reports = await compare(target, scenarios, values.fixtures, {
      playback: values.playback,
      side,
    });
    for (const r of reports) {
      console.log(
        `${r.outcome.toUpperCase().padEnd(11)} ${r.scenario}${r.divergence ? `  (${r.divergence})` : ''}`,
      );
      for (const d of r.differences)
        console.log(`    ${d.severity} ${d.step} ${d.path}: ${d.old} -> ${d.new}`);
      if (r.error) console.log(`    error: ${r.error}`);
    }
    const reportFile = join(values.fixtures, 'report.json');
    const previous = existsSync(reportFile)
      ? (JSON.parse(await readFile(reportFile, 'utf8')) as ScenarioReport[])
      : [];
    const excluded = [
      values.only ? `--only ${values.only}` : '',
      ...values.skip.map((s) => `--skip ${s}`),
    ]
      .filter(Boolean)
      .join(' ');
    await writeFile(
      reportFile,
      `${JSON.stringify(mergeReports(previous, reports, allScenarios, `not run yet: excluded by ${excluded}`), null, 2)}\n`,
    );
    const failed = reports.filter(
      (r) => r.outcome === 'fail' || r.outcome === 'error' || r.outcome === 'missing',
    );
    console.log(
      `\n${reports.length - failed.length} of ${reports.length} scenarios pass, diverge as agreed or are skipped`,
    );
    process.exit(failed.length > 0 ? 1 : 0);
  }
} else if (command === 'baseline') {
  const out = values.out ?? fail(usage);
  if (values.against) {
    const target = targetFor(values.target);
    const old = await readBaseline(values.against);
    const questions = old.questions.map((q) => ({
      id: q.id,
      question: q.question,
      dataset: old.dataset,
    }));
    const fresh =
      (await runBaseline(target, questions, mcpRetrieveOnly(toolName('probe', side))))[0] ??
      fail('no questions in the old baseline');
    await writeBaselines(out, [fresh]);
    const results = compareBaselines(old, fresh);
    const exact = results.filter((r) => r.differences.length === 0).length;
    for (const r of results.filter((x) => x.differences.length > 0))
      console.log(`DIFF ${r.question} overlap@10 ${r.overlapAt10.toFixed(2)}`);
    console.log(`\n${exact} of ${results.length} questions match up to tie order`);
    process.exit(exact === results.length ? 0 : 1);
  }
  const file = values.questions ?? fail(usage);
  const questions = parseQuestions(JSON.parse(await readFile(file, 'utf8')));
  const written = await writeBaselines(
    out,
    await runBaseline(
      targetFor(values.target),
      questions,
      mcpRetrieveOnly(toolName('probe', side)),
    ),
  );
  console.log(`wrote ${written.join(', ')}`);
} else if (command === 'playback') {
  const mode = values.mode === 'record' ? 'record' : 'replay';
  const upstreamUrl = process.env.PARITY_LLM_UPSTREAM_URL;
  const upstreamKey = process.env.PARITY_LLM_UPSTREAM_KEY;
  if (mode === 'record' && (!upstreamUrl || !upstreamKey))
    fail('recording needs PARITY_LLM_UPSTREAM_URL and PARITY_LLM_UPSTREAM_KEY in .env.parity');
  const playback = await startPlayback({
    mode,
    cassette: values.cassette,
    port: Number(values.port),
    ...(mode === 'record'
      ? {
          upstream: {
            baseUrl: upstreamUrl as string,
            apiKey: upstreamKey as string,
            auth: process.env.PARITY_LLM_UPSTREAM_AUTH === 'bearer' ? 'bearer' : 'api-key',
          },
        }
      : {}),
  });
  console.log(
    `${mode === 'record' ? 'recording' : 'replaying'} at ${playback.url} with ${values.cassette}`,
  );
  const stop = async () => {
    await playback.close();
    if (playback.misses.length > 0)
      console.log(`${playback.misses.length} requests had no recording`);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} else if (command === 'sweep') {
  const file = values.questions ?? fail(usage);
  const judgeUrl = process.env.PARITY_JUDGE_URL;
  const judgeKey = process.env.PARITY_JUDGE_KEY;
  const judgeModel = process.env.PARITY_JUDGE_MODEL;
  if (!judgeUrl || !judgeKey || !judgeModel)
    fail('sweep needs PARITY_JUDGE_URL, PARITY_JUDGE_KEY and PARITY_JUDGE_MODEL');
  const cases = parseQuestions(JSON.parse(await readFile(file, 'utf8'))) as SweepCase[];
  const report = await runSweep({
    targets: [targetFor('old'), targetFor('new')],
    cases,
    ask: openAiAsker({
      old: toolName('agent', 'old'),
      new: values.model ?? toolName('agent', 'new'),
    }),
    judge: (process.env.PARITY_JUDGE_PROTOCOL === 'anthropic-messages'
      ? anthropicJudge
      : openAiJudge)({
      baseUrl: judgeUrl as string,
      apiKey: judgeKey as string,
      model: judgeModel as string,
    }),
    repeats: Number(values.repeats),
  });
  await writeFile(
    join(values.fixtures, 'sweep-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const t of report.targets)
    console.log(
      `${t.target.padEnd(4)} mean ${t.mean.toFixed(3)} [${t.ci[0].toFixed(3)}, ${t.ci[1].toFixed(3)}]`,
    );
  console.log(
    `paired difference ${report.paired.meanDifference.toFixed(3)} [${report.paired.ci[0].toFixed(3)}, ${report.paired.ci[1].toFixed(3)}]`,
  );
  for (const p of report.problems) console.log(`problem: ${p}`);
  process.exit(report.valid ? 0 : 1);
} else if (
  command === 'quality' ||
  command === 'quality-profiles' ||
  command === 'quality-report' ||
  command === 'agent-budget-benchmark'
) {
  const testSet = await loadTestSet(values.testset);
  const cases = values.limit ? testSet.cases.slice(0, Number(values.limit)) : testSet.cases;
  const reports = reportsFor(testSet.id);
  const runs = join(
    reports,
    command === 'agent-budget-benchmark' ? 'budget-runs.jsonl' : 'quality-runs.jsonl',
  );
  const judgeModel = process.env.PARITY_JUDGE_MODEL;
  const judgeUrl = process.env.PARITY_JUDGE_URL;
  const judgeKey = process.env.PARITY_JUDGE_KEY;
  const judge =
    judgeUrl && judgeKey && judgeModel
      ? (process.env.PARITY_JUDGE_PROTOCOL === 'anthropic-messages' ? anthropicJudge : openAiJudge)(
          {
            baseUrl: judgeUrl,
            apiKey: judgeKey,
            model: judgeModel,
          },
        )
      : undefined;
  const operator = operatorAccessFromEnv(process.env);
  const attribute = operator ? platformAttributor(operator, 'new') : undefined;
  if (command === 'quality') {
    const kinds = values.kinds.split(',').filter(Boolean) as Kind[];
    if (kinds.includes('answer') && !judge)
      fail('answers need PARITY_JUDGE_URL, PARITY_JUDGE_KEY and PARITY_JUDGE_MODEL');
    if (kinds.includes('answer') && !attribute)
      console.log(
        'no PARITY_NEW_OPERATOR_TOKEN and PARITY_NEW_SUPPORT_SESSION: answers run without stage attribution',
      );
    await runQuality({
      cases,
      targets: [targetFor('old'), targetFor('new')],
      kinds,
      repeats: Number(values.repeats),
      concurrency: Number(values.concurrency),
      file: runs,
      tools: { old: testSet.profile.old, new: testSet.profile.new },
      ...(attribute ? { attribute } : {}),
      ...(judge ? { judge } : {}),
      onProgress: (done, total, errors) => {
        if (done % 10 === 0 || done === total)
          console.log(`${done}/${total} calls, ${errors} errors`);
      },
    });
    console.log(`runs written to ${runs}`);
  } else if (command === 'agent-budget-benchmark') {
    const relaxed =
      values['relaxed-tool'] ??
      testSet.profile.new.relaxedAgent ??
      fail(`no relaxed agent for ${testSet.id}; pass --relaxed-tool`);
    const fresh = targetFor('new');
    await runQuality({
      cases,
      targets: [
        { ...fresh, name: 'current' },
        { ...fresh, name: 'relaxed' },
      ],
      kinds: ['answer'],
      repeats: Number(values.repeats),
      concurrency: Number(values.concurrency),
      file: runs,
      tools: {
        current: testSet.profile.new,
        relaxed: { ...testSet.profile.new, agent: relaxed },
      },
      ...(operator
        ? { attribute: async (t, run) => await platformAttributor(operator, t.name)(t, run) }
        : {}),
      ...(judge ? { judge } : {}),
    });
    const records = await loadRecords(runs);
    const summary = summarizeAnswers(cases, records, ['current', 'relaxed']);
    await writeJson(join(reports, 'agent-budget-benchmark.json'), {
      testSet: testSet.id,
      tools: { current: testSet.profile.new.agent, relaxed },
      servedModels: servedModels(records, ['current', 'relaxed']),
      summary,
    });
    for (const s of summary.systems)
      console.log(
        `${s.target.padEnd(8)} judge ${s.score?.mean.toFixed(3) ?? 'n/a'}  pattern ${s.patternMatch?.toFixed(3) ?? 'n/a'}  false refusal ${s.falseRefusal?.toFixed(3) ?? 'n/a'}  read ${s.stages.read?.toFixed(3) ?? 'n/a'}  p50 ${s.latencyMs.p50 ?? 'n/a'} ms`,
      );
    const gate = values['fail-on-gate'] && (summary.paired?.ci[1] ?? 0) < 0;
    process.exit(gate ? 1 : 0);
  } else if (command === 'quality-profiles') {
    const local = join(root, '.env.local');
    if (existsSync(local)) process.loadEnvFile(local);
    const raw = (
      await readFile(join(root, 'apps', 'api', 'config', 'local', 'knowledge.yaml'), 'utf8')
    ).replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => process.env[name] ?? m);
    const knowledge = new KnowledgeRouter({
      catalog: parseYaml(raw),
      adapters: [typesense],
      secrets: envSecrets(),
    }).open(
      { kind: 'dataset', id: testSet.profile.new.dataset ?? testSet.profile.corpus },
      {
        tenant: '991825827',
        principal: { kind: 'operator', issuer: 'parity', subject: 'quality' },
        task: 'parity-quality',
        signal: new AbortController().signal,
        meter: async () => undefined,
      },
    );
    const summary = await measureProfiles(cases, knowledge, ['phrase', 'metadata', 'content'], 30);
    await writeJson(join(reports, 'quality-profiles.json'), summary);
    console.log(
      JSON.stringify({ recall: summary.recall, union: summary.union, cases: summary.cases }),
    );
  } else {
    const records = await loadRecords(runs);
    const targets: [string, string] = ['old', 'new'];
    const profilesFile = join(reports, 'quality-profiles.json');
    const repeats = Math.max(0, ...records.map((r) => r.repeat + 1));
    const report: QualityReport = {
      provisional: testSet.provisional,
      testSet: {
        id: testSet.id,
        source: testSet.source,
        status: testSet.status,
        cases: cases.length,
        corpus: testSet.profile.corpus,
      },
      generatedAt: new Date().toISOString(),
      repeats,
      ...(judge ? { judge: { id: judge.id, model: judge.model } } : {}),
      ...(records.some((r) => r.kind === 'answer')
        ? {
            servedModels: servedModels(records, targets, {
              old: process.env.PARITY_OLD_SERVED_MODEL,
              new: process.env.PARITY_NEW_SERVED_MODEL,
            }),
          }
        : {}),
      ...(records.some((r) => r.kind === 'retrieval')
        ? { retrieval: summarizeRetrieval(cases, records, targets) }
        : {}),
      ...(records.some((r) => r.kind === 'answer')
        ? { answers: summarizeAnswers(cases, records, targets) }
        : {}),
      ...(existsSync(profilesFile)
        ? { profiles: JSON.parse(await readFile(profilesFile, 'utf8')) }
        : {}),
      notes: [
        'Neither system reports token usage over MCP, so cost per answer is not compared here.',
        'headless-rag returns its top chunks after reranking (often 3 to 5); the platform returns up to 10, which limits overlap and favours the platform on recall at 10.',
        'Both systems plan queries with a language model, so retrieval varies between repeats; stability shows how much. retrieval-score gives the deterministic fixed-query comparison.',
        'Refusal rates use a keyword heuristic and undercount refusals worded in other ways; the judge scores on the not-covered tag are the better signal.',
        'Search profile recall uses the raw question with no planner and no auto-filters, so it measures the profiles alone, not the full pipeline.',
        'Stage attribution (search pool, displayed, read) comes from the platform task log through the operator diagnostics; headless-rag exposes no stages over HTTP, so its column stays empty.',
      ],
    };
    await writeJson(join(reports, 'quality-report.json'), report);
    await writeFile(join(reports, 'quality-report.md'), renderMarkdown(report));
    console.log(renderMarkdown(report));
  }
} else if (
  command === 'retrieval-score' ||
  command === 'rerank-benchmark' ||
  command === 'auto-filter-eval'
) {
  const testSet = await loadTestSet(values.testset);
  const cases = values.limit ? testSet.cases.slice(0, Number(values.limit)) : testSet.cases;
  const reports = reportsFor(testSet.id);
  const wanted = values.target === 'both' ? ['old', 'new'] : [values.target];
  const retrievers = wanted.map((name) => {
    if (name === 'new') {
      const access =
        operatorAccessFromEnv(process.env) ??
        fail('the new platform needs PARITY_NEW_OPERATOR_TOKEN and PARITY_NEW_SUPPORT_SESSION');
      const service = testSet.profile.new.retrieveService ?? testSet.profile.new.service;
      return {
        name,
        retriever: platformRetriever(
          access,
          service
            ? { service }
            : { dataset: testSet.profile.new.dataset ?? testSet.profile.corpus },
        ),
      };
    }
    const access =
      debugAccessFromEnv(process.env) ??
      fail('headless-rag needs PARITY_OLD_DEBUG_KEY and RAG_TS_RETRIEVE_ENABLED=true on its side');
    const args = testSet.profile.old.arguments;
    return {
      name,
      retriever: headlessRetriever(access, {
        tenant: String(args.tenant),
        datasetConfigKey: String(args.dataset_config_key),
      }),
    };
  });
  const maxRank = Number(values['max-acceptable-rank']);
  const results: Record<string, unknown> = {};
  let gateFailed = false;
  for (const { name, retriever } of retrievers) {
    if (command === 'retrieval-score') {
      const score = await scoreRetrieval(cases, retriever, {
        ...(values.rerank === undefined ? {} : { rerank: values.rerank === 'true' }),
        ...(values['auto-filter'] === undefined
          ? {}
          : { autoFilter: values['auto-filter'] === 'true' }),
      });
      results[name] = score;
      console.log(renderScore(name, score));
    } else if (command === 'rerank-benchmark') {
      const comparison = await compareToggle(
        'rerank',
        cases,
        retriever,
        (on) => ({ rerank: on }),
        maxRank,
      );
      results[name] = comparison;
      console.log(renderScore(`${name} rerank off`, comparison.off));
      console.log(renderScore(`${name} rerank on`, comparison.on));
      console.log(`${name} gate: ${comparison.gate.failures.length} cases past rank ${maxRank}`);
      gateFailed ||= comparison.gate.failures.length > 0 || !comparison.valid;
    } else {
      const comparison = await compareToggle(
        'auto-filter',
        cases,
        retriever,
        (on) => ({ autoFilter: on }),
        maxRank,
      );
      const detections = autoFilterDetections(cases, comparison.on);
      results[name] = { ...comparison, detections };
      console.log(renderScore(`${name} auto-filter off`, comparison.off));
      console.log(renderScore(`${name} auto-filter on`, comparison.on));
      console.log(`${name} year detected in ${detections.matched} of ${detections.checked} cases`);
      gateFailed ||= detections.matched < detections.checked || !comparison.valid;
    }
  }
  await writeJson(join(reports, `${command}.json`), {
    testSet: testSet.id,
    corpus: testSet.profile.corpus,
    generatedAt: new Date().toISOString(),
    results,
  });
  process.exit(values['fail-on-gate'] && gateFailed ? 1 : 0);
} else {
  fail(usage);
}
