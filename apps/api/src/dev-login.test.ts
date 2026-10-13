import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { unknownTestPerson } from './dev-login.js';

describe('mock dev login', () => {
  it('answers an unknown test person with a 404 problem, not a 500', async () => {
    const app = new Hono().post('/mock/dev-login', (c) => unknownTestPerson(c));

    const res = await app.request('/mock/dev-login', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status: 404, title: 'Fant ikke testpersonen' });
  });
});
