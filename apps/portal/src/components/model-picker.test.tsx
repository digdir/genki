// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../api/models';
import { ModelPicker } from './ModelPicker';

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

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  maker: 'OpenAI',
  operator: { name: 'Microsoft Azure', region: 'Sverige' },
  residency: 'eu',
  capabilities: ['stream'],
  operations: ['chat'],
  price: null,
  recommended: false,
  available: true,
  ...extra,
});

const catalog: CatalogModel[] = [
  model('alpha'),
  model('beta', { price: { inputPerThousand: 0.0076, outputPerThousand: 0.0459 } }),
  model('borealis', {
    maker: 'AIVAR',
    operator: { name: 'AI-gatewayen' },
    residency: 'norway',
    contextWindow: 128000,
  }),
  model('delta'),
  model('epsilon'),
  model('gamma'),
  model('omega'),
  model('zeta', { recommended: true }),
  model('embedder', { operations: ['embed'] }),
  model('held', { available: false, reason: 'requires_approval', residency: 'global' }),
  model('refused', { available: false, reason: 'not_allowed' }),
];

const Harness = ({
  models = catalog,
  initial = 'alpha',
  onChange = () => undefined,
  residency,
}: {
  models?: CatalogModel[];
  initial?: string;
  onChange?: (id: string) => void;
  residency?: CatalogModel['residency'];
}) => {
  const [value, setValue] = useState(initial);
  return (
    <ModelPicker
      models={{ status: 'ready', data: models }}
      value={value}
      service="Rapportassistenten"
      {...(residency ? { residency } : {})}
      onChange={(id) => {
        setValue(id);
        onChange(id);
      }}
    />
  );
};

