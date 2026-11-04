import type { Maturity } from '@genai/kernel';
import type { ModelInfo } from './port.js';

export interface OperationPort {
  info(): ModelInfo;
  call(descriptor: string, input: unknown): Promise<unknown>;
}

export interface OperationGovernance {
  maturity(kind: string): Promise<Maturity>;
  processorRecorded(endpoint: string): Promise<boolean>;
}

export const unrecordedGovernance: OperationGovernance = {
  maturity: async () => 'test',
  processorRecorded: async () => false,
};
