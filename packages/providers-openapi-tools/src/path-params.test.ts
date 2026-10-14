import { describe, expect, it } from 'vitest';
import { requestFor } from './source.js';

const plan = {
  method: 'get' as const,
  path: '/v1/cases/{id}/notes',
  parameters: [{ name: 'id', in: 'path' as const }],
  body: false,
};
const endpoint = 'https://api.example.no';

describe('requestFor', () => {
  it('builds the url of the selected operation', () => {
    expect(requestFor(endpoint, plan, { id: 'sak-1' })).toMatchObject({
      url: 'https://api.example.no/v1/cases/sak-1/notes',
    });
  });

  it('refuses a path parameter that would leave the selected operation', () => {
    for (const id of ['..', '.', '']) {
      expect(requestFor(endpoint, plan, { id })).toHaveProperty('error');
    }
  });

  it('keeps slashes and encoded dots inside a path parameter within one segment', () => {
    expect(requestFor(endpoint, plan, { id: '../admin' })).toMatchObject({
      url: 'https://api.example.no/v1/cases/..%2Fadmin/notes',
    });
    expect(requestFor(endpoint, plan, { id: '%2E%2E' })).toMatchObject({
      url: 'https://api.example.no/v1/cases/%252E%252E/notes',
    });
  });
});
