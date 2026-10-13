export const residencies = ['norway', 'eu', 'global'] as const;
export type Residency = (typeof residencies)[number];

export const residencyAllows = (allowed: Residency, actual: Residency) =>
  residencies.indexOf(actual) <= residencies.indexOf(allowed);

export interface EmbeddingUsage {
  inputTokens: number;
}

export interface EmbedResult {
  vectors: number[][];
  usage: EmbeddingUsage;
}

export interface EmbedderInfo {
  id: string;
  residency: Residency;
  dimensions: number;
  maxBatch?: number;
}

export interface EmbeddingPort {
  info(): EmbedderInfo;
  embed(texts: string[]): Promise<EmbedResult>;
}

export type EmbeddingErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'bad_request'
  | 'unauthorized'
  | 'cancelled'
  | 'residency'
  | 'invalid_response';

export class EmbeddingError extends Error {
  constructor(
    readonly code: EmbeddingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}
