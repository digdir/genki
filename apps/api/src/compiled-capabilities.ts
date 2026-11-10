import type { CompiledCapability } from '@genai/definitions';

/** Compiles the published services once and again only after invalidate(). */
export const compiledCapabilityCache = (compile: () => Promise<CompiledCapability[]>) => {
  let current: Promise<CompiledCapability[]> | undefined;
  return {
    get: async (): Promise<CompiledCapability[]> => {
      const pending = (current ??= compile());
      try {
        return [...(await pending)];
      } catch (error) {
        if (current === pending) current = undefined;
        throw error;
      }
    },
    invalidate: () => {
      current = undefined;
    },
  };
};
