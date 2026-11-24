// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RefBlockPayload } from '@genai/contracts/blocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockHostContext } from './block-events.js';
import { DeclarativeBlock } from './declarative-block.js';

afterEach(cleanup);

const payload = (events: RefBlockPayload['events']): RefBlockPayload => ({
  ref: '991825827/kort@1',
  tier: 'declarative',
  publisher: '991825827',
  title: { nb: 'Kort' },
  zones: ['main'],
  events,
  states: ['filled'],
  reads: ['question.text'],
  texts: { nb: { again: 'Spør igjen', done: 'Lagret' } },
  template: {
    version: 1,
    root: {
      type: 'stack',
      children: [
        {
          type: 'button',
          text: { t: 'again' },
          event: { name: 'ask', question: { bind: 'question.text' } },
        },
        { type: 'button', text: { t: 'done' }, event: { name: 'notify', text: { t: 'done' } } },
      ],
    },
  },
});

const draw = (events: RefBlockPayload['events']) => {
  const onEvent = vi.fn();
  render(
    <BlockHostContext.Provider value={{ locale: 'nb', onEvent }}>
      <DeclarativeBlock
        payload={payload(events)}
        data={{ question: { text: 'Hva er klarspråk?' } }}
        state="filled"
      />
    </BlockHostContext.Provider>,
  );
  return onEvent;
};

describe('a declarative block in the host', () => {
  it('drops an event the block does not declare', () => {
    const onEvent = draw(['notify']);

    fireEvent.click(screen.getByRole('button', { name: 'Spør igjen' }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('sends a declared event to the host', () => {
    const onEvent = draw(['ask']);

    fireEvent.click(screen.getByRole('button', { name: 'Spør igjen' }));

    expect(onEvent).toHaveBeenCalledWith({ name: 'ask', question: 'Hva er klarspråk?' });
  });

  it('shows a notify in a status line of its own, never sent to the host', () => {
    const onEvent = draw(['notify']);

    fireEvent.click(screen.getByRole('button', { name: 'Lagret' }));

    expect(screen.getByRole('status').textContent).toBe('Lagret');
    expect(onEvent).not.toHaveBeenCalled();
  });
});
