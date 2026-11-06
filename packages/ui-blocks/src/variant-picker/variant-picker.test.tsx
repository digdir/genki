// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
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
  render(<VariantPicker variants={variants} chosen={chosen} onChoose={onChoose} />);
  return onChoose;
};

const trigger = () => screen.getByRole('button', { name: /^Variant: / });
// The list is a closed popover in jsdom, so its buttons count as hidden.
const option = (name: string) =>
  screen.getByRole('button', {
    name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}`),
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

  it('is not shown when there is nothing to choose between', () => {
    const { container, rerender } = render(
      <VariantPicker variants={[answer]} chosen={answer.id} onChoose={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<VariantPicker variants={[]} onChoose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('says «Standard» when the app does not know which variant is in use', () => {
    render(<VariantPicker variants={variants} onChoose={() => {}} />);
    expect(trigger().textContent).toBe('Standard');
    expect(option('Svar med kilder').getAttribute('aria-current')).toBeNull();
  });

  it('says «Standard» for a kept choice the service no longer offers, rather than a dead name', () => {
    render(
      <VariantPicker variants={variants} chosen="kunnskapsassistenten__gone" onChoose={() => {}} />,
    );
    expect(trigger().textContent).toBe('Standard');
  });

  it('opens its list above the button, since its place is in the question field at the foot', () => {
    show();
    const list = screen.getByRole('heading', { name: 'Velg variant', hidden: true }).parentElement;
    expect(list?.getAttribute('data-placement')).toBe('top-end');
  });

  it('is neutral unless the app gives it another colour family, as in kunnskapsassistenten’s field', () => {
    const { rerender } = render(<VariantPicker variants={variants} onChoose={() => {}} />);
    const list = () =>
      screen.getByRole('heading', { name: 'Velg variant', hidden: true }).parentElement;
    expect(trigger().getAttribute('data-color')).toBe('neutral');
    expect(list()?.getAttribute('data-color')).toBe('neutral');
    rerender(<VariantPicker variants={variants} onChoose={() => {}} color="brand1" />);
    expect(trigger().getAttribute('data-color')).toBe('brand1');
    expect(list()?.getAttribute('data-color')).toBe('brand1');
  });

  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <VariantPicker variants={variants} onChoose={() => {}} />
      </InLocale>,
    );
    expect(trigger().getAttribute('aria-label')).toBe('Variant: Default');
    expect(screen.getByRole('heading', { name: 'Choose a variant', hidden: true })).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
