// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { exampleFlows, type Flow } from '../../data/stepflows';
import { translator } from '../../i18n';
import { Diagram } from './Diagram';
import { analyse, fromDefinition, newBlockStep, versionLabel } from './model';

afterEach(cleanup);

const en = translator('en');
const flows = Object.fromEntries(exampleFlows.map((f) => [f.id, f]));
const flow = flows['svar-med-kilder'] as Flow;

describe('step flows in English', () => {
  it('labels the diagram in English', () => {
    const analysis = analyse(flow, flows, {}, en);
    render(
      inEnglish(
        <Diagram
          flow={flow}
          analysis={analysis}
          overlay={false}
          subOpen={{}}
          onToggleSub={() => undefined}
          onOpen={() => undefined}
          onAdd={() => undefined}
        />,
      ),
    );
    expect(screen.getByRole('list', { name: 'The steps in the flow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add step' })).toBeTruthy();
  });

  it('writes validation messages, labels and parse errors in English', () => {
    expect(newBlockStep('s1', en).label).toBe('New step');
    expect(versionLabel({ ...flow, draft: true, version: 3 }, en)).toBe('v3 (draft)');
    const broken = { ...flow, steps: [newBlockStep('s1', en)] };
    expect(analyse(broken, flows, {}, en).errors.get('s1')).toContain('Choose a step type.');
    expect(() =>
      fromDefinition(
        { apiVersion: 'genai/v1', kind: 'Service', spec: { steps: [] } },
        undefined,
        en,
      ),
    ).toThrow('kind must be StepFlow.');
  });
});
