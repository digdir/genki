// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRow } from '../../api';
import { renderLive } from '../../test-utils';

const entry = (over: Partial<AuditRow>): AuditRow => ({
  task: 't1',
  tenant: '999888777',
  action: 'platform.setting.set',
  actor: 'employee:ap:kari',

  at: '2026-11-17T08:15:00Z',
  outcome: 'applied',
  target: 'setting:answers.language',
  reason: '',
  ...over,
});

const rows: AuditRow[] = [
  entry({ task: 'own', actorName: 'Kari Nordmann' }),
  entry({
    task: 'model',
    action: 'platform.catalog.publish',
    actor: 'operator:digdir-ops',
    target: 'catalog:model/nimbrel-cortex/cortex@3',
    at: '2026-11-16T12:00:00Z',
  }),
  entry({
    task: 'dataset',
    action: 'platform.catalog.publish',
    actor: 'operator:digdir-ops',
    target: 'catalog:dataset/kudos@2',
    at: '2026-11-15T03:00:00Z',
  }),
];

const open = (auditDays = 730) =>
  renderLive('#/log/changes', {}, (url) => {
    if (/\/audit\?/.test(url)) return Response.json({ data: rows, total: rows.length });
    if (/\/models$/.test(url))
      return Response.json({
        data: [
          {
            id: 'nimbrel-cortex/cortex',
            name: 'Nimbrel Cortex',
            residency: 'eu',
            capabilities: [],
          },
        ],
      });
    if (/\/settings\/effective$/.test(url))
      return Response.json({
        'retention.auditDays': {
          key: 'retention.auditDays',
          value: auditDays,
          source: 'platform',
          defaultVersion: 1,
          overridden: [],
          rejected: [],
        },
      });
    return undefined;
  });

const list = () => screen.findByRole('list', { name: 'Endringer' });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Logg, Endringer: Digdir catalogue changes', () => {
  it('hides Digdir catalogue changes until "Vis endringer fra Digdir" is on', async () => {
    await open();
    expect(within(await list()).getAllByRole('listitem')).toHaveLength(1);

    fireEvent.click(screen.getByRole('switch', { name: /Vis endringer fra Digdir/ }));

    expect(within(await list()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('names a catalogue model and links its building block instead of the raw catalogue id', async () => {
    await open();
    fireEvent.click(await screen.findByRole('switch', { name: /Vis endringer fra Digdir/ }));

    const link = within(await list()).getByRole('link', { name: 'Nimbrel Cortex, versjon 3' });
    expect(link.getAttribute('href')).toBe('#/building-blocks/model/nimbrel-cortex%2Fcortex');
    expect(screen.queryByText(/model\/nimbrel-cortex/)).toBeNull();
  });

  it('files a catalogue dataset change under Datasett', async () => {
    await open();
    fireEvent.click(await screen.findByRole('switch', { name: /Vis endringer fra Digdir/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Datasett' }));

    const items = within(await list()).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('kudos, versjon 2');
  });
});

describe('Logg, Endringer: retention', () => {
  it('says changes are kept for two years when the audit period is 730 days', async () => {
    await open(730);
    expect(await screen.findByText('Endringer lagres i to år.')).toBeTruthy();
  });

  it('names the days when the audit period is not two years', async () => {
    await open(400);
    expect(await screen.findByText('Endringer lagres i 400 dager.')).toBeTruthy();
  });
});
