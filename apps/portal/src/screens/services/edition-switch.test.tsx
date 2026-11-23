// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari } from '../../test-utils';

afterEach(cleanup);

const header = () =>
  screen.getByRole('heading', { level: 1, name: 'Rapportassistenten' }).closest('header');

describe('switching between the test edition and I bruk', () => {
  it('still counts the test edition changes after the owner has looked at I bruk', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/definition';
    const base = mockFetch();
    let saved = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await base(input, init);
      if (init?.method === 'PUT' && String(input).endsWith('/draft')) saved = response.ok;
      return response;
    };
    render(<App auth={auth} fetch={fetch} live />);
    const editor = (await screen.findByLabelText(
      'Teknisk tekst',
      {},
      { timeout: 8000 },
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: editor.value.replace(/purpose: .*/, "purpose: 'Svarer kort.'") },
    });
    await waitFor(() => expect(saved).toBe(true), { timeout: 5000 });

    window.location.hash = '#/services/rapportassistenten';
    await waitFor(() => expect(header()?.textContent).toMatch(/endring er ikke publisert/), {
      timeout: 5000,
    });
    window.location.hash = '#/services/rapportassistenten?edition=in-use';
    await waitFor(() => expect(header()?.textContent).toMatch(/^.*Det brukerne har nå/), {
      timeout: 5000,
    });
    window.location.hash = '#/services/rapportassistenten';
    await waitFor(() => expect(header()?.textContent).toMatch(/endring er ikke publisert/), {
      timeout: 5000,
    });
  }, 30000);
});
