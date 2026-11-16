import type { ApiLog } from './failure-log.js';

type Target = Pick<NodeJS.Process, 'on' | 'exit'>;

const reasonFields = (reason: unknown) => {
  const code = (reason as { code?: unknown } | null)?.code;
  return {
    error: reason instanceof Error ? reason.name : typeof reason,
    ...(typeof code === 'string' ? { code } : {}),
  };
};

/** Logs an unhandled rejection by error name and code only, and keeps the process running. */
export const keepRunningOnRejection = (log: ApiLog, target: Target = process) => {
  let count = 0;
  target.on('unhandledRejection', (reason) => {
    count += 1;
    log('unhandled promise rejection', { ...reasonFields(reason), count });
  });
  target.on('uncaughtException', (error) => {
    log('uncaught exception, exiting', reasonFields(error));
    target.exit(1);
  });
};
