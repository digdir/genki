import { describe, expect, it } from 'vitest';
import { admitPayload, JobQueueError } from './job-queue.js';
import {
  convertPriority,
  knowledgeIngestQueue,
  knowledgeKeys,
  knowledgePlatformQueues,
  knowledgeServerQueues,
} from './knowledge-queues.js';
import {
  heavyWorkStart,
  inNightWindow,
  nextNightWindowStart,
  nightlyCron,
  nightWindowEnd,
} from './night-window.js';

const sixHours = 6 * 60 * 60 * 1000;

describe('the knowledge queues', () => {
  it('each queue runs with the contract ADR 0042 gives it', () => {
    const contract = (queue: (typeof knowledgePlatformQueues)[number]) => ({
      name: queue.name,
      policy: queue.policy,
      expireInSeconds: queue.expireInSeconds,
      heartbeatSeconds: queue.heartbeatSeconds,
      retryLimit: queue.retryLimit,
      retryBackoff: queue.retryBackoff ?? false,
      deadLetter: queue.deadLetter,
    });
    expect(knowledgePlatformQueues.map(contract)).toEqual([
      {
        name: 'knowledge.ingest',
        policy: 'exclusive',
        expireInSeconds: 7200,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
      {
        name: 'knowledge.push',
        policy: 'exclusive',
        expireInSeconds: 900,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
      {
        name: 'knowledge.activate',
        policy: 'singleton',
        expireInSeconds: 900,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
      {
        name: 'knowledge.drop',
        policy: 'singleton',
        expireInSeconds: 3600,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
    ]);
    expect(knowledgeServerQueues(sixHours).map(contract)).toEqual([
      {
        name: 'knowledge.convert',
        policy: 'exclusive',
        expireInSeconds: 6 * 3600 + 3600,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
      {
        name: 'knowledge.index',
        policy: 'exclusive',
        expireInSeconds: 1800,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
      {
        name: 'knowledge.fill',
        policy: 'exclusive',
        expireInSeconds: 1800,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
      {
        name: 'knowledge.build',
        policy: 'singleton',
        expireInSeconds: 86400,
        heartbeatSeconds: 60,
        retryLimit: 1,
        retryBackoff: false,
        deadLetter: false,
      },
      {
        name: 'knowledge.check',
        policy: 'singleton',
        expireInSeconds: 7200,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: false,
        deadLetter: false,
      },
      {
        name: 'knowledge.cleanup',
        policy: 'singleton',
        expireInSeconds: 7200,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: false,
        deadLetter: false,
      },
      {
        name: 'knowledge.export',
        policy: 'singleton',
        expireInSeconds: 7200,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: false,
        deadLetter: false,
      },
      {
        name: 'knowledge.seed',
        policy: 'exclusive',
        expireInSeconds: 3600,
        heartbeatSeconds: 60,
        retryLimit: 2,
        retryBackoff: true,
        deadLetter: true,
      },
    ]);
    expect(knowledgeServerQueues(30 * sixHours)[0]?.expireInSeconds).toBe(86400);
    expect(convertPriority.upload).toBeGreaterThan(convertPriority.run);
    expect(convertPriority.run).toBeGreaterThan(convertPriority.candidate);
    expect(knowledgeKeys.ingest({ dataset: '991825827/kudos', id: 'nightly' })).toBe(
      '991825827/kudos#nightly',
    );
  });

  it('job payloads hold no document text', () => {
    const run = { run: '0b6d1c1e-3f7a-4a51-9a4e-0f6f0d1f2a3b', tenant: '991825827' };
    expect(admitPayload(knowledgeIngestQueue, run)).toEqual(run);
    for (const smuggled of [
      { ...run, title: 'Årsrapport 2024' },
      { ...run, run: 'Årsrapport for Digitaliseringsdirektoratet 2024' },
      { ...run, tenant: 'Digdir' },
    ])
      expect(() => admitPayload(knowledgeIngestQueue, smuggled)).toThrow(JobQueueError);
    for (const queue of [...knowledgePlatformQueues, ...knowledgeServerQueues(sixHours)])
      expect(() => admitPayload(queue, { text: 'Søknaden ble avslått fordi …' })).toThrow(
        JobQueueError,
      );
  });
});

describe('the night window', () => {
  it('the night window gives its next start across a daylight-saving change', () => {
    const window = '01:00-06:00';
    // Summer time ends on 25 October 2026 at 03:00 local time, which becomes 02:00.
    expect(nextNightWindowStart(window, new Date('2026-10-24T12:00:00Z')).toISOString()).toBe(
      '2026-10-24T23:00:00.000Z',
    );
    expect(nextNightWindowStart(window, new Date('2026-10-25T12:00:00Z')).toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
    // Summer time starts on 29 March 2026 at 02:00 local time, which becomes 03:00.
    expect(nextNightWindowStart(window, new Date('2026-03-28T12:00:00Z')).toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    );
    expect(nextNightWindowStart(window, new Date('2026-03-29T12:00:00Z')).toISOString()).toBe(
      '2026-03-29T23:00:00.000Z',
    );
    expect(nextNightWindowStart(window, new Date('2026-03-29T00:00:00Z')).toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    );
    expect(inNightWindow(window, new Date('2026-10-25T04:30:00Z'))).toBe(true);
    expect(inNightWindow(window, new Date('2026-10-25T05:30:00Z'))).toBe(false);
    expect(inNightWindow(window, new Date('2026-07-01T03:59:00Z'))).toBe(true);
    expect(inNightWindow(window, new Date('2026-07-01T04:00:00Z'))).toBe(false);
    expect(inNightWindow('22:00-04:00', new Date('2026-01-15T22:30:00Z'))).toBe(true);
    expect(inNightWindow('22:00-04:00', new Date('2026-01-15T12:00:00Z'))).toBe(false);
  });

  it('heavy work sent by day starts at the next window, and inside it at once', () => {
    const day = new Date('2026-11-03T13:00:00Z');
    const night = new Date('2026-11-04T01:30:00Z');
    expect(heavyWorkStart('01:00-06:00', day).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(heavyWorkStart('01:00-06:00', night)).toBe(night);
  });

  it('with the window set to always, heavy work starts at once and the window never ends', () => {
    const day = new Date('2026-11-03T13:00:00Z');
    expect(inNightWindow('always', day)).toBe(true);
    expect(heavyWorkStart('always', day)).toBe(day);
    expect(nightWindowEnd('always', day)).toBeUndefined();
  });

  it('gives the end of the window a build runs in', () => {
    expect(nightWindowEnd('01:00-06:00', new Date('2026-11-04T01:30:00Z'))?.toISOString()).toBe(
      '2026-11-04T05:00:00.000Z',
    );
  });

  it('the nightly checks are scheduled at the window start in Europe/Oslo', () => {
    expect(nightlyCron('01:00-06:00')).toBe('0 1 * * *');
    expect(nightlyCron('22:30-04:00')).toBe('30 22 * * *');
    expect(nightlyCron('always')).toBe('0 1 * * *');
  });
});
