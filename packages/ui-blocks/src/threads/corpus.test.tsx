// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import captured from './fixtures/genki-test-conversations.json' with { type: 'json' };
import { Threads } from './Threads.js';
import type { ThreadItem } from './types.js';

document.getAnimations ??= () => [];
beforeEach(() => {
  // The afternoon of the capture, so the groups and times are the ones a person saw that day.
  vi.useFakeTimers({ now: new Date('2026-11-06T13:30:00Z'), toFake: ['Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The host's adapter, as thin as the contract allows: `topic` is the title, `created` the time. */
const threadOf = (c: (typeof captured.conversations)[number]): ThreadItem => ({
  id: c.id,
  title: c.topic,
  updatedAt: c.created,
});
const threads = captured.conversations.map(threadOf);

const draw = () => render(<Threads threads={threads} threadHref={(t) => `/threads/${t.id}`} />);

describe(`the ${captured.total} conversations listed from genki-test on ${captured.capturedOn}`, () => {
  it('draws one row per conversation, named by its whole title', () => {
    draw();
    expect(screen.getAllByRole('link')).toHaveLength(captured.conversations.length);
    for (const c of captured.conversations)
      expect(screen.getByRole('link', { name: c.topic })).toBeTruthy();
  });

  it('shows each title exactly as the platform sent it, and nothing but the title and the time', () => {
    draw();
    for (const c of captured.conversations) {
      const row = screen.getByRole('link', { name: c.topic });
      const time = row.querySelector('time') as HTMLTimeElement;
      expect(row.textContent).toBe(`${c.topic}${time.textContent}`);
      expect(time.dateTime).toBe(new Date(c.created).toISOString());
    }
  });

  it('lists them newest first, under «I dag», with the clock on each row', () => {
    draw();
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Tidligere tråder',
      'I dag',
    ]);
    const newestFirst = [...captured.conversations]
      .sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : 1))
      .map((c) => c.topic);
    const rows = screen.getAllByRole('link');
    expect(rows.map((row) => row.querySelector('.uib-threads-thread-title')?.textContent)).toEqual(
      newestFirst,
    );
    for (const row of rows) expect(within(row).getByText(/^\d{2}:\d{2}$/).tagName).toBe('TIME');
  });

  it('finds the same threads a plain search of the titles finds, for every word in them', () => {
    const { container } = draw();
    const words = new Set(
      captured.conversations.flatMap((c) =>
        c.topic
          .toLocaleLowerCase('nb')
          .split(/[^\p{L}\p{N}]+/u)
          .filter((w) => w.length > 3),
      ),
    );
    const field = screen.getByRole('searchbox', { name: 'Søk i tråder' });
    expect(words.size).toBe(153);
    for (const word of words) {
      fireEvent.change(field, { target: { value: word } });
      const expected = captured.conversations.filter((c) =>
        c.topic.toLocaleLowerCase('nb').includes(word),
      ).length;
      expect(screen.getAllByRole('link')).toHaveLength(expected);
      expect(container.querySelector('output.uib-threads-search-status')?.textContent).toBe(
        expected === 1 ? '1 tråd' : `${expected} tråder`,
      );
    }
  });
});
