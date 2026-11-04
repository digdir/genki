import type { Maturity } from '@genai/kernel';
import type { ModelInfo } from './port.js';

export interface OperationPort {
  info(): ModelInfo;
  call(descriptor: string, input: unknown): Promise<unknown>;
}

export interface ProcessorFacts {
  acceptsUnmaskedInput: boolean;
}

export interface OperationGovernance {
  maturity(kind: string): Promise<Maturity>;
  processor(endpoint: string): Promise<ProcessorFacts | undefined>;
}

export const unrecordedGovernance: OperationGovernance = {
  maturity: async () => 'test',
  processor: async () => undefined,
};
