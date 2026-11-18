// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nb as sharedNb } from '../i18n.js';
import { en, nb } from './i18n.js';
import { VariantPicker, type VariantOption } from './VariantPicker.js';

afterEach(cleanup);

const variants: VariantOption[] = [
  { id: 'kunnskapsassistenten__default', title: 'Svar med kilder' },
  {
    id: 'kunnskapsassistenten__mini',
    title: 'Rask (GPT-5 mini)',
    description: 'Svarer raskere, med en mindre modell.',
  },
];
const [answer, fast] = variants as [VariantOption, VariantOption];

const show = (chosen: string | undefined = answer.id, onChoose = vi.fn()) => {
  render(<VariantPicker variants={variants} value={chosen} onChange={onChoose} />);
  return onChoose;
};

const trigger = () => screen.getByRole('button', { name: /^Variant: / });
// The list is a closed popover in jsdom, so its buttons count as hidden.
const option = (name: string) =>
  screen.getByRole('button', {
    name: new RegExp(`^${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`),
    hidden: true,
  });

describe('the variant picker', () => {
  it('is a button named after the variant in use, that says what it chooses', () => {
    show();
    expect(trigger().textContent).toBe('Svar med kilder');
    expect(trigger().getAttribute('aria-label')).toBe('Variant: Svar med kilder');
  });

  it('lists each variant by name, with its description only when it has one', () => {
    show();
    expect(option('Rask (GPT-5 mini)').textContent).toBe(
      'Rask (GPT-5 mini)Svarer raskere, med en mindre modell.',
    );
    expect(option('Svar med kilder').textContent).toBe('Svar med kilder');
  });

  it('marks the variant in use as current, with a check beside it', () => {
    show(fast.id);
    expect(option('Rask (GPT-5 mini)').getAttribute('aria-current')).toBe('true');
    expect(option('Rask (GPT-5 mini)').querySelector('svg')).toBeTruthy();
    expect(option('Svar med kilder').getAttribute('aria-current')).toBeNull();
    expect(option('Svar med kilder').querySelector('svg')).toBeNull();
  });

  it('reports the choice and gives focus back to the button', () => {
    const onChoose = show();
    fireEvent.click(trigger());
    fireEvent.click(option('Rask (GPT-5 mini)'));
    expect(onChoose).toHaveBeenCalledWith('kunnskapsassistenten__mini');
    expect(document.activeElement).toBe(trigger());
  });

  it('shows the service, then its variants, and never a variant as a service of its own', () => {
    const ofKa = variants.map((variant) => ({ ...variant, service: 'Kunnskapsassistenten' }));
    render(<VariantPicker variants={ofKa} onChange={() => {}} />);
    const list = screen.getByRole('list', { name: 'Kunnskapsassistenten', hidden: true });
    const title = document.getElementById(list.getAttribute('aria-labelledby') ?? '');
    expect(title?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(list)
        .getAllByRole('button', { hidden: true })
        .map((button) => button.querySelector('.uib-variant-picker-name')?.textContent),
    ).toEqual(['Svar med kilder', 'Rask (GPT-5 mini)']);
    expect(screen.getAllByRole('list', { hidden: true })).toHaveLength(1);
  });

  it('heads each service’s variants with its own name when the app offers several services', () => {
    render(
      <VariantPicker
        variants={[
          { id: 'ka__default', title: 'Standard', service: 'Kunnskapsassistenten' },
          { id: 'other__default', title: 'Standard', service: 'Annen tjeneste' },
          { id: 'ka__fast', title: 'Rask', service: 'Kunnskapsassistenten' },
        ]}
        onChange={() => {}}
      />,
    );
    const names = (service: string) =>
      within(screen.getByRole('list', { name: service, hidden: true }))
        .getAllByRole('button', { hidden: true })
        .map((button) => button.textContent);
    expect(screen.getAllByRole('list', { hidden: true })).toHaveLength(2);
    expect(names('Kunnskapsassistenten')).toEqual(['Standard', 'Rask']);
    expect(names('Annen tjeneste')).toEqual(['Standard']);
  });

  it('is not shown when there is nothing to choose between', () => {
    const { container, rerender } = render(
      <VariantPicker variants={[answer]} value={answer.id} onChange={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<VariantPicker variants={[]} onChange={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('says «Standard» when the app does not know which variant is in use', () => {
    render(<VariantPicker variants={variants} onChange={() => {}} />);
    expect(trigger().textContent).toBe('Standard');
    expect(option('Svar med kilder').getAttribute('aria-current')).toBeNull();
  });

  it('says «Standard» for a kept choice the service no longer offers, rather than a dead name', () => {
    render(
      <VariantPicker variants={variants} value="kunnskapsassistenten__gone" onChange={() => {}} />,
    );
    expect(trigger().textContent).toBe('Standard');
  });

  it('draws no heading in the page’s outline in another block’s slot, and one at the level asked for', () => {
    const { rerender } = render(<VariantPicker variants={variants} onChange={() => {}} />);
    expect(screen.queryByRole('heading', { hidden: true })).toBeNull();
    expect(screen.getByRole('list', { name: 'Velg variant', hidden: true })).toBeTruthy();
    rerender(<VariantPicker variants={variants} onChange={() => {}} headingLevel={3} />);
    expect(
      screen.getByRole('heading', { name: 'Velg variant', level: 3, hidden: true }),
    ).toBeTruthy();
  });

  it('opens its list above the button, since its place is in the question field at the foot', () => {
    show();
    const list = screen.getByRole('list', { name: 'Velg variant', hidden: true }).parentElement;
    expect(list?.getAttribute('data-placement')).toBe('top-end');
  });

  it('is neutral unless the app gives it another colour family, as in kunnskapsassistenten’s field', () => {
    const { rerender } = render(<VariantPicker variants={variants} onChange={() => {}} />);
    const list = () =>
      screen.getByRole('list', { name: 'Velg variant', hidden: true }).parentElement;
    expect(trigger().getAttribute('data-color')).toBe('neutral');
    expect(list()?.getAttribute('data-color')).toBe('neutral');
    rerender(<VariantPicker variants={variants} onChange={() => {}} color="brand1" />);
    expect(trigger().getAttribute('data-color')).toBe('brand1');
    expect(list()?.getAttribute('data-color')).toBe('brand1');
  });

  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <VariantPicker variants={variants} onChange={() => {}} />
      </InLocale>,
    );
    expect(trigger().getAttribute('aria-label')).toBe('Variant: Default');
    expect(screen.getByRole('list', { name: 'Choose a variant', hidden: true })).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('keeps its words in its own catalogue, out of the shared one that Approach loads', () => {
    expect(Object.keys(nb)).toEqual(['variantPicker']);
    expect(sharedNb).not.toHaveProperty('variantPicker');
  });

  it('still takes the old names, chosen and onChoose, until hosts have moved', () => {
    const onChoose = vi.fn();
    render(
      <VariantPicker variants={variants} chosen="kunnskapsassistenten__mini" onChoose={onChoose} />,
    );
    expect(trigger().textContent).toContain('Rask');
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('button', { name: /Svar med kilder/, hidden: true }));
    expect(onChoose).toHaveBeenCalledWith('kunnskapsassistenten__default');
  });
});
