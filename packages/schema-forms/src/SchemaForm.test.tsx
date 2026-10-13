// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { InLocale } from '@genai/i18n/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureSchemaFetch, fixtureSchemaList, fixtureSchemas } from './fixtures.js';
import type { UiSchema, Value } from './schema.js';
import { SchemaForm, type SchemaFormProps } from './SchemaForm.js';
import { problemIssues } from './validate.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const Harness = ({
  initial = {},
  onValue,
  ...props
}: Omit<SchemaFormProps, 'value' | 'onChange'> & {
  initial?: Value;
  onValue?: (v: Value) => void;
}) => {
  const [value, setValue] = useState<Value>(initial);
  return (
    <SchemaForm
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
};

const one = (name: string, schema: UiSchema, required = false): UiSchema => ({
  type: 'object',
  ...(required ? { required: [name] } : {}),
  properties: { [name]: { 'x-label': { nb: 'Felt', en: 'Field' }, ...schema } },
});

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0] as Value;

describe('widgets', () => {
  it('text widget writes the typed text and empties to no value', () => {
    const spy = vi.fn();
    render(<Harness schema={one('name', { type: 'string' })} onValue={spy} />);
    const input = screen.getByLabelText(/^Felt/);
    fireEvent.change(input, { target: { value: 'Kari' } });
    expect(last(spy)).toEqual({ name: 'Kari' });
    fireEvent.change(input, { target: { value: '' } });
    expect(last(spy)).toEqual({});
  });

  it('textarea and prompt widgets render a multi-line field', () => {
    render(<Harness schema={one('text', { type: 'string', 'x-widget': 'prompt' })} />);
    expect(screen.getByLabelText(/^Felt/).tagName).toBe('TEXTAREA');
    cleanup();
    render(<Harness schema={one('text', { type: 'string', 'x-widget': 'textarea' })} />);
    expect(screen.getByLabelText(/^Felt/).tagName).toBe('TEXTAREA');
  });

  it('number widget reads a Norwegian decimal comma', () => {
    const spy = vi.fn();
    render(<Harness schema={one('t', { type: 'number' })} onValue={spy} />);
    fireEvent.change(screen.getByLabelText(/^Felt/), { target: { value: '0,7' } });
    expect(last(spy)).toEqual({ t: 0.7 });
    expect((screen.getByLabelText(/^Felt/) as HTMLInputElement).value).toBe('0,7');
  });

  it('toggle widget is a switch', () => {
    const spy = vi.fn();
    render(<Harness schema={one('on', { type: 'boolean' })} onValue={spy} />);
    fireEvent.click(screen.getByRole('switch', { name: /Felt/ }));
    expect(last(spy)).toEqual({ on: true });
  });

  it('select widget shows enum labels and offers the default when the field is optional', () => {
    const spy = vi.fn();
    render(
      <Harness
        schema={one('mode', {
          type: 'string',
          enum: ['fast', 'thorough'],
          'x-enumLabels': {
            fast: { nb: 'Rask', en: 'Fast' },
            thorough: { nb: 'Grundig', en: 'Thorough' },
          },
        })}
        onValue={spy}
      />,
    );
    const select = screen.getByLabelText(/^Felt/);
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Bruk standard', 'Rask', 'Grundig']);
    fireEvent.change(select, { target: { value: 'thorough' } });
    expect(last(spy)).toEqual({ mode: 'thorough' });
  });

  it('multiselect widget is a group of checkboxes', () => {
    const spy = vi.fn();
    render(
      <Harness
        schema={one('caps', {
          type: 'array',
          items: { type: 'string', enum: ['stream', 'tools'] },
        })}
        onValue={spy}
      />,
    );
    const group = screen.getByRole('group', { name: /Felt/ });
    fireEvent.click(within(group).getByLabelText('tools'));
    expect(last(spy)).toEqual({ caps: ['tools'] });
  });

  it.each(['model', 'dataset', 'tool'])(
    '%s widget loads its options from the x-options route with the app fetch',
    async (widget) => {
      const fetchJson = vi.fn(async () => ({ data: [{ id: 'gpt', name: 'GPT 4.1' }] }));
      render(
        <Harness
          schema={one('ref', {
            type: 'string',
            'x-widget': widget,
            'x-options': { route: '/tenants/{tenant}/things', value: 'id', label: 'name' },
          })}
          fetchJson={fetchJson}
          routeParams={{ tenant: '991825827' }}
        />,
      );
      expect(await screen.findByRole('option', { name: 'GPT 4.1' })).toBeTruthy();
      expect(fetchJson).toHaveBeenCalledWith('/tenants/991825827/things', expect.anything());
    },
  );

  it('multiselect widget reads its options from a nested list in the route response, in the order they are ticked', async () => {
    const fetchJson = vi.fn(async () => ({
      fields: [{ field: 'type', options: [{ value: 'Evaluering' }, { value: 'Årsrapport' }] }],
    }));
    const spy = vi.fn();
    render(
      <Harness
        schema={one('types', {
          type: 'array',
          items: { type: 'string' },
          'x-widget': 'multiselect',
          'x-options': {
            route: '/api/facets?dataset-config-key={datasetKey}&fields={documentField}',
            items: 'fields.0.options',
            value: 'value',
          },
        })}
        fetchJson={fetchJson}
        routeParams={{ datasetKey: 'kudos', documentField: 'type' }}
        onValue={spy}
      />,
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Årsrapport' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Evaluering' }));
    expect(fetchJson).toHaveBeenCalledWith(
      '/api/facets?dataset-config-key=kudos&fields=type',
      expect.anything(),
    );
    expect(last(spy)).toEqual({ types: ['Årsrapport', 'Evaluering'] });
  });

  it('secret widget never shows the stored value', () => {
    const spy = vi.fn();
    render(
      <Harness
        schema={one('key', { type: 'string', 'x-sensitive': true })}
        initial={{ key: 'hemmelig-verdi' }}
        onValue={spy}
      />,
    );
    const input = screen.getByLabelText(/^Felt/) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    expect(screen.queryByDisplayValue('hemmelig-verdi')).toBeNull();
    expect(screen.getByText(/En verdi er lagret og vises ikke/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'ny' } });
    expect(last(spy)).toEqual({ key: 'ny' });
  });

  it('cron widget explains the five fields and rejects anything else', () => {
    render(
      <Harness
        schema={one('when', { type: 'string', 'x-widget': 'cron' })}
        initial={{ when: 'hver dag' }}
        showErrors
      />,
    );
    expect(screen.getAllByText(/Felt må ha fem felt/).length).toBeGreaterThan(0);
  });

  it('code widget parses JSON and flags invalid JSON', () => {
    const spy = vi.fn();
    render(
      <Harness
        schema={one('cfg', { type: 'object', 'x-widget': 'code' })}
        onValue={spy}
        showErrors
      />,
    );
    const box = screen.getByLabelText(/^Felt/);
    fireEvent.change(box, { target: { value: '{"a": 1}' } });
    expect(last(spy)).toEqual({ cfg: { a: 1 } });
    fireEvent.change(box, { target: { value: '{"a":' } });
    expect(screen.getAllByText('Felt må være gyldig JSON.').length).toBeGreaterThan(0);
  });

  it('list widget adds and removes values', () => {
    const spy = vi.fn();
    render(
      <Harness schema={one('tags', { type: 'array', items: { type: 'string' } })} onValue={spy} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    fireEvent.change(screen.getByLabelText('Felt 1'), { target: { value: 'a' } });
    expect(last(spy)).toEqual({ tags: ['a'] });
    fireEvent.click(screen.getByRole('button', { name: 'Fjern Felt 1' }));
    expect(last(spy)).toEqual({});
  });

  it('list widget renders object items with their own fields', () => {
    const spy = vi.fn();
    render(<Harness schema={fixtureSchemas['StepFlow@v1'] as UiSchema} onValue={spy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    const item = screen.getByRole('group', { name: 'Steg 1' });
    fireEvent.change(within(item).getByLabelText(/^Id/), { target: { value: 'svar' } });
    expect(last(spy)).toEqual({ steps: [{ id: 'svar' }] });
  });

  it('map widget writes keys and values', () => {
    const spy = vi.fn();
    render(
      <Harness
        schema={one('headers', { type: 'object', additionalProperties: { type: 'string' } })}
        onValue={spy}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    fireEvent.change(screen.getByLabelText('Nøkkel 1'), { target: { value: 'x-org' } });
    fireEvent.change(screen.getByLabelText('Verdi 1'), { target: { value: '991825827' } });
    expect(last(spy)).toEqual({ headers: { 'x-org': '991825827' } });
  });
});

describe('rules', () => {
  it('renders groups as fieldsets in x-order', () => {
    render(<Harness schema={fixtureSchemas['Service@v1'] as UiSchema} />);
    const about = screen.getByRole('group', { name: 'Om tjenesten' });
    const labels = within(about)
      .getAllByText(/^(Navn|Beskrivelse|Svarspråk)/, { selector: 'label, legend' })
      .map((l) => l.textContent?.replace(/ \(valgfritt\)/, ''));
    expect(labels).toEqual(['Navn', 'Beskrivelse', 'Svarspråk']);
  });

  it('shows a field only when its x-showIf holds', () => {
    render(
      <Harness
        schema={{
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['mcp', 'openapi'], 'x-label': 'Type' },
            spec: {
              type: 'string',
              'x-label': 'Spesifikasjon',
              'x-showIf': { field: 'kind', equals: 'openapi' },
            },
          },
        }}
      />,
    );
    expect(screen.queryByLabelText(/^Spesifikasjon/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Type/), { target: { value: 'openapi' } });
    expect(screen.getByLabelText(/^Spesifikasjon/)).toBeTruthy();
  });

  it('renders a discriminated union as a choice followed by the chosen variant fields', () => {
    const spy = vi.fn();
    render(<Harness schema={fixtureSchemas['Model@v1'] as UiSchema} operator onValue={spy} />);
    const temperature = screen.getByRole('group', { name: 'Temperatur' });
    const rule = within(temperature).getByLabelText(/^Regel/);
    expect(
      within(rule)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Bruk standard', 'Støttes ikke, send aldri', 'Fast verdi']);
    expect(within(temperature).queryByLabelText(/^Fast verdi/)).toBeNull();
    fireEvent.change(rule, { target: { value: 'fixed' } });
    fireEvent.change(within(temperature).getByLabelText(/^Fast verdi/), {
      target: { value: '0,3' },
    });
    expect(last(spy).parameters).toEqual({ temperature: { mode: 'fixed', value: 0.3 } });
    fireEvent.change(rule, { target: { value: '' } });
    expect(last(spy).parameters).toBeUndefined();
  });

  it('embeds the schema a kind uses where its condition holds', async () => {
    const fetchJson = vi.fn(async (path: string) => fixtureSchemaFetch()(path));
    render(
      <Harness
        schema={fixtureSchemas['Service@v1'] as UiSchema}
        uses={fixtureSchemaList.find((r) => r.kind === 'Service')?.uses ?? []}
        fetchJson={fetchJson}
      />,
    );
    fireEvent.change(
      screen.getAllByLabelText(/^Strategi/).find((e) => e.tagName === 'SELECT') as HTMLElement,
      {
        target: { value: 'single-call' },
      },
    );
    expect(await screen.findByLabelText(/^Maks tokens i svaret/)).toBeTruthy();
    expect(fetchJson).toHaveBeenCalledWith('/schemas/Strategy.single-call%401', undefined, 'nb');
  });

  it('hides x-advanced fields until asked, and opens them when one has an error', () => {
    const schema = fixtureSchemas['Block.model@1'] as UiSchema;
    render(<Harness schema={schema} />);
    expect(screen.queryByLabelText(/^Temperatur/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Vis avanserte innstillinger' }));
    expect(screen.getByLabelText(/^Temperatur/)).toBeTruthy();
    cleanup();
    render(<Harness schema={schema} initial={{ temperature: 5 }} showErrors />);
    expect(screen.getByLabelText(/^Temperatur/)).toBeTruthy();
  });

  it('shows an x-readOnly field locked with the reason', () => {
    render(
      <Harness
        schema={fixtureSchemas['Model@v1'] as UiSchema}
        initial={{ deployment: 'gpt-4.1' }}
        operator
      />,
    );
    const input = screen.getByLabelText(/^Utrulling/) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(
      document.getElementById(input.getAttribute('aria-describedby')?.split(' ')[0] ?? '')
        ?.textContent,
    ).toBe('Låst etter publisering.');
  });

  it('disables an x-right field with the reason when the person lacks the right', () => {
    render(
      <Harness
        schema={fixtureSchemas['Plugin.example-block@1'] as UiSchema}
        can={(right) => right !== 'blocks.configure'}
        rightLabel={() => 'Endre byggeklosser'}
      />,
    );
    const input = screen.getByLabelText(/^Tidsgrense/) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getAllByText(/Krever rettigheten «Endre byggeklosser»./).length).toBe(2);
    expect(screen.getByText(/Standard: 30./)).toBeTruthy();
  });

  it('lets a person with the right change an x-right field', () => {
    render(
      <Harness schema={fixtureSchemas['Plugin.example-block@1'] as UiSchema} can={() => true} />,
    );
    expect((screen.getByLabelText(/^Tidsgrense/) as HTMLInputElement).disabled).toBe(false);
  });

  it('disables x-operator fields outside the operator console', () => {
    render(<Harness schema={fixtureSchemas['Model@v1'] as UiSchema} />);
    expect((screen.getByLabelText(/^Datalagring/) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getAllByText('Bare driften hos Digdir kan endre dette.').length).toBeGreaterThan(
      0,
    );
  });

  it('disables a setting at a layer its x-settableAt leaves out', () => {
    render(<Harness schema={fixtureSchemas['Settings@v1'] as UiSchema} layer="service" />);
    expect((screen.getByLabelText(/^Maks antall kilder/) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText(/^Lagringstid for logger/) as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('shows problems from the API on their fields, linked with aria-describedby', () => {
    const issues = problemIssues({ errors: [{ path: 'name', message: 'Navnet er tatt.' }] });
    render(
      <Harness
        schema={fixtureSchemas['Service@v1'] as UiSchema}
        issues={issues}
        showErrors
        attempt={1}
      />,
    );
    const input = screen.getByLabelText(/^Navn/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain('Navnet er tatt.');
  });

  it('lists errors in a summary that links to each field and takes focus on save', async () => {
    render(<Harness schema={fixtureSchemas['Service@v1'] as UiSchema} showErrors attempt={1} />);
    const link = screen.getByRole('link', { name: 'Fyll ut Navn.' });
    await waitFor(() => expect(document.activeElement?.contains(link)).toBe(true));
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByLabelText(/^Navn/));
  });

  it('shows labels, help and messages in English from the resolved labels', () => {
    render(
      <InLocale locale="en">
        <Harness schema={fixtureSchemas['Service@v1'] as UiSchema} showErrors />
      </InLocale>,
    );
    expect(screen.getByRole('group', { name: 'About the service' })).toBeTruthy();
    expect(screen.getByText('What the model must always follow.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fill in Name.' })).toBeTruthy();
  });

  it('falls back to the app label for a property without x-label', () => {
    render(
      <Harness
        schema={{ type: 'object', properties: { maxTokens: { type: 'integer' } } }}
        labelFor={(path) => (path === 'maxTokens' ? 'Maks tokens' : undefined)}
      />,
    );
    expect(screen.getByLabelText(/^Maks tokens/)).toBeTruthy();
  });

  it('uses a custom widget for a path when the screen gives one', () => {
    render(
      <Harness
        schema={one('columns', { type: 'array' })}
        widgets={{ columns: (p) => <p>Egen {p.label}</p> }}
      />,
    );
    expect(screen.getByText('Egen Felt')).toBeTruthy();
  });
});
