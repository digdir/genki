import type { QueueWork } from '@genai/jobs';

/** Each platform queue with the handler the worker works it with; the worker installs exactly these. */
export const platformWork: QueueWork[] = [];
