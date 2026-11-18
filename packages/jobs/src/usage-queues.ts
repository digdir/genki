import { z } from 'zod';
import { defineQueue } from './job-queue.js';

const minute = 60;

/** Reads a usage source's hours into usage_buckets (docs/api/gateway.md, "The poll job"). */
export const usageGatewayPollQueue = defineQueue({
  name: 'usage-gateway-poll',
  policy: 'singleton',
  payload: z.strictObject({ source: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'a source id') }),
  expireInSeconds: 30 * minute,
  heartbeatSeconds: minute,
  retryLimit: 2,
  retryDelaySeconds: 5 * minute,
  retryBackoff: true,
  deadLetter: true,
});

/** Twenty past every hour, after the gateway's settle time. */
export const usageGatewayPollCron = '20 * * * *';
