// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { BlockData } from '@genai/contracts/block-fields';
import type { RefBlockPayload } from '@genai/contracts/blocks';
import { fromTemplate, type AssistantLayout, type PlacedBlock } from '@genai/ui-blocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantApi } from './api.js';
import { Assistant } from './Assistant.js';
import { CodeBlock } from './code-block.js';
import { RefBlock } from './ref-block.js';

const ref = '889640782/figur@2';
const frameUrl = `https://blocks.example.test/frame/889640782/figur/2/${'a'.repeat(64)}`;

const payload = (extra: Partial<RefBlockPayload> = {}): RefBlockPayload => ({
  ref,
  tier: 'code',
  publisher: '889640782',
  publisherName: 'Nav',
  title: { nb: 'Figur i svaret', en: 'Figure in the answer' },
  zones: ['main', 'secondary'],
  events: ['ask', 'open-document', 'notify'],
  states: ['filled'],
  reads: ['question.text', 'sources.index'],
  frame: { url: frameUrl, sha256: 'a'.repeat(64) },
  ...extra,
});

const data: BlockData = {
  question: { text: 'Hva er klarspråk?' },
  sources: [{ index: 1, title: 'Klarspråk' }],
};

const frameOf = () => screen.getByTitle('Figur i svaret') as HTMLIFrameElement;

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const fakePort = (): FakePort => ({ onmessage: null, postMessage: vi.fn(), close: vi.fn() });

const hello = (
  options: { source?: unknown; origin?: string; data?: unknown; ports?: unknown[] } = {},
) => {
  const port = fakePort();
  act(() => {
    const event = new MessageEvent('message', {
      data: options.data ?? { genki: 1, type: 'ready' },
      origin: options.origin ?? 'null',
      source: (options.source ?? frameOf().contentWindow) as MessageEventSource,
    });
    Object.defineProperty(event, 'ports', { value: options.ports ?? [port] });
    window.dispatchEvent(event);
  });
  return port;
};

const fromPort = (port: FakePort, message: unknown) =>
  act(() => {
    port.onmessage?.({ data: message });
  });

const connect = () => hello();
const ask = (port: FakePort, question = 'Hva betyr det?') =>
  fromPort(port, { genki: 1, type: 'event', name: 'ask', payload: { question } });
