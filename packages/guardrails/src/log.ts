import type { Event } from '@genai/contracts';
import type { EventLog } from '@genai/kernel';
import { redactPii, type PiiCategory } from './pii.js';

export interface PiiSafeLogOptions {
  categoriesFor: (
    task: string,
  ) => readonly PiiCategory[] | undefined | Promise<readonly PiiCategory[] | undefined>;
  fallback?: readonly PiiCategory[];
}

export const piiSafeEventLog = (inner: EventLog, options: PiiSafeLogOptions): EventLog => ({
  append: async (event, scope) => {
    const categories = (await options.categoriesFor(event.task)) ?? options.fallback ?? [];
    if (categories.length === 0) return inner.append(event, scope);
    const redacted: Omit<Event, 'seq'> = {
      ...event,
      data: redactPii(event.data, categories),
      ...(event.fallback ? { fallback: redactPii(event.fallback, categories) } : {}),
    };
    return inner.append(redacted, scope);
  },
  read: (task, fromSeq, isLive) => inner.read(task, fromSeq, isLive),
  wake: (task) => inner.wake(task),
});
