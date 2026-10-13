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
