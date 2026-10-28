// Retrieval-only comparison for the Kudos pilot (genki issue 92): every ka-kudos-draft question goes to
// Kunnskapsassistenten's retrieve-only service on a local Typesense that holds only the pilot's documents
// (digdir/kudos-local-typesense, copied by benchmarks/kudos-pilot/copy_typesense.py), and to the same service on
// digdir/kudos-next in pgvector. Both rerank with ColBERT. Scored per document; paired bootstrap. A third side,
// typesense-blind, is the Typesense service with the planner's corpus step off (planner.expansionMode: blind).
//
//   npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts run [rounds] [side,side]
//   npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts compare <run.json>... [baseline candidate]
//   npx tsx --conditions=source packages/eval/src/scripts/kudos-pilot-compare.ts verdicts <dir> <run.json>... [side,side]
//
// `run` asks each question of every side back to back (typesense and pgvector by default), in `rounds` rounds (3 by
// default), so the sides meet the same load and the same planner variance; `compare` scores candidate against
// baseline (typesense and pgvector by default), each question averaged over its rounds, taking each side's rounds
// from whichever run files hold it. `verdicts` writes each side's per-question scores, averaged over its rounds, to
// <dir>/<side>.jsonl for the benchmarks' report.py (benchmarks/kudos-pilot/engines and embeddings).
//
// Needs a running API in dev mode (KUDOS_PILOT_API, default http://localhost:8096) and DEV_API_KEY. Looks up shared
// chunk ids in the local Typesense (TYPESENSE_LOCAL_URL, default http://127.0.0.1:8108, key in
// benchmarks/kudos-pilot/.data/typesense-local-key). KUDOS_PILOT_LIMIT asks only the first questions, for a smoke
// run. Writes to benchmarks/kudos-pilot/.data.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { pairedBootstrap } from '../stats.js';
import type { TestSet } from '../schema.js';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const envFile = join(root, '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const api = process.env.KUDOS_PILOT_API ?? 'http://localhost:8096';
const pilot = join(root, 'benchmarks', 'kudos-pilot');
const out = join(pilot, '.data');

// Each side is a service; its engine says how its documents are named and whether its chunk ids can be shared.
// The self-hosted models of benchmarks/kudos-pilot/models.json are sides too, each on its own API
type Engine = 'typesense' | 'pgvector';
interface SideOption {
  service: string;
  engine: Engine;
  label: string;
  api?: string;
}
const localModels = (
  JSON.parse(readFileSync(join(pilot, 'models.json'), 'utf8')) as {
    models: { key: string; hf: string; name?: string; api: number }[];
  }
).models;
const sideOptions: Record<string, SideOption> = {
  typesense: {
    service: 'kudos-pilot-typesense-retrieve-only__default',
    engine: 'typesense',
    label: 'Typesense',
  },
  'typesense-blind': {
    service: 'kudos-pilot-typesense-blind-retrieve-only__default',
    engine: 'typesense',
    label: 'Typesense, phrase step off',
  },
  pgvector: {
    service: 'kudos-pilot-retrieve-only__default',
    engine: 'pgvector',
    label: 'pgvector',
  },
  ...Object.fromEntries(
    localModels.map((m) => [
      m.key,
      {
        service: `kudos-pilot-${m.key}-retrieve-only__default`,
        engine: 'pgvector' as const,
        label: `pgvector, ${m.name ?? m.hf}`,
        api: `http://localhost:${m.api}`,
      },
    ]),
  ),
};
type Side = string;
const isSide = (s: string): s is Side => s in sideOptions;
const optionsOf = (side: Side): SideOption => {
  const options = sideOptions[side];
  if (!options) throw new Error(`unknown side ${side}`);
  return options;
};
const engineOf = (side: Side): Engine => optionsOf(side).engine;
const labelOf = (side: Side) => optionsOf(side).label;

interface SampleDocument {
  uuid: string;
  old_id: string | null;
}
const sample = (
  JSON.parse(readFileSync(join(pilot, 'sample.json'), 'utf8')) as { documents: SampleDocument[] }
).documents;
// Typesense names a document by its old numeric id, pgvector by its KUDOS UUID; a few old ids have two UUIDs
const pilotOld = new Set(sample.flatMap((d) => (d.old_id ? [d.old_id] : [])));
const oldOf = new Map(sample.flatMap((d) => (d.old_id ? [[d.uuid, d.old_id] as const] : [])));

// The local Typesense's Kudos chunks, from the digdir/kudos-local-typesense dataset in the local catalog
const knowledge = parseYaml(
  readFileSync(join(root, 'apps', 'api', 'config', 'local', 'knowledge.yaml'), 'utf8'),
) as { datasets: { id: string; options?: { collections?: { chunks?: string } } }[] };
const typesenseChunks = knowledge.datasets.find((d) => d.id === 'digdir/kudos-local-typesense')
  ?.options?.collections?.chunks;
const typesense = {
  url: process.env.TYPESENSE_LOCAL_URL ?? 'http://127.0.0.1:8108',
  // Read when a run looks up chunk ids, so `compare` works on saved runs without the local Typesense
  key: () => readFileSync(join(out, 'typesense-local-key'), 'utf8').trim(),
};

interface Case {
  id: string;
  split: string;
  question: string;
  expected: string[];
}
const testSet = parseYaml(
  readFileSync(join(root, 'packages', 'eval', 'testsets', 'ka-kudos-draft.yaml'), 'utf8'),
) as TestSet;
const cases: Case[] = testSet.spec.cases.flatMap((c) => {
  const expected = [
    ...new Set((c.expected?.sources ?? []).flatMap((s) => (s.document ? [s.document] : []))),
  ];
  const question =
    typeof c.input === 'string'
      ? c.input
      : (c.input.parts ?? []).map((p) => String((p as { text?: unknown }).text ?? '')).join(' ');
  return expected.length === 0 ? [] : [{ id: c.id, split: c.split ?? 'train', question, expected }];
});
const asked = cases.slice(0, Number(process.env.KUDOS_PILOT_LIMIT ?? cases.length));

interface Source {
  chunk: string;
  document: string;
}
interface Answer {
  sources: Source[];
  latencyMs: number;
  // Typesense only: every document that holds each chunk, since its chunk ids are not unique across documents
  holders?: Record<string, string[]>;
  error?: string;
}
type Round = Partial<Record<Side, Record<string, Answer>>>;

const ask = async (side: Side, question: string): Promise<Answer> => {
  const started = performance.now();
  const response = await fetch(`${optionsOf(side).api ?? api}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.DEV_API_KEY ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: optionsOf(side).service,
      messages: [{ role: 'user', content: question }],
    }),
  });
  const latencyMs = Math.round(performance.now() - started);
  const body = (await response.json()) as {
    sources?: { document_id?: string; source?: { id?: string } }[];
    error?: unknown;
  };
  if (!response.ok) return { sources: [], latencyMs, error: JSON.stringify(body.error ?? body) };
  const sources = (body.sources ?? []).map((s) => ({
    chunk: String(s.source?.id ?? ''),
    document: String(s.document_id ?? ''),
  }));
  return engineOf(side) === 'typesense'
    ? { sources, latencyMs, holders: await holdersOf(sources.map((s) => s.chunk)) }
    : { sources, latencyMs };
};

// Every document in the local Typesense that holds each chunk id, page by page
const holdersOf = async (chunks: string[]): Promise<Record<string, string[]>> => {
  const ids = [...new Set(chunks.filter((c) => /^[\w-]+$/.test(c)))];
  if (ids.length === 0 || !typesenseChunks) return {};
  const holders: Record<string, string[]> = {};
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({
      q: '*',
      filter_by: `chunk_id:=[${ids.join(',')}]`,
      include_fields: 'chunk_id,doc_num',
      per_page: '250',
      page: String(page),
    });
    const response = await fetch(
      `${typesense.url}/collections/${typesenseChunks}/documents/search?${params}`,
      { headers: { 'X-TYPESENSE-API-KEY': typesense.key() } },
    );
    const body = (await response.json()) as {
      found?: number;
      hits?: { document: { chunk_id: string; doc_num: string | number } }[];
    };
    for (const { document } of body.hits ?? [])
      holders[document.chunk_id] = [
        ...(holders[document.chunk_id] ?? []),
        String(document.doc_num),
      ];
    if ((body.hits ?? []).length === 0 || page * 250 >= (body.found ?? 0)) return holders;
  }
};

const run = async (rounds: number, sides: Side[]) => {
  const results: Round[] = [];
  for (let round = 1; round <= rounds; round++) {
    const answers: Round = Object.fromEntries(sides.map((s) => [s, {}]));
    for (const [i, c] of asked.entries())
      for (const side of sides) {
        const answer = await ask(side, c.question);
        (answers[side] ??= {})[c.id] = answer;
        console.log(
          `round ${round} ${i + 1}/${asked.length} ${side} ${c.id} ${answer.error ?? ''}`,
        );
      }
    results.push(answers);
  }
  mkdirSync(out, { recursive: true });
  const file = join(out, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const services = Object.fromEntries(sides.map((s) => [s, optionsOf(s).service]));
  writeFileSync(file, JSON.stringify({ api, services, rounds: results }, null, 2));
  console.log(`wrote ${file}`);
};

// The pilot documents of an answer in rank order, each once, by old id. `credited` also counts the other pilot
// documents that hold a Typesense chunk, since Typesense may have served a copy of it from a document outside
const ranking = (side: Side, answer: Answer, credited: boolean) => {
  const ranked: string[] = [];
  for (const { chunk, document } of answer.sources) {
    const own = engineOf(side) === 'typesense' ? document : oldOf.get(document);
    const shared = credited ? (answer.holders?.[chunk] ?? []) : [];
    for (const doc of [own, ...shared])
      if (doc !== undefined && pilotOld.has(doc) && !ranked.includes(doc)) ranked.push(doc);
  }
  return ranked;
};

// Document-level scores for one ranking: recall at 5 and 10, reciprocal rank and nDCG at 10
const scores = (expected: string[], ranked: string[]) => {
  const ranks = expected
    .map((doc) => ranked.indexOf(doc) + 1)
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  const recall = (k: number) => ranks.filter((r) => r <= k).length / expected.length;
  const dcg = ranks.filter((r) => r <= 10).reduce((sum, r) => sum + 1 / Math.log2(r + 1), 0);
  const ideal = Array.from(
    { length: Math.min(expected.length, 10) },
    (_, i) => 1 / Math.log2(i + 2),
  ).reduce((a, b) => a + b, 0);
  return {
    'Recall@10': recall(10),
    'Recall@5': recall(5),
    MRR: ranks[0] ? 1 / ranks[0] : 0,
    'nDCG@10': dcg / ideal,
  };
};
const metrics = ['Recall@10', 'Recall@5', 'MRR', 'nDCG@10'] as const;
type Scores = ReturnType<typeof scores>;

// Each side's rounds, from whichever of the run files asked it
const roundsFrom = (files: string[]) => {
  const loaded = files.map(
    (f) => (JSON.parse(readFileSync(f, 'utf8')) as { rounds: Round[] }).rounds,
  );
  return (side: Side): Record<string, Answer>[] =>
    loaded.flatMap((rounds) => rounds.flatMap((r) => (r[side] ? [r[side]] : [])));
};

// One question's scores averaged over a side's rounds; only a Typesense side can be credited
const averagedOver = (
  rounds: Record<string, Answer>[],
  side: Side,
  c: Case,
  credited: boolean,
): Scores => {
  const each = rounds.map((r) =>
    scores(
      c.expected,
      ranking(side, r[c.id] as Answer, credited && engineOf(side) === 'typesense'),
    ),
  );
  return Object.fromEntries(
    metrics.map((m) => [m, each.reduce((sum, s) => sum + s[m], 0) / each.length]),
  ) as Scores;
};

// Per side, one line per question: its scores as served and credited, averaged over the side's rounds
const verdicts = (dir: string, files: string[], named: Side[]) => {
  const roundsOf = roundsFrom(files);
  const held = Object.keys(sideOptions).filter((s) => roundsOf(s).length > 0);
  mkdirSync(dir, { recursive: true });
  for (const side of named.length > 0 ? named : held) {
    const rounds = roundsOf(side);
    if (rounds.length === 0) throw new Error(`no rounds for ${side} in ${files.join(', ')}`);
    const lines = cases.map((c) => {
      const answered = rounds.filter((r) => r[c.id] && !r[c.id]?.error);
      return JSON.stringify({
        item: c.id,
        split: c.split,
        documents: c.expected,
        rounds: rounds.length,
        errors: rounds.length - answered.length,
        latencyMs: answered.map((r) => (r[c.id] as Answer).latencyMs),
        served: answered.length === rounds.length ? averagedOver(rounds, side, c, false) : null,
        credited: answered.length === rounds.length ? averagedOver(rounds, side, c, true) : null,
      });
    });
    writeFileSync(join(dir, `${side}.jsonl`), lines.join('\n') + '\n');
    console.log(`wrote ${join(dir, `${side}.jsonl`)} (${rounds.length} rounds)`);
  }
};

const compare = (files: string[], baseline: Side, candidate: Side) => {
  const roundsOf = roundsFrom(files);
  const sides = [baseline, candidate];
  const missing = sides.filter((s) => roundsOf(s).length === 0);
  if (missing.length > 0)
    throw new Error(`no rounds for ${missing.join(', ')} in ${files.join(', ')}`);
  const usable = cases.filter((c) =>
    sides.every((s) => roundsOf(s).every((r) => r[c.id] && !r[c.id]?.error)),
  );
  const averaged = (side: Side, c: Case, credited: boolean): Scores =>
    averagedOver(roundsOf(side), side, c, credited);
  const pct = (x: number) => (x * 100).toFixed(1);
  const header = `| Metric (document level) | ${labelOf(baseline)} | ${labelOf(candidate)} | Difference | 95% CI |\n| --- | --- | --- | --- | --- |`;
  const table = (selected: Case[], credited: boolean) =>
    metrics.map((m) => {
      const p = pairedBootstrap(
        selected.map((c) => averaged(baseline, c, credited)[m]),
        selected.map((c) => averaged(candidate, c, credited)[m]),
        { iterations: 10_000 },
      );
      return `| ${m} | ${pct(p.meanBaseline)} | ${pct(p.meanCandidate)} | ${p.difference >= 0 ? '+' : ''}${pct(p.difference)} | ${pct(p.ci[0])} to ${pct(p.ci[1])} |`;
    });
  const all = (side: Side) => roundsOf(side).flatMap((r) => Object.values(r));
  const latency = (side: Side) => {
    const ms = all(side)
      .map((a) => a.latencyMs)
      .sort((a, b) => a - b);
    const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
    return `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms`;
  };
  const distinct = (side: Side) => {
    const answers = all(side);
    const total = answers.reduce((n, a) => n + ranking(side, a, false).length, 0);
    return (total / Math.max(answers.length, 1)).toFixed(1);
  };
  const typesenseSides = sides.filter((s) => engineOf(s) === 'typesense');
  const sharing = typesenseSides.map((side) => {
    const answers = all(side);
    const outside = answers.filter((a) => a.sources.some((s) => !pilotOld.has(s.document))).length;
    const shared = answers.reduce(
      (n, a) => n + Object.values(a.holders ?? {}).filter((h) => new Set(h).size > 1).length,
      0,
    );
    return `${labelOf(side)}: answers with a document outside the pilot ${outside} of ${answers.length}; returned chunks held by more than one document ${shared}.`;
  });
  const holdout = usable.filter((c) => c.split === 'holdout');
  const roundCounts = sides.map((s) => `${labelOf(s)} ${roundsOf(s).length}`).join(', ');
  const report = [
    `# Kudos pilot: retrieval on ${labelOf(baseline)} and ${labelOf(candidate)}`,
    '',
    `${usable.length} of ${cases.length} questions with an expected document. Rounds: ${roundCounts}; each question's scores are averaged over its rounds. Each run asks its sides back to back, on one machine. Every service plans the search with a model and reranks with ColBERT; Typesense runs locally and holds only the pilot's ${pilotOld.size} documents, copied from the shared test cluster.`,
    '',
    ...(typesenseSides.length > 0
      ? [
          `Typesense's chunk ids are not unique across documents, so it can serve a passage under another document than the one it searched. The first table credits every pilot document that holds a chunk a Typesense side returned (its best case); as served, without that credit, follows.`,
          '',
        ]
      : []),
    header,
    ...table(usable, true),
    '',
    ...(typesenseSides.length > 0 ? [`As served:`, '', header, ...table(usable, false), ''] : []),
    `Holdout only (${holdout.length} questions)${typesenseSides.length > 0 ? ', credited' : ''}:`,
    '',
    header,
    ...table(holdout, true),
    '',
    `Distinct pilot documents per answer: ${sides.map((s) => `${labelOf(s)} ${distinct(s)}`).join(', ')}.`,
    ...sharing,
    `Latency over every call: ${sides.map((s) => `${labelOf(s)} ${latency(s)}`).join('; ')}.`,
    '',
  ].join('\n');
  mkdirSync(out, { recursive: true });
  const reportFile = join(out, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(reportFile, report);
  console.log(report);
  console.log(`wrote ${reportFile}`);
};

const sidesFrom = (list: string) => {
  const named = list.split(',').map((s) => s.trim());
  const unknown = named.filter((s) => !isSide(s));
  if (unknown.length > 0)
    throw new Error(
      `unknown side ${unknown.join(', ')}; sides: ${Object.keys(sideOptions).join(', ')}`,
    );
  return named as Side[];
};

const [command, ...args] = process.argv.slice(2);
if (command === 'run')
  await run(args[0] ? Number(args[0]) : 3, sidesFrom(args[1] ?? 'typesense,pgvector'));
else if (command === 'compare' && args.some((a) => a.endsWith('.json'))) {
  const named = args.filter((a) => !a.endsWith('.json'));
  const [baseline, candidate] = sidesFrom(
    named.length > 0 ? named.join(',') : 'typesense,pgvector',
  );
  if (!baseline || !candidate) throw new Error('compare takes two sides: baseline and candidate');
  compare(
    args.filter((a) => a.endsWith('.json')),
    baseline,
    candidate,
  );
} else if (command === 'verdicts' && args[0] && args.some((a) => a.endsWith('.json'))) {
  const [dir, ...rest] = args;
  const named = rest.filter((a) => !a.endsWith('.json'));
  verdicts(
    dir,
    rest.filter((a) => a.endsWith('.json')),
    named.length > 0 ? sidesFrom(named.join(',')) : [],
  );
} else {
  console.error(
    'usage: run [rounds] [side,side], compare <run.json>... [baseline candidate], or verdicts <dir> <run.json>... [side,side]',
  );
  process.exit(1);
}
