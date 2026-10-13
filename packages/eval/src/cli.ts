import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeAgreement, parseLabels } from './calibration.js';
import { compareRuns, type ComparableField } from './runner.js';
import { evalRun, parseTestSetYaml, splits } from './schema.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const usage = [
  'usage:',
  '  eval validate <testset.yaml>...',
  '  eval compare <baseline-run.json> <candidate-run.json> <metric> [--allow commit,services] [--tag <tag>]',
  '  eval kappa <labels.yaml|json>',
  'A run itself is started through the platform (platform.eval.run), which records provenance from the kernel.',
].join('\n');

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

export const main = (argv: string[], io: Io): number => {
  const [command, ...args] = argv;
  try {
    if (command === 'validate' && args.length > 0) {
      for (const file of args) {
        const set = parseTestSetYaml(readFileSync(file, 'utf8'));
        const counts = splits
          .map((s) => `${s} ${set.spec.cases.filter((c) => c.split === s).length}`)
          .join(', ');
        io.out(
          `${set.metadata.id} v${set.metadata.version}: ${set.spec.cases.length} cases (${counts})`,
        );
      }
      return 0;
    }
    if (command === 'compare' && args.length >= 3) {
      const [a, b, metric] = args as [string, string, string];
      const baseline = evalRun.parse(JSON.parse(readFileSync(a, 'utf8')));
      const candidate = evalRun.parse(JSON.parse(readFileSync(b, 'utf8')));
      const allow = flag(args, '--allow')?.split(',') as ComparableField[] | undefined;
      const tag = flag(args, '--tag');
      const c = compareRuns(baseline, candidate, metric, {
        ...(allow ? { allowDifferent: allow } : {}),
        ...(tag ? { tag } : {}),
      });
      io.out(
        `${metric}: ${c.meanBaseline.toFixed(3)} -> ${c.meanCandidate.toFixed(3)}, difference ${c.difference.toFixed(3)} [${c.ci[0].toFixed(3)}, ${c.ci[1].toFixed(3)}] over ${c.n} cases`,
      );
      return 0;
    }
    if (command === 'kappa' && args.length === 1) {
      for (const a of judgeAgreement(parseLabels(readFileSync(args[0] as string, 'utf8')))) {
        io.out(
          `${a.judge}: kappa ${a.kappa.toFixed(3)}, agreement ${a.observed.toFixed(3)} over ${a.n} items, ${a.blocking ? 'may block' : 'advisory only'}`,
        );
      }
      return 0;
    }
    io.err(usage);
    return 2;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2), {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
