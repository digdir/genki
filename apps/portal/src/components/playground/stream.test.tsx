// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import {
  parseSseMessage,
  readSse,
  type PlaygroundResult,
  type PlaygroundRunRequest,
  type PlaygroundStreamEvent,
} from '../../api/playground';
import { sseOf } from '../../data/playground';
import { mockFetch } from '../../mock';
import type { TimelineStep } from '../../types';
import { AnswerCard } from './AnswerCard';
import { PlaygroundPanel } from './PlaygroundPanel';
import { applyEvent, startRun } from './RunView';

document.getAnimations ??= () => [];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const encoder = new TextEncoder();

const step = (id: string, over: Partial<TimelineStep> = {}): TimelineStep => ({
  id,
  type: 'search',
  title: `Steg ${id}`,
  summary: `Oppsummering ${id}`,
  at: 0.5,
  blocks: [],
  ...over,
});

const result = (over: Partial<PlaygroundResult> = {}): PlaygroundResult => ({
  runId: 'tp-1',
  text: 'Svaret er ja [1] og nei [2].',
  sources: [
    {
      chunkId: 'c1',
      title: 'Første rapport',
      headers: ['Kapittel 2', 'Funn'],
      position: 4,
      text: 'Teksten i første kilde.',
      score: 0.91,
    },
    { chunkId: 'c2', title: 'Andre rapport', text: 'Teksten i andre kilde.' },
  ],
  citations: [
    { index: 1, chunkId: 'c1' },
    { index: 2, chunkId: 'c2' },
  ],
  searchNotes: [],
  timeMs: 1200,
  tokensIn: 100,
  tokensOut: 20,
  costNok: 0.01,
  dataLocation: 'norway',
  ...over,
});

interface Controlled {
  push(events: PlaygroundStreamEvent[]): Promise<void>;
  close(): Promise<void>;
}

