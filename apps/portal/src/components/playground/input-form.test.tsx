// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient, type ApiClient } from '../../api';
import type { PlaygroundRunRequest } from '../../api/playground';
import { mockFetch } from '../../mock';
import { toYaml } from '../../yaml';
import { TestRun } from '../../screens/service/TestRun';
import { InputForm, type FormValues } from './InputForm';
import { PlaygroundPanel } from './PlaygroundPanel';

document.getAnimations ??= () => [];
afterEach(cleanup);

const tenant = '991825827';

const definition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'rapportassistenten', name: 'Rapportassistenten' },
  spec: {
    input: {
      accepts: ['text/plain'],
      fields: [
        {
          id: 'ministry',
          label: 'Departement',
          kind: 'choice',
          required: true,
          options: ['Kunnskapsdepartementet', 'Klima- og miljødepartementet'],
        },
        { id: 'year', label: 'År', kind: 'year' },
      ],
    },
    output: { kind: 'answer' },
  },
};

describe('the input form in the playground', () => {
  it('shows the draft form, refuses a run without required fields and sends the values', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const api = createApiClient({
      baseUrl: '/api',
      fetch: mockFetch(undefined, undefined, undefined, undefined, {
        features: { playground: { runs } },
      }),
      token: () => 'kari',
    });
    render(
      <PlaygroundPanel
        layout="full"
        context="service"
        name="rapportassistenten"
        api={api}
        tenant={tenant}
        tenantName="Testetaten"
        serviceDraft={{ definition }}
      />,
    );

    const ministry = await screen.findByRole('combobox', { name: /Departement/ });
    expect(screen.getByText('Må fylles ut')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Fyll ut «Departement».')).toBeTruthy();
    expect(runs).toEqual([]);

    fireEvent.change(ministry, { target: { value: 'Kunnskapsdepartementet' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'År' }), { target: { value: '2025' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål eller merknad (valgfritt)' }), {
      target: { value: 'Er målene nådd?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByRole('link', { name: 'Se kjøringen' });
    expect(runs[0]?.input).toEqual({
      fields: { ministry: 'Kunnskapsdepartementet', year: 2025 },
      text: 'Er målene nådd?',
    });
  });
});

const withFacetField = {
  ...definition,
  spec: {
    ...definition.spec,
    input: {
      accepts: ['text/plain'],
      fields: [
        {
          id: 'type',
          label: 'Dokumenttype',
          kind: 'choice',
          required: true,
          optionsFrom: { dataset: 'digdir/kudos', facet: 'type' },
        },
      ],
    },
  },
};

const mockApi = () => createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'kari' });

const typeOptions = async () =>
  [
    ...(
      (await screen.findByRole('option', { name: 'Årsrapport' })).parentElement as HTMLElement
    ).querySelectorAll('option'),
  ].map((o) => o.textContent);

describe('fields with options from a dataset facet', () => {
  it('lists the facet values in the playground form for a draft', async () => {
    render(
      <PlaygroundPanel
        layout="full"
        context="service"
        name="rapportassistenten"
        api={mockApi()}
        tenant={tenant}
        tenantName="Testetaten"
        serviceDraft={{ definition: withFacetField }}
      />,
    );

    expect(await typeOptions()).toEqual(['Velg', 'Årsrapport', 'Tildelingsbrev']);
  });

  it('shows the form with facet values in the builder test run of a YAML draft', async () => {
    render(
      <TestRun
        api={mockApi()}
        tenant={tenant}
        serviceId="rapportassistenten"
        draft={toYaml(withFacetField)}
      />,
    );

    expect(await typeOptions()).toEqual(['Velg', 'Årsrapport', 'Tildelingsbrev']);
    expect(screen.getByLabelText('Spørsmål eller merknad (valgfritt)')).toBeTruthy();
  });

  it('shows the form of the published version in the builder test run', async () => {
    const asked: unknown[] = [];
    const api = {
      getDefinition: async () => ({ latest: { definition: withFacetField } }),
      draftInputFields: async (_tenant: string, sent: unknown) => {
        asked.push(sent);
        return [{ ...withFacetField.spec.input.fields[0], options: ['Årsrapport'] }];
      },
    } as unknown as ApiClient;
    render(<TestRun api={api} tenant={tenant} serviceId="rapportassistenten" />);

    expect(await typeOptions()).toEqual(['Velg', 'Årsrapport']);
    expect(asked).toEqual([withFacetField]);
  });
});

describe('the input form in the builder test run', () => {
  it('runs the draft from the form and sends the values as input', async () => {
    const calls: unknown[][] = [];
    const api = {
      testRunDraft: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, task: 't1', answer: 'Vurdert.', parts: [] };
      },
    } as unknown as ApiClient;
    render(<TestRun api={api} tenant={tenant} serviceId="rapportassistenten" draft={definition} />);

    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøve' }));
    expect(await screen.findByText('Fyll ut «Departement».')).toBeTruthy();
    expect(calls).toEqual([]);

    fireEvent.change(screen.getByRole('combobox', { name: /Departement/ }), {
      target: { value: 'Klima- og miljødepartementet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøve' }));

    expect(await screen.findByText('Vurdert.')).toBeTruthy();
    expect(calls[0]?.[2]).toBe('');
    expect(calls[0]?.[4]).toEqual({ ministry: 'Klima- og miljødepartementet' });
  });
});

describe('a choice with many options', () => {
  const years = Array.from({ length: 30 }, (_, i) => String(2026 - i));
  const Harness = ({ seen }: { seen: (string | string[])[] }) => {
    const [values, setValues] = useState<FormValues>({});
    return (
      <InputForm
        intro="Fyll ut skjemaet."
        fields={[{ id: 'year', label: 'År', kind: 'choice', options: years }]}
        values={values}
        errors={{}}
        onChange={(id, value) => {
          seen.push(value);
          setValues((v) => ({ ...v, [id]: value }));
        }}
      />
    );
  };

  it('offers a searchable list instead of a long select', () => {
    const seen: (string | string[])[] = [];
    const { container } = render(<Harness seen={seen} />);

    expect(screen.queryByRole('combobox', { name: /^År/ })?.tagName).not.toBe('SELECT');
    expect(screen.getByLabelText(/^År/, { selector: 'input' })).toBeTruthy();
    const item = document.createElement('data');
    item.value = '2024';
    item.textContent = '2024';
    act(() => {
      container
        .querySelector('ds-suggestion')
        ?.dispatchEvent(
          new CustomEvent('comboboxbeforeselect', { detail: item, cancelable: true }),
        );
    });

    expect(seen).toEqual(['2024']);
  });
});