const loaded = () => act(() => void frameOf().dispatchEvent(new Event('load')));
const rendered = (port: FakePort) => {
  act(() => void vi.advanceTimersByTime(150));
  return port.postMessage.mock.calls as [{ type: string; data: BlockData }][];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('a code block in the host', () => {
  it('frames the block with scripts only, and no network, top navigation, popups or same origin', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" />);

    const frame = frameOf();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe(frameUrl);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('allow')).toBe('');
  });

  it('gives the frame its title from the block', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" locale="en" />);

    expect(screen.getByTitle('Figure in the answer')).toBeTruthy();
  });

  it('takes a channel only from its own frame, with an opaque origin, and only once', () => {
    const onAsk = vi.fn();
    render(<CodeBlock payload={payload()} data={data} state="filled" handlers={{ onAsk }} />);

    const fromWindow = hello({ source: window });
    const fromOrigin = hello({ origin: 'https://blocks.example.test' });
    const malformed = hello({ data: { genki: 1, type: 'ready', extra: true } });
    const own = connect();
    const later = connect();
    for (const port of [fromWindow, fromOrigin, malformed, later]) ask(port, 'x');
    ask(own);

    expect(onAsk.mock.calls).toEqual([['Hva betyr det?']]);
  });

  it('takes nothing from the frame window itself, only from its channel', () => {
    const onAsk = vi.fn();
    render(<CodeBlock payload={payload()} data={data} state="filled" handlers={{ onAsk }} />);
    connect();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { genki: 1, type: 'event', name: 'ask', payload: { question: 'x' } },
          origin: 'null',
          source: frameOf().contentWindow as MessageEventSource,
        }),
      );
    });

    expect(onAsk).not.toHaveBeenCalled();
  });

  it('drops a malformed message on its channel', () => {
    const onAsk = vi.fn();
    render(<CodeBlock payload={payload()} data={data} state="filled" handlers={{ onAsk }} />);
    const port = connect();

    fromPort(port, {
      genki: 1,
      type: 'event',
      name: 'ask',
      payload: { question: 'x', send: true },
    });
    fromPort(port, 'ask');

    expect(onAsk).not.toHaveBeenCalled();
  });

  it('drops an event the block did not declare', () => {
    const onAsk = vi.fn();
    render(
      <CodeBlock
        payload={payload({ events: ['notify'] })}
        data={data}
        state="filled"
        handlers={{ onAsk }}
      />,
    );

    ask(connect());

    expect(onAsk).not.toHaveBeenCalled();
  });

  it('drops a message over 8 KiB and those beyond 20 a second', () => {
    const onSetFilter = vi.fn();
    render(
      <CodeBlock
        payload={payload({ events: ['set-filter'] })}
        data={data}
        state="filled"
        handlers={{ onSetFilter }}
      />,
    );
    const port = connect();
    const filter = (size: number) =>
      fromPort(port, {
        genki: 1,
        type: 'event',
        name: 'set-filter',
        payload: { field: 'type', values: Array.from({ length: 50 }, () => 'x'.repeat(size)) },
      });

    filter(200);
    filter(100);
    expect(onSetFilter).toHaveBeenCalledTimes(1);
    expect(onSetFilter.mock.calls[0]?.[1][0]).toHaveLength(100);

    act(() => void vi.advanceTimersByTime(1_000));
    for (let i = 0; i < 25; i++) filter(10);
    expect(onSetFilter).toHaveBeenCalledTimes(21);

    act(() => void vi.advanceTimersByTime(1_000));
    filter(10);
    expect(onSetFilter).toHaveBeenCalledTimes(22);
  });

  it('puts at most one ask a second in the composer', () => {
    const onAsk = vi.fn();
    render(<CodeBlock payload={payload()} data={data} state="filled" handlers={{ onAsk }} />);
    const port = connect();

    for (let i = 0; i < 10; i++) ask(port, `spørsmål ${i}`);
    expect(onAsk.mock.calls).toEqual([['spørsmål 0']]);

    act(() => void vi.advanceTimersByTime(1_000));
    ask(port, 'etter et sekund');
    expect(onAsk).toHaveBeenLastCalledWith('etter et sekund');
  });

  it('counts resizes apart from events, so a block that resizes often still gets its events through', () => {
    const onAsk = vi.fn();
    render(<CodeBlock payload={payload()} data={data} state="filled" handlers={{ onAsk }} />);
    const port = connect();

    for (let i = 0; i < 30; i++) fromPort(port, { genki: 1, type: 'resize', height: 200 + i });
    ask(port);

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(frameOf().getAttribute('height')).toBe('219');
  });

  it('opens only a source the block was given', () => {
    const onOpenDocument = vi.fn();
    render(
      <CodeBlock payload={payload()} data={data} state="filled" handlers={{ onOpenDocument }} />,
    );
    const port = connect();

    for (const source of [1, 7])
      fromPort(port, { genki: 1, type: 'event', name: 'open-document', payload: { source } });

    expect(onOpenDocument.mock.calls).toEqual([[1]]);
  });

  it('sends a code block only the fields it reads, and only on its channel', () => {
    render(
      <RefBlock
        payload={payload({ reads: ['question.text'] })}
        data={{ ...data, answer: { text: 'Hemmelig svar' }, thread: { title: 'Privat' } }}
        state="filled"
      />,
    );
    const onWindow = vi.spyOn(frameOf().contentWindow as Window, 'postMessage');

    const posted = rendered(connect());

    expect(posted).toHaveLength(1);
    expect(posted[0]?.[0]).toMatchObject({ genki: 1, type: 'render', state: 'filled' });
    expect(posted[0]?.[0].data).toEqual({ question: { text: 'Hva er klarspråk?' } });
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('sends nothing before the frame hands over its channel', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" />);
    const onWindow = vi.spyOn(frameOf().contentWindow as Window, 'postMessage');

    act(() => void vi.advanceTimersByTime(1_000));

    expect(onWindow).not.toHaveBeenCalled();
  });

  it('keeps rendering while the data changes faster than the render interval', () => {
    const view = (text: string) => (
      <CodeBlock payload={payload()} data={{ question: { text } }} state="filled" />
    );
    const { rerender } = render(view('a'));
    const port = connect();

    for (const [i, text] of ['ab', 'abc', 'abcd', 'abcde'].entries()) {
      rerender(view(text));
      act(() => void vi.advanceTimersByTime(i === 3 ? 100 : 60));
    }

    expect(port.postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(port.postMessage.mock.lastCall?.[0]).toMatchObject({
      data: { question: { text: 'abcde' } },
    });
  });

  it('shows an error when the frame is not ready within 5 seconds of loading', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(screen.queryByText('Designelementet svarer ikke.')).toBeNull();

    loaded();
    act(() => void vi.advanceTimersByTime(5_001));

    expect(screen.getByText('Designelementet svarer ikke.')).toBeTruthy();
    expect(screen.queryByTitle('Figur i svaret')).toBeNull();
  });

  it('removes a frame that navigates away, and closes its channel', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" />);
    const port = connect();

    loaded();
    expect(screen.queryByText('Designelementet ble stoppet.')).toBeNull();
    loaded();

    expect(screen.getByText('Designelementet ble stoppet.')).toBeTruthy();
    expect(screen.queryByTitle('Figur i svaret')).toBeNull();
    expect(port.close).toHaveBeenCalled();
  });

  it('starts afresh when the block points to a new frame', () => {
    const second = `https://blocks.example.test/frame/889640782/figur/3/${'b'.repeat(64)}`;
    const { rerender } = render(<CodeBlock payload={payload()} data={data} state="filled" />);
    const first = connect();
    loaded();

    rerender(
      <CodeBlock
        payload={payload({ frame: { url: second, sha256: 'b'.repeat(64) } })}
        data={data}
        state="filled"
      />,
    );
    loaded();

    expect(screen.queryByText('Designelementet ble stoppet.')).toBeNull();
    expect(frameOf().getAttribute('src')).toBe(second);
    expect(first.close).toHaveBeenCalled();
  });

  it('sizes the frame from resize within 2,000 pixels', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" />);
    expect(frameOf().getAttribute('height')).toBe('120');
    const port = connect();

    fromPort(port, { genki: 1, type: 'resize', height: 480 });
    expect(frameOf().getAttribute('height')).toBe('480');

    fromPort(port, { genki: 1, type: 'resize', height: 99_999 });
    expect(frameOf().getAttribute('height')).toBe('480');
  });

  it('reads a notice from the block out politely, at most once a second', () => {
    render(<CodeBlock payload={payload()} data={data} state="filled" />);
    const port = connect();
    const notify = (text: string) =>
      fromPort(port, { genki: 1, type: 'event', name: 'notify', payload: { text } });

    notify('Kodeelementet virker');
    notify('Igjen');
    expect(screen.getByRole('status').textContent).toBe('Kodeelementet virker');

    act(() => void vi.advanceTimersByTime(1_000));
    notify('Etter et sekund');
    expect(screen.getByRole('status').textContent).toBe('Etter et sekund');
  });

  it('names the publisher under a block from another organisation only', () => {
    const { rerender } = render(
      <CodeBlock payload={payload()} data={data} state="filled" host="991825827" />,
    );
    expect(screen.getByText('Fra Nav')).toBeTruthy();

    rerender(<CodeBlock payload={payload()} data={data} state="filled" host="889640782" />);
    expect(screen.queryByText('Fra Nav')).toBeNull();
  });

  it('draws a placeholder while no block origin is set', () => {
    render(<CodeBlock payload={payload({ frame: undefined })} data={data} state="filled" />);

    expect(screen.queryByTitle('Figur i svaret')).toBeNull();
    expect(screen.getByText(`Denne verten har ingen innebygd blokk for ${ref}.`)).toBeTruthy();
  });
});