describe('current model held back', () => {
  it('warns when the current model is held back by the policy, with the reason', () => {
    const { unmount } = render(<Harness initial="held" />);
    expect(screen.getByText(/Modellen held venter på godkjenning/)).toBeTruthy();
    expect(screen.getByText('Krever godkjenning')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Be om tilgang' })).toBeTruthy();
    unmount();
    render(<Harness initial="refused" />);
    expect(screen.getByText(/Modellen refused er ikke tillatt for dere/)).toBeTruthy();
    expect(screen.getByText('Ikke tillatt for dere')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Be om tilgang' })).toBeNull();
  });
});

const open = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Bytt modell' }));
  return screen.getByRole('dialog', { name: 'Velg modell' });
};

const names = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('radio')
    .map((r) => (r as HTMLInputElement).value);

describe('the model picker', () => {
  it('shows the chosen model compactly and opens the list only on "Bytt modell"', () => {
    render(<Harness />);
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('Data i EU/EØS')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Bytt modell' }).getAttribute('aria-haspopup')).toBe(
      'dialog',
    );
  });

  it('shows a short trigger label when given one and keeps "Bytt modell" as its name', () => {
    render(
      <ModelPicker
        models={{ status: 'ready', data: catalog }}
        value="alpha"
        service="Rapportassistenten"
        triggerLabel="Bytt"
        onChange={() => undefined}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Bytt modell' });
    expect(trigger.textContent).toBe('Bytt');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Velg modell' })).toBeTruthy();
  });

  it('lists the current model first, then recommended models, and shows six until asked for more', () => {
    render(<Harness />);
    const dialog = open();
    expect(names(dialog)).toHaveLength(6);
    expect(names(dialog).slice(0, 2)).toEqual(['alpha', 'zeta']);
    expect(within(dialog).getByText('8 modeller passer, viser de 6 beste')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vis 2 til' }));
    expect(names(dialog)).toHaveLength(8);
  });

  it("ranks models that serve the call, within the service's data location and priced before the rest", () => {
    render(
      <Harness
        initial="mini"
        residency="eu"
        models={[
          model('anthropic', { residency: 'global' }),
          model('any-call', { operations: [], residency: 'eu' }),
          model('free-eu', { residency: 'eu' }),
          model('image', { operations: ['generate-image'] }),
          model('mini', { price: { inputPerThousand: 0.0076, outputPerThousand: 0.0459 } }),
          model('priced-eu', { price: { inputPerThousand: 0.02, outputPerThousand: 0.1 } }),
        ]}
      />,
    );
    expect(names(open())).toEqual(['mini', 'priced-eu', 'free-eu', 'anthropic', 'any-call']);
  });

  it('marks the current model in the list and does not offer it as a change', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const dialog = open();
    const current = within(dialog).getByRole('radio', { name: /^alpha/ }) as HTMLInputElement;
    expect(current.checked).toBe(true);
    expect(within(current.closest('.mp-row') as HTMLElement).getByText('Brukes nå')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Bruk alpha' })).toBeNull();
    const keep = within(dialog).getByRole('button', { name: 'Velg en annen modell' });
    expect(keep.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(keep);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('gives the price on each row with its unit, kr per 1M tokens', () => {
    render(<Harness />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vis 2 til' }));
    expect(within(dialog).getByText('7,60 / 45,90 kr per 1M')).toBeTruthy();
  });

  it('searches by name, maker and operator', () => {
    render(<Harness />);
    const dialog = open();
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'gateway' },
    });
    expect(names(dialog)).toEqual(['borealis']);
    expect(within(dialog).getByText('1 modell passer')).toBeTruthy();
  });

  it('filters on where data is processed with chips', () => {
    render(<Harness />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Norge' }));
    expect(names(dialog)).toEqual(['borealis']);
  });

  it('hides models that cannot answer in chat until "Passer chat" is turned off', () => {
    render(<Harness />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Vis 2 til' }));
    expect(names(dialog)).not.toContain('embedder');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Passer chat' }));
    const embedder = within(dialog).getByRole('radio', { name: /embedder/ }) as HTMLInputElement;
    expect(embedder.disabled).toBe(true);
    expect(within(dialog).getByText('Kan ikke svare i chat')).toBeTruthy();
  });

  it('shows models the policy holds back as not available, with the reason and a way to ask for access', () => {
    render(<Harness />);
    const dialog = open();
    expect(names(dialog)).not.toContain('held');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Tilgjengelig for oss' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Vis \d+ til$/ }));

    const held = within(dialog).getByRole('radio', { name: /held/ }) as HTMLInputElement;
    expect(held.disabled).toBe(true);
    expect(within(dialog).getByText('Krever godkjenning')).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: 'Be om tilgang til held' }).getAttribute('href'),
    ).toBe('#/building-blocks/model/held');

    const refused = within(dialog).getByRole('radio', { name: /refused/ }) as HTMLInputElement;
    expect(refused.disabled).toBe(true);
    expect(within(dialog).getByText('Ikke tillatt for dere')).toBeTruthy();
    expect(within(dialog).queryByRole('link', { name: 'Be om tilgang til refused' })).toBeNull();
  });

  it('applies the chosen model only on "Bruk", and Avbryt keeps the old one', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    let dialog = open();
    fireEvent.click(within(dialog).getByRole('radio', { name: /^zeta/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));
    expect(onChange).not.toHaveBeenCalled();

    dialog = open();
    fireEvent.click(within(dialog).getByRole('radio', { name: /^zeta/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bruk zeta' }));
    expect(onChange).toHaveBeenCalledWith('zeta');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Anbefalt')).toBeTruthy();
  });

  it('works from the keyboard: focus starts in the search field and Escape closes back to "Bytt modell"', async () => {
    render(<Harness />);
    const dialog = open();
    const search = within(dialog).getByRole('searchbox', { name: 'Søk' });
    expect(document.activeElement).toBe(search);
    for (const radio of within(dialog).getAllByRole('radio'))
      expect(radio.getAttribute('tabindex')).not.toBe('-1');

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Bytt modell' })),
    );
  });

  it('compares two or three models side by side and marks the rows that differ', () => {
    render(<Harness />);
    const dialog = open();
    const compare = within(dialog).getByRole('button', { name: 'Sammenlign' });
    expect(compare.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Sammenlign alpha' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Sammenlign borealis' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sammenlign (2)' }));

    const table = within(screen.getByRole('dialog', { name: 'Sammenlign modeller' })).getByRole(
      'table',
    );
    const row = (label: string) =>
      within(table).getByRole('rowheader', { name: label }).closest('tr');
    expect(row('Laget av')?.className).toContain('mc-differs');
    expect(row('Funksjoner')?.className ?? '').not.toContain('mc-differs');
    expect(within(table).getByText('128 000 tokens')).toBeTruthy();
  });

  it('lets no more than three models be compared', () => {
    render(<Harness />);
    const dialog = open();
    for (const name of ['zeta', 'alpha', 'beta'])
      fireEvent.click(within(dialog).getByRole('checkbox', { name: `Sammenlign ${name}` }));
    expect(
      (within(dialog).getByRole('checkbox', { name: 'Sammenlign borealis' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it('warns when the chosen model is not among the models the tenant can use', () => {
    render(<Harness initial="gone/model" />);
    expect(
      screen.getByText(
        'Modellen gone/model er ikke blant modellene dere kan bruke nå. Velg en annen.',
      ),
    ).toBeTruthy();
  });

  it('speaks English', () => {
    render(inEnglish(<Harness />));
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose a model' });
    expect(within(dialog).getByRole('checkbox', { name: 'Fits chat' })).toBeTruthy();
    expect(within(dialog).getByText('8 models fit, showing the best 6')).toBeTruthy();
    expect(within(dialog).getByText('In use now')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: /^zeta/ }));
    expect(within(dialog).getByRole('button', { name: 'Use zeta' })).toBeTruthy();
  });
});
