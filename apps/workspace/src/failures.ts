import { createFormat, locales, type Format } from '@genai/i18n';
import { translator, type T } from './i18n';
import type { ChatFailure, FailureKind } from './types';

const nb = translator('nb');

export const platformMessages = {
  topic: nb('failures.platformTopic'),
  sources: nb('failures.platformSources'),
};

const platformTexts = (key: 'failures.platformTopic' | 'failures.platformSources') =>
  new Set(locales.map((locale) => translator(locale)(key)));
const topicTexts = platformTexts('failures.platformTopic');
const sourcesTexts = platformTexts('failures.platformSources');

const quotaCodes = new Set([
  'budget_exceeded',
  'limit_exceeded',
  'quota_exceeded',
  'insufficient_quota',
  'rate_limit_exceeded',
]);
const accessCodes = new Set([
  'agent_not_found',
  'model_not_found',
  'mode_not_allowed',
  'agent_disabled',
  'agent_not_authorized',
  'mode_not_authorized',
  'dataset_not_authorized',
  'no_dataset_scope',
]);

const codeOf = (body: unknown) => {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  const code = (body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
};

export interface RunError {
  failure_code?: unknown;
  model_failed?: unknown;
}

const failureFromRun = (error: RunError | undefined): ChatFailure | undefined => {
  if (!error) return undefined;
  if (error.model_failed === true) return { kind: 'unavailable' };
  if (typeof error.failure_code !== 'string') return undefined;
  if (quotaCodes.has(error.failure_code)) return { kind: 'quota' };
  return { kind: 'service-failed' };
};

const runErrorOf = (body: unknown) => {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'object' && error !== null ? (error as RunError) : undefined;
};

export const failureFromHttp = (status: number, body: unknown): ChatFailure => {
  const code = codeOf(body);
  if (code === 'service_paused') return { kind: 'paused' };
  if (code === 'invalid_input') {
    const message = (body as { error?: { message?: unknown } }).error?.message;
    return { kind: 'invalid-input', ...(typeof message === 'string' ? { message } : {}) };
  }
  if (status === 429 || (code && quotaCodes.has(code))) return { kind: 'quota' };
  const run = failureFromRun(runErrorOf(body));
  if (run) return run;
  if (status === 401 || code === 'invalid_api_key') return { kind: 'signed-out' };
  if (status === 403 || status === 404 || (code && accessCodes.has(code)))
    return { kind: 'no-access' };
  return { kind: 'unavailable' };
};

export const failureFromStreamError = (message: string, error?: RunError): ChatFailure =>
  failureFromRun(error) ??
  (/budget|quota|kvote|limit_exceeded/i.test(message)
    ? { kind: 'quota' }
    : { kind: 'unavailable' });

export const failureFromAnswer = (text: string): ChatFailure | undefined => {
  const trimmed = text.trim();
  if (topicTexts.has(trimmed)) return { kind: 'refused' };
  if (sourcesTexts.has(trimmed)) return { kind: 'no-sources' };
  return undefined;
};

export interface FailureCopy {
  color: 'warning' | 'danger' | 'info';
  title: string;
  text: string;
  action?: string;
}

export const failureCopy = (
  failure: ChatFailure,
  context: { organisation: string; now: Date },
  t: T = nb,
  f: Format = createFormat(t.locale),
): FailureCopy => {
  const copy: Record<FailureKind, () => FailureCopy> = {
    quota: () => {
      const next = new Date(context.now.getFullYear(), context.now.getMonth() + 1, 1);
      return {
        color: 'warning',
        title: t('failures.quotaTitle'),
        text: t('failures.quotaText', {
          organisation: context.organisation,
          month: f.month(context.now),
          next: f.month(next),
        }),
      };
    },
    unavailable: () => ({
      color: 'danger',
      title: t('failures.unavailableTitle'),
      text: t('failures.unavailableText'),
      action: t('failures.tryAgain'),
    }),
    'service-failed': () => ({
      color: 'danger',
      title: t('failures.serviceFailedTitle'),
      text: t('failures.serviceFailedText'),
      action: t('failures.tryAgain'),
    }),
    refused: () => ({
      color: 'info',
      title: t('failures.refusedTitle'),
      text: failure.message ?? t('failures.refusedText'),
    }),
    'no-sources': () => ({
      color: 'info',
      title: t('failures.noSourcesTitle'),
      text: failure.message ?? t('failures.noSourcesText'),
    }),
    'signed-out': () => ({
      color: 'warning',
      title: t('failures.signedOutTitle'),
      text: t('failures.signedOutText'),
    }),
    paused: () => ({
      color: 'warning',
      title: t('failures.pausedTitle'),
      text: `${t('failures.paused')}.`,
    }),
    'invalid-input': () => ({
      color: 'warning',
      title: t('failures.invalidTitle'),
      text: failure.message ?? t('failures.invalidText'),
    }),
    'no-access': () => ({
      color: 'warning',
      title: t('failures.noAccessTitle'),
      text: t('failures.noAccessText'),
    }),
  };
  return copy[failure.kind]();
};
