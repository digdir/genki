import type { Event, Task } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { toTimeline, warningText } from './timeline.js';

const task = {
  id: 'tp1',
  service: { capability: { id: 'testetaten/rapportassistenten', version: '4' } },
  status: 'completed',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari' },
  createdAt: '2026-10-07T12:32:00.000Z',
  endedAt: '2026-10-07T12:32:03.400Z',
  usage: {},
} as unknown as Task;

const retrievalResult = (attribution: unknown) =>
  ({
    seq: 4,
    ts: '2026-10-07T12:32:00.500Z',
    type: 'kernel.result',
    data: [
      {
        mime: 'application/vnd.genai.retrieval+json',
        body: { kind: 'json', json: { queries: ['digital veiledning'], attribution } },
      },
    ],
  }) as unknown as Event;

describe('run timeline search notes', () => {
  it('skipped documents become one Søkemerknad step of type searchnote', () => {
    const timeline = toTimeline(
      task,
      [
        retrievalResult({
          content: 14,
          skipped: [
            { document: 'Evaluering av veiledningstjenesten (2019).pdf', reason: 'no_text' },
            { document: 'Brukerundersøkelse 2021 – vedlegg.xlsx', reason: 'unsupported_type' },
            { document: 'Notat om chatbot (2022)', reason: 'outside_access' },
            { document: 'Notat om chatbot (2022)', reason: 'outside_access' },
            { document: 'Skadet rapport.docx', reason: 'conversion_failed' },
          ],
        }),
      ],
      new Date('2026-10-07T12:32:04.000Z'),
    );

    const notes = timeline.steps.filter((s) => s.type === 'searchnote');
    expect(notes).toEqual([
      expect.objectContaining({
        title: 'Søkemerknad',
        summary: '4 dokumenter hoppet over',
        blocks: [
          {
            kind: 'list',
            label: 'Søkemotoren hoppet over',
            items: [
              ['Evaluering av veiledningstjenesten (2019).pdf', 'Skannet PDF uten tekst'],
              ['Brukerundersøkelse 2021 – vedlegg.xlsx', 'Filtypen kan ikke søkes i'],
              ['Notat om chatbot (2022)', 'Utenfor tilgangen til tjenesten'],
              ['Skadet rapport.docx', 'Kunne ikke lese dokumentet'],
            ],
          },
        ],
      }),
    ]);
    expect(timeline.steps.map((s) => s.type)).toEqual(['searchnote', 'search', 'result']);
  });

  it('keeps string warnings as notices next to the search note', () => {
    const timeline = toTimeline(
      task,
      [
        retrievalResult({
          warnings: ['skipped phrase search: dataset lacks profile phrase'],
          skipped: [{ document: 'tom.md', reason: 'no_text' }],
        }),
      ],
      new Date('2026-10-07T12:32:04.000Z'),
    );

    expect(timeline.steps.map((s) => [s.type, s.summary])).toEqual([
      ['searchnote', '1 dokument hoppet over'],
      ['note', 'Søket «phrase» ble hoppet over fordi datasettet mangler søkeprofilen phrase.'],
      ['search', '1 søk: «digital veiledning»'],
      ['result', 'Svaret ble levert'],
    ]);
    expect(timeline.steps[0]?.blocks[0]?.items).toEqual([['tom.md', 'Dokumentet har ingen tekst']]);
  });
});

describe('search notes in Norwegian', () => {
  it('translates the retrieval warnings people see in the log', () => {
    expect(
      warningText('skipped org auto-filter on orgs_long: dataset lacks a multiselect field'),
    ).toBe('Filteret på virksomhet ble ikke brukt fordi feltet orgs_long ikke har flere verdier.');
    expect(warningText('skipped org auto-filter: engine lacks facets')).toMatch(/^Filteret på/);
    expect(warningText('skipped doc-title fan-out: engine lacks range')).toMatch(/dokumenttitler/);
    expect(warningText('something new')).toBeUndefined();
  });

  it('keeps an unknown warning as a quote under a Norwegian summary', () => {
    const timeline = toTimeline(
      task,
      [retrievalResult({ content: 1, warnings: ['something new'] })],
      new Date('2026-10-07T12:32:04.000Z'),
    );
    expect(timeline.steps.find((s) => s.type === 'note')).toEqual(
      expect.objectContaining({
        summary: 'Søket ble justert underveis.',
        blocks: [{ kind: 'quote', text: 'something new' }],
      }),
    );
  });
});

