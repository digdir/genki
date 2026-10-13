import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { en, nb } from './i18n/index.js';
import { keepsOwnErrorShape } from './problem-responses.js';
import { bootPlatform, digdir } from './testkit.js';

const outsiderTenant = '974760673';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  per: {
    kind: 'employee',
    issuer: 'test',
    subject: 'per',
    tenant: outsiderTenant,
    authorizedFor: [{ org: outsiderTenant }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
};

const reason = 'Sjekker at API-et er konsistent';

const boot = () => bootPlatform({ people, services: ['hjelper'] });

type App = Awaited<ReturnType<typeof boot>>['app'];

const routesOf = (app: App) =>
  [
    ...new Set(
      app.routes
        .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].map((route) => {
    const [method = 'GET', template = ''] = route.split(' ');
    return { route, method, template };
  });

const concrete = (template: string) =>
  template
    .replace(':tenant', digdir)
    .replace(/(\/services\/):(id|service)\b/, '$1hjelper')
    .replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x');

const send = (
  app: App,
  method: string,
  path: string,
  who: string | undefined,
  init: { reason?: string; language?: string } = {},
) =>
  app.request(path, {
    method,
    headers: {
      ...(who ? { authorization: `Bearer ${who}` } : {}),
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(init.reason ? { 'change-reason': init.reason } : {}),
      ...(init.language ? { 'accept-language': init.language } : {}),
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });

const shape = (text: string) => text.replace(/\{[^}]*\}/g, '{}');
const shapesOf = (catalogue: Record<string, Record<string, unknown>>) =>
  new Set(
    Object.values(catalogue).flatMap((ns) =>
      Object.values(ns).flatMap((m) =>
        typeof m === 'string'
          ? [shape(m)]
          : Object.values(m as object)
              .map(String)
              .map(shape),
      ),
    ),
  );
const patternsOf = (shapes: Set<string>) =>
  [...shapes].map(
    (known) =>
      new RegExp(
        `^${known
          .split('{}')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.+')}$`,
        's',
      ),
  );

describe('one consistent API', () => {
  it('answers every error outside /v1, A2A and MCP as problem+json with type, title and status', async () => {
    const { app } = await boot();
    const wrong: string[] = [];
    for (const { route, method, template } of routesOf(app)) {
      if (keepsOwnErrorShape(template)) continue;
      for (const [who, init] of [
        [undefined, {}],
        ['per', { reason }],
        ['kari', {}],
        ['kari', { reason }],
      ] as const) {
        const res = await send(app, method, concrete(template), who, init);
        if (res.status < 400) continue;
        const body = (await res.json().catch(() => undefined)) as
          { type?: unknown; title?: unknown; status?: unknown } | undefined;
        const typed = res.headers.get('content-type')?.startsWith('application/problem+json');
        if (
          !typed ||
          typeof body?.type !== 'string' ||
          typeof body.title !== 'string' ||
          body.status !== res.status
        )
          wrong.push(`${route} as ${who ?? 'nobody'} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('answers 404, never 403, on every tenant route to someone who cannot reach the tenant', async () => {
    const { app } = await boot();
    const wrong: string[] = [];
    for (const { route, method, template } of routesOf(app)) {
      if (!template.startsWith('/tenants/:tenant')) continue;
      for (const who of ['per', 'drift']) {
        const res = await send(app, method, concrete(template), who, { reason });
        if (res.status !== 404 && res.status !== 400)
          wrong.push(`${route} as ${who} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('answers every list with an object holding data, never a bare array', async () => {
    const { app } = await boot();
    const bare: string[] = [];
    for (const { route, method, template } of routesOf(app)) {
      if (method !== 'GET' || keepsOwnErrorShape(template)) continue;
      for (const who of ['kari', 'drift']) {
        const res = await send(app, 'GET', concrete(template), who);
        if (res.status !== 200 || !res.headers.get('content-type')?.includes('json')) continue;
        if (Array.isArray(await res.json().catch(() => undefined))) bare.push(`${route} as ${who}`);
      }
    }
    expect(bare).toEqual([]);
  }, 120_000);

  it.each([
    ['en', en],
    ['nb', nb],
  ] as const)(
    'gives every error title and detail in %s from the API catalogues',
    async (language, catalogue) => {
      const { app } = await boot();
      const patterns = patternsOf(
        shapesOf(catalogue as unknown as Record<string, Record<string, unknown>>),
      );
      const untranslated = new Set<string>();
      for (const { route, method, template } of routesOf(app)) {
        if (keepsOwnErrorShape(template)) continue;
        for (const [who, init] of [
          [undefined, {}],
          ['per', { reason }],
          ['kari', {}],
          ['kari', { reason }],
        ] as const) {
          const res = await send(app, method, concrete(template), who, { ...init, language });
          if (res.status < 400) continue;
          const body = (await res.json().catch(() => ({}))) as {
            title?: unknown;
            detail?: unknown;
          };
          for (const text of [body.title, body.detail])
            if (typeof text === 'string' && !patterns.some((p) => p.test(text)))
              untranslated.add(`${route} -> ${res.status} ${JSON.stringify(text)}`);
        }
      }
      expect([...untranslated]).toEqual([]);
    },
    120_000,
  );
});
