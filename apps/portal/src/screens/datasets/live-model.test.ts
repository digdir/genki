import { describe, expect, it } from 'vitest';
import type { DatasetView } from '../../api/datasets';
import { createFormat } from '@genai/i18n';
import { translator } from '../../i18n';
import { matchesFilter } from './DatasetList';
import { listItemOf } from './live-model';

const view: DatasetView = {
  id: 'digdir/kudos',
  fullId: 'digdir/kudos',
  name: 'Kudos',
  editable: false,
  state: 'external',
  index: { endpoint: 'kudos-typesense', collections: { docs: 'KUDOS_documents' } },
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
    expect(item.sourceText).toBe('kudos-typesense, samling KUDOS_documents');
    expect(item.docsText).toBe('45 321');
    expect(item.lastText).toBe('Ukjent, utenfor plattformen');
  });

  it('says the same in English', () => {
    const item = listItemOf(translator('en'), createFormat('en'), view);

    expect(item.sourceText).toBe('kudos-typesense, collection KUDOS_documents');
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
        stored: 136,
        skipped: 12,
      },
    });

    expect(item.status).toBe('Delvis lest inn');
    expect(item.note).toBe('12 dokumenter ble ikke lest');
  });

  it('offers to try a failed ingestion again only for an own dataset', () => {
    const lastExecution = {
      status: 'failed',
      startedAt: '2026-10-07T10:00:00Z',
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