describe('a code block in the assistant', () => {
  const api: AssistantApi = {
    loadModels: vi.fn(async () => []),
    loadThreads: vi.fn(async () => []),
    loadThread: vi.fn(async () => ({ title: '', turns: [] })),
    loadCorpora: vi.fn(async () => []),
    loadFields: vi.fn(async () => []),
    loadFacets: vi.fn(async () => []),
    loadAbout: vi.fn(async () => undefined),
    ask: vi.fn(async function* () {}),
  };

  beforeEach(() => {
    window.matchMedia = ((media: string) => ({
      media,
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });

  it('puts an ask from a code block in the composer and never sends it', async () => {
    const layout = fromTemplate('chat-only').layout;
    const withBlock: AssistantLayout = {
      ...layout,
      zones: {
        ...layout.zones,
        secondary: [...layout.zones.secondary, { block: 'ref', ref } as unknown as PlacedBlock],
      },
    };
    render(
      <Assistant
        api={api}
        layout={withBlock}
        refBlocks={{ [ref]: payload() }}
        service="ka"
        tenant="991825827"
        profile={{ assistantName: 'KA' }}
      />,
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));

    ask(connect(), 'Hva er klarspråk i praksis?');

    const fields = screen.getAllByRole('textbox') as HTMLTextAreaElement[];
    expect(fields.some((f) => f.value === 'Hva er klarspråk i praksis?')).toBe(true);
    expect(api.ask).not.toHaveBeenCalled();
  });
});