describe('a failed run in the timeline', () => {
  const failed = { ...task, status: 'failed' } as Task;
  const at = (seq: number, type: string, data: unknown, audience?: string) =>
    ({
      seq,
      ts: `2026-10-07T12:32:0${seq}.000Z`,
      type,
      data,
      ...(audience ? { audience } : {}),
    }) as unknown as Event;
  const events = [
    at(1, 'kernel.notice', { kind: 'step', step: 'finn', block: 'documents@1', status: 'started' }),
    at(2, 'kernel.notice', { kind: 'step', step: 'finn', block: 'documents@1', status: 'done' }),
    at(
      3,
      'kernel.error',
      { code: 'strategy_error', message: 'step les failed: document 42 has no text' },
      'audit',
    ),
    at(3, 'kernel.error', { code: 'strategy_error', message: 'the service failed' }),
  ];

  it('names the step that failed and shows why to people who manage services', () => {
    const timeline = toTimeline(failed, events, new Date('2026-10-07T12:32:04.000Z'), undefined, {
      details: true,
    });

    expect(timeline.steps.map((s) => [s.type, s.title, s.summary])).toEqual([
      ['step', 'Steg «finn» (documents@1)', 'Ferdig'],
      ['error', 'Steget «les» feilet', 'Steget «les» feilet. Tjenesten feilet underveis.'],
    ]);
    expect(timeline.steps.at(-1)?.blocks).toEqual([
      { kind: 'quote', text: 'step les failed: document 42 has no text' },
    ]);
  });

  it('gives others the reason without the error text', () => {
    const timeline = toTimeline(failed, events, new Date('2026-10-07T12:32:04.000Z'));

    expect(timeline.steps.at(-1)).toMatchObject({ type: 'error', blocks: [] });
    expect(JSON.stringify(timeline)).not.toContain('document 42');
  });
});

describe('failed and skipped steps in the timeline', () => {
  const at = (seq: number, data: unknown) =>
    ({
      seq,
      ts: `2026-10-07T12:32:0${seq}.000Z`,
      type: 'kernel.notice',
      data,
    }) as unknown as Event;
  const events = [
    at(1, { kind: 'step', step: 'les', path: 'hver#0/les', status: 'done' }),
    at(2, {
      kind: 'step',
      step: 'hver',
      path: 'hver#1',
      item: 1,
      status: 'failed',
      error: 'scanned pdf without text',
    }),
    at(3, { kind: 'step', step: 'hver', path: 'hver', status: 'done' }),
    at(4, { kind: 'step', step: 'tabell', path: 'tabell', status: 'failed', error: 'no column' }),
    at(5, { kind: 'step', step: 'tabell', path: 'tabell', status: 'skipped' }),
  ];

  it('marks a skipped loop item, the partial loop and the failed step with state and depth', () => {
    const timeline = toTimeline(task, events, new Date('2026-10-07T12:32:06.000Z'));

    expect(timeline.steps.map((s) => [s.title, s.state, s.depth])).toEqual([
      ['Steg «les»', undefined, 1],
      ['Element 2 i «hver»', 'skipped', 1],
      ['Steg «hver»', 'partial', undefined],
      ['Steget «tabell» feilet', 'failed', undefined],
      ['Steg «tabell»', 'skipped', undefined],
    ]);
    expect(timeline.steps[2]?.summary).toBe('Ferdig, 1 element hoppet over');
    expect(JSON.stringify(timeline)).not.toContain('scanned pdf');
  });

  it('shows the item error to people who manage services', () => {
    const timeline = toTimeline(task, events, new Date('2026-10-07T12:32:06.000Z'), undefined, {
      details: true,
    });

    expect(timeline.steps[1]?.blocks).toEqual([
      { kind: 'quote', text: 'scanned pdf without text' },
    ]);
  });
});
