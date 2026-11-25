import { pathToFileURL } from 'node:url';
import { expiredFlags, flags, type FlagSpec } from '@genai/contracts/flags';

export interface ExpiredFlagsReport {
  lines: string[];
  exitCode: number;
}

export const reportExpiredFlags = (
  now: Date,
  registry: Record<string, FlagSpec>,
  strict: boolean,
): ExpiredFlagsReport => {
  const expired = expiredFlags(now, registry);
  if (expired.length === 0)
    return { lines: ['No feature flag is past its removeBy date.'], exitCode: 0 };
  const lines = expired.map((key) => {
    const spec = registry[key] as FlagSpec;
    return `::warning file=packages/contracts/src/flags.ts::Feature flag ${key} (owner ${spec.owner}) passed its removeBy date ${spec.removeBy}: remove it or move the date`;
  });
  return { lines, exitCode: strict ? 1 : 0 };
};

const main = () => {
  const report = reportExpiredFlags(new Date(), flags, process.argv.includes('--strict'));
  console.log(report.lines.join('\n'));
  process.exitCode = report.exitCode;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
