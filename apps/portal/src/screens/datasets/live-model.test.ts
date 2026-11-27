import { describe, expect, it } from 'vitest';
import type {
  DatasetView,
  ExecutionStatus,
  ExecutionView,
  LastExecution,
} from '../../api/datasets';
import { ApiError } from '../../api/error';
import { createFormat } from '@genai/i18n';
import { translator } from '../../i18n';
import { matchesFilter } from './DatasetList';
import {
  datasetStatus,
  executionStatus,
  failureText,
  listItemOf,
  readableText,
  reasonText,
  recentDateTime,
} from './live-model';

const view: DatasetView = {
  id: 'digdir/kudos',
  fullId: 'digdir/kudos',
  name: 'Kudos',
  editable: false,
  state: 'external',
  index: { endpoint: 'kudos-elastic', collections: { docs: 'KUDOS_documents' } },
  source: 'none',
  documents: 45321,
  chunks: null,
  lastExecution: null,
  nextRunAt: null,
};

describe('a shared dataset ingested outside the platform in the list', () => {
  it.each(['nb', 'en'] as const)('names a Parquet source in %s', (locale) => {
    const item = listItemOf(translator(locale), createFormat(locale), {
      ...view,
      editable: true,
      state: 'ready',
      source: 'parquet',
    });

    expect(item.sourceText).toBe('Parquet');
  });

  it('says it is shared and ingested outside, names the engine and collection, and counts the documents', () => {
    const item = listItemOf(translator('nb'), createFormat('nb'), view);

    expect(item.status).toBe('Utenfor plattformen');
    expect(item.sourceText).toBe('kudos-elastic, samling KUDOS_documents');
    expect(item.docsText).toBe('45 321');
    expect(item.lastText).toBe('Ukjent, utenfor plattformen');
  });

  it('says the same in English', () => {
    const item = listItemOf(translator('en'), createFormat('en'), view);

    expect(item.sourceText).toBe('kudos-elastic, collection KUDOS_documents');
    expect(item.lastText).toBe('Unknown, outside the platform');
  });

  it('keeps the real status for a dataset the platform ingested', () => {
    const item = listItemOf(translator('nb'), createFormat('nb'), {
      ...view,
      state: 'ready',
      source: 'website',
      lastExecution: {
        status: 'succeeded',
        startedAt: '2026-10-07T10:00:00Z',
        endedAt: '2026-10-07T10:05:00Z',
        stored: 3,
        skipped: 0,
      },
    });

    expect(item.status).toBe('Klar');
    expect(item.subText).toBe('Nettsted · Delt med dere');
  });
});

describe('what a dataset in the list needs', () => {
  const own: DatasetView = { ...view, editable: true, state: 'ready', source: 'website' };

  it('counts a dataset with no source yet as needing follow-up', () => {
    const item = listItemOf(translator('nb'), createFormat('nb'), {
      ...own,
      state: 'needs-pipeline',
      source: 'none',
    });

    expect(item.status).toBe('Ikke lest inn');
    expect(item.needsSource).toBe(true);
    expect(item.note).toBe('Ingen kilde ennå');
    expect(matchesFilter('attention', item)).toBe(true);
  });

  it('shows an ingestion that skipped documents as partly ingested, with how many', () => {
    const item = listItemOf(translator('nb'), createFormat('nb'), {
      ...own,
      lastExecution: {
        status: 'succeeded',
        startedAt: '2026-10-07T10:00:00Z',
        endedAt: '2026-10-07T10:05:00Z',
        stored: 136,
        skipped: 12,
      },
    });

    expect(item.status).toBe('Delvis lest inn');
    expect(item.note).toBe('12 dokumenter ble ikke lest');
  });

  it('offers to try a failed ingestion again only for an own dataset', () => {
    const lastExecution: LastExecution = {
      status: 'failed',
      startedAt: '2026-10-07T10:00:00Z',
      endedAt: '2026-10-07T10:05:00Z',
      stored: 0,
      skipped: 0,
    };
    const mine = listItemOf(translator('nb'), createFormat('nb'), { ...own, lastExecution });
    const theirs = listItemOf(translator('nb'), createFormat('nb'), {
      ...own,
      editable: false,
      lastExecution,
    });

    expect(mine.canRetry).toBe(true);
    expect(theirs.canRetry).toBeUndefined();
  });
});

describe('an open ingestion run', () => {
  const own: DatasetView = { ...view, editable: true, state: 'ready', source: 'website' };
  const last = (status: ExecutionStatus): LastExecution => ({
    status,
    startedAt: '2026-10-07T10:00:00Z',
    endedAt: null,
    stored: null,
    skipped: null,
  });

  it.each([
    ['queued', 'I kø', 'Starter når innlesingen før er ferdig.'],
    ['running', 'Innlesing pågår', undefined],
    ['waiting', 'Venter', 'Venter på godkjenning.'],
  ] as const)('never reads a %s run as finished', (status, shown, note) => {
    const item = listItemOf(translator('nb'), createFormat('nb'), {
      ...own,
      lastExecution: last(status),
    });

    expect(item.status).toBe(shown);
    expect(item.note).toBe(note);
  });

  it.each([
    ['queued', 'I kø', 'Queued'],
    ['running', 'Pågår', 'In progress'],
    ['waiting', 'Venter', 'Waiting'],
    ['succeeded', 'Fullført', 'Completed'],
    ['failed', 'Feilet', 'Failed'],
    ['cancelled', 'Avbrutt', 'Cancelled'],
  ] as const)('names a %s run in its own words in nb and en', (status, nb, en) => {
    const run: ExecutionView = { id: 'r1', status, startedAt: '2026-10-07T10:00:00Z' };

    expect(executionStatus(translator('nb'), run).text).toBe(nb);
    expect(executionStatus(translator('en'), run).text).toBe(en);
  });
});

