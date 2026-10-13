// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchEngineInfo } from '../../api/search-engines';
import { DatasetList, type DatasetListItem } from './DatasetList';
import { FilePicker } from './FilePicker';
import { EngineCapabilities } from './SearchEngine';

afterEach(cleanup);

const item = (over: Partial<DatasetListItem>): DatasetListItem => ({
  id: 'a',
  name: 'Veiledere',
  description: 'Veiledere for søkere',
  status: 'Klar',
  sourceText: 'Opplastede filer',
  docsText: '12',
  lastText: '1. oktober',
  ...over,
});

describe('datasets in English', () => {
  it('lists datasets with translated chrome and status labels', () => {
    render(
      inEnglish(
        <DatasetList
          datasets={[item({}), item({ id: 'b', name: 'Nettsider', status: 'Feilet' })]}
        />,
      ),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Datasets' })).toBeTruthy();
    expect(screen.getByText('1 dataset needs attention: Nettsider.')).toBeTruthy();
    expect(screen.getByText('Showing 2 of 2 datasets')).toBeTruthy();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'New dataset' })).toBeTruthy();
  });

  it('explains the file picker in English', () => {
    render(inEnglish(<FilePicker id="f" onFiles={() => undefined} />));
    expect(screen.getByText('Choose files')).toBeTruthy();
    expect(screen.getByText(/Or drag the files here/)).toBeTruthy();
  });

  it('names what a search engine can and cannot do', () => {
    const engine = { capabilities: ['text_search'] } as unknown as SearchEngineInfo;
    render(inEnglish(<EngineCapabilities engine={engine} />));
    expect(screen.getByText('Text search')).toBeTruthy();
    expect(screen.getByText('Combined search')).toBeTruthy();
    expect(screen.getAllByText('Cannot').length).toBeGreaterThan(0);
  });
});
