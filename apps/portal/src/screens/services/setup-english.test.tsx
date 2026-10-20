// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { columnProblems } from '../../data/table-output';
import { translator } from '../../i18n';
import type { InputFormField } from '../../data/input-form';
import { applySpec } from '../../data/service-definition';
import { exampleTemplate } from '../../data/services';
import { registerStrategies } from '../../data/strategies';
import { platformStrategies } from '../../mock/strategies';
import type { TableOutput } from '../../data/table-output';
import { InputFormEditor, formIssues } from './InputFormEditor';
import { SetupHarness } from './setup-harness';
import { TableOutputEditor } from './TableOutputEditor';

document.getAnimations ??= () => [];

afterEach(cleanup);

describe('the service setup in English', () => {
  it('shows the default instructions with an English label and note', () => {
    registerStrategies(platformStrategies);
    render(
      inEnglish(
        <SetupHarness
          sections={['instructions']}
          initial={applySpec(exampleTemplate('answers'), {
            strategy: { id: 'rag-single-shot', version: 1, config: {} },
          })}
        />,
      ),
    );

    fireEvent.click(screen.getByText('See the default instructions'));
    expect(
      (
        screen.getByLabelText(
          'The default instructions (cannot be changed here)',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain('{date}');
    expect(screen.getByText(/becomes today's date/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use as a starting point' })).toBeTruthy();
  });

  it('shows labels, risk options and start options in English', () => {
    render(
      inEnglish(
        <SetupHarness
          sections={['purpose', 'io', 'guards', 'start']}
          initial={exampleTemplate('drafts')}
        />,
      ),
    );

    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByText('Purpose and audience')).toBeTruthy();
    expect(screen.getByText('Limited risk')).toBeTruthy();
    expect(screen.getByText('Risk level under the AI Act')).toBeTruthy();
    expect(screen.getByText("AI workspace (the platform's chat)")).toBeTruthy();
    expect(screen.queryByText('Formål og målgruppe')).toBeNull();
  });
});

describe('the input form editor in English', () => {
  it('adds a field with an English default label and English field kinds', () => {
    const seen: InputFormField[][] = [];
    const Harness = () => {
      const [fields, setFields] = useState<InputFormField[]>([]);
      return (
        <InputFormEditor
          fields={fields}
          datasets={[]}
          onChange={(next) => {
            seen.push(next);
            setFields(next);
          }}
        />
      );
    };
    render(inEnglish(<Harness />));

    expect(screen.getByText('Input form')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(seen.at(-1)?.[0]?.label).toBe('New field');
    expect(screen.getByLabelText('Label')).toBeTruthy();
    expect(screen.getByText('Single choice')).toBeTruthy();
  });

  it('writes validation messages in English', () => {
    const t = translator('en');
    const field: InputFormField = {
      id: 'Bad id',
      label: 'Year',
      kind: 'choice',
      required: false,
      help: '',
      options: '',
      optionsFrom: null,
    };
    expect(formIssues(t, [field], undefined).map((x) => x.text)).toEqual([
      '"Year": use lower-case letters, digits and _ in the ID, and start with a letter.',
      '"Year" needs at least one option.',
    ]);
  });
});

describe('the table output editor in English', () => {
  it('labels columns and moves them with English announcements', () => {
    const table: TableOutput = {
      columns: [
        { key: 'a', name: 'A', type: 'string', desc: '', kind: 'document', values: '' },
        { key: 'b', name: 'B', type: 'string', desc: '', kind: 'document', values: '' },
      ],
      rowKey: 'a',
    };
    const Harness = () => {
      const [value, setValue] = useState(table);
      return <TableOutputEditor serviceId="s" table={value} onChange={setValue} />;
    };
    render(inEnglish(<Harness />));

    fireEvent.click(screen.getByRole('button', { name: 'Move B up' }));
    expect(screen.getByText('"B" is now column 1.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove A' })).toBeTruthy();
  });

  it('explains key problems in English', () => {
    const t = translator('en');
    const problems = columnProblems(t, {
      columns: [
        { key: 'x', name: '', type: 'enum', desc: '', kind: 'document', values: '' },
        { key: 'x', name: '', type: 'string', desc: '', kind: 'document', values: '' },
      ],
      rowKey: '',
    });
    expect(problems[0]?.values).toBe(
      'Enter at least one allowed value when the type is fixed values.',
    );
    expect(problems[1]?.key).toBe('The key "x" is already in use. Keys must be unique.');
  });
});
