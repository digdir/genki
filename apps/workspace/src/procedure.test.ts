import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { allDone, withStep, type ProcedureState } from './procedure';

const t = translator('nb');
const empty: ProcedureState = { steps: [] };
const shown = (state: ProcedureState) => state.steps.map((s) => [s.title, s.status]);

describe('the approach from the stream', () => {
  it('marks the step in progress done when the next one starts', () => {
    const one = withStep(empty, { stage: 'tool', tool: 'search' }, t);
    expect(shown(withStep(one, { stage: 'tool', tool: 'read_chunks' }, t))).toEqual([
      ['Lette etter steder som handler om spørsmålet', 'done'],
      ['Leste de relevante delene nøye', 'active'],
    ]);
  });

  it('shows the label the platform sends before its own title for the tool', () => {
    const state = withStep(empty, { tool: 'search', label: 'Søkte i årsrapportene' }, t);
    expect(state.steps[0]?.title).toBe('Søkte i årsrapportene');
  });

  it('leaves out frames a person cannot read, such as an unknown tool or a new iteration', () => {
    const start = withStep(empty, { tool: 'search' }, t);
    expect(withStep(start, { tool: 'use_skill' }, t)).toBe(start);
    expect(withStep(start, { event: 'agent/iteration-started', iteration: 2 }, t)).toBe(start);
  });

  it('keeps one step when the same tool is called again in a row', () => {
    const start = withStep(empty, { tool: 'search' }, t);
    expect(withStep(start, { tool: 'search', iteration: 2 }, t)).toBe(start);
  });

  it('shows the planned steps as waiting, and moves through them in order', () => {
    const planned = withStep(
      empty,
      { tool: 'plan_queries', plan: ['plan_queries', 'search', 'generate_response'] },
      t,
    );
    expect(shown(planned)).toEqual([
      ['Forsto spørsmålet', 'active'],
      ['Lette etter steder som handler om spørsmålet', 'waiting'],
      ['Skrev svaret', 'waiting'],
    ]);
    expect(shown(withStep(planned, { tool: 'generate_response' }, t))).toEqual([
      ['Forsto spørsmålet', 'done'],
      ['Lette etter steder som handler om spørsmålet', 'done'],
      ['Skrev svaret', 'active'],
    ]);
  });

  it('updates the step in progress with what it read so far', () => {
    const reading = withStep(
      empty,
      {
        tool: 'read_chunks',
        description: '17 er lest så langt.',
        documents: [{ title: 'Årsrapport 2025', pages: 's. 4' }],
        'documents-read': 17,
      },
      t,
    );
    const later = withStep(reading, { tool: 'read_chunks', 'documents-read': 38 }, t);
    expect(later.steps).toHaveLength(1);
    expect(later.steps[0]).toMatchObject({
      status: 'active',
      description: '17 er lest så langt.',
      documents: [{ title: 'Årsrapport 2025', detail: 's. 4' }],
      documentsRead: 38,
    });
  });

  it('keeps how many documents the run reads from for the line at the bottom', () => {
    expect(withStep(empty, { tool: 'inspect_filters', 'documents-total': 214 }, t).read).toBe(214);
  });

  it('marks every step done when the answer is done, and drops planned steps never reached', () => {
    const state = withStep(empty, { tool: 'search', plan: ['search', 'report_gaps'] }, t);
    expect(allDone(state.steps).map((s) => [s.title, s.status])).toEqual([
      ['Lette etter steder som handler om spørsmålet', 'done'],
    ]);
  });

  it('has the same step titles in English', () => {
    expect(withStep(empty, { tool: 'generate_response' }, translator('en')).steps[0]?.title).toBe(
      'Wrote the answer',
    );
  });
});
