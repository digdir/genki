// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFlowInputs } from '../../data/flow-inputs';
import {
  inputFieldId,
  inputFieldsFrom,
  inputFieldsOf,
  type InputFormField,
} from '../../data/input-form';
import type { InputFieldSpec } from '../../data/service-definition';
import { InputFieldsEditor, InputFormEditor, type InputOptionLookup } from './InputFormEditor';

document.getAnimations ??= () => [];

afterEach(cleanup);

const tenant = '991825827';

const Harness = ({ seen }: { seen: InputFormField[][] }) => {
  const [fields, setFields] = useState<InputFormField[]>([]);
  return (
    <InputFormEditor
      fields={fields}
      datasets={[`${tenant}/kudos`]}
      onChange={(next) => {
        seen.push(next);
        setFields(next);
      }}
    />
  );
};

const latest = (seen: InputFormField[][]) => seen.at(-1) ?? [];

describe('the input form editor in the service builder', () => {
  it('adds, fills, reorders and removes fields', () => {
    const seen: InputFormField[][] = [];
    render(<Harness seen={seen} />);

    expect(
      screen.getByText(
        'Tjenesten tar bare imot tekst. Legg til felt hvis den trenger faste opplysninger.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til felt' }));
    fireEvent.change(screen.getByLabelText('Ledetekst'), { target: { value: 'Departement' } });
    fireEvent.click(screen.getByLabelText('Ett valg'));
    fireEvent.change(screen.getByLabelText('Faste valg, ett per linje'), {
      target: { value: 'Kunnskapsdepartementet\nKlima- og miljødepartementet' },
    });
    fireEvent.click(screen.getByLabelText('Påkrevd'));

    fireEvent.click(screen.getByRole('button', { name: 'Legg til felt' }));
    fireEvent.change(screen.getByLabelText('Ledetekst'), { target: { value: 'Virksomhet' } });
    fireEvent.click(screen.getByLabelText('Virksomhet'));
    fireEvent.click(screen.getByLabelText('Fra et datasett'));
    fireEvent.change(screen.getByLabelText('Felt i datasettet'), {
      target: { value: 'organisation' },
    });

    expect(latest(seen).map((f) => f.label)).toEqual(['Departement', 'Virksomhet']);
    expect(latest(seen)[0]?.required).toBe(true);
    expect(latest(seen)[1]?.optionsFrom).toEqual({
      dataset: `${tenant}/kudos`,
      facet: 'organisation',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Flytt Virksomhet opp' }));
    expect(latest(seen).map((f) => f.label)).toEqual(['Virksomhet', 'Departement']);
    expect(screen.getByText('«Virksomhet» er flyttet opp til plass 1.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fjern feltet' }));
    expect(latest(seen).map((f) => f.label)).toEqual(['Departement']);
  });

  it('writes the fields as spec.input.fields and reads them back', () => {
    const form: InputFormField[] = [
      {
        id: '',
        label: 'Departement',
        kind: 'choice',
        required: true,
        help: '',
        options: 'KD\nKLD\nKD',
        optionsFrom: null,
      },
      {
        id: '',
        label: 'Virksomhet',
        kind: 'organisation',
        required: false,
        help: 'Virksomheten som rapporterer',
        options: '',
        optionsFrom: { dataset: `${tenant}/kudos`, facet: 'organisation', pattern: '^[A-Z]' },
        dependsOn: 'departement',
      },
      {
        id: '',
        label: 'År',
        kind: 'year',
        required: true,
        help: '',
        options: '',
        optionsFrom: { dataset: `${tenant}/kudos`, facet: 'year' },
        default: '2025',
      },
    ];

    const fields = inputFieldsOf(form, tenant);

    expect(fields).toEqual([
      {
        id: 'departement',
        label: 'Departement',
        kind: 'choice',
        required: true,
        options: ['KD', 'KLD'],
      },
      {
        id: 'virksomhet',
        label: 'Virksomhet',
        kind: 'organisation',
        required: false,
        help: 'Virksomheten som rapporterer',
        dependsOn: 'departement',
        optionsFrom: { dataset: `${tenant}/kudos`, facet: 'organisation', pattern: '^[A-Z]' },
      },
      {
        id: 'aar',
        label: 'År',
        kind: 'year',
        required: true,
        default: 2025,
        optionsFrom: { dataset: `${tenant}/kudos`, facet: 'year' },
      },
    ]);
    const back = inputFieldsFrom({ fields });
    expect(back.map((f) => [f.id, f.options, f.default, f.dependsOn])).toEqual([
      ['departement', 'KD\nKLD', undefined, undefined],
      ['virksomhet', '', undefined, 'departement'],
      ['aar', '', '2025', undefined],
    ]);
  });

  it('lets a person type one option per line while the definition holds the list', () => {
    const seen: (InputFieldSpec[] | undefined)[] = [];
    const Probe = () => {
      const [fields, setFields] = useState<InputFieldSpec[] | undefined>([
        { id: 'departement', label: 'Departement', kind: 'choice', options: ['KD'] },
      ]);
      return (
        <InputFieldsEditor
          fields={fields ?? []}
          datasets={[]}
          tenant={tenant}
          onChange={(next) => {
            seen.push(next);
            setFields(next);
          }}
        />
      );
    };
    render(<Probe />);
    const options = screen.getByLabelText('Faste valg, ett per linje') as HTMLTextAreaElement;

    fireEvent.change(options, { target: { value: 'KD\n' } });
    expect((screen.getByLabelText('Faste valg, ett per linje') as HTMLTextAreaElement).value).toBe(
      'KD\n',
    );
    fireEvent.change(options, { target: { value: 'KD\nKLD' } });
    expect(seen.at(-1)?.[0]?.options).toEqual(['KD', 'KLD']);

    fireEvent.click(screen.getByRole('button', { name: 'Fjern feltet' }));
    expect(seen.at(-1)).toBeUndefined();
  });
});

