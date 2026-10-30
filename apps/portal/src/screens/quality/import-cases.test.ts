import { describe, expect, it } from 'vitest';
import { parseCaseFile } from './import-cases';

const evalTestSet =
  Object.values(
    import.meta.glob<string>('../../../../../packages/eval/testsets/ka-kudos-draft.yaml', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0] ?? '';

describe('importing test cases from a file', () => {
  it('reads a platform test set in the packages/eval YAML format, holdout as locked', () => {
    const result = parseCaseFile('ka-kudos-draft.yaml', evalTestSet);
    if (!result.ok) throw new Error(result.problem);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => r.problems.length === 0)).toBe(true);
    const first = result.rows[0]?.value;
    expect(first?.id).toBe('ka-kudos-001-factual');
    expect(first?.expected).toMatch(/budsjettmodellen/);
    expect(first?.split).toBe('open');
    expect(
      parseCaseFile('x.yaml', 'cases:\n  - input: Hei\n    expected: Svar\n    split: holdout\n'),
    ).toMatchObject({ ok: true, rows: [{ value: { split: 'locked' } }] });
  });

  it('reads CSV with comma or semicolon and quoted cells, numbering rows as in the file', () => {
    const result = parseCaseFile(
      'cases.csv',
      'input;expected;type;split\n"Hva koster et tilsyn; i kroner?";Oppgir gebyret;exact;locked\nHei;;must_reject;\n',
    );
    expect(result).toMatchObject({
      ok: true,
      unit: 'row',
      rows: [
        {
          row: 2,
          value: { input: 'Hva koster et tilsyn; i kroner?', type: 'exact', split: 'locked' },
          problems: [],
        },
        { row: 3, value: { type: 'must_reject', split: 'open' }, problems: [] },
      ],
    });
  });

  it('reports every problem per row, including ids that already exist or repeat', () => {
    const result = parseCaseFile(
      'cases.json',
      JSON.stringify([
        { id: 'a', input: '', expected: 'x' },
        { id: 'b', input: 'Hei', type: 'fuzzy', split: 'later' },
        { id: 'c', input: 'Hei', expected: 'x' },
        { id: 'c', input: 'Hei', expected: 'x' },
        { id: 'Bad Id', input: { data: {} }, expected: 'x' },
      ]),
      ['a'],
    );
    if (!result.ok) throw new Error(result.problem);
    expect(result.rows.map((r) => [r.row, r.problems])).toEqual([
      [1, ['inputMissing', 'idExists']],
      [2, ['typeUnknown', 'expectedMissing', 'splitUnknown']],
      [3, []],
      [4, ['idDuplicate']],
      [5, ['inputStructured', 'idInvalid']],
    ]);
  });

  it('refuses files it cannot read as a whole', () => {
    expect(parseCaseFile('cases.xlsx', '')).toEqual({ ok: false, problem: 'formatUnknown' });
    expect(parseCaseFile('cases.json', '{')).toEqual({ ok: false, problem: 'unreadable' });
    expect(parseCaseFile('cases.csv', 'question;answer\n')).toEqual({
      ok: false,
      problem: 'noCases',
    });
    expect(parseCaseFile('cases.csv', 'navn;svar\nx;y\n')).toEqual({
      ok: false,
      problem: 'headerMissing',
    });
  });

  it('keeps every named criterion and a reference answer beside them, so none is dropped on import', () => {
    const result = parseCaseFile(
      'x.yaml',
      [
        'cases:',
        '  - input: Hvem eier Kudos?',
        '    expected:',
        '      referenceAnswer: DFØ eier Kudos.',
        '      criteria:',
        '        criteria: Svaret nevner DFØ',
        '        supporting_quotes: Kudos driftes av DFØ',
        '  - input: Hva er Kudos?',
        '    expected:',
        '      criteria:',
        '        supporting_quotes: Kudos er et dokumentarkiv',
        '',
      ].join('\n'),
    );

    expect(result).toMatchObject({
      ok: true,
      rows: [
        {
          problems: [],
          value: {
            expected: {
              referenceAnswer: 'DFØ eier Kudos.',
              criteria: {
                criteria: 'Svaret nevner DFØ',
                supporting_quotes: 'Kudos driftes av DFØ',
              },
            },
          },
        },
        {
          problems: [],
          value: { expected: { criteria: { supporting_quotes: 'Kudos er et dokumentarkiv' } } },
        },
      ],
    });
  });

  it('refuses a row whose criteria name is not one judges read, rather than importing half the file', () => {
    const result = parseCaseFile(
      'x.yaml',
      [
        'cases:',
        '  - input: Hei',
        '    expected:',
        '      criteria:',
        '        Supporting quotes: x',
        '',
      ].join('\n'),
    );

    expect(result).toMatchObject({ ok: true, rows: [{ problems: ['criterionNameInvalid'] }] });
  });
});
