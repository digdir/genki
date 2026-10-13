// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PlaygroundOptions,
  PlaygroundRunRequest,
  TestCaseCandidateRequest,
} from '../../api/playground';
import { examplePlaygroundOptions } from '../../data/playground';
import { mockFetch } from '../../mock';
import type { PlaygroundMockOptions } from '../../mock/playground';
import { expectAccessible, renderAt } from '../../test-utils';
import {
  PlaygroundPanel,
  type PlaygroundPanelProps,
  type PlaygroundState,
} from './PlaygroundPanel';

const setWidth = (px: number) => {
  window.innerWidth = px;
  window.dispatchEvent(new Event('resize'));
};

afterEach(() => {
  cleanup();
  setWidth(1024);
  localStorage.clear();
});

const withPlayground = (playground: PlaygroundMockOptions, seen: string[] = []) => {
  const base = mockFetch(undefined, undefined, undefined, undefined, {
    features: { playground },
  });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(`${init?.method ?? 'GET'} ${url}`);
    return base(input, init);
  };
  return fetch;
};

const openPage = async (playground: PlaygroundMockOptions = {}, seen: string[] = []) => {
  await renderAt('#/playground', withPlayground(playground, seen));
  return screen.findByRole('textbox', { name: 'Spørsmål' });
};