const harness = () => {
  const requests: PlaygroundRunRequest[] = [];
  const streams: Controlled[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/playground/runs/stream')) return base(input, init);
    requests.push(JSON.parse(String(init?.body)) as PlaygroundRunRequest);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    streams.push({
      push: async (events) => {
        await act(async () => {
          controller.enqueue(encoder.encode(sseOf(events)));
          await new Promise((r) => setTimeout(r, 0));
        });
      },
      close: async () => {
        await act(async () => {
          controller.close();
          await new Promise((r) => setTimeout(r, 0));
        });
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'test' });
  return { api, requests, streams };
};

const ask = async (question: string, label = 'Spørsmål') => {
  fireEvent.change(await screen.findByRole('textbox', { name: label }), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

const finish = async (stream: Controlled, value: PlaygroundResult, setup = 'setup' as const) => {
  await stream.push([
    { event: 'result', setup, result: value },
    { event: 'status', setup, status: 'completed' },
    { event: 'done', quota: { usedPercent: 10, monthlyTokens: 1000 } },
  ]);
  await stream.close();
};

describe('the playground stream', () => {
  it('parses server-sent events split across chunks', async () => {
    const text = sseOf([
      { event: 'started', setup: 'setup', runId: 'tp-1', startedAt: '2026-10-09T10:00:00Z' },
      { event: 'delta', setup: 'setup', text: 'Hei', channel: 'answer' },
    ]);
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(encoder.encode(text.slice(0, 17)));
        c.enqueue(encoder.encode(text.slice(17)));
        c.close();
      },
    });
    const seen: PlaygroundStreamEvent[] = [];
    await readSse(new Response(body), (e) => seen.push(e));

    expect(seen).toEqual([
      { event: 'started', setup: 'setup', runId: 'tp-1', startedAt: '2026-10-09T10:00:00Z' },
      { event: 'delta', setup: 'setup', text: 'Hei', channel: 'answer' },
    ]);
    expect(parseSseMessage('event: ping\ndata: {}')).toBeUndefined();
  });

  it('folds events into a live run: upserts steps, appends deltas and retracts', () => {
    let run = startRun(0);
    run = applyEvent(
      run,
      { event: 'step', setup: 'setup', step: step('e1', { state: 'running' }) },
      1,
    );
    run = applyEvent(run, { event: 'step', setup: 'setup', step: step('e1') }, 2);
    run = applyEvent(run, { event: 'delta', setup: 'setup', text: 'utkast', channel: 'answer' }, 3);
    run = applyEvent(run, { event: 'retract', setup: 'setup', reason: 'discarded' }, 4);
    run = applyEvent(
      run,
      { event: 'delta', setup: 'setup', text: 'Endelig', channel: 'answer' },
      5,
    );

    expect(run.steps).toEqual([step('e1')]);
    expect(run.answer).toBe('Endelig');
    expect(applyEvent(run, { event: 'result', setup: 'setup', result: result() }, 9)).toMatchObject(
      { status: 'completed', endedAt: 9, runId: 'tp-1' },
    );
  });

  it('shows steps, reasoning and the streamed answer while the run is going, then the result', async () => {
    const { api, streams } = harness();
    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);
    await ask('Hva sier rapportene?');
    await waitFor(() => expect(streams).toHaveLength(1));
    const [stream] = streams as [Controlled];

    await stream.push([
      { event: 'started', setup: 'setup', runId: 'tp-1', startedAt: '2026-10-09T10:00:00Z' },
      {
        event: 'step',
        setup: 'setup',
        step: step('e1', {
          type: 'plan',
          title: 'Planla søket',
          summary: 'Genererte 2 søk: «a», «b»',
          raw: { queries: ['a', 'b'] },
        }),
      },
      {
        event: 'step',
        setup: 'setup',
        step: step('e2', { type: 'model', title: 'Modellkall · runde 1', state: 'running' }),
      },
      { event: 'delta', setup: 'setup', text: 'Jeg må søke først.', channel: 'reasoning' },
      {
        event: 'stats',
        setup: 'setup',
        stats: {
          iterations: 1,
          toolCalls: 3,
          chunksRead: 7,
          documents: 2,
          warnings: [],
          inputTokens: 0,
          outputTokens: 0,
          byModel: [],
        },
      },
    ]);

    expect(screen.getByText('Kjører', { selector: '.ds-tag' })).toBeTruthy();
    expect(screen.getByText('Jeg må søke først.').className).toBe('log-reasoning');
    const steps = screen.getByRole('list', { name: 'Hva skjedde' });
    expect(within(steps).getByText('Planla søket')).toBeTruthy();
    expect(within(steps).getByText('Genererte 2 søk: «a», «b»')).toBeTruthy();
    expect(
      within(steps)
        .getByRole('button', { name: /Modellkall · runde 1/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    const head = screen.getByText('Verktøykall').parentElement;
    expect(head?.textContent).toBe('Verktøykall3');

    fireEvent.click(within(steps).getByRole('button', { name: /Planla søket/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Vis rådata' }));
    expect(screen.getByText(/"queries"/)).toBeTruthy();

    await stream.push([{ event: 'delta', setup: 'setup', text: 'Et utkast', channel: 'answer' }]);
    expect(screen.getByText('Et utkast')).toBeTruthy();
    await stream.push([{ event: 'retract', setup: 'setup', reason: 'discarded' }]);
    expect(screen.queryByText('Et utkast')).toBeNull();

    await finish(stream, result({ steps: [step('e1', { title: 'Planla søket' })] }));
    expect(await screen.findByRole('link', { name: 'Se kjøringen' })).toBeTruthy();
    expect(screen.getByText('Ferdig', { selector: '.ds-tag' })).toBeTruthy();
    expect(screen.getByText('Unike dokumenter')).toBeTruthy();
  });

  it('streams both setups when comparing', async () => {
    const { api, streams } = harness();
    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sammenlign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    await ask('Hva sier rapportene?', 'Spørsmål til begge oppsettene');
    await waitFor(() => expect(streams).toHaveLength(1));
    const [stream] = streams as [Controlled];

    await stream.push([
      { event: 'step', setup: 'compareWith', step: step('e1', { title: 'Søk i B' }) },
      { event: 'step', setup: 'setup', step: step('e1', { title: 'Søk i A' }) },
    ]);
    const lists = screen.getAllByRole('list', { name: 'Hva skjedde' });
    expect(lists.map((l) => l.textContent)).toEqual([
      expect.stringContaining('Søk i A'),
      expect.stringContaining('Søk i B'),
    ]);

    await stream.push([
      { event: 'result', setup: 'compareWith', result: result({ runId: 'tp-2' }) },
    ]);
    await finish(stream, result());
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
  });

  it('turns [N] into links to a source panel with prev and next', () => {
    render(
      <AnswerCard result={result()} saveExpanded={false} onSave={() => {}} onShowCall={() => {}} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Kilde 1: Første rapport' }));
    const panel = screen.getByRole('region', { name: /Kilde 1 av 2: Første rapport/ });
    expect(within(panel).getByText('c1')).toBeTruthy();
    expect(within(panel).getByText('Kapittel 2 › Funn')).toBeTruthy();
    expect(within(panel).getByText('Del 4')).toBeTruthy();
    expect(within(panel).getByText('0,91')).toBeTruthy();
    expect(within(panel).getByText('Teksten i første kilde.')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Neste kilde' }));
    expect(screen.getByRole('region', { name: /Kilde 2 av 2: Andre rapport/ })).toBeTruthy();
  });

  it('shows the tokens per model when more than one model was used', () => {
    render(
      <AnswerCard
        result={result({
          byModel: [
            { model: 'Borealis-27B', inputTokens: 80, outputTokens: 10, costNok: 0.01 },
            { model: 'Qwen3.8-27B', inputTokens: 20, outputTokens: 10, costNok: null },
          ],
        })}
        saveExpanded={false}
        onSave={() => {}}
        onShowCall={() => {}}
      />,
    );

    const models = screen.getByRole('list', { name: 'Tokens per modell' });
    const text = (models.textContent ?? '').replace(/\u00a0/g, ' ');
    expect(text).toContain('Borealis-27B · 80 inn, 10 ut · 0,01 kr');
    expect(text).toContain('Qwen3.8-27B · 20 inn, 10 ut · Ikke priset');
  });

  it('a clarification offers choices, and a choice continues the conversation with history', async () => {
    const { api, streams, requests } = harness();
    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);
    await ask('Hva er fristen?');
    await waitFor(() => expect(streams).toHaveLength(1));
    await finish(
      streams[0] as Controlled,
      result({
        text: 'Gjelder det søknad eller klage?',
        citations: [],
        clarification: {
          question: 'Gjelder det søknad eller klage?',
          options: ['Søknad', 'Klage'],
        },
      }),
    );

    const choices = await screen.findByRole('group', { name: 'Velg et svar' });
    fireEvent.click(within(choices).getByRole('button', { name: 'Klage' }));
    await waitFor(() => expect(requests).toHaveLength(2));

    expect(requests[0]?.history).toBeUndefined();
    expect(requests[1]?.input).toEqual({ text: 'Klage' });
    expect(requests[1]?.history).toEqual([
      { role: 'user', text: 'Hva er fristen?' },
      { role: 'assistant', text: 'Gjelder det søknad eller klage?' },
    ]);
  });

  it('Ny samtale starts over without history', async () => {
    const { api, streams, requests } = harness();
    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);
    await ask('Første spørsmål');
    await waitFor(() => expect(streams).toHaveLength(1));
    await finish(streams[0] as Controlled, result());
    await screen.findByRole('link', { name: 'Se kjøringen' });

    fireEvent.click(screen.getByRole('button', { name: 'Ny samtale' }));
    expect(screen.queryByText('Første spørsmål')).toBeNull();
    await ask('Andre spørsmål');
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.history).toBeUndefined();
  });

  it('remembers the last setup for the next visit', async () => {
    const { api } = harness();
    const view = render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sammenlign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    view.unmount();

    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);
    expect(
      await screen.findByRole('textbox', { name: 'Spørsmål til begge oppsettene' }),
    ).toBeTruthy();
  });

  it('ignores a remembered setup that is no longer allowed', async () => {
    localStorage.setItem(
      'genai.playground.setup:999888777:free:',
      JSON.stringify({
        a: { model: 'openai/gpt-5', datasets: [], skills: [], blocks: [], output: 'text' },
      }),
    );
    const { api } = harness();
    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" />);

    expect(await screen.findByRole('textbox', { name: 'Spørsmål' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /GPT-5/ })).toBeNull();
  });

  it('feeds the task timeline side panel from the stream', async () => {
    const { api, streams } = harness();
    render(<PlaygroundPanel layout="full" api={api} tenant="999888777" timelinePanel />);
    const panel = await screen.findByRole('region', { name: 'Oppgavens tidslinje' });
    expect(
      within(panel).getByText(
        'Her ser du søk, kilder, modellkall og tokens når du sender et spørsmål.',
      ),
    ).toBeTruthy();

    await ask('Hva sier rapportene?');
    await waitFor(() => expect(streams).toHaveLength(1));
    await (streams[0] as Controlled).push([
      {
        event: 'step',
        setup: 'setup',
        step: step('e1', { title: 'Søk', summary: '«veiledning» · 14 treff', at: 0.6 }),
      },
    ]);

    const row = within(panel).getByText('Søk').closest('li');
    expect(row?.textContent).toBe('+0,6 sSøk«veiledning» · 14 treff');
  });
});
