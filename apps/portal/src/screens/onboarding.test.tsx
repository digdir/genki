// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRow } from '../api';
import { renderLive } from '../test-utils';

const row = (action: string, target: string, at: string, actorName?: string): AuditRow => ({
  task: `t-${at}`,
  tenant: '999888777',
  action,
  actor: 'urn:person:1',
  ...(actorName ? { actorName } : {}),
  at,
  outcome: 'applied',
  target,
  reason: '',
});

const audit: AuditRow[] = [
  row('platform.pipeline.save', 'pipeline:nettsider', '2026-10-03T09:00:00Z', 'Kari Nordmann'),
  row('platform.service.draft.save', 'service-draft:rapportassistenten', '2026-10-10T09:00:00Z'),
  row(
    'platform.service.publish',
    'Service:rapportassistenten@1',
    '2026-10-14T09:00:00Z',
    'Ola Hansen',
  ),
  row(
    'platform.service.publish',
    'Service:postsortering@1',
    '2026-10-20T09:00:00Z',
    'Kari Nordmann',
  ),
];

const paged =
  (rows: AuditRow[], asked: string[] = []) =>
  (url: string, method: string) => {
    const found = /\/audit(\?.*)?$/.exec(url);
    if (method !== 'GET' || !found) return undefined;
    asked.push(url);
    const query = new URLSearchParams(found[1] ?? '');
    const newest = [...rows].reverse();
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? newest.length);
    return Response.json({ data: newest.slice(offset, offset + limit), total: rows.length });
  };

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Kom i gang', () => {
  it('says when and by whom each step was first done, from the change log', async () => {
    await renderLive('#/onboarding', {}, paged(audit));

    expect(await screen.findByText('Gjort 3. oktober 2026 av Kari Nordmann.')).toBeTruthy();
    expect(screen.getByText('Gjort 10. oktober 2026: Rapportassistenten.')).toBeTruthy();
    expect(
      screen.getByText('Gjort 14. oktober 2026 av Ola Hansen: Rapportassistenten ble publisert.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Postsortering ble publisert/)).toBeNull();
  });

  it('reads the change log a page at a time from its oldest end, never the whole log', async () => {
    const asked: string[] = [];
    const later = Array.from({ length: 450 }, (_, i) =>
      row(
        'platform.setting.set',
        'answer.language',
        `2026-11-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`,
      ),
    );
    await renderLive('#/onboarding', {}, paged([...audit, ...later], asked));

    expect(await screen.findByText('Gjort 3. oktober 2026 av Kari Nordmann.')).toBeTruthy();
    expect(asked.every((url) => /[?&]limit=\d+/.test(url))).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('offset=254');
  });

  it('counts the trial runs on the try step and says who ran the first', async () => {
    const run = (id: string, createdAt: string, name: string) => ({
      id,
      status: 'completed',
      service: 'platform/draft/playground/x',
      serviceName: 'platform/draft/playground/x',
      capability: 'platform/draft/playground/x',
      version: null,
      environment: null,
      createdAt,
      endedAt: createdAt,
      actor: { kind: 'person', name },
    });
    await renderLive('#/onboarding', {}, (url, method) =>
      method === 'GET' && /\/tasks\?.*origin=playground/.test(url)
        ? Response.json({
            data: [
              run('p3', '2026-10-12T09:00:00Z', 'Ola Hansen'),
              run('p2', '2026-10-11T09:00:00Z', 'Kari Nordmann'),
              run('p1', '2026-10-10T09:00:00Z', 'Kari Nordmann'),
            ],
            total: 3,
          })
        : paged(audit)(url, method),
    );

    await waitFor(() =>
      expect(
        screen.getByText('Gjort 10. oktober 2026 av Kari Nordmann: 3 prøvekjøringer.'),
      ).toBeTruthy(),
    );
  });
});