describe('a finished run whose counts are not known', () => {
  it('shows the counts as not available instead of as zero', () => {
    const item = listItemOf(translator('nb'), createFormat('nb'), {
      ...view,
      editable: true,
      state: 'ready',
      source: 'website',
      documents: null,
      lastExecution: {
        status: 'succeeded',
        startedAt: '2026-10-07T10:00:00Z',
        endedAt: '2026-10-07T10:05:00Z',
        stored: null,
        skipped: null,
      },
    });

    expect(item.status).toBe('Klar');
    expect(item.note).toBeUndefined();
    expect(item.docsText).toBe('Ikke tilgjengelig');
  });
});

describe("an organisation's own endpoint dataset", () => {
  const endpoint: DatasetView = {
    ...view,
    id: 'sak',
    fullId: '991825827/sak',
    scope: '991825827',
    editable: true,
    state: 'external',
    source: 'endpoint',
    index: { endpoint: '991825827/endpoint-sak' },
    documents: null,
  };

  it('is shown as its own endpoint, never as shared or with the connection id', () => {
    const item = listItemOf(translator('nb'), createFormat('nb'), endpoint);

    expect(datasetStatus(endpoint)).toBe('Eget endepunkt');
    expect(item.shared).toBe(false);
    expect(item.sourceText).toBe('Eget endepunkt');
    expect(item.subText).toBe('Eget endepunkt · Egne');
    expect(item.lastText).toBe('Søkes direkte i endepunktet');
    expect(JSON.stringify(item)).not.toContain('endpoint-sak');
  });
});

describe('a refused change', () => {
  const refused = (status: number, errors: { path: string; message: string }[]) =>
    new ApiError(status, { type: 'about:blank', title: 'Invalid request', status, errors });

  it('names the refused fields in our words, never the API message', () => {
    const error = refused(400, [
      { path: 'description', message: 'Too small: expected string to have >=1 characters' },
    ]);

    expect(failureText(translator('nb'), error)).toBe(
      'Dette ble ikke godtatt: Beskrivelse. Rett det og prøv igjen.',
    );
    expect(failureText(translator('en'), error)).toBe(
      'This was not accepted: Description. Correct it and try again.',
    );
  });

  it('falls back to a translated text for a field it does not know', () => {
    const text = failureText(translator('nb'), refused(400, [{ path: 'x.y', message: 'Invalid' }]));

    expect(text).toBe('Endringen ble ikke godtatt. Sjekk feltene og prøv igjen.');
  });

  it('uses its own words for a conflict', () => {
    const text = failureText(
      translator('en'),
      refused(409, [{ path: 'id', message: 'dataset sak exists' }]),
    );

    expect(text).not.toContain('exists');
    expect(text).toContain('Reload the page');
  });
});

describe('a file skipped for having no readable text', () => {
  it.each(['nb', 'en'] as const)('promises no text recognition switch in %s', (locale) => {
    const text = reasonText(translator(locale), 'no_text');

    expect(text).not.toMatch(/tekstgjenkjenning|slått på|text recognition|turned on/i);
    expect(text).toMatch(/skannet|scanned/);
  });
});

describe('dates in the dataset list', () => {
  const now = new Date('2026-11-19T10:00:00Z');

  it('leaves out the year for a date in the current year', () => {
    expect(recentDateTime(createFormat('nb'), '2026-11-15T01:00:00Z', now)).toBe(
      '15. november kl. 02:00',
    );
    expect(recentDateTime(createFormat('en'), '2026-11-15T01:00:00Z', now)).toBe(
      '15 November, 02:00',
    );
  });

  it('keeps the year for a date in another year', () => {
    expect(recentDateTime(createFormat('nb'), '2025-11-15T01:00:00Z', now)).toBe(
      '15. november 2025 kl. 02:00',
    );
  });
});

describe('document text in the panel', () => {
  it('turns a markdown table into lines of cells and drops the rule row', () => {
    expect(readableText('| Post | Beløp |\n|---|:--:|\n| Drift | 100 |')).toBe(
      'Post · Beløp\nDrift · 100',
    );
  });

  it('shortens dot leaders in a table of contents', () => {
    expect(readableText('Innledning.............3')).toBe('Innledning … 3');
  });

  it('reads a long adversarial line in linear time', () => {
    const line = `|${' |-'.repeat(50_000)}x`;
    const started = performance.now();
    readableText(`${line}\n${'.'.repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
