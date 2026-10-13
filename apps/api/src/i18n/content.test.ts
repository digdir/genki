import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { failureReason } from '../failures.js';
import { elapsed } from '../operations.js';
import { serviceHealth } from '../service-health.js';
import { localeMiddleware } from './index.js';

const app = new Hono();
app.use('*', localeMiddleware);
app.get('/content', (c) =>
  c.json({
    failure: failureReason({ code: 'deadline_exceeded', step: 'finn' }),
    elapsed: elapsed(125 * 60_000),
    health: serviceHealth({ primary: 'a', fallback: 'b', residency: 'norway' }, [
      { id: 'a', residency: 'eu', enabled: true },
      { id: 'b', residency: 'norway', enabled: false },
    ]),
  }),
);

const content = async (language?: string) =>
  (
    await app.request('/content', language ? { headers: { 'accept-language': language } } : {})
  ).json();

describe('platform content follows the request language', () => {
  it('stays in bokmål without Accept-Language', async () => {
    expect(await content()).toEqual({
      failure: 'Steget «finn» feilet. Kjøringen tok for lang tid.',
      elapsed: '2 t 5 min',
      health: {
        status: 'active',
        warnings: [
          { model: 'b', message: 'Modellen b er tatt ut av bruk.' },
          {
            model: 'a',
            message:
              'Modellen a er nå klassifisert til å behandle data i EU/EØS, men tjenesten krever i Norge.',
          },
        ],
      },
    });
  });

  it('is English when the request asks for English', async () => {
    expect(await content('en-US,en;q=0.9')).toEqual({
      failure: 'The step "finn" failed. The run took too long.',
      elapsed: '2 h 5 min',
      health: {
        status: 'active',
        warnings: [
          { model: 'b', message: 'The model b has been retired.' },
          {
            model: 'a',
            message:
              'The model a is now classified to process data in the EU/EEA, but the service requires in Norway.',
          },
        ],
      },
    });
  });
});