const field = (label: string, id = ''): InputFormField => ({
  id,
  label,
  kind: 'text',
  required: false,
  help: '',
  options: '',
  optionsFrom: null,
});

const flow = {
  spec: {
    input: { virksomheter: 'liste', aar: 'liste' },
    steps: [
      {
        id: 'finn',
        block: 'documents@1',
        input: { filters: { orgs_short: '{{input.virksomheter}}', years: '{{input.aar}}' } },
      },
    ],
  },
};

describe('the ids of input form fields', () => {
  it('spells æ, ø and å so that År becomes aar', () => {
    expect(inputFieldId('År', [])).toBe('aar');
    expect(inputFieldId('Økonomi og bærekraft', [])).toBe('okonomi_og_baerekraft');
  });

  it('shows the id, lets it be changed before publishing and locks it after', () => {
    const changes: InputFormField[][] = [];
    const { rerender } = render(
      <InputFormEditor fields={[field('År')]} datasets={[]} onChange={(f) => changes.push(f)} />,
    );
    const id = screen.getByLabelText('Id') as HTMLInputElement;
    expect(id.value).toBe('aar');
    fireEvent.change(id, { target: { value: 'ar' } });
    expect(changes[0]?.[0]?.id).toBe('ar');

    rerender(
      <InputFormEditor
        fields={[field('År', 'aar')]}
        datasets={[]}
        lockedIds={['aar']}
        onChange={() => undefined}
      />,
    );
    expect((screen.getByLabelText('Id') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('Publisert. Id-en kan ikke endres.')).toBeTruthy();
  });

  it('lets the id follow the label until it is changed by hand', () => {
    const seen: InputFormField[][] = [];
    render(<Harness seen={seen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Legg til felt' }));
    fireEvent.change(screen.getByLabelText('Ledetekst'), { target: { value: 'Økonomi' } });
    expect((screen.getByLabelText('Id') as HTMLInputElement).value).toBe('okonomi');

    fireEvent.change(screen.getByLabelText('Id'), { target: { value: 'economy' } });
    fireEvent.change(screen.getByLabelText('Ledetekst'), { target: { value: 'Økonomi og drift' } });
    expect(latest(seen)[0]?.id).toBe('economy');
  });

  it('shows what the step flow needs and blocks publishing when an input is missing', () => {
    const check = checkFlowInputs('maloppnaelse-flyt@1', flow, ['virksomheter', 'ar']);
    expect(check).toEqual({
      flow: 'maloppnaelse-flyt@1',
      used: ['virksomheter', 'aar'],
      missing: ['aar'],
      declared: [],
    });
    render(
      <InputFormEditor
        fields={[field('Virksomheter', 'virksomheter'), field('År', 'ar')]}
        datasets={[]}
        onChange={() => undefined}
        flowCheck={check}
      />,
    );
    expect(screen.getByText('Skjemaet kan ikke publiseres før dette er rettet:')).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'Stegflyten trenger input.aar, men ingen felt har id-en «aar».',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Fylles av feltet «Virksomheter»')).toBeTruthy();
    expect(screen.getByText('Mangler')).toBeTruthy();
    expect(checkFlowInputs('f@1', flow, ['virksomheter', 'aar']).missing).toEqual([]);
  });

  it('suggests fields for the inputs the step flow reads and adds them', () => {
    const seen: InputFormField[][] = [];
    const check = checkFlowInputs('maloppnaelse-flyt@1', flow, []);
    const Suggesting = () => {
      const [fields, setFields] = useState<InputFormField[]>([]);
      return (
        <InputFormEditor
          fields={fields}
          datasets={[]}
          flowCheck={checkFlowInputs(
            'maloppnaelse-flyt@1',
            flow,
            fields.map((f) => f.id),
          )}
          onChange={(next) => {
            seen.push(next);
            setFields(next);
          }}
        />
      );
    };
    expect(check.missing).toEqual(['virksomheter', 'aar']);
    render(<Suggesting />);

    expect(screen.getByText('Forslag: 2 felt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til i utkastet' }));

    expect(latest(seen).map((f) => [f.id, f.required])).toEqual([
      ['virksomheter', true],
      ['aar', true],
    ]);
    expect(screen.queryByText('Forslag: 2 felt')).toBeNull();
    expect(screen.queryByText('Skjemaet kan ikke publiseres før dette er rettet:')).toBeNull();
  });

  it('flags a duplicate id and a choice without options', () => {
    render(
      <InputFormEditor
        fields={[field('Virksomhet', 'agency'), { ...field('År', 'agency'), kind: 'choice' }]}
        datasets={[]}
        onChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole('link', {
        name: 'Id-en «agency» er allerede brukt av feltet «Virksomhet». Id-ene må være unike.',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: '«År» trenger minst ett valg.' })).toBeTruthy();
    expect(screen.getAllByText('Feil')).toHaveLength(1);
  });
});

const dataset = `${tenant}/kudos`;

const lookup = (facets: string[]): InputOptionLookup => ({
  datasets: async () => [{ ref: dataset, name: 'Kudos-rapporter', facets }],
  values: async () => [
    { value: 'Digitaliseringsdirektoratet', count: 412 },
    { value: 'Testetaten', count: 164 },
    { value: 'Statens eksempelverk', count: 188 },
    { value: 'Prøvedirektoratet', count: 97 },
    { value: 'Lånekassen', count: 50 },
  ],
});

const fromDataset = (label: string, id: string, facet: string): InputFormField => ({
  ...field(label, id),
  kind: 'organisation',
  optionsFrom: { dataset, facet },
});

describe('options from a dataset', () => {
  it('lists the facets of the dataset and shows the values it holds now', async () => {
    render(
      <InputFormEditor
        fields={[fromDataset('Virksomhet', 'agency', 'orgs_long')]}
        datasets={[dataset]}
        lookup={lookup(['orgs_long', 'type'])}
        onChange={() => undefined}
      />,
    );

    expect(await screen.findByText('Verdier i datasettet nå')).toBeTruthy();
    expect(screen.getByText('Digitaliseringsdirektoratet, 412 dokumenter')).toBeTruthy();
    expect(screen.getByText('… og 1 til')).toBeTruthy();
    expect(
      [...(screen.getByLabelText('Felt i datasettet') as HTMLSelectElement).options].map(
        (o) => o.value,
      ),
    ).toEqual(['orgs_long', 'type']);
    expect(screen.getByText('fra Kudos-rapporter (orgs_long)', { exact: false })).toBeTruthy();
  });

  it('says when the search engine of the dataset cannot fetch options', async () => {
    render(
      <InputFormEditor
        fields={[fromDataset('Virksomhet', 'agency', 'orgs_long')]}
        datasets={[dataset]}
        lookup={lookup([])}
        onChange={() => undefined}
      />,
    );

    expect(
      await screen.findByText(
        'Søkemotoren til datasettet kan ikke hente valg. Bruk faste valg, eller bytt søkemotor.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: '«Virksomhet»: søkemotoren til datasettet kan ikke hente valg.',
      }),
    ).toBeTruthy();
  });

  it('marks where a dependent choice gets its link as not decided, and disables it in the preview', () => {
    render(
      <InputFormEditor
        fields={[
          { ...field('Departement', 'ministry'), kind: 'choice', options: 'KD\nDFD' },
          { ...fromDataset('Virksomhet', 'agency', 'orgs_long'), dependsOn: 'ministry' },
        ]}
        datasets={[dataset]}
        onChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Virksomhet' }));

    expect(screen.getByText('Hvor koblingen kommer fra')).toBeTruthy();
    expect(screen.getAllByText('Ikke bestemt').length).toBeGreaterThan(0);
    const preview = screen.getByPlaceholderText('Velg departement først') as HTMLInputElement;
    expect(preview.disabled).toBe(true);
  });
});
