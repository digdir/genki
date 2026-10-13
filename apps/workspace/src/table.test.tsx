// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exampleGoalTable } from './mock';
import { tableFrom, type ResultTable } from './ResultTable';
import { TableResult, type TableActions } from './screens/TableResult';
import { expectAccessible } from './testing';
import type { CellEdit, TableReview } from './types';

document.getAnimations ??= () => [];

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(cleanup);

const goals = tableFrom(exampleGoalTable) as ResultTable;

const boot = (
  options: { table?: ResultTable; actions?: TableActions; review?: TableReview } = {},
) => {
  const flashes: string[] = [];
  const saved: CellEdit[][] = [];
  let approved = 0;
  const actions: TableActions = options.actions ?? {
    ...(options.review ? { load: async () => options.review as TableReview } : {}),
    save: async (edits) => {
      saved.push(edits);
      return {
        edits: edits.map((e) => ({ ...e, byName: 'Per Hansen' })),
        approval: { status: 'draft' },
      };
    },
    approve: async () => {
      approved += 1;
      return {
        edits: [],
        approval: { status: 'approved', byName: 'Per Hansen', at: '2026-10-08T09:20:00Z' },
      };
    },
  };
  const view = render(
    <div lang="nb">
      <TableResult
        entry={{
          key: 'task-1',
          task: 'task-1',
          serviceName: 'Vurdering av måloppnåelse',
          createdAt: '2026-10-08T08:14:00Z',
          inputs: [
            { label: 'Departement', value: 'Testdepartementet' },
            { label: 'Virksomhet', value: 'Statens eksempelverk' },
          ],
          table: options.table ?? goals,
        }}
        actions={actions}
        userName="Per Hansen"
        logUrl="http://portal/#/log/task-1"
        onFlash={(text) => flashes.push(text)}
      />
    </div>,
  );
  return { view, flashes, saved, approved: () => approved };
};

const region = () => screen.getByRole('region', { name: goals.title as string });

