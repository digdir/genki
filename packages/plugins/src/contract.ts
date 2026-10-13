export const skipped = 'skipped' as const;

export interface ContractCheck<T> {
  name: string;
  run(subject: T, signal: AbortSignal): Promise<unknown>;
}

export interface ContractSuite<T> {
  contract: string;
  checks: ContractCheck<T>[];
}

export interface ContractTarget<T> {
  subject: T;
  close?(): Promise<void>;
}

export type ContractSetup<T> = () => Promise<ContractTarget<T>>;

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  reason?: string;
  ms: number;
}

export interface SuiteResult {
  contract: string;
  passed: boolean;
  startedAt: string;
  endedAt: string;
  results: CheckResult[];
}

export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

export const check: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new ContractViolation(message);
};

const show = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const checkEqual = <T>(actual: T, expected: T, what: string) => {
  if (show(actual) !== show(expected))
    throw new ContractViolation(`${what}: expected ${show(expected)}, got ${show(actual)}`);
};

export const failure = async (run: () => unknown): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

export const checkFailsWith = async (run: () => unknown, code: string, what: string) => {
  const error = await failure(run);
  check(error !== undefined, `${what}: expected a ${code} error, but the call succeeded`);
  const got = (error as { code?: unknown }).code;
  check(
    got === code,
    `${what}: expected code ${code}, got ${String(got)} (${error instanceof Error ? error.message : String(error)})`,
  );
};

const timed = <T>(work: Promise<T>, ms: number, name: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ContractViolation(`${name} did not finish within ${ms} ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

export interface RunOptions {
  timeoutMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export const runContract = async <T>(
  suite: ContractSuite<T>,
  setup: ContractSetup<T>,
  options: RunOptions = {},
): Promise<SuiteResult> => {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startedAt = now().toISOString();
  const results: CheckResult[] = [];
  let target: ContractTarget<T> | undefined;
  try {
    target = await timed(setup(), timeoutMs, 'setup');
  } catch (error) {
    results.push({
      name: 'setup',
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      ms: 0,
    });
  }
  if (target) {
    for (const item of suite.checks) {
      const started = Date.now();
      if (options.signal?.aborted) {
        results.push({ name: item.name, status: 'skipped', reason: 'cancelled', ms: 0 });
        continue;
      }
      const controller = new AbortController();
      try {
        const outcome = await timed(
          item.run(target.subject, controller.signal),
          timeoutMs,
          item.name,
        );
        results.push({
          name: item.name,
          status: outcome === skipped ? 'skipped' : 'passed',
          ms: Date.now() - started,
        });
      } catch (error) {
        controller.abort();
        results.push({
          name: item.name,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started,
        });
      }
    }
    await target.close?.().catch(() => undefined);
  }
  return {
    contract: suite.contract,
    passed: results.every((r) => r.status !== 'failed'),
    startedAt,
    endedAt: now().toISOString(),
    results,
  };
};
