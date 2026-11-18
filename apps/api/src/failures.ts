import {
  asProviderFailure,
  runErrorCode,
  type Event,
  type ProviderFailure,
} from '@genai/contracts';
import { t, translate, type ApiKey } from './i18n/index.js';

export interface RunFailure {
  code: string;
  message: string;
  step?: string;
  provider?: ProviderFailure;
}

const reasons: Record<string, ApiKey> = {
  model_error: 'runs.failModel',
  model_unavailable: 'runs.failModelUnavailable',
  strategy_error: 'runs.failStrategy',
  budget_exceeded: 'runs.failBudget',
  deadline_exceeded: 'runs.failDeadline',
  limit_exceeded: 'runs.failLimit',
  forbidden: 'runs.failForbidden',
  misconfigured: 'runs.failMisconfigured',
  cancelled: 'runs.failCancelled',
  interrupted: 'runs.failInterrupted',
  server_stopped: 'runs.failServerStopped',
};

export const failedStep = (message: string) =>
  /(?:^|: )step ([^\s:]+)(?: failed|:)/.exec(message)?.[1];

export const failureReason = (failure: Pick<RunFailure, 'code' | 'step'>) => {
  const reason = translate(reasons[failure.code] ?? 'runs.failStrategy');
  return failure.step && failure.code !== 'model_error' && failure.code !== 'model_unavailable'
    ? t('runs.stepFailedReason', { step: failure.step, reason })
    : reason;
};

const modelMissing = /\bno model \S+ in the catalog\b|\bmodel \S+ is turned off\b/;

const refined = (code: string, message: string) =>
  (code === 'strategy_error' || code === 'model_error') && modelMissing.test(message)
    ? 'model_unavailable'
    : code;

const errorData = (e: Event) => {
  const data = (e.data ?? {}) as { code?: unknown; message?: unknown; provider?: unknown };
  const provider = asProviderFailure(data.provider);
  return {
    code: refined(
      typeof data.code === 'string' ? data.code : 'strategy_error',
      typeof data.message === 'string' ? data.message : '',
    ),
    message: typeof data.message === 'string' ? data.message : '',
    ...(provider ? { provider } : {}),
  };
};

export const failureOf = (events: Event[]): RunFailure | undefined => {
  const errors = events.filter((e) => e.type === 'kernel.error');
  if (errors.length === 0) return undefined;
  const audit = errors.find((e) => e.audience === 'audit') ?? errors[0];
  const { code, message, provider } = errorData(audit as Event);
  const step = failedStep(message);
  return { code, message, ...(step ? { step } : {}), ...(provider ? { provider } : {}) };
};

export const failureFromError = (error: unknown): RunFailure => {
  const message = error instanceof Error ? error.message : String(error);
  const code = refined(runErrorCode(error), message);
  const step = failedStep(message);
  return { code, message, ...(step ? { step } : {}) };
};
