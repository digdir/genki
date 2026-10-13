import { runErrorCode, type Event } from '@genai/contracts';
import { t, translate, type ApiKey } from './i18n/index.js';

export interface RunFailure {
  code: string;
  message: string;
  step?: string;
}

const reasons: Record<string, ApiKey> = {
  model_error: 'runs.failModel',
  strategy_error: 'runs.failStrategy',
  budget_exceeded: 'runs.failBudget',
  deadline_exceeded: 'runs.failDeadline',
  limit_exceeded: 'runs.failLimit',
  forbidden: 'runs.failForbidden',
  misconfigured: 'runs.failMisconfigured',
  cancelled: 'runs.failCancelled',
  interrupted: 'runs.failInterrupted',
};

export const failedStep = (message: string) =>
  /(?:^|: )step ([^\s:]+)(?: failed|:)/.exec(message)?.[1];

export const failureReason = (failure: Pick<RunFailure, 'code' | 'step'>) => {
  const reason = translate(reasons[failure.code] ?? 'runs.failStrategy');
  return failure.step && failure.code !== 'model_error'
    ? t('runs.stepFailedReason', { step: failure.step, reason })
    : reason;
};

const errorData = (e: Event) => {
  const data = (e.data ?? {}) as { code?: unknown; message?: unknown };
  return {
    code: typeof data.code === 'string' ? data.code : 'strategy_error',
    message: typeof data.message === 'string' ? data.message : '',
  };
};

export const failureOf = (events: Event[]): RunFailure | undefined => {
  const errors = events.filter((e) => e.type === 'kernel.error');
  if (errors.length === 0) return undefined;
  const audit = errors.find((e) => e.audience === 'audit') ?? errors[0];
  const { code, message } = errorData(audit as Event);
  const step = failedStep(message);
  return { code, message, ...(step ? { step } : {}) };
};

export const failureFromError = (error: unknown): RunFailure => {
  const message = error instanceof Error ? error.message : String(error);
  const code = runErrorCode(error);
  const step = failedStep(message);
  return { code, message, ...(step ? { step } : {}) };
};
