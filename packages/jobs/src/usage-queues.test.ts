import { describe, expect, it } from 'vitest';
import { admitPayload } from './job-queue.js';
import { usageGatewayPollCron, usageGatewayPollQueue } from './usage-queues.js';

describe('the usage poll queue', () => {
  it('is a singleton with retries and a dead-letter queue, sent at twenty past every hour', () => {
    expect(usageGatewayPollQueue).toMatchObject({
      name: 'usage-gateway-poll',
      policy: 'singleton',
      retryLimit: 2,
      deadLetter: true,
    });
    expect(usageGatewayPollCron).toBe('20 * * * *');
  });

  it('carries the source id and nothing else', () => {
    expect(admitPayload(usageGatewayPollQueue, { source: 'gateway' })).toEqual({
      source: 'gateway',
    });
    expect(() =>
      admitPayload(usageGatewayPollQueue, { source: 'gateway', tenant: '991825827' }),
    ).toThrow();
    expect(() =>
      admitPayload(usageGatewayPollQueue, { source: 'https://gateway.example.no' }),
    ).toThrow();
  });
});
