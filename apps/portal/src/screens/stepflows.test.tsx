// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleFlows } from '../data/stepflows';
import { exampleStepFlow, mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';
import { parseYaml, toYaml } from '../yaml';
import { platformStepBlocks } from '../mock/step-blocks';
import maloppnaelse from './stepflows/fixtures/maloppnaelse-flyt.json';
import { allSteps, fromDefinition, toDefinition } from './stepflows/model';

const stepFlowExamples = Object.entries(
  import.meta.glob<string>('../../../../packages/definitions/examples/*.yaml', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
).filter(([, text]) => /^kind: StepFlow$/m.test(text));

const asWritten = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(asWritten)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k, v]) => !(k === 'onError' && v === 'stop'))
            .filter(([k, v]) => !(k === 'name' && v === (value as { id?: unknown }).id))
            .map(([k, v]) => [k, asWritten(v)]),
        )
      : value;

const flows = Object.fromEntries(exampleFlows.map((f) => [f.id, f]));
const base = '#/developer/step-flows/svar-med-kilder';

type Call = { url: string; method: string; body: unknown; headers: Headers };

const recording = () => {
  const calls: Call[] = [];
  const inner = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    return inner(input, init);
  };
  return { calls, fetch };
};

const openService = async (query = '', fetch?: typeof globalThis.fetch) => {
  await renderAt(`${base}${query}`, fetch);
  await screen.findByRole('tab', { name: /^Diagram/ });
};

const openHome = async (fetch?: typeof globalThis.fetch) => {
  await renderAt('#/developer/step-flows', fetch);
  await screen.findByRole('heading', { level: 2, name: 'Stegflyter' });
};

const choose = (input: HTMLElement, value: string, label: string) => {
  const item = document.createElement('data');
  item.value = value;
  item.textContent = label;
  act(() => {
    input
      .closest('ds-suggestion')
      ?.dispatchEvent(new CustomEvent('comboboxbeforeselect', { detail: item, cancelable: true }));
  });
};
const yamlBox = () => screen.getByLabelText('Stegflyt som YAML') as HTMLTextAreaElement;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  window.location.hash = '';
});

const pickBlock = (name: RegExp) => {
  const dialog = screen.getByRole('dialog', { name: 'Legg til steg' });
  fireEvent.click(within(dialog).getByRole('button', { name }));
};

