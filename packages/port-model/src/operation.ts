import type { Maturity } from '@genai/kernel';
import type { WireExchange } from '@genai/operations';
import type { ModelInfo } from './port.js';

export interface OperationCallOptions {
  /** Raw tier only: sees the masked exchange, so an operator can record it as a fixture. */
  observe?: (exchange: WireExchange) => void;
}

export interface OperationPort {
  info(): ModelInfo;
  call(descriptor: string, input: unknown, options?: OperationCallOptions): Promise<unknown>;
}

export interface OperationGovernance {
  maturity(kind: string): Promise<Maturity>;
  processorRecorded(endpoint: string): Promise<boolean>;
}

export const unrecordedGovernance: OperationGovernance = {
  maturity: async () => 'test',
  processorRecorded: async () => false,
};
