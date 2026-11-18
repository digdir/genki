import type { Task } from '@genai/contracts';
import { tenantSampleRate } from '@genai/composition';
import type { SettingsRegistry } from '@genai/definitions';
import type { SecretResolver } from '@genai/kernel';

export interface WorkerTraceDeps {
  secrets: SecretResolver;
  tasks: (id: string) => Promise<Task | undefined>;
  settings: Pick<SettingsRegistry, 'effective'>;
  fetch?: typeof fetch;
}

export const workerTraceDeps = ({ settings, fetch, ...deps }: WorkerTraceDeps) => ({
  ...deps,
  serviceName: 'genai-worker',
  sampleRateFor: tenantSampleRate(settings),
  ...(fetch ? { fetch } : {}),
});
