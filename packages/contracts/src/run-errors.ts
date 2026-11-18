export const isModelError = (error: unknown): boolean => {
  for (let e = error, depth = 0; e instanceof Error && depth < 10; depth++) {
    if (e.name === 'ModelError') return true;
    e = e.cause;
  }
  return false;
};

export const runErrorCode = (error: unknown): string =>
  isModelError(error)
    ? 'model_error'
    : error instanceof Error && error.name === 'KernelError'
      ? String((error as Error & { code?: unknown }).code)
      : 'strategy_error';

export interface ProviderFailure {
  status: number;
  body?: string;
}

export const providerBodyLength = 500;

export const asProviderFailure = (value: unknown): ProviderFailure | undefined => {
  const found = value as { status?: unknown; body?: unknown } | null | undefined;
  if (typeof found?.status !== 'number') return undefined;
  return {
    status: found.status,
    ...(typeof found.body === 'string' && found.body
      ? { body: found.body.slice(0, providerBodyLength) }
      : {}),
  };
};

/** The provider's status and redacted error body an error carries for the audit, never for the client. */
export const providerFailureOf = (error: unknown): ProviderFailure | undefined => {
  for (let e = error, depth = 0; e instanceof Error && depth < 10; depth++) {
    const provider = asProviderFailure((e as { provider?: unknown }).provider);
    if (provider) return provider;
    e = e.cause;
  }
  return undefined;
};
