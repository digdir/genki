// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectsApi } from './projects-api';
import { saneYears } from './screens/projects/shared';
import { ApiError } from './api';
import { exampleProject, mockProjectsApi } from './projects-mock';
import { expectAccessible, renderApp } from './testing';

document.getAnimations ??= () => [];

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const project = `#/projects/${exampleProject().id}`;

describe('projects in the workspace', () => {
  it('explains what a project is when there are none', async () => {
    const { container } = await renderApp('#/projects', {
      projects: mockProjectsApi({ projects: [] }),
    });

    expect(
      await screen.findByRole('heading', { name: 'Du har ingen prosjekter ennå' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Prosjekter' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Nytt prosjekt' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Prosjekter' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expectAccessible(container);
  });

  it('explains missing access instead of offering a retry that cannot succeed', async () => {
    const api = mockProjectsApi();
    api.list = async () => {
      throw new ApiError(403, undefined);
    };
    await renderApp('#/projects', { projects: api });

    expect(
      await screen.findByText('Du har ikke tilgang til prosjekter i denne virksomheten.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
  });

  it('deletes a project after asking, and refuses a second project with the same name', async () => {
    await renderApp(project);
    fireEvent.click(await screen.findByRole('button', { name: 'Slett prosjektet' }));
    expect(screen.getByText(/Dette kan ikke angres/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ja, slett prosjektet' }));
    expect(await screen.findByText('Prosjektet er slettet.')).toBeTruthy();
    cleanup();

    await renderApp('#/projects/new');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Navn' }), {
      target: { value: exampleProject().name },
    });
    expect(await screen.findByText('Du har allerede et prosjekt med dette navnet.')).toBeTruthy();
  });

  it('renames a project, keeps its data and refuses an empty or taken name', async () => {
    const projects = mockProjectsApi();
    const other = await projects.create(
      '999888777',
      { name: 'Inkluderingsdugnaden', purpose: '', selections: [], services: [] },
      'test',
    );
    await renderApp(project, { projects });
    fireEvent.click(await screen.findByRole('button', { name: 'Endre navn' }));
    const field = screen.getByRole('textbox', { name: 'Nytt navn' });

    fireEvent.change(field, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre navnet' }));
    expect(screen.getByText('Skriv et navn på prosjektet.')).toBeTruthy();
    fireEvent.change(field, { target: { value: other.name } });
    expect(await screen.findByText('Du har allerede et prosjekt med dette navnet.')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'Tilskuddsordningene 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre navnet' }));

    expect(await screen.findByText('Navnet er endret.')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Tilskuddsordningene 2026' }),
    ).toBeTruthy();
    const saved = await projects.get('999888777', exampleProject().id);
    expect(saved.name).toBe('Tilskuddsordningene 2026');
    expect(saved.selections).toEqual(exampleProject().selections);
    expect(saved.reason).toBe('Endret navnet på prosjektet');
  });

  it('lists projects with their selections and new documents', async () => {
    await renderApp('#/projects');

    const link = await screen.findByRole('link', { name: exampleProject().name });
    const card = link.closest('li') as HTMLElement;
    expect(link.getAttribute('href')).toBe(project);
    expect(within(card).getByText('1 utvalg')).toBeTruthy();
    expect(within(card).getByText('3 nye dokumenter')).toBeTruthy();
  });

  it('creates a project with a first selection from a dataset', async () => {
    await renderApp('#/projects/new');

    fireEvent.click(await screen.findByRole('button', { name: 'Opprett prosjektet' }));
    expect(await screen.findByText('Gi prosjektet et navn.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Navn' }), {
      target: { value: 'Inkluderingsdugnaden' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Hva skal prosjektet finne ut\?/ }), {
      target: { value: 'Hvordan rapporterer etatene?' },
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'År' }), {
      target: { value: '2025' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Opprett prosjektet' }));

    expect(await screen.findByText('Prosjektet er opprettet.')).toBeTruthy();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Inkluderingsdugnaden' }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/projects/inkluderingsdugnaden');
  });

  it('shows the data basis, new documents and lets the person follow new documents', async () => {
    const { container } = await renderApp(project);

    expect(
      await screen.findByRole('heading', { level: 1, name: exampleProject().name }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Alle prosjekter' }).getAttribute('href')).toBe(
      '#/projects',
    );
    expect(screen.getByRole('tab', { name: /Datagrunnlag/ }).textContent).toContain('3 nye');
    expect(await screen.findByText('26 dokumenter')).toBeTruthy();
    const fresh = screen.getByRole('heading', { name: 'Nye dokumenter' }).closest('section');
    expect(within(fresh as HTMLElement).getAllByText('Ny')).toHaveLength(3);
    expect(screen.getByRole('switch', { name: 'Følg med på nye dokumenter' })).toHaveProperty(
      'checked',
      true,
    );
    fireEvent.click(
      screen.getByRole('radio', { name: 'Kjør tjenesten på nye dokumenter automatisk' }),
    );
    expect(screen.getByRole('textbox', { name: 'Grense per måned (kr)' })).toBeTruthy();
    expect(
      screen.getByText('Resultatene blir utkast («Utkast laget med KI») til du godkjenner dem.'),
    ).toBeTruthy();
    expectAccessible(container);
  });

  it('says when the monthly limit is reached, the subscription is paused or access is gone', async () => {
    const capped = exampleProject();
    capped.subscriptions = capped.subscriptions.map((s) => ({
      ...s,
      mode: 'run',
      service: 'maloppnaelse',
      cap: { maxCostNok: 200 },
      status: 'paused',
      waiting: 4,
      paused: { kind: 'cost-cap', reason: 'Grensen er nådd', at: '2026-10-08T05:00:00Z' },
    }));
    await renderApp(project, { projects: mockProjectsApi({ projects: [capped], noAccess: true }) });

    expect(await screen.findByText('Månedsgrensen på 200 kr er nådd')).toBeTruthy();
    expect(screen.getByText(/^4 nye dokumenter venter\. De kjøres 1\. november/)).toBeTruthy();
    expect(await screen.findByText('Du har ikke lenger tilgang til datasettet')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Følg med på nye dokumenter' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('keeps assessment points with who wrote them', async () => {
    await renderApp(`${project}/points`);

    expect(await screen.findByText(/Mål med tall i tildelingsbrevet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    expect(screen.getByText('Skriv vurderingspunktet før du legger det til.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Nytt vurderingspunkt' }), {
      target: { value: 'Klimamål vurderes for seg.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));

    expect(await screen.findByText('Klimamål vurderes for seg.')).toBeTruthy();
    expect(await screen.findByText('Vurderingspunktet er lagt til.')).toBeTruthy();
  });

  it('lists analyses, marks old data and lets the person approve an automatic run', async () => {
    const { container } = await renderApp(`${project}/analyses`);

    const draft = await screen.findByText('Utkast laget med KI');
    const auto = draft.closest('li') as HTMLElement;
    expect(within(auto).getByRole('heading', { name: /^Automatisk: / })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Analyser/ }).textContent).toContain('1 venter');
    expect(screen.getByText(/Bygger på eldre datagrunnlag: 3 nye dokumenter siden\./)).toBeTruthy();
    expectAccessible(container);

    window.location.hash = `${project}/analyses/run-auto`;
    fireEvent.click(await screen.findByRole('button', { name: 'Godkjenn resultatene' }));

    expect(await screen.findByText('Resultatene er godkjent.')).toBeTruthy();
    expect(await screen.findByText('Godkjent av Per Hansen')).toBeTruthy();
  });

  it('estimates the cost before an analysis starts', async () => {
    await renderApp(`${project}/analyses`);

    fireEvent.click(await screen.findByRole('button', { name: 'Beregn kostnad' }));
    expect(await screen.findByText('Anslått 36 kr til 42 kr for 26 dokumenter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start analysen' }));

    expect(await screen.findByText('Analysen har startet. Resultatene kommer her.')).toBeTruthy();
  });

  it('shows progress while the cost is estimated and reuses the estimate for the same input', async () => {
    const base = exampleProject();
    const second = {
      ...(base.selections[0] as (typeof base.selections)[number]),
      id: 'arsrapporter-2024',
      name: 'Årsrapporter 2024',
    };
    const api = mockProjectsApi({
      projects: [{ ...base, selections: [...base.selections, second] }],
    });
    let calls = 0;
    const estimate = api.estimate.bind(api);
    api.estimate = async (...args) => {
      calls += 1;
      return estimate(...args);
    };
    await renderApp(`${project}/analyses`, { projects: api });

    fireEvent.click(await screen.findByRole('button', { name: 'Beregn kostnad' }));
    expect(screen.getByRole('status').textContent).toContain('Beregner kostnad');
    await screen.findByText(/Anslått/);
    const choose = (name: string) =>
      fireEvent.change(screen.getByRole('combobox', { name: 'Utvalg' }), {
        target: { value: name },
      });
    choose('arsrapporter-2024');
    fireEvent.click(await screen.findByRole('button', { name: 'Beregn kostnad' }));
    await screen.findByText(/Anslått/);
    choose('arsrapporter-2025');
    fireEvent.click(await screen.findByRole('button', { name: 'Beregn kostnad' }));
    await screen.findByText(/Anslått/);

    expect(calls).toBe(2);
  });

  it('offers only real years, newest first, in the year picker', () => {
    const values = ['2438', '2022', '2050', '2024', '1899', '2025', '2023'].map((value) => ({
      value,
    }));

    expect(saneYears(values, 2026).map((v) => v.value)).toEqual(['2025', '2024', '2023', '2022']);
  });

  it('shows who did what in the project log', async () => {
    await renderApp(`${project}/log`);

    const entry = await screen.findByText('opprettet prosjektet', { exact: false });
    expect(entry.closest('li')?.textContent).toContain('Per Hansen');
  });
});

describe('the projects API client', () => {
  it('sends the reason and the name with every change, under the tenant', async () => {
    const sent: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const api = createProjectsApi({
      baseUrl: '/api',
      token: () => 't',
      actorName: () => 'Per Hansen',
      fetch: async (url, init) => {
        sent.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        return Response.json({ id: 'p1', text: 'x', by: 'b', at: 'a' });
      },
    });

    await api.addPoint('991825827', 'p 1', 'Et punkt', 'La til vurderingspunkt');

    expect(sent[0]?.url).toBe('/api/tenants/991825827/projects/p%201/points');
    expect(sent[0]?.headers['change-reason']).toBe(encodeURIComponent('La til vurderingspunkt'));
    expect(sent[0]?.headers['actor-name']).toBe(encodeURIComponent('Per Hansen'));
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({ text: 'Et punkt' });
  });

  it('turns a problem response into an error with its title', async () => {
    const api = createProjectsApi({
      baseUrl: '',
      token: () => undefined,
      fetch: async () => Response.json({ title: 'Fant ikke prosjektet' }, { status: 404 }),
    });

    await waitFor(() => expect(api.get('1', 'x')).rejects.toMatchObject({ status: 404 }));
  });
});
