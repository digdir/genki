import type { ProfileSummary } from './profiles.js';
import type { AnswerSummary, RetrievalSummary, ServedModels } from './quality.js';

const pct = (x: number | undefined) => (x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | undefined, digits = 3) => (x === undefined ? 'n/a' : x.toFixed(digits));
const ci = (c: [number, number] | undefined, digits = 3) =>
  c ? `[${c[0].toFixed(digits)}, ${c[1].toFixed(digits)}]` : 'n/a';
const ms = (x: number | undefined) => (x === undefined ? 'n/a' : `${(x / 1000).toFixed(1)} s`);

export interface QualityReport {
  provisional: boolean;
  testSet: { id?: string; source: string; status: string; cases: number; corpus?: string };
  generatedAt: string;
  repeats: number;
  judge?: { id: string; model: string };
  servedModels?: { systems: [ServedModels, ServedModels]; problems: string[] };
  retrieval?: RetrievalSummary;
  answers?: AnswerSummary;
  profiles?: ProfileSummary;
  notes: string[];
}

export const renderMarkdown = (report: QualityReport): string => {
  const lines: string[] = [];
  lines.push('# Answer-quality comparison: headless-rag and genki');
  lines.push('');
  if (report.provisional)
    lines.push(
      `**Provisional.** The test set (${report.testSet.source}) is a draft or has cases marked for review. Treat the numbers as a first reading, not a gate.`,
    );
  lines.push('');
  lines.push(
    `${report.testSet.cases} questions${report.testSet.corpus ? ` on ${report.testSet.corpus}` : ''}, ${report.repeats} repeats per system, generated ${report.generatedAt}.`,
  );
  if (report.servedModels) {
    const [a, b] = report.servedModels.systems;
    const models = (m: ServedModels) =>
      m.models.length ? `${m.models.join(', ')} (${m.source})` : 'unknown';
    lines.push('', `Served model: headless-rag ${models(a)}; genki ${models(b)}.`);
    for (const p of report.servedModels.problems) lines.push(`- ${p}`);
  }
  if (report.retrieval) {
    const [a, b] = report.retrieval.systems;
    lines.push('', '## Retrieval (Kunnskapsassistenten retrieve-only tool)', '');
    lines.push('| | headless-rag | genki |', '|---|---|---|');
    lines.push(`| Expected source in top 10 | ${pct(a.recallAt10)} | ${pct(b.recallAt10)} |`);
    lines.push(`| Expected source in top 20 | ${pct(a.recallAt20)} | ${pct(b.recallAt20)} |`);
    lines.push(`| Chunks returned (mean) | ${num(a.meanChunks, 1)} | ${num(b.meanChunks, 1)} |`);
    lines.push(
      `| Same chunks across repeats (Jaccard) | ${num(a.stability)} | ${num(b.stability)} |`,
    );
    lines.push(
      `| Latency p50 / p90 | ${ms(a.latencyMs.p50)} / ${ms(a.latencyMs.p90)} | ${ms(b.latencyMs.p50)} / ${ms(b.latencyMs.p90)} |`,
    );
    lines.push(`| Errors | ${a.errors} of ${a.runs} | ${b.errors} of ${b.runs} |`);
    lines.push('');
    lines.push(
      `Overlap between the systems' top 10: ${num(report.retrieval.overlapAt10)} ${ci(report.retrieval.overlapAt10Ci)}. Recall difference (platform minus headless-rag): ${num(report.retrieval.recallDifference?.mean)} ${ci(report.retrieval.recallDifference?.ci)}, n=${report.retrieval.recallDifference?.n ?? 0}.`,
    );
  }
  if (report.answers) {
    const [a, b] = report.answers.systems;
    lines.push('', '## Answers (Kunnskapsassistenten agent tool)', '');
    if (report.judge)
      lines.push(`Judge: ${report.judge.model}, scores 0 to 1 against the reference answer.`, '');
    lines.push('| | headless-rag | genki |', '|---|---|---|');
    lines.push(
      `| Judge score (mean, 95% CI) | ${num(a.score?.mean)} ${ci(a.score?.ci)} | ${num(b.score?.mean)} ${ci(b.score?.ci)} |`,
    );
    lines.push(
      `| Answer matches expected pattern | ${pct(a.patternMatch)} | ${pct(b.patternMatch)} |`,
    );
    lines.push(
      `| Cites the expected document | ${pct(a.citesExpectedDocument)} | ${pct(b.citesExpectedDocument)} |`,
    );
    lines.push(`| Cites any source | ${pct(a.citesAnything)} | ${pct(b.citesAnything)} |`);
    lines.push(
      `| Refuses when the answer is not in the corpus | ${pct(a.refusalOnNotCovered)} | ${pct(b.refusalOnNotCovered)} |`,
    );
    lines.push(
      `| Refuses when the answer is in the corpus | ${pct(a.falseRefusal)} | ${pct(b.falseRefusal)} |`,
    );
    lines.push(
      `| Expected source in the agent's search pool | ${pct(a.stages.inPool)} | ${pct(b.stages.inPool)} |`,
    );
    lines.push(
      `| Expected source displayed to the model | ${pct(a.stages.displayed)} | ${pct(b.stages.displayed)} |`,
    );
    lines.push(`| Expected source read | ${pct(a.stages.read)} | ${pct(b.stages.read)} |`);
    lines.push(
      `| Latency p50 / p90 | ${ms(a.latencyMs.p50)} / ${ms(a.latencyMs.p90)} | ${ms(b.latencyMs.p50)} / ${ms(b.latencyMs.p90)} |`,
    );
    lines.push(
      `| Errors (calls / judge) | ${a.errors} / ${a.judgeErrors} of ${a.runs} | ${b.errors} / ${b.judgeErrors} of ${b.runs} |`,
    );
    if (report.answers.paired)
      lines.push(
        '',
        `Paired difference in judge score (platform minus headless-rag): ${num(report.answers.paired.meanDifference)} ${ci(report.answers.paired.ci)}, n=${report.answers.paired.n}.`,
      );
    lines.push('', '| Tag | n | headless-rag | genki |', '|---|---|---|---|');
    for (const t of report.answers.byTag)
      lines.push(`| ${t.tag} | ${t.n} | ${num(t.scores[0])} | ${num(t.scores[1])} |`);
  }
  if (report.profiles) {
    const p = report.profiles;
    lines.push('', '## Search profiles on Norwegian questions (M.2)', '');
    lines.push(
      `Raw question, no planner, top ${p.limit} per profile, ${p.cases} questions with a known source.`,
      '',
    );
    lines.push('| Profile | Expected source found | Only this profile found it |', '|---|---|---|');
    for (const name of p.profiles)
      lines.push(`| ${name} | ${pct(p.recall[name])} | ${p.onlyFoundBy[name] ?? 0} |`);
    lines.push(`| any profile | ${pct(p.union)} | |`);
  }
  if (report.notes.length) {
    lines.push('', '## Notes', '');
    for (const n of report.notes) lines.push(`- ${n}`);
  }
  return `${lines.join('\n')}\n`;
};
