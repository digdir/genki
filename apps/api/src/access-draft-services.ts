import type { ServiceTarget } from '@genai/identity';

const running = new Map<string, ServiceTarget>();

/** Which tenant service a registered draft capability runs, so a limit on the service also holds for its draft runs. */
export const draftServices = {
  remember: (capability: string, target: ServiceTarget) => running.set(capability, target),
  forget: (capability: string) => running.delete(capability),
  of: (capability: string) => running.get(capability),
};