describe('a table with a source in each cell', () => {
  it('is a draft that says what is quoted, what is assessed and what lacks a source', () => {
    const { view } = boot();

    expect(screen.getByRole('heading', { level: 1, name: goals.title as string })).toBeTruthy();
    expect(screen.getByText(/Utkast laget med KI\./)).toBeTruthy();
    expect(screen.getByText(/KI-vurderingene er merket\./)).toBeTruthy();
    expect(screen.getByText('Statens eksempelverk')).toBeTruthy();
    expect(
      screen.getByText('4 rader: 1 nådd, 1 delvis nådd, 1 ikke nådd, 1 ikke omtalt'),
    ).toBeTruthy();
    expect(within(region()).getAllByText('KI-vurdering')).toHaveLength(2);
    expect(within(region()).getAllByText('Fra dokumentet')).toHaveLength(2);
    expect(within(region()).getByText('Ingen omtale funnet.')).toBeTruthy();
    expect(screen.getByText('1 celle mangler kilde')).toBeTruthy();
    expect(within(region()).getAllByText('Ingen kilde')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Godkjenn tabellen' })).toBeTruthy();
    expectAccessible(view.container);
  });

  it('filters on the assessment and sorts by a column', () => {
    boot();

    fireEvent.click(screen.getByRole('radio', { name: '1 ikke nådd' }));
    expect(within(region()).getAllByRole('row')).toHaveLength(2);
    expect(within(region()).getByText('Mål 3: Redusere sykefravær')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Alle' }));
    fireEvent.click(within(region()).getByRole('button', { name: /Vurdering/ }));
    const header = within(region()).getByRole('columnheader', { name: /Vurdering/ });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });

  it('opens a source with the quote, page, version and a link to the document', async () => {
    boot();

    fireEvent.click(
      within(region()).getAllByRole('button', {
        name: 'Kilde 1 for Mål 1: Raskere saksbehandling, Årsrapport 2025, Statens eksempelverk',
      })[0] as HTMLElement,
    );

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByRole('heading', { name: 'Kilde 1' })).toBeTruthy();
    expect(
      within(panel).getByText('Saksbehandlingstiden gikk ned fra 41 til 28 dager.'),
    ).toBeTruthy();
    expect(within(panel).getByText('4')).toBeTruthy();
    expect(within(panel).getByText('2')).toBeTruthy();
    expect(
      within(panel).getByRole('link', { name: 'Åpne dokumentet (åpnes i ny fane)' }),
    ).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Se kjøringen' }).getAttribute('href')).toBe(
      'http://portal/#/log/task-1',
    );
  });

  it('shows the excerpt, location and date of a source from a step flow table', async () => {
    const table = tableFrom({
      title: goals.title,
      columns: [{ key: 'goal', label: 'Mål' }],
      rows: [
        {
          document: '90581',
          cells: {
            goal: {
              value: 'Effektiv forvaltning',
              sources: [
                {
                  chunkId: 'c1',
                  document: '90581',
                  title: 'Tildelingsbrev 2024',
                  excerpt: 'Forvaltningen i Norge er effektiv.',
                  headers: ['3. Mål', 'Mål 1'],
                  publishedAt: '2024-12-20T00:00:00.000Z',
                },
              ],
            },
          },
        },
      ],
      skipped: [],
    }) as ResultTable;
    boot({ table });

    fireEvent.click(
      within(region()).getAllByRole('button', { name: /^Kilde 1 for/ })[0] as HTMLElement,
    );

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Forvaltningen i Norge er effektiv.')).toBeTruthy();
    expect(within(panel).getByText('3. Mål › Mål 1')).toBeTruthy();
    expect(within(panel).getByText('20. desember 2024')).toBeTruthy();
  });

  it('lets the person change an assessment, keeps the original and saves the change', async () => {
    const { saved } = boot();

    fireEvent.click(
      within(region()).getByRole('button', {
        name: 'Endre vurdering for Mål 3: Redusere sykefravær',
      }),
    );
    fireEvent.change(
      within(region()).getByRole('combobox', {
        name: 'Endre vurdering for Mål 3: Redusere sykefravær',
      }),
      { target: { value: 'Delvis nådd' } },
    );
    fireEvent.click(within(region()).getByRole('button', { name: 'Ferdig' }));

    await waitFor(() =>
      expect(saved.at(-1)).toEqual([{ row: 2, column: 'assessment', value: 'Delvis nådd' }]),
    );
    expect(within(region()).getByText('Endret av deg')).toBeTruthy();
    fireEvent.click(within(region()).getByRole('button', { name: 'Vis opprinnelig' }));
    expect(within(region()).getByText('Opprinnelig: Ikke nådd')).toBeTruthy();
  });

  it('records who approved the table and removes the draft mark and the edit buttons', async () => {
    const { flashes, approved } = boot();

    fireEvent.click(screen.getByRole('button', { name: 'Godkjenn tabellen' }));

    expect(
      await screen.findByText(/^Godkjent av Per Hansen 8\. oktober 2026 kl\. 11\.20\./),
    ).toBeTruthy();
    expect(approved()).toBe(1);
    expect(flashes.at(-1)).toMatch(/^Tabellen er godkjent\./);
    expect(screen.queryByText(/Utkast laget med KI\./)).toBeNull();
    expect(within(region()).queryByRole('button', { name: /^Endre vurdering/ })).toBeNull();
  });

  it('shows an earlier approval and edits from the API when it opens', async () => {
    boot({
      review: {
        edits: [
          { row: 0, column: 'assessment', value: 'Delvis nådd', original: 'Nådd', byName: 'Kari' },
        ],
        approval: { status: 'approved', byName: 'Kari Nordmann', at: '2026-10-07T07:00:00Z' },
      },
    });

    expect(await screen.findByText(/^Godkjent av Kari Nordmann/)).toBeTruthy();
    expect(within(region()).getByText('Endret av Kari')).toBeTruthy();
  });

  it('downloads CSV with the sources, marked as a draft until it is approved', async () => {
    const { flashes } = boot();

    fireEvent.click(screen.getByRole('button', { name: 'Last ned' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: /CSV/ })).toBeTruthy();
    expect(within(dialog).getByRole('switch', { name: 'Ta med kilder' })).toBeTruthy();
    expect(
      within(dialog).getByText('Tabellen er ikke godkjent. Filen merkes «Utkast laget med KI».'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Last ned' }));

    expect(flashes.at(-1)).toBe('Tabellen er lastet ned som CSV, med kilder.');
  });

  it('pages through many rows, 50 at a time', () => {
    const many: ResultTable = {
      title: goals.title as string,
      columns: goals.columns,
      rows: Array.from({ length: 120 }, (_, i) => ({
        cells: {
          goal: { value: `Virksomhet ${String(i + 1).padStart(3, '0')}`, sources: [] },
          assessment: { value: i % 2 ? 'Nådd' : 'Ikke nådd', sources: [] },
        },
      })),
      skipped: [],
    };
    boot({ table: many });

    expect(within(region()).getAllByRole('row')).toHaveLength(51);
    expect(screen.getByText('Viser 1–50 av 120 rader.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Side 3' }));
    expect(screen.getByText('Viser 101–120 av 120 rader.')).toBeTruthy();
  });

  it('shows a skipped document with a translated reason and never the English engine message', () => {
    boot({
      table: {
        title: goals.title as string,
        columns: goals.columns,
        rows: [],
        skipped: [
          {
            index: 0,
            document: { title: 'Årsrapport' },
            code: 'invalid_json',
            error: 'step uthenting: the model did not return valid JSON',
          },
        ],
      },
    });

    expect(screen.getAllByText(/format som ikke kunne leses/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/did not return valid JSON/)).toBeNull();
  });
});
