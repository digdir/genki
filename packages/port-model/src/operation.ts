import type { GateChunk, Maturity } from '@genai/kernel';
import type { SessionIO, SessionOutcome, WireExchange } from '@genai/operations';
import type { ModelInfo } from './port.js';

export interface OperationCallOptions {
  /** Raw tier only: sees the masked exchange, so an operator can record it as a fixture. */
  observe?: (exchange: WireExchange) => void;
}

export interface OperationPort {
  info(): ModelInfo;
  call(descriptor: string, input: unknown, options?: OperationCallOptions): Promise<unknown>;
  /** A descriptor whose answer streams: its text deltas, masked and restored by the gate, then its result. */
  stream?(descriptor: string, input: unknown): AsyncIterable<GateChunk<unknown>>;
  /** A descriptor that is a live session: every message both ways passes the gate until the session ends. */
  session?(descriptor: string, input: unknown, io: SessionIO): Promise<SessionOutcome>;
}

export interface OperationGovernance {
  maturity(kind: string): Promise<Maturity>;
  processorRecorded(endpoint: string): Promise<boolean>;
  /** Whether the connection's processor record names the provider's retention and allows provider-side state. */
  providerStateAllowed?(endpoint: string): Promise<boolean>;
}

export const unrecordedGovernance: OperationGovernance = {
  maturity: async () => 'test',
  processorRecorded: async () => false,
};
