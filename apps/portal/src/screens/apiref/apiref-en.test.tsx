// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api';
import { endpoints, portalActions } from '../../data/api-reference';
import { Actions } from './Actions';
import { EndpointDetail } from './EndpointDetail';
import { EndpointNav } from './EndpointNav';
import { ServiceAsApi } from './ServiceAsApi';

afterEach(cleanup);

const endpoint = (id: string) => {
  const found = endpoints.find((e) => e.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe('API reference in English', () => {
  it('has a unique id for every endpoint and a text for every portal action', () => {
    const ids = endpoints.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(portalActions.every((a) => endpoints.some((e) => e.id === a.endpoint))).toBe(true);
  });

  it('groups endpoints under English area names', () => {
    render(inEnglish(<EndpointNav selected="tj-pub" onPick={() => undefined} />));
    const nav = screen.getByRole('navigation', { name: 'Endpoints' });
    expect(within(nav).getByText('Export and import')).toBeTruthy();
    expect(within(nav).getByRole('button', { name: /Publish a version/ })).toBeTruthy();
    expect(screen.getByLabelText('Search endpoints')).toBeTruthy();
  });

  it('describes an endpoint with its rights, parameters and errors', () => {
    render(
      inEnglish(
        <EndpointDetail ep={endpoint('tj-pub')} tenant="999888777" tenantName="Testetaten" />,
      ),
    );
    const detail = screen.getByRole('article');
    expect(
      within(detail).getByRole('heading', { level: 2, name: 'Publish a version' }),
    ).toBeTruthy();
    expect(within(detail).getByText('Manage services')).toBeTruthy();
    expect(within(detail).getByRole('region', { name: 'Parameters' })).toBeTruthy();
    expect(within(detail).getByText('400 Reason missing')).toBeTruthy();
    expect(within(detail).getByText('401 Not signed in')).toBeTruthy();
    expect(within(detail).getByLabelText('curl').textContent).toContain('Reason for the change');
    expect(within(detail).getByRole('button', { name: 'Copy curl' })).toBeTruthy();
  });

  it('shows portal actions in English', () => {
    render(inEnglish(<Actions tenant="999888777" onDone={() => undefined} />));
    expect(screen.getByText('Publish version 8')).toBeTruthy();
    expect(screen.getByText('Services › Kunnskapsassistenten › Publish')).toBeTruthy();
  });

  it('shows the service as an API in English', () => {
    const api = { sharedServices: () => Promise.resolve([]) } as unknown as ApiClient;
    render(inEnglish(<ServiceAsApi api={api} />));
    expect(screen.getByRole('heading', { name: 'Variants' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Table of variants' })).toBeTruthy();
    expect(screen.getByText('Nothing. Uses the settings of the service.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Input schema' })).toBeTruthy();
  });
});
