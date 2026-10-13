// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedbackTab, feedbackFrom } from './FeedbackTab';

document.getAnimations ??= () => [];
afterEach(cleanup);

describe('anonymised feedback from the API', () => {
  it('renders ratings with only a date and no task or comment', () => {
    const items = feedbackFrom(
      Array.from({ length: 5 }, (_, i) => ({ rating: 'down' as const, at: `2026-10-0${i + 1}` })),
      true,
    );
    render(
      <FeedbackTab
        feedback={items}
        added={{}}
        onAdded={() => {}}
        onAddCase={() => 'tc-1'}
        onShowProposal={() => {}}
        setFlash={() => {}}
      />,
    );

    expect(items.every((i) => i.run === undefined)).toBe(true);
    expect(screen.getAllByText(/2026/).length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText(/Kjøring/)).toBeNull();
    expect(screen.queryByText(/undefined|Invalid Date/)).toBeNull();
  });
});
