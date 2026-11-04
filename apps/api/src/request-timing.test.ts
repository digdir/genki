import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { RequestTiming } from './request-timing.js';

const appWith = (options: { slowMs?: number; everyRequest?: boolean; elapsed: number }) => {
  const logged: RequestTiming[] = [];
  let clock = 0;
  const app = createApp('test', {
    requestTiming: {
      write: (entry) => logged.push(entry),
      now: () => clock,
      ...(options.slowMs === undefined ? {} : { slowMs: options.slowMs }),
      ...(options.everyRequest ? { everyRequest: true } : {}),
    },
  });
  app.get('/tenants/:tenant/overview', (c) => {
    clock += options.elapsed;
    return c.json({ ok: true });
  });
  return { app, logged };
};

describe('request timing', () => {
  it('logs a slow request with its route pattern, never the raw path or query', async () => {
    const { app, logged } = appWith({ elapsed: 1200 });
    await app.request('/tenants/312521172/overview?secret=abc');

    expect(logged).toEqual([
      { method: 'GET', route: '/tenants/:tenant/overview', status: 200, ms: 1200 },
    ]);
    expect(JSON.stringify(logged)).not.toContain('312521172');
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

  it('stays quiet for requests under the threshold of 500 ms by default', async () => {
    const { app, logged } = appWith({ elapsed: 499 });
    await app.request('/tenants/312521172/overview');

    expect(logged).toEqual([]);
  });

  it('logs every request when asked to, an unknown path as unmatched', async () => {
    const { app, logged } = appWith({ elapsed: 3, everyRequest: true });
    await app.request('/tenants/312521172/overview');
    await app.request('/nothing/here');

    expect(logged).toEqual([
      { method: 'GET', route: '/tenants/:tenant/overview', status: 200, ms: 3 },
      { method: 'GET', route: 'unmatched', status: 404, ms: 0 },
    ]);
  });
});
