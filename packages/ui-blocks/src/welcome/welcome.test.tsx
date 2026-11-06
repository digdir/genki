// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InLocale } from '@genai/i18n/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Suggestions, Welcome } from './Welcome.js';

afterEach(cleanup);

const questions = [
  'Hva handler dokumentene i denne samlingen om?',
  'Gi meg en oversikt over de viktigste temaene.',
  'Oppsummer det viktigste i noen få punkter.',
];

describe('the welcome', () => {
  it('greets the reader by name and asks what they wonder about, in one heading', () => {
    render(<Welcome name="Kari" />);
    const headings = screen.getAllByRole('heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.tagName).toBe('H2');
    expect(headings[0]?.textContent).toBe('Hei, Kari 👋Hva lurer du på?');
  });

  it('greets without a name when it has none', () => {
    render(<Welcome />);
    expect(screen.getByRole('heading').textContent).toBe('Hei 👋Hva lurer du på?');
  });

  it('keeps the wave from screen readers', () => {
    render(<Welcome name="Kari" />);
    expect(screen.getByText('👋').getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the host’s colour family on the block only when given one', () => {
    const { container, rerender } = render(<Welcome />);
    expect(container.firstElementChild?.hasAttribute('data-color')).toBe(false);
    rerender(<Welcome color="neutral" />);
    expect(container.firstElementChild?.getAttribute('data-color')).toBe('neutral');
  });
});

describe('the suggestions', () => {
  it('offers each question as a button under «Forslag»', () => {
    render(<Suggestions suggestions={questions} onPick={() => {}} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Forslag' })).toBeTruthy();
    for (const question of questions)
      expect(screen.getByRole('button', { name: question })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('hands a picked question to the host, which fills the field and does not send it', () => {
    const picked: string[] = [];
    render(<Suggestions suggestions={questions} onPick={(question) => picked.push(question)} />);
    fireEvent.click(screen.getByRole('button', { name: questions[1] }));
    expect(picked).toEqual([questions[1]]);
  });

  it('draws nothing without suggestions, not even its heading', () => {
    const { container } = render(<Suggestions suggestions={[]} onPick={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('is no landmark, since it is a list of buttons and not a section', () => {
    render(<Suggestions suggestions={questions} onPick={() => {}} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('the welcome’s language', () => {
  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <Welcome name="Kari" />
        <Suggestions suggestions={['What do the documents say?']} onPick={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'Hi, Kari 👋What would you like to know?',
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Suggestions' })).toBeTruthy();
  });
});
