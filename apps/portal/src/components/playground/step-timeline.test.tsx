// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineStep, TimelineStepState } from '../../types';
import { RunTimeline } from './StepTimeline';

afterEach(cleanup);

const timeline = (over: Partial<TimelineStep>) =>
  render(
    <RunTimeline
      steps={[{ id: 's1', type: 'search', title: 'Steg', summary: '', at: 0, blocks: [], ...over }]}
    />,
  );

describe('the time on a step in the run timeline', () => {
  it('shows <1 ms for a step without timing and without a state', () => {
    timeline({});
    expect(screen.getByRole('button').textContent).toMatch(/<1 ms$/);
  });

  it('shows <1 ms for an ok step without timing', () => {
    timeline({ state: 'ok' });
    expect(screen.getByRole('button').textContent).toMatch(/<1 ms$/);
  });

  it.each<TimelineStepState>([
    'skipped',
    'cancelled',
    'rejected',
    'failed',
    'partial',
    'running',
    'waiting',
    'pending',
  ])('shows no time for a %s step without timing', (state) => {
    timeline({ state });
    expect(screen.getByRole('button').textContent).not.toMatch(/ms|\d s/);
  });

  it('shows the duration of a failed step when it is known', () => {
    timeline({ state: 'failed', durationSeconds: 2 });
    expect(screen.getByRole('button').textContent).toMatch(/2,0 s$/);
  });
});
