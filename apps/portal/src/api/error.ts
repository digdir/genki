import type { Problem } from '../types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
    readonly retryAfter?: number,
  ) {
    super(problem?.title ?? problem?.error ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}
