export const residencies = ['norway', 'eu', 'global'] as const;
export type Residency = (typeof residencies)[number];

export const failureModes = ['degrade', 'fail'] as const;
export type FailureMode = (typeof failureModes)[number];

export interface RerankRequest {
  query: string;
  documents: string[];
}

export interface Ranked {
  index: number;
  score: number;
  rank: number;
}

export interface RerankResult {
  ranking: Ranked[];
  degraded?: { reason: 'error'; message: string };
}

export interface RerankerInfo {
  id: string;
  residency: Residency;
  onFailure: FailureMode;
}

export interface RerankPort {
  info(): RerankerInfo;
  rerank(request: RerankRequest): Promise<RerankResult>;
}

export type RerankErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'bad_request'
  | 'unauthorized'
  | 'cancelled'
  | 'residency'
  | 'forbidden';

export class RerankError extends Error {
  constructor(
    readonly code: RerankErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RerankError';
  }
}