const pasteYaml = async (text: string) => {
  fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
  fireEvent.change(yamlBox(), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
  await screen.findByText('YAML er brukt. Diagrammet er oppdatert.');
  fireEvent.click(screen.getByRole('tab', { name: 'Diagram' }));
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the step flow editor', () => {
  it('opens on the flow itself with a back link to Stegflyter and its diagram, with no strategy chooser and no library tab', async () => {
    await openService();
    expect(screen.queryByRole('tab', { name: 'Bibliotek: Stegflyter' })).toBeNull();
    expect(
      within(screen.getByRole('main'))
        .getByRole('link', { name: 'Stegflyter' })
        .getAttribute('href'),
    ).toBe('#/developer/step-flows');
    expect(screen.getByRole('heading', { level: 1, name: 'Svar med kilder' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Arbeidsmåte' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Stegflyt' })).toBeNull();
    expect(screen.getByText(/Brukes også av Spør veilederen, Intern spørsmålsbank/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Stegene i flyten' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Endre gjenta: Søk til grunnlaget holder/ }),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Flyten er gyldig');
    expectAccessible();
  });

  it.each([
    ['svar', 'Svar med kilder'],
    ['sak', 'Saksforberedelse'],
    ['post', 'Sorter post'],
  ])('picks flyt=%s from the query', async (q, name) => {
    await openService(`?flyt=${q}`);
    expect(screen.getByRole('heading', { level: 1, name })).toBeTruthy();
    expectAccessible();
  });

  it('shows Gjenta, For hver, Velg and Delflyt controls', async () => {
    await openService();
    expect(screen.getByRole('button', { name: /^Endre gjenta: / })).toBeTruthy();
    cleanup();
    await openService('?flyt=sak');
    expect(screen.getByRole('button', { name: /^Endre for hver: / })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Endre delflyten / })).toBeTruthy();
    cleanup();
    await openService('?flyt=post');
    expect(screen.getByRole('button', { name: /^Endre velg: / })).toBeTruthy();
    expectAccessible();
  });

  it('expands a subflow read-only', async () => {
    await openService('?flyt=sak');
    const toggle = screen.getByRole('button', { name: 'Vis stegene i delflyten' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const hide = screen.getByRole('button', { name: 'Skjul stegene i delflyten' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('group', { name: /Steg i delflyt/ }).length).toBeGreaterThan(0);
    expectAccessible();
  });

  it('shows the test-run overlay from the query and toggles it', async () => {
    await openService('?testkjoring=true');
    const toggle = screen.getByRole('switch', {
      name: 'Vis siste testkjøring',
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByRole('link', { name: 'Åpne tidslinjen' })).toBeTruthy();
    expect(screen.getByText(/Testkjøring /)).toBeTruthy();
    expectAccessible();
    fireEvent.click(toggle);
    expect(screen.queryByRole('link', { name: 'Åpne tidslinjen' })).toBeNull();
  });

  it('runs a test and then shows the overlay', async () => {
    await openService();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør test' }));
    expect(screen.getByText('Kjører testen …')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kjør test' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await act(async () => {
      vi.advanceTimersByTime(1300);
    });
    vi.useRealTimers();
    expect(screen.getByText('Testkjøringen er ferdig og vises i diagrammet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Åpne tidslinjen' })).toBeTruthy();
  });
});

describe('live validation and step editor', () => {
  it('edits a step in the side panel and flags broken references with a tab badge', async () => {
    await openService();
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Søk i rapportene' }));
    const panel = screen.getByRole('dialog', { name: 'Søk i rapportene' });
    expect(within(panel).getByText('Steg · id: sok')).toBeTruthy();
    expectAccessible();
    fireEvent.click(within(panel).getByRole('button', { name: 'Slett steget' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText(/«Søk i rapportene» er slettet/)).toBeTruthy();
    const alertHeading = screen.getByRole('heading', { level: 2, name: /feil i flyten/ });
    expect(alertHeading).toBeTruthy();
    expect(screen.getByLabelText(/\d+ feil/)).toBeTruthy();
    const errorButton = screen.getAllByRole('button', { name: /finnes ikke før dette steget/ })[0];
    fireEvent.click(errorButton as HTMLElement);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør test' }));
    expect(screen.getByText('Rett feilene før du kjører en test.')).toBeTruthy();
  });

  it('offers route, template, agent, model and the document blocks in the picker, with a description', async () => {
    await openService();
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Planlegg søk' }));
    const panel = screen.getByRole('dialog', { name: 'Planlegg søk' });
    const picker = within(panel).getByRole('combobox', { name: /Stegtype/ }) as HTMLSelectElement;
    const labels = [...picker.options].map((o) => o.text);
    for (const label of [
      'Finn dokumenter',
      'Les ett dokument',
      'Lag tabell med kilder',
      'Spør språkmodellen',
      'Sett sammen tekst',
      'Send til kø',
      'La modellen søke selv',
    ])
      expect(labels).toContain(label);
    fireEvent.change(picker, { target: { value: 'documents' } });
    expect(within(panel).getByText(/Lister dokumenter fra datasettene/)).toBeTruthy();
    expectAccessible();
  });

  it('renames a step and adds a new one below', async () => {
    await openService();
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Planlegg søk' }));
    fireEvent.change(screen.getByLabelText('Navn på steget'), { target: { value: 'Planlegg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
    expect(await screen.findByText(/«Planlegg» er oppdatert/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Planlegg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til steg under' }));
    pickBlock(/^Klassifiser/);
    expect(screen.getByRole('dialog', { name: 'Klassifiser' })).toBeTruthy();
    expect(await screen.findByText('«Klassifiser» er lagt til under «Planlegg».')).toBeTruthy();
  });

  it('opens the editor for each control kind', async () => {
    await openService();
    fireEvent.click(screen.getByRole('button', { name: /Endre gjenta/ }));
    expect(screen.getByLabelText('Maks antall runder')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Maks antall runder'), { target: { value: '100' } });
    expect(screen.queryByText('Maks antall runder må være fra 1 til 100.')).toBeNull();
    fireEvent.change(screen.getByLabelText('Maks antall runder'), { target: { value: '101' } });
    expect(screen.getByText('Maks antall runder må være fra 1 til 100.')).toBeTruthy();
    expectAccessible();
  });
});

describe('editing real building blocks', () => {
  it('edits table columns and a fixed text input, and writes templates the runtime reads', async () => {
    await openService();
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Planlegg søk' }));
    const panel = screen.getByRole('dialog', { name: 'Planlegg søk' });
    fireEvent.change(within(panel).getByRole('combobox', { name: /Stegtype/ }), {
      target: { value: 'table' },
    });
    const items = within(panel).getByRole('group', { name: /^items/ });
    fireEvent.click(within(items).getByRole('radio', { name: 'Fast tekst eller verdi' }));
    fireEvent.change(within(items).getByLabelText('Fast tekst'), {
      target: { value: '{{input.query}}' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Legg til kolonne' }));
    fireEvent.change(within(panel).getByLabelText('Nøkkel'), { target: { value: 'goal' } });
    fireEvent.change(within(panel).getByLabelText('Navn'), { target: { value: 'Mål' } });
    fireEvent.change(within(panel).getByLabelText('Verdi fra'), { target: { value: '__other' } });
    fireEvent.change(within(panel).getByLabelText('Sti til verdien'), {
      target: { value: 'goal' },
    });
    await waitFor(() => expectAccessible());
    fireEvent.click(within(panel).getByRole('button', { name: 'Bruk' }));
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));

    const text = yamlBox().value;
    expect(text).toContain('block: table@1');
    expect(text).toMatch(/items: '\{\{input\.query\}\}'/);
    expect(text).toMatch(/- key: goal\s+label: Mål\s+from: goal/);
  });
});

describe('new step flow fields', () => {
  const maloppnaelseYaml = toYaml(maloppnaelse);

  it('picks a building block from a searchable list and adds it at the bottom', async () => {
    await openService();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til steg' }));
    const dialog = screen.getByRole('dialog', { name: 'Legg til steg' });
    expect(within(dialog).getByText('table@1')).toBeTruthy();
    expectAccessible();
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'tabell' },
    });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'finnes ikke' },
    });
    expect(within(dialog).getByText('Ingen stegtyper passer med «finnes ikke».')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Søk' }), {
      target: { value: '' },
    });
    pickBlock(/^Lag tabell med kilder/);
    expect(screen.queryByRole('dialog', { name: 'Legg til steg' })).toBeNull();
    expect(
      await screen.findByText('«Lag tabell med kilder» er lagt til nederst i flyten.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Lag tabell med kilder' })).toBeTruthy();
  });

  it('flags an unknown reference in fixed text at once and previews the text', async () => {
    await openService();
    await pasteYaml(maloppnaelseYaml);
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Hent ut mål og resultater' }));
    const panel = screen.getByRole('dialog', { name: 'Hent ut mål og resultater' });
    const prompt = within(panel).getByRole('group', { name: /^prompt/ });
    const text = within(prompt).getByLabelText('Fast tekst') as HTMLTextAreaElement;
    expect(within(prompt).queryByText(/finnes ikke i et tidligere steg/)).toBeNull();
    fireEvent.change(text, { target: { value: 'Mål for {{input.agency}} i {{dok.title}}' } });
    expect(
      within(prompt).getByText('Referansen «input.agency» finnes ikke i et tidligere steg.'),
    ).toBeTruthy();
    expect(text.getAttribute('aria-invalid')).toBe('true');
    expect(within(prompt).getByText('[input.agency]')).toBeTruthy();
    fireEvent.change(text, { target: { value: 'Mål i' } });
    fireEvent.click(within(prompt).getByRole('button', { name: 'steps.les.chunks' }));
    expect(text.value).toBe('Mål i {{steps.les.chunks}}');
    expect(within(prompt).queryByText(/finnes ikke i et tidligere steg/)).toBeNull();
    await waitFor(() => expectAccessible());
  });

  it('switches an input between a reference and fixed text', async () => {
    await openService();
    await pasteYaml(maloppnaelseYaml);
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Hent ut mål og resultater' }));
    const panel = screen.getByRole('dialog', { name: 'Hent ut mål og resultater' });
    const chunks = within(panel).getByRole('group', { name: /^chunks/ });
    const fromStep = within(chunks).getByRole('radio', { name: 'Fra et tidligere steg' });
    expect((fromStep as HTMLInputElement).checked).toBe(true);
    expect(
      (within(chunks).getByLabelText('Verdi fra et tidligere steg') as HTMLSelectElement).value,
    ).toBe('les.chunks');
    fireEvent.click(within(chunks).getByRole('radio', { name: 'Fast tekst eller verdi' }));
    expect(within(chunks).getByLabelText('Fast tekst')).toBeTruthy();
  });

  it('edits table columns with sources from the loop and keeps their order', async () => {
    await openService();
    await pasteYaml(maloppnaelseYaml);
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Lag tabellen' }));
    const panel = screen.getByRole('dialog', { name: 'Lag tabellen' });
    const sources = within(panel).getAllByLabelText('Verdi fra')[1] as HTMLSelectElement;
    const labels = [...sources.options].map((o) => o.text);
    expect(labels).toContain('Dokumentets tittel');
    expect(labels).toContain('Hent ut mål og resultater › goal');
    expect(labels).toContain('Annen verdi …');
    expect(sources.value).toBe('goal');
    fireEvent.click(within(panel).getByRole('button', { name: 'Flytt Dokument ned' }));
    expect(
      within(panel)
        .getByRole('button', { name: 'Flytt Dokument opp' })
        .getAttribute('aria-disabled'),
    ).toBeNull();
    fireEvent.change(within(panel).getAllByLabelText('Verdi fra')[3] as HTMLSelectElement, {
      target: { value: '__other' },
    });
    expect(within(panel).getByText('Velg hvor verdien kommer fra.', { exact: false })).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Sti til verdien'), {
      target: { value: 'item.goals' },
    });
    await waitFor(() => expectAccessible());
    fireEvent.click(within(panel).getByRole('button', { name: 'Bruk' }));
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(yamlBox().value).toMatch(
      /- key: goal\s+label: Mål\s+from: goal\s+- key: document\s+label: Dokument\s+from: document\.title/,
    );
    expect(yamlBox().value).toContain('from: item.goals');
  });

  it('lets a loop skip a failing element', async () => {
    await openService();
    await pasteYaml(maloppnaelseYaml);
    fireEvent.click(screen.getByRole('button', { name: /^Endre for hver: For hvert dokument/ }));
    const panel = screen.getByRole('dialog', { name: 'For hvert dokument' });
    const group = within(panel).getByRole('group', { name: 'Hvis ett element feiler' });
    expect(
      (within(group).getByRole('radio', { name: /Hopp over elementet/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(within(group).getByText(/står i resultatet med grunnen/)).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: /Stopp flyten/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Bruk' }));
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(yamlBox().value).not.toContain('onError: skip');
  });

  it('keeps parameters the editor does not know and warns about them', async () => {
    await openService();
    const flow = structuredClone(maloppnaelse);
    const extract = flow.spec.steps[1]?.forEach?.steps[1] as { params: Record<string, unknown> };
    extract.params.x_reasoning_effort = 'low';
    extract.params.stop_sequences = ['###'];
    await pasteYaml(toYaml(flow));
    expect(screen.getByText('2 ukjente parametre')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Flyten er gyldig');
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Hent ut mål og resultater' }));
    const panel = screen.getByRole('dialog', { name: 'Hent ut mål og resultater' });
    expect(within(panel).getByRole('heading', { name: 'Andre parametre fra YAML' })).toBeTruthy();
    expect(within(panel).getByText(/sjekkes mot stegtypen når du publiserer/)).toBeTruthy();
    expect(within(panel).getByText('x_reasoning_effort')).toBeTruthy();
    expect(within(panel).getByText('["###"]')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Bruk' }));
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    expect(yamlBox().value).toContain('x_reasoning_effort: low');
  });
});

describe('YAML tab', () => {
  it('shows English keys and applies edits back to the diagram', async () => {
    await openService('?visning=yaml');
    const text = yamlBox().value;
    for (const key of [
      'kind: StepFlow',
      'steps:',
      'block: model@1',
      'onError: use-default',
      'repeat:',
    ])
      expect(text).toContain(key);
    expect(
      screen.getByRole('button', { name: 'Bruk endringene' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expectAccessible();
    fireEvent.change(yamlBox(), {
      target: { value: text.replace('name: Planlegg søk', 'name: Planlegg søket') },
    });
    expect(screen.getByText('Ulagrede endringer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(await screen.findByText('YAML er brukt. Diagrammet er oppdatert.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Diagram' }));
    expect(screen.getByRole('button', { name: 'Endre steget Planlegg søket' })).toBeTruthy();
  });

  it.each(stepFlowExamples)(
    'takes %s pasted as it is and writes the same steps back',
    async (_, text) => {
      await openService('?visning=yaml');
      fireEvent.change(yamlBox(), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
      expect(await screen.findByText('YAML er brukt. Diagrammet er oppdatert.')).toBeTruthy();
      const original = parseYaml(text) as { metadata: { name: string }; spec: { steps: unknown } };
      const written = parseYaml(yamlBox().value) as typeof original;
      expect(written.metadata.name).toBe(original.metadata.name);
      expect(asWritten(written.spec.steps)).toEqual(asWritten(original.spec.steps));
    },
  );

  it('shows the line number of a syntax error and rejects duplicate ids', async () => {
    await openService('?visning=yaml');
    const text = yamlBox().value;
    fireEvent.change(yamlBox(), { target: { value: `${text}  : : bad\n\t- x` } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect((await screen.findByText(/Linje \d+/)).textContent).toMatch(/Linje \d+/);
    expect(yamlBox().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    expect(screen.getByText('I takt med diagrammet')).toBeTruthy();
    fireEvent.change(yamlBox(), { target: { value: text.replace('id: ranger', 'id: sok') } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(await screen.findByText('Id-en «sok» er brukt to ganger.')).toBeTruthy();
  });
});

describe('YAML model', () => {
  it('round-trips every example flow through English YAML', () => {
    for (const f of exampleFlows) {
      const yaml = toYaml(toDefinition(f, '999888777', flows));
      expect(yaml).toContain('kind: StepFlow');
      expect(yaml).not.toMatch(/\b(steg|byggekloss|ved_feil|gjenta|for_hver|velg_etter|delflyt):/);
      const back = fromDefinition(parseYaml(yaml), f);
      expect(toDefinition(back, '999888777', flows)).toEqual(toDefinition(f, '999888777', flows));
    }
  });

  it('uses only building blocks the platform has, so mock and live save the same flows', () => {
    const known = new Set(platformStepBlocks.map((b) => b.name));
    const used = exampleFlows.flatMap((f) =>
      allSteps(f.steps).flatMap((s) => (s.kind === 'block' ? [s.block] : [])),
    );
    expect(used.filter((b) => !known.has(b))).toEqual([]);
  });

  it('writes repeat, forEach, switchOn with cases and else, subflow and onError', () => {
    const all = exampleFlows.map((f) => toYaml(toDefinition(f, 't', flows))).join('\n');
    for (const key of [
      'repeat:',
      'forEach:',
      'switchOn:',
      'cases:',
      'else:',
      'subflow:',
      'onError: stop',
      'default:',
    ])
      expect(all).toContain(key);
  });

  it('writes the platform names of the building blocks', () => {
    const yaml = [
      'apiVersion: genai/v1',
      'kind: StepFlow',
      'metadata:',
      '  id: blokker',
      'spec:',
      '  purpose: Test',
      '  steps:',
      '    - id: a',
      '      block: extract@1',
      '    - id: b',
      '      block: documents@1',
      '    - id: c',
      '      block: retrieve@1',
    ].join('\n');
    const flow = fromDefinition(parseYaml(yaml));
    const written = toDefinition(flow, 't', flows).spec.steps;
    expect(written.map((s) => s.block)).toEqual(['extract@1', 'documents@1', 'retrieve@1']);
  });

  it('still parses the old Norwegian keys', () => {
    const legacy = [
      'apiVersion: genai/v1',
      'kind: StepFlow',
      'metadata:',
      '  id: gammel',
      '  navn: Gammel flyt',
      'spec:',
      '  formal: Test',
      '  steg:',
      '    - id: a',
      '      navn: Klassifiser',
      '      byggekloss: classify@1',
      '      ved_feil: hopp_over',
      '    - id: b',
      '      velg_etter: steps.a.kategori',
      '      tilfeller:',
      '        - nar: klage',
      '          steg:',
      '            - id: c',
      '              byggekloss: skriv@1',
      '              ved_feil: standardverdi',
      '              standardverdi: tom',
      '      ellers: []',
      '    - id: d',
      '      gjenta:',
      '        til: steps.c.tekst er ja',
      '        maks: 2',
      '        steg: []',
      '    - id: e',
      '      for_hver:',
      '        i: steps.a.liste',
      '        som: x',
      '        steg: []',
      '    - id: f',
      '      delflyt: hent-dokumenter@1',
    ].join('\n');
    const flow = fromDefinition(parseYaml(legacy));
    expect(flow.name).toBe('Gammel flyt');
    expect(flow.steps.map((s) => s.kind)).toEqual(['block', 'branch', 'repeat', 'foreach', 'sub']);
    const [a, b] = flow.steps;
    expect(a).toMatchObject({ block: 'classify', err: 'skip', label: 'Klassifiser' });
    expect(b).toMatchObject({
      cases: [{ when: 'klage', steps: [{ err: 'use-default', def: 'tom' }] }],
    });
  });

  it('rejects a wrong kind and duplicate ids', () => {
    expect(() =>
      fromDefinition({ apiVersion: 'genai/v1', kind: 'Service', spec: { steps: [] } }),
    ).toThrow('kind må være StepFlow.');
    expect(() =>
      fromDefinition({
        apiVersion: 'genai/v1',
        kind: 'StepFlow',
        spec: {
          steps: [
            { id: 'a', block: 'sok' },
            { id: 'a', block: 'sok' },
          ],
        },
      }),
    ).toThrow('Id-en «a» er brukt to ganger.');
  });
});

describe('Stegflyter in Utviklerverktøy', () => {
  it('lists the step flows in a table with their version and the services that use them', async () => {
    await openHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Utviklerverktøy' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Stegflyter' });
    const postruting = within(table).getByRole('link', { name: 'Postruting' });
    expect(postruting.getAttribute('href')).toBe('#/developer/step-flows/postruting');
    expect(within(table).getByRole('link', { name: 'Høringsoppsummering' })).toBeTruthy();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Stegflyt', 'Gjeldende versjon', 'Brukes av']);
    expect(screen.getByRole('link', { name: 'Ny stegflyt' }).getAttribute('href')).toBe(
      '#/developer/step-flows/new',
    );
    expectAccessible();
  });

  it('filters the step flows by who made them', async () => {
    await openHome();
    const table = await screen.findByRole('table', { name: 'Stegflyter' });
    const own = screen.getByRole('button', { name: /^Våre/ });
    fireEvent.click(own);
    expect(own.getAttribute('aria-pressed')).toBe('true');
    expect(own.closest('.sf-chips')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Postruting' })).toBeTruthy();
    expect(within(table).queryByRole('link', { name: 'Høringsoppsummering' })).toBeNull();
  });

  it('shows the Fra andre filter only when another organisation has shared a step flow', async () => {
    await openHome();
    await screen.findByRole('table', { name: 'Stegflyter' });
    expect(screen.getByRole('button', { name: /^Fra andre \d+$/ })).toBeTruthy();
    cleanup();

    const inner = mockFetch();
    const ownOnly: typeof globalThis.fetch = async (input, init) => {
      const response = await inner(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('step_flow')) return response;
      const body = (await response.json()) as { data: { publisher: { type: string } }[] };
      body.data = body.data.filter((flow) => flow.publisher.type !== 'shared');
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    await openHome(ownOnly);
    await screen.findByRole('table', { name: 'Stegflyter' });
    expect(screen.queryByRole('button', { name: /^Fra andre/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Våre/ })).toBeTruthy();
  });

  it('marks Utviklerverktøy in the menu while a step flow is open', async () => {
    await openService();
    const nav = screen.getByRole('navigation', { name: /hovedmeny|meny/i });
    expect(
      within(nav).getByRole('link', { name: 'Utviklerverktøy' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('sends the old step flow addresses to Utviklerverktøy, keeping the flow and the query', async () => {
    await renderAt('#/step-flows/postruting?flyt=sak');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/developer/step-flows/postruting?flyt=sak'),
    );
    cleanup();
    await renderAt('#/step-flows');
    await waitFor(() => expect(window.location.hash).toBe('#/developer/step-flows'));
  });

  it('opens the editor at #/developer/step-flows/:id', async () => {
    await renderAt('#/developer/step-flows/postruting');
    expect(await screen.findByRole('heading', { level: 1, name: 'Postruting' })).toBeTruthy();
  });

  it('says a save makes a new version of the step flow, not of a service, when one service uses it', async () => {
    await renderAt('#/developer/step-flows/postruting');
    expect(
      await screen.findByText('Endringer lagres som en ny versjon av stegflyten.'),
    ).toBeTruthy();
    expect(screen.queryByText(/ny versjon av tjenesten/)).toBeNull();
  });

  it('lists the published versions of a flow under Versjoner in the editor', async () => {
    await renderAt('#/developer/step-flows/postruting');
    expect(await screen.findByRole('tab', { name: 'Versjoner' })).toBeTruthy();
    const versions = await screen.findByRole('region', {
      name: 'Versjoner av Postruting',
      hidden: true,
    });
    expect(await within(versions).findByText('v2')).toBeTruthy();
    expect(within(versions).getByText('Klager går til klageenheten.')).toBeTruthy();
    expect(within(versions).getByText('v1')).toBeTruthy();
  });

  it('offers to pin the flow to the service it was opened from, with a way back to that service', async () => {
    await renderAt(`${base}?service=rapportassistent`);
    await screen.findByRole('tab', { name: /^Diagram/ });
    expect(
      within(screen.getByRole('main'))
        .getByRole('link', { name: /^Tilbake til/ })
        .getAttribute('href'),
    ).toBe('#/services/rapportassistent');
    expect(screen.getByRole('button', { name: 'Fest denne versjonen i tjenesten' })).toBeTruthy();
  });

  it('pins the current version of a flow to a chosen service through its draft', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/step-flows/saksforberedelse', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Saksforberedelse' });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk i en tjeneste' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Bruk Saksforberedelse i en tjeneste',
    });
    const input = within(dialog).getByRole('combobox', { name: 'Tjeneste' });
    const options = () =>
      [...dialog.querySelectorAll<HTMLOptionElement>('u-option, option')].filter((o) => o.value);
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    const option = options()[0] as HTMLOptionElement;
    choose(input, option.value, option.label);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Koble til tjenesten' }));

    expect(await within(dialog).findByText(/er koblet til .+ i et utkast/)).toBeTruthy();
    const saved = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith(`/services/${option.value}/draft`),
    );
    const version = flows.saksforberedelse?.version;
    expect(
      (saved?.body as { definition: { spec: { strategy: unknown } } }).definition.spec.strategy,
    ).toMatchObject({ id: 'step-flow', config: { flow: `saksforberedelse@${version}` } });
    expect(saved?.headers.get('change-reason')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/definitions'))).toBe(false);
  });

  it('shows a flow from Digdir read-only, with Diagram and YAML and no editor', async () => {
    const definition = {
      ...exampleStepFlow.latest.definition,
      metadata: { id: 'sf-hoering', name: 'Høringsoppsummering', version: 3 },
    };
    await renderAt(
      '#/developer/step-flows/sf-hoering',
      mockFetch(undefined, undefined, undefined, undefined, {
        features: {
          blocks: {
            flowDefinitions: {
              'sf-hoering': {
                id: 'sf-hoering',
                owner: 'digdir',
                version: 3,
                publishedAt: '2026-10-01T10:00:00Z',
                yaml: 'kind: StepFlow\nmetadata:\n  id: sf-hoering # as published\n',
                definition,
              },
            },
          },
        },
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Høringsoppsummering' }),
    ).toBeTruthy();
    expect(
      (await screen.findByRole('tab', { name: 'Diagram' })).getAttribute('aria-selected'),
    ).toBe('true');
    expect((await screen.findAllByText('Klassifiser')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('radiogroup', { name: 'Arbeidsmåte' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lagre som v/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/developer/step-flows/sf-hoering/yaml'),
    );
    expect(
      (await screen.findByRole('region', { name: 'Stegflyten som YAML' })).textContent,
    ).toContain('id: sf-hoering # as published');
  });

  it('says the flow is not shown, without blaming the publisher, when the API has no definition', async () => {
    await renderAt('#/developer/step-flows/sf-hoering');
    await screen.findByRole('heading', { level: 1, name: 'Høringsoppsummering' });
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Diagram' })).toBeNull());
    expect(screen.queryByText(/Utgiveren har ikke delt/)).toBeNull();
  });

  it('shows an error with retry when the step flows cannot be loaded', async () => {
    await openHome(failingFetch(/\/building-blocks/));
    expect(await screen.findByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
    expectAccessible();
  });
});

describe('saving', () => {
  it('requires a reason, validates and publishes with the reason header', async () => {
    const { calls, fetch } = recording();
    await openService('', fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Planlegg søk' }));
    fireEvent.change(screen.getByLabelText('Navn på steget'), { target: { value: 'Planlegg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
    const save = await screen.findByRole('button', { name: 'Lagre som v5' });
    expectAccessible();
    fireEvent.click(save);
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(screen.getByLabelText(/Hva er endret, og hvorfor\?/).getAttribute('aria-invalid')).toBe(
      'true',
    );
    fireEvent.change(screen.getByLabelText(/Hva er endret, og hvorfor\?/), {
      target: { value: 'Kortere navn på planleggingen' },
    });
    fireEvent.click(save);
    expect(await screen.findByText(/Stegflyten er lagret som v\d+\./)).toBeTruthy();
    const validate = calls.find((c) => c.url.endsWith('/definitions/validate'));
    const publish = calls.find((c) => c.url.endsWith('/definitions') && c.method === 'POST');
    expect((validate?.body as { definition: { kind: string } }).definition.kind).toBe('StepFlow');
    expect(decodeURIComponent(publish?.headers.get('change-reason') ?? '')).toBe(
      'Kortere navn på planleggingen',
    );
    expect(
      (publish?.body as { definition: { spec: { steps: { name: string }[] } } }).definition.spec
        .steps[0]?.name,
    ).toBe('Planlegg');
  });

  it('asks a new flow for a name before its first save and derives the id from it', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/step-flows/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Ny stegflyt' });
    fireEvent.click(screen.getByRole('button', { name: /Legg til (et )?steg/ }));
    pickBlock(/^Klassifiser/);
    fireEvent.click(screen.getByRole('button', { name: 'Slett steget' }));
    fireEvent.change(screen.getByLabelText(/Hva flyten gjør/), {
      target: { value: 'Sorterer brev' },
    });
    fireEvent.change(screen.getByLabelText(/Hva er endret, og hvorfor\?/), {
      target: { value: 'Første versjon' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Lagre som v/ }));
    expect(screen.getByText('Gi flyten et navn.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/definitions/validate'))).toBe(false);

    fireEvent.change(screen.getByLabelText('Navn på flyten'), {
      target: { value: 'Brev til arkiv' },
    });
    expect(screen.getByText(/Id: brev-til-arkiv\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Lagre som v/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/definitions/validate'))).toBe(true),
    );
    const validate = calls.find((c) => c.url.endsWith('/definitions/validate'));
    expect(
      (validate?.body as { definition: { metadata: { id: string; name: string } } }).definition
        .metadata,
    ).toMatchObject({ id: 'brev-til-arkiv', name: 'Brev til arkiv' });
  });

  it('shows server validation errors for an empty new flow', async () => {
    await renderAt('#/developer/step-flows/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny stegflyt' });
    fireEvent.click(screen.getByRole('button', { name: /Legg til (et )?steg/ }));
    pickBlock(/^Klassifiser/);
    fireEvent.click(screen.getByRole('button', { name: 'Slett steget' }));
    fireEvent.change(screen.getByLabelText('Navn på flyten'), {
      target: { value: 'Brevsortering' },
    });
    fireEvent.change(screen.getByLabelText(/Hva flyten gjør/), {
      target: { value: 'Sorterer brev' },
    });
    fireEvent.change(screen.getByLabelText(/Hva er endret, og hvorfor\?/), {
      target: { value: 'Første versjon' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Lagre som v/ }));
    expect(
      await screen.findByText('Plattformen godtok ikke flyten. Se feilene under.'),
    ).toBeTruthy();
    expect(screen.getByText('spec.steps')).toBeTruthy();
    expectAccessible();
  });

  it('reports a failed publish', async () => {
    await openService('', failingFetch(/\/definitions$/, 500));
    fireEvent.click(screen.getByRole('button', { name: 'Endre steget Planlegg søk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk' }));
    fireEvent.change(screen.getByLabelText(/Hva er endret, og hvorfor\?/), {
      target: { value: 'Prøver å lagre' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Lagre som v/ }));
    expect(await screen.findByText('Kunne ikke lagre stegflyten. Prøv igjen.')).toBeTruthy();
  });
});
