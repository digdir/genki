import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('api', () => {
  const app = createApp('test');

  it('answers health with its version', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: 'test', lockdown: false });
  });

  it('publishes an OpenAPI document that lists health', async () => {
    const res = await app.request('/openapi.json');
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/health');
  });
});