const askSample = (question: string) => {
  fireEvent.click(screen.getByRole('button', { name: question }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

const renderPanel = async (props: PlaygroundPanelProps) => {
  render(
    <main>
      <h1>Testside</h1>
      <PlaygroundPanel tenantName="Testetaten" {...props} />
    </main>,
  );
  await screen.findByRole('button', { name: /sammenlign/i });
};

describe('Prøveområde', () => {
  it('Enter sends and Shift+Enter adds a line', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const input = await openPage({ runs });

    fireEvent.change(input, { target: { value: 'Hva sier evalueringene om digital veiledning?' } });
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(runs).toHaveLength(0);

    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByRole('link', { name: 'Se kjøringen' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toEqual({ text: 'Hva sier evalueringene om digital veiledning?' });
    expect(runs[0]?.setup.service).toEqual({ id: 'rapportassistenten', version: 'draft' });
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(/Søkemerknad:/).closest('p')?.textContent).toContain(
      '3 dokumenter ble hoppet over i søket',
    );
    expect(screen.getByText(/Denne økten: 1 kjøring ·/)).toBeTruthy();
    expectAccessible();
  });

  it('Sammenlign has aria-pressed and shows two answers', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await openPage({ runs });

    const compare = screen.getByRole('button', { name: 'Sammenlign' });
    expect(compare.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(compare);
    expect(
      screen.getByRole('button', { name: 'Avslutt sammenligning' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('group', { name: 'Oppsett B' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål til begge oppsettene' }), {
      target: { value: 'Hva sier evalueringene om digital veiledning?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    const labels = screen.getAllByRole('article').map((a) => a.firstElementChild?.textContent);
    expect(labels[0]).toMatch(/^A · Borealis-27B/);
    expect(labels[1]).toMatch(/^B · Qwen3\.8-27B/);
    expect(runs[0]?.compareWith?.model).toBe('aivar/qwen3-8');
    expect(screen.getByText(/Denne økten: 2 kjøringer/)).toBeTruthy();
    expectAccessible();
  });

  it('Lagre som testtilfelle sends a candidate, not a case', async () => {
    const candidates: TestCaseCandidateRequest[] = [];
    const seen: string[] = [];
    await openPage({ candidates }, seen);
    askSample('Hva sier evalueringene om digital veiledning?');
    fireEvent.click(await screen.findByRole('button', { name: 'Lagre som testtilfelle' }));

    const expected = screen.getByRole('textbox', { name: 'Forventet svar' }) as HTMLTextAreaElement;
    expect(expected.value).toContain('Evalueringene peker på tre ting');
    fireEvent.change(expected, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send forslaget' }));
    expect(screen.getByText('Fyll ut både spørsmål og forventet svar.')).toBeTruthy();
    expect(expected.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(expected, { target: { value: 'Tre funn med kilder fra Kudos.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send forslaget' }));

    expect(
      await screen.findByText(/Det blir et testtilfelle når eieren av testsettet godtar det/),
    ).toBeTruthy();
    expect(candidates).toEqual([
      expect.objectContaining({
        question: 'Hva sier evalueringene om digital veiledning?',
        answer: 'Tre funn med kilder fra Kudos.',
        testSet: 'rapport-sporsmal',
        service: 'rapportassistenten',
        origin: 'playground',
        task: expect.stringMatching(/^tp/),
      }),
    ]);
    const writes = seen.filter((s) => !s.startsWith('GET'));
    expect(writes.some((s) => s.includes('/tenants/999888777/testcase-candidates'))).toBe(true);
    expect(writes.some((s) => /test-sets|\/cases/.test(s))).toBe(false);
    expectAccessible();
  });

  it('a not-allowed model shows the rule and disables Bruk oppsettet', async () => {
    await renderPanel({ layout: 'full', state: 'not-allowed' });

    const gpt5 = screen.getByRole('radio', { name: /GPT-5 \(OpenAI\)/ }) as HTMLInputElement;
    expect(gpt5.checked).toBe(true);
    const heading = screen.getByRole('heading', { name: 'GPT-5 kan ikke brukes hos Testetaten' });
    const alert = heading.parentElement ?? heading;
    expect(alert.textContent).toContain('«Tillatt datalagring», som Digdir eier');
    expect(within(alert).getByRole('link', { name: 'Se innstillingen' })).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Bruk oppsettet' });
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(apply);
    expect(screen.getByRole('button', { name: 'Bruk oppsettet' })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /GPT-4\.1/ }));
    expect(screen.getByRole('heading', { name: 'GPT-4.1 krever godkjenning' })).toBeTruthy();
    expect(screen.getByText('Data i EU/EØS')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: /Borealis-27B/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    expect(screen.queryByRole('button', { name: 'Bruk oppsettet' })).toBeNull();
  });

  it('the side panel is modal under 760 px', async () => {
    setWidth(600);
    const onClose = vi.fn();
    await renderPanel({ layout: 'side', context: 'dataset', name: 'Kudos-rapporter', onClose });

    const panel = screen.getByRole('dialog', { name: 'Prøv' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.inset).toMatch(/^0(px)?$/);
    expect(screen.getByText('Søk og svar med Kudos-rapporter')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Datasett: Kudos-rapporter' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();

    setWidth(1024);
    await renderPanel({ layout: 'side', context: 'skill', name: 'Skrive vedtaksbrev', onClose });
    const wide = screen.getByRole('dialog', { name: 'Prøv' });
    expect(wide.getAttribute('aria-modal')).toBe('false');
    expect(wide.style.position).toBe('');
    expect(
      screen.getByText('Med ferdigheten Skrive vedtaksbrev slik den er i siste publiserte versjon'),
    ).toBeTruthy();
  });

  it('names the skill by the given title and suggests no Kudos questions outside the Kudos example', async () => {
    await renderPanel({
      layout: 'side',
      context: 'skill',
      name: 'klarsprak',
      title: 'Klarspråk i vedtak',
    });

    expect(
      screen.getByText('Med ferdigheten Klarspråk i vedtak slik den er i siste publiserte versjon'),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Hva sier evalueringene om digital veiledning?' }),
    ).toBeNull();
  });

  it('an empty question is not sent', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const input = await openPage({ runs });

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(runs).toHaveLength(0);
  });

  it('the error state offers Prøv igjen and says nothing was stored', async () => {
    await renderPanel({ layout: 'full', state: 'error' });

    expect(screen.getByRole('heading', { name: 'Vi fikk ikke svar fra modellen' })).toBeTruthy();
    expect(screen.getByText(/Det er ikke noe galt med oppsettet\./)).toBeTruthy();
    expect(
      screen.getByText(/Ingenting er lagret, og kjøringen er ikke telt i kvoten\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('link', { name: 'Se kjøringen' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Vi fikk ikke svar fra modellen' })).toBeNull();
  });

  it('a failed run from the API shows the error and Prøv igjen runs it again', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await openPage({ runs, failRuns: 1 });
    askSample('Hva sier evalueringene om digital veiledning?');

    expect(
      await screen.findByRole('heading', { name: 'Vi fikk ikke svar fra modellen' }),
    ).toBeTruthy();
    expect(screen.getByText(/Borealis-27B svarte ikke\./)).toBeTruthy();
    expect(screen.getByText(/Kjøringer teller med i kvoten/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('link', { name: 'Se kjøringen' })).toBeTruthy();
    expect(runs).toHaveLength(2);
  });

  it('a run that failed in a step says so, with the error, instead of blaming the model', async () => {
    await openPage({
      failRuns: 1,
      failure: {
        code: 'strategy_error',
        step: 'finn',
        title: 'Steget «finn» feilet. Tjenesten feilet underveis.',
        detail: 'step finn failed: input.aar is required',
        runId: 'r-8c21',
      },
    });
    askSample('Hva sier evalueringene om digital veiledning?');

    expect(await screen.findByRole('heading', { name: 'Kjøringen feilet' })).toBeTruthy();
    expect(screen.getByText('Steget «finn» feilet.').tagName).toBe('STRONG');
    expect(screen.getByText(/Tjenesten feilet underveis\./)).toBeTruthy();
    expect(screen.getByText('Teknisk melding')).toBeTruthy();
    expect(document.querySelector('.run-failure-detail')?.textContent).toBe(
      'step: finn\nerror: strategy_error\nmessage: step finn failed: input.aar is required\nrun: r-8c21',
    );
    expect(screen.getByRole('link', { name: 'Se kjøringen i Logg' }).getAttribute('href')).toBe(
      '#/log/r-8c21',
    );
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
    expect(screen.queryByText(/svarte ikke/)).toBeNull();
  });

  it('a step failure without the error text shows no Teknisk melding', async () => {
    await openPage({
      failRuns: 1,
      failure: {
        code: 'strategy_error',
        step: 'finn',
        title: 'Steget «finn» feilet. Tjenesten feilet underveis.',
      },
    });
    askSample('Hva sier evalueringene om digital veiledning?');

    expect(await screen.findByRole('heading', { name: 'Kjøringen feilet' })).toBeTruthy();
    expect(screen.queryByText('Teknisk melding')).toBeNull();
  });

  it('extraction sends the sample file and shows the fields', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await renderAt('#/playground', withPlayground({ runs }));
    fireEvent.click(await screen.findByRole('button', { name: 'Endre oppsett' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Et eget oppsett' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Hent ut opplysninger fra et dokument' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));

    expect(screen.getByText('Last opp et dokument for å prøve uttrekket')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk en eksempelfil' }));
    expect(screen.getByText('Valgt: Søknad_2025_007.pdf')).toBeTruthy();
    const [extract] = screen
      .getAllByRole('button', { name: 'Hent ut opplysninger' })
      .filter((b) => !b.closest('[role="group"]'));
    expect(extract).toBeTruthy();
    if (extract) fireEvent.click(extract);

    expect(await screen.findByText('Søkers navn')).toBeTruthy();
    expect(runs[0]?.input).toEqual({ file: { name: 'Søknad_2025_007.pdf', sample: true } });
    expect(runs[0]?.setup.output).toBe('fields');
    expectAccessible();
  });

  it('Vis API-kall shows the run call the API has', async () => {
    await openPage();
    const [showCall] = screen.getAllByRole('button', { name: 'Vis API-kall' });
    if (showCall) fireEvent.click(showCall);
    const panel = screen.getByRole('dialog', { name: 'Kjør oppsettet' });
    expect(within(panel).getByText('/tenants/999888777/playground/runs')).toBeTruthy();
    expect(within(panel).queryByText('Ikke bestemt')).toBeNull();
    expect(within(panel).getByText(/Administrere tjenester/)).toBeTruthy();
  });

  it('runs options, run, compare and save as test case against the API shapes', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const candidates: TestCaseCandidateRequest[] = [];
    const seen: string[] = [];
    const options: PlaygroundOptions = {
      services: [
        {
          id: 'svar',
          name: 'Svar',
          latestVersion: 2,
          versions: [
            {
              version: 2,
              draft: false,
              inUse: true,
              setup: {
                model: 'aivar/borealis-27b',
                datasets: ['digdir/kudos'],
                skills: ['klarsprak@1'],
                blocks: ['pii'],
                output: 'text',
              },
            },
          ],
        },
      ],
      models: [
        {
          id: 'aivar/borealis-27b',
          name: 'Borealis-27B',
          dataLocation: 'norway',
          status: 'allowed',
        },
        { id: 'aivar/qwen3-8', name: 'Qwen3.8-27B', dataLocation: 'norway', status: 'allowed' },
      ],
      datasets: [
        { id: 'digdir/kudos', name: 'Kudos-rapporter', dataLocation: 'norway', status: 'allowed' },
      ],
      skills: [{ id: 'klarsprak', name: 'Klarspråk', version: 1, ref: 'klarsprak@1' }],
      blocks: [{ id: 'pii', name: 'pii', kind: 'guardrail', status: 'allowed' }],
      testSets: [{ id: 'svar-sporsmal', name: 'Spørsmål til svar', cases: 3, service: 'svar' }],
      outputs: ['text', 'fields'],
      quota: { usedPercent: 12, monthlyTokens: 50_000_000 },
    };
    await openPage({ options, runs, candidates }, seen);

    expect(screen.getByRole('button', { name: 'Tjeneste: Svar, versjon 2 (i bruk)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ferdighet: Klarspråk' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sammenlign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Spørsmål til begge oppsettene' }), {
      target: { value: 'Hva sier evalueringene om digital veiledning?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
    expect(runs[0]).toEqual({
      setup: {
        service: { id: 'svar', version: 2 },
        model: 'aivar/borealis-27b',
        datasets: ['digdir/kudos'],
        skills: ['klarsprak@1'],
        blocks: ['pii'],
        output: 'text',
      },
      compareWith: expect.objectContaining({ model: 'aivar/qwen3-8' }),
      input: { text: 'Hva sier evalueringene om digital veiledning?' },
    });
    const [first] = screen.getAllByRole('article');
    expect(
      within(first as HTMLElement)
        .getByText(/^Evaluering av digital veiledning i Testetaten \(2023\)/)
        .closest('li')?.textContent,
    ).toBe(
      'Evaluering av digital veiledning i Testetaten (2023) · Kudos-rapporter, side 12 [1] [2] [3]',
    );
    expect(within(first as HTMLElement).getByText('Norge')).toBeTruthy();

    const [saveA] = screen.getAllByRole('button', { name: 'Lagre som testtilfelle' });
    if (saveA) fireEvent.click(saveA);
    expect((screen.getByRole('combobox', { name: 'Testsett' }) as HTMLSelectElement).value).toBe(
      'svar-sporsmal',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send forslaget' }));

    expect(
      await screen.findByText(/Forslaget er lagt til i «Svar · Spørsmål til svar/),
    ).toBeTruthy();
    expect(candidates).toEqual([
      {
        task: expect.stringMatching(/^tp/),
        question: 'Hva sier evalueringene om digital veiledning?',
        answer: expect.stringContaining('Evalueringene peker på tre ting'),
        testSet: 'svar-sporsmal',
        service: 'svar',
        origin: 'playground',
      },
    ]);
    expect(seen.filter((s) => s.startsWith('POST'))).toEqual([
      'POST /api/tenants/999888777/playground/runs/stream',
      'POST /api/tenants/999888777/testcase-candidates',
    ]);
  });

  it('a used-up quota shows the message from the API', async () => {
    await openPage({ quotaExhausted: true });
    askSample('Hva sier evalueringene om digital veiledning?');

    expect(await screen.findByRole('heading', { name: 'Vi fikk ikke svar' })).toBeTruthy();
    expect(screen.getByText(/^Kvoten for måneden er brukt opp\./)).toBeTruthy();
  });

  it('starts on the first service exposed for chat, not the first in the list', async () => {
    const options = structuredClone(examplePlaygroundOptions);
    options.services.sort((x) => (x.chat ? 1 : -1));
    expect(options.services[0]?.chat).toBeFalsy();
    await openPage({ options });

    expect(screen.getByRole('button', { name: /^Tjeneste: Rapportassistenten, / })).toBeTruthy();
  });

  it('a sample question fills the question field and sends nothing until Send is pressed', async () => {
    const runs: PlaygroundRunRequest[] = [];
    const input = (await openPage({ runs })) as HTMLTextAreaElement;
    fireEvent.click(
      screen.getByRole('button', { name: 'Hva sier evalueringene om digital veiledning?' }),
    );

    expect(input.value).toBe('Hva sier evalueringene om digital veiledning?');
    expect(document.activeElement).toBe(input);
    expect(runs).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('link', { name: 'Se kjøringen' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toEqual({ text: 'Hva sier evalueringene om digital veiledning?' });
  });

  it('shows sample questions from the service definition and none when it has no examples', async () => {
    const options = structuredClone(examplePlaygroundOptions);
    const chat = options.services.find((s) => s.chat);
    if (chat) chat.exampleQuestions = ['Hva er fristen for søknad?'];
    await openPage({ options });
    expect(screen.getByRole('button', { name: 'Hva er fristen for søknad?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /evalueringene/ })).toBeNull();
    cleanup();

    if (chat) delete chat.exampleQuestions;
    await openPage({ options });
    expect(screen.queryByRole('button', { name: /fristen|evalueringene|ventetid/ })).toBeNull();
  });

  it('a run the API refuses shows the rule it gave', async () => {
    const options = structuredClone(examplePlaygroundOptions);
    for (const version of options.services[0]?.versions ?? []) version.setup.model = 'openai/gpt-5';
    await openPage({ options });
    askSample('Hva sier evalueringene om digital veiledning?');

    expect(await screen.findByRole('heading', { name: 'Vi fikk ikke svar' })).toBeTruthy();
    expect(
      screen.getByText(/^GPT-5 kan ikke brukes i dette oppsettet\. Regelen er at data skal/),
    ).toBeTruthy();
  });

  it('an uploaded document is sent as base64 with its name and type', async () => {
    const runs: PlaygroundRunRequest[] = [];
    await renderAt('#/playground', withPlayground({ runs }));
    fireEvent.click(await screen.findByRole('button', { name: 'Endre oppsett' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Et eget oppsett' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Hent ut opplysninger fra et dokument' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    const upload = new File(['Søker: Eksempel IL'], 'søknad.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Dokument'), { target: { files: [upload] } });
    const [extract] = screen
      .getAllByRole('button', { name: 'Hent ut opplysninger' })
      .filter((b) => !b.closest('[role="group"]'));
    if (extract) fireEvent.click(extract);

    expect(await screen.findByText('Søkers navn')).toBeTruthy();
    expect(runs[0]?.input).toEqual({
      file: {
        name: 'søknad.txt',
        mediaType: 'text/plain',
        data: btoa(String.fromCharCode(...new TextEncoder().encode('Søker: Eksempel IL'))),
      },
    });
  });

  it.each<PlaygroundState>(['empty', 'answer', 'compare', 'quota', 'not-allowed', 'error'])(
    'the %s state is accessible',
    async (state) => {
      await renderPanel({ layout: 'full', state });
      if (state === 'quota') expect(screen.getByText('Kvoten er nesten brukt opp.')).toBeTruthy();
      if (state === 'compare') expect(screen.getAllByRole('article')).toHaveLength(2);
      if (state === 'answer') expect(screen.getAllByRole('article')).toHaveLength(1);
      expectAccessible();
    },
  );
});
