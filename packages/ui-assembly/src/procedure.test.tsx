// @vitest-environment jsdom
import { Approach } from '@genai/ui-blocks';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stepsOf, type StepFrame } from './procedure.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const frames: StepFrame[] = [
  { event: 'agent/iteration-started', iteration: 1 },
  { stage: 'tool', tool: 'plan_queries', event: 'tool/call' },
  { stage: 'tool', tool: 'search', event: 'tool/call' },
  { stage: 'tool', tool: 'search', event: 'tool/call' },
  { stage: 'tool', tool: 'read_chunks', event: 'tool/call' },
  { stage: 'tool', tool: 'read_chunks', event: 'tool/call' },
  {
    event: 'agent/turn-completed',
    'tool-calls': [
      { tool: 'read_chunks', args: { chunk_ids: ['a', 'b', 'c'] } },
      { tool: 'read_chunks', args: { chunk_ids: ['d'] } },
    ],
  },
  { label: 'Vurderte treffene' },
  { label: 'Vurderte treffene' },
  { stage: 'tool', tool: 'search', event: 'tool/call' },
  { stage: 'tool', tool: 'generate_response', event: 'tool/call' },
];
const approach = { frames, startedAt: 0, finishedAt: 1000 };

describe('the steps from genki’s frames', () => {
  it('are one per frame with a title, the last in progress while the answer comes', () => {
    const steps = stepsOf(approach, true);
    expect(steps.map((step) => step.title)).toEqual([
      'Forsto spørsmålet',
      'Lette etter steder som handler om spørsmålet',
      'Lette etter steder som handler om spørsmålet',
      'Leste de relevante delene nøye',
      'Leste de relevante delene nøye',
      'Vurderte treffene',
      'Vurderte treffene',
      'Lette etter steder som handler om spørsmålet',
      'Skrev svaret',
    ]);
    expect(steps.at(-1)?.status).toBe('active');
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  });

  it('give the passages a turn read to the reading step before it', () => {
    expect(stepsOf(approach, false).map((step) => step.excerptsRead ?? 0)).toEqual([
      0, 0, 0, 0, 4, 0, 0, 0, 0,
    ]);
  });

  it('give each step the time genki reports for its tool calls, only when asked for the times', () => {
    const turn: StepFrame[] = [
      { stage: 'tool', tool: 'search', event: 'tool/call' },
      { stage: 'tool', tool: 'read_chunks', event: 'tool/call' },
      {
        event: 'agent/turn-completed',
        'tool-calls': [
          { tool: 'search', 'duration-ms': 1200 },
          { tool: 'read_chunks', 'duration-ms': 800, args: { chunk_ids: ['a'] } },
          { tool: 'read_chunks', 'duration-ms': 'soon' },
          { tool: 'rerank_results', 'duration-ms': 300 },
        ],
      },
      { stage: 'tool', tool: 'generate_response', event: 'tool/call' },
    ];
    const timed = stepsOf({ frames: turn, startedAt: 0 }, false, 'nb', true);
    expect(timed.map((step) => step.duration)).toEqual([1200, 800, undefined]);
    expect(stepsOf({ frames: turn, startedAt: 0 }, false).some((step) => 'duration' in step)).toBe(
      false,
    );
  });

  it('time each call of a tool called twice in one turn on its own step, in the turn’s order', () => {
    const turns: StepFrame[] = [
      { stage: 'tool', tool: 'search', event: 'tool/call' },
      {
        event: 'agent/turn-completed',
        'tool-calls': [{ tool: 'search', 'duration-ms': 100 }],
      },
      { stage: 'tool', tool: 'search', event: 'tool/call' },
      { stage: 'tool', tool: 'read_chunks', event: 'tool/call' },
      { stage: 'tool', tool: 'search', event: 'tool/call' },
      {
        event: 'agent/turn-completed',
        'tool-calls': [
          { tool: 'search', 'duration-ms': 1000 },
          { tool: 'read_chunks', 'duration-ms': 200 },
          { tool: 'search', 'duration-ms': 3000 },
        ],
      },
    ];
    const timed = stepsOf({ frames: turns, startedAt: 0 }, false, 'nb', true);
    expect(timed.map((step) => step.duration)).toEqual([100, 1000, 200, 3000]);
  });

  it('read in Approach as they did when the assembly joined the runs itself', () => {
    render(<Approach steps={stepsOf(approach, false)} working={false} startedAt={0} open />);
    const lines = [...document.querySelectorAll('.uib-approach-step-title')].map(
      (title) => title.textContent,
    );
    expect(lines).toEqual([
      'Forsto spørsmålet',
      'Lette etter steder som handler om spørsmålet (2 ganger)',
      'Leste 4 utdrag nøye',
      'Vurderte treffene (2 ganger)',
      'Lette etter steder som handler om spørsmålet',
      'Skrev svaret',
    ]);
  });
});
