import { describe, expect, it } from 'vitest';
import type { DatasetView } from '../../api/datasets';
import { createFormat } from '@genai/i18n';
import { translator } from '../../i18n';
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
    expect(item.sourceText).toBe('Nettsted, delt med dere');
  });
});
