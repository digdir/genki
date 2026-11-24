// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRow } from '../../api';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari } from '../../test-utils';

const entry = (over: Partial<AuditRow>): AuditRow => ({
  task: over.task ?? 't1',
  tenant: '999888777',
  action: 'platform.service.lifecycle',
  actor: 'employee:ap:kari',
  at: '2026-11-17T08:15:00Z',
  outcome: 'applied',
  target: 'service:999888777/smoke-throwaway',
  reason: '',
  ...over,
});

const audit: AuditRow[] = [
  entry({
    task: 'a',
    actor: 'agency-system:urn:genai:legacy-api-key:k1',
    at: '2026-11-17T21:15:30Z',
  }),
  entry({
    task: 'b',
    actor: 'agency-system:urn:genai:legacy-api-key:k1',
    at: '2026-11-17T21:15:00Z',
  }),
  entry({
    task: 'c',
    action: 'platform.service.publish',
    target: 'Service:smoke-throwaway@7',
    reason: 'Nye kilder',
    actorName: 'Kari Nordmann',
    at: '2026-11-16T09:42:00Z',
  }),
  entry({
    task: 'd',
    action: 'platform.setting.set',
    target: 'setting:answers.language',
    actor: 'employee:ap:ola',
    actorName: 'Ola Nordmann',
    at: '2026-11-15T10:05:00Z',
  }),
];

const platform: typeof fetch = async (input, init) => {
  const url = String(input);
  if (/\/tenants\/[^/]+\/audit(\?|$)/.test(url))
    return Response.json({ data: audit, total: audit.length });
  if (/\/tenants\/[^/]+\/services$/.test(url))
    return Response.json({ data: [{ id: 'smoke-throwaway', name: 'Røyktest' }] });
  if (/\/tenants\/[^/]+\/access$/.test(url))
    return Response.json({ services: [], keys: [{ id: 'k1', name: 'deploy-smoke' }] });
  return mockFetch()(input, init);
};

const open = async (path: string) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={platform} live />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Siste endringer on Oversikt', () => {
  it('names the service and links it instead of showing its id', async () => {
    await open('#/overview');

    const changes = await screen.findByRole('region', { name: 'Siste endringer' });
    const links = await within(changes).findAllByRole('link', { name: 'Røyktest' });
    expect(links[0]?.getAttribute('href')).toBe('#/services/smoke-throwaway');
    expect(within(changes).queryByText(/smoke-throwaway/)).toBeNull();
  });

  it('names the deploy key as a key, never as an employee, and shows a repeated change once', async () => {
    await open('#/overview');

    const changes = await screen.findByRole('region', { name: 'Siste endringer' });
    expect(await within(changes).findAllByText('API-nøkkel deploy-smoke')).toHaveLength(1);
    expect(within(changes).queryByText('Ansatt i virksomheten')).toBeNull();
    expect(within(changes).getByRole('link', { name: 'Hele loggen' }).getAttribute('href')).toBe(
      '#/log/changes',
    );
  });

  it('says which version was published, as the design does', async () => {
    await open('#/overview');

    const changes = await screen.findByRole('region', { name: 'Siste endringer' });
    const row = (await within(changes).findByText(/publiserte utgave 7 av/)).closest('span');
    expect(row?.textContent).toBe('Kari Nordmann publiserte utgave 7 av Røyktest');
  });
});

describe('Logg › Endringer', () => {
  it('opens at #/log/changes with the area tag and the reason of each change', async () => {
    await open('#/log/changes');

    const list = await screen.findByRole('list', { name: 'Endringer' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('«Nye kilder»')).toBeTruthy();
    expect(within(list).getAllByText('Tjenester').length).toBe(2);
    expect(screen.getByRole('status').textContent).toBe('Viser 3 av 3 endringer');
  });

  it('filters by area and by person, and resets both', async () => {
    await open('#/log/changes');
    await screen.findByRole('list', { name: 'Endringer' });

    fireEvent.click(screen.getByRole('radio', { name: 'Innstillinger' }));
    expect(
      within(screen.getByRole('list', { name: 'Endringer' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Alle' }));
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'Kari Nordmann' } });
    expect(
      within(screen.getByRole('list', { name: 'Endringer' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill' }));
    expect(
      within(screen.getByRole('list', { name: 'Endringer' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });
});
