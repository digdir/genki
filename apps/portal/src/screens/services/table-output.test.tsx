// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { tableOutputFrom, tableOutputSpec, type TableOutput } from '../../data/table-output';
import { TableColumnsEditor, TableOutputEditor, type TableSpec } from './TableOutputEditor';

afterEach(cleanup);

const goal = {
  key: 'goal',
  name: 'Mål',
  type: 'string',
  desc: 'Målet slik det står i tildelingsbrevet.',
  kind: 'document',
  values: '',
} as const;
const assessment = {
  key: 'assessment',
  name: 'Vurdering',
  type: 'enum',
  desc: 'Om målet er nådd.',
  kind: 'assessment',
  values: 'Nådd, Delvis nådd, Ikke nådd',
} as const;

const Harness = ({ initial, seen }: { initial: TableOutput; seen: TableOutput[] }) => {
  const [table, setTable] = useState(initial);
  return (
    <TableOutputEditor
      serviceId="maloppnaelse"
      table={table}
      onChange={(t) => {
        seen.push(t);
        setTable(t);
      }}
    />
  );
};

const columns = () => screen.getAllByRole('listitem');

describe('table output columns in the builder', () => {
  it('moves, renames and removes columns and keeps the row key on the renamed column', () => {
    const seen: TableOutput[] = [];
    render(<Harness initial={{ columns: [goal, assessment], rowKey: 'goal' }} seen={seen} />);

    fireEvent.click(screen.getByRole('button', { name: 'Flytt Vurdering opp' }));
    expect(columns()[0]?.textContent).toContain('1. Vurdering');
    expect(screen.getByText('«Vurdering» er nå kolonne 1.')).toBeTruthy();

    const second = columns()[1] as HTMLElement;
    fireEvent.change(within(second).getByLabelText('Nøkkel'), { target: { value: 'maal' } });
    expect(seen.at(-1)?.rowKey).toBe('maal');

    fireEvent.click(screen.getByRole('button', { name: 'Fjern Mål' }));
    expect(seen.at(-1)).toEqual({ columns: [assessment], rowKey: '' });
    expect(screen.getByText('«Mål» er fjernet.')).toBeTruthy();
  });

  it('shows allowed values for an assessment and flags duplicate keys', () => {
    render(<Harness initial={{ columns: [goal], rowKey: '' }} seen={[]} />);

    expect(screen.queryByLabelText('Tillatte verdier, kommaseparert')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Vurdering' }));
    expect(screen.getByLabelText('Tillatte verdier, kommaseparert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Legg til kolonne' }));
    const added = columns()[1] as HTMLElement;
    expect((within(added).getByLabelText('Nøkkel') as HTMLInputElement).value).toBe('ny_kolonne');
    fireEvent.change(within(added).getByLabelText('Nøkkel'), { target: { value: 'goal' } });
    expect(within(added).getByText(/Nøkkelen «goal» er allerede brukt/)).toBeTruthy();
  });

  it('marks which column identifies the row', () => {
    const seen: TableOutput[] = [];
    render(<Harness initial={{ columns: [goal, assessment], rowKey: '' }} seen={seen} />);

    const second = columns()[1] as HTMLElement;
    fireEvent.click(within(second).getByRole('radio', { name: 'Identifiserer raden' }));
    expect(seen.at(-1)?.rowKey).toBe('assessment');
  });
});

describe('table output in the definition', () => {
  it('writes the columns and row key and reads them back', () => {
    const table = { columns: [goal, assessment], rowKey: 'goal' };
    const output = tableOutputSpec(table);
    expect(output.rowKey).toBe('goal');
    expect(output.columns).toEqual([
      {
        key: 'goal',
        name: 'Mål',
        type: 'string',
        description: 'Målet slik det står i tildelingsbrevet.',
        kind: 'document',
      },
      {
        key: 'assessment',
        name: 'Vurdering',
        type: 'enum',
        description: 'Om målet er nådd.',
        kind: 'assessment',
        values: ['Nådd', 'Delvis nådd', 'Ikke nådd'],
      },
    ]);
    expect(tableOutputFrom(output)).toEqual(table);
  });

  it('lets a person type a column name with spaces while the definition holds the trimmed name', () => {
    const seen: TableSpec[] = [];
    const Probe = () => {
      const [table, setTable] = useState<TableSpec>(
        tableOutputSpec({ columns: [goal], rowKey: '' }),
      );
      return (
        <TableColumnsEditor
          serviceId="maloppnaelse"
          table={table}
          onChange={(next) => {
            seen.push(next);
            setTable(next);
          }}
        />
      );
    };
    render(<Probe />);
    const name = within(columns()[0] as HTMLElement).getByLabelText('Navn') as HTMLInputElement;

    fireEvent.change(name, { target: { value: 'Mål ' } });
    expect(name.value).toBe('Mål ');
    expect(seen.at(-1)?.columns?.[0]?.name).toBe('Mål');
  });
});
