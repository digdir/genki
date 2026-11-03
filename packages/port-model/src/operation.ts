import type { ModelInfo } from './port.js';

export interface OperationPort {
  info(): ModelInfo;
  call(descriptor: string, input: unknown): Promise<unknown>;
}
