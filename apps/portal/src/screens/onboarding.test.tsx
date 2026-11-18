// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
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

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Kom i gang', () => {
  it('says when and by whom each step was first done, from the change log', async () => {
    await renderLive('#/onboarding', {}, (url, method) =>
      method === 'GET' && /\/audit$/.test(url) ? Response.json({ data: audit }) : undefined,
    );

    expect(await screen.findByText('Gjort 3. oktober 2026 av Kari Nordmann.')).toBeTruthy();
    expect(screen.getByText('Gjort 10. oktober 2026: Rapportassistenten.')).toBeTruthy();
    expect(
      screen.getByText('Gjort 14. oktober 2026 av Ola Hansen: Rapportassistenten ble publisert.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Postsortering ble publisert/)).toBeNull();
  });
});
