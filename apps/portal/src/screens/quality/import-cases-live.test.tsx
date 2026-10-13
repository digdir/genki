// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { translator } from '../../i18n';
import { mockFetch } from '../../mock';
import { expectAccessible, kari } from '../../test-utils';
import { parseCaseFile } from './import-cases';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const openLive = async () => {
  const writes: { method: string; path: string; body: unknown; reason: string | null }[] = [];
  const inner = mockFetch(undefined, undefined, undefined, undefined, {
    features: { quality: {} },
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const reason = new Headers(init?.headers).get('change-reason');
    if (init?.method && init.method !== 'GET')
      writes.push({
        method: init.method,
        path: url.replace(/^\/api/, ''),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        reason: reason === null ? null : decodeURIComponent(reason),
      });
    return inner(input, init);
  };
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services/rapportassistenten/quality';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByText('Hvor mange tilsyn hadde vi i 2025?');
  return writes;
};

const choose = (name: string, text: string) => {
  const file = new File([text], name);
  Object.defineProperty(file, 'text', { value: async () => text });
  fireEvent.change(screen.getByLabelText('Fil med testtilfeller (CSV, JSON eller YAML)'), {
    target: { files: [file] },
  });
};

describe('importing test cases into a live test set', () => {
  it('lists validation errors per row and imports nothing while any row is wrong', async () => {
    const writes = await openLive();
    fireEvent.click(screen.getByRole('button', { name: 'Importer testtilfeller' }));
    choose('saker.csv', 'input,expected,type\nHei,,criteria\n,Svar,exact\nHva?,Svar,fuzzy\n');

    const alert = await screen.findByRole('alert');
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Rad 2: forventet svar eller kriterier mangler',
      'Rad 3: input mangler',
      'Rad 4: type må være criteria, exact eller must_reject',
    ]);
    expect(screen.queryByRole('button', { name: /^Importer \d/ })).toBeNull();
    expect(writes).toEqual([]);
    expectAccessible();
  });

  it('imports every case from a platform test set file with a reason naming the file', async () => {
    const writes = await openLive();
    fireEvent.click(screen.getByRole('button', { name: 'Importer testtilfeller' }));
    choose(
      'kjerne.yaml',
      [
        'apiVersion: genai/v1',
        'kind: TestSet',
        'spec:',
        '  cases:',
        '    - id: tilsyn-gebyr',
        '      split: holdout',
        '      input: Hva koster et tilsyn?',
        '      expected:',
        '        referenceAnswer: Oppgir gebyret.',
        '    - id: tilsyn-antall',
        '      split: train',
        '      input: Hvor mange tilsyn ble gjort?',
        '      expected:',
        '        answerPattern: (?i)tilsyn',
      ].join('\n'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Importer 2 testtilfeller' }));

    expect(
      await screen.findByText('2 testtilfeller er importert til Kjernespørsmål.'),
    ).toBeTruthy();
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toMatchObject({
      method: 'POST',
      path: '/tenants/999888777/test-sets/rapport-kjerne/cases',
      body: {
        id: 'tilsyn-gebyr',
        input: 'Hva koster et tilsyn?',
        expected: 'Oppgir gebyret.',
        type: 'criteria',
        split: 'locked',
      },
      reason: 'Importerte testtilfeller fra kjerne.yaml til Kjernespørsmål',
    });
    expect(writes[1]).toMatchObject({ body: { id: 'tilsyn-antall', split: 'open' } });
  });

  it('words the row errors in English on an English screen', () => {
    const t = translator('en');
    const result = parseCaseFile('cases.csv', 'input,expected\n,Answer\n');
    if (!result.ok) throw new Error(result.problem);
    const row = result.rows[0];
    expect(
      t('quality.importLine', {
        where: t('quality.importRow', { n: row?.row ?? 0 }),
        problems: t('quality.importProblem.inputMissing'),
      }),
    ).toBe('Row 2: input is missing');
  });
});
