import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { blockRuntime, blockRuntimePath } from './block-frame-runtime.js';

interface FakePort {
  sent: unknown[];
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

const fakePort = (): FakePort => {
  const port: FakePort = {
    sent: [],
    onmessage: null,
    postMessage: (message) => port.sent.push(message),
  };
  return port;
};

const frame = (options: { top?: boolean } = {}) => {
  const posted: { message: unknown; target: string; transfer: unknown[] }[] = [];
  const set: Record<string, string> = {};
  const ports: FakePort[] = [];
  const parent = {
    postMessage: (message: unknown, target: string, transfer: unknown[] = []) =>
      posted.push({ message, target, transfer }),
  };
  class MessageChannel {
    port1 = fakePort();
    port2 = fakePort();
    constructor() {
      ports.push(this.port1, this.port2);
    }
  }
  const window: Record<string, unknown> = { addEventListener: () => undefined };
  window.parent = options.top ? window : parent;
  window.window = window;
  const document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => (set[name] = value) },
      setAttribute: () => undefined,
    },
  };
  runInNewContext(blockRuntime, { window, document, console, Object, Math, MessageChannel });
  const genki = window.genki as {
    onRender(cb: (view: unknown) => void): void;
    emit(name: string, payload: unknown): void;
    resize(height: number): void;
  };
  const own = ports[0];
  const send = (data: unknown) => own?.onmessage?.({ data });
  return { genki, posted, set, send, own, given: ports[1] };
};

const render = (extra: Record<string, unknown> = {}) => ({
  genki: 1,
  type: 'render',
  state: 'filled',
  locale: 'nb',
  colorScheme: 'light',
  theme: {},
  props: {},
  texts: {},
  data: { question: { text: 'Hva er klarspråk?' } },
  ...extra,
});

describe('the runtime in a block frame', () => {
  it('hands its parent one private channel before the bundle runs, and nothing else', () => {
    const { posted, given } = frame();

    expect(posted).toEqual([
      { message: { genki: 1, type: 'ready' }, target: '*', transfer: [given] },
    ]);
  });

  it('does nothing outside a frame', () => {
    const { posted, genki } = frame({ top: true });

    expect(posted).toEqual([]);
    expect(genki).toBeUndefined();
  });

  it('takes a render only on its own channel', () => {
    const { genki, send } = frame();
    const seen: unknown[] = [];
    genki.onRender((view) => seen.push(view));

    send(render());

    expect(seen).toEqual([
      {
        state: 'filled',
        locale: 'nb',
        colorScheme: 'light',
        props: {},
        texts: {},
        data: { question: { text: 'Hva er klarspråk?' } },
      },
    ]);
  });

  it('drops a render of the wrong shape', () => {
    const { genki, send } = frame();
    const seen: unknown[] = [];
    genki.onRender((view) => seen.push(view));

    for (const data of [
      'render',
      null,
      render({ genki: 2 }),
      render({ type: 'ready' }),
      render({ data: 'ikke et objekt' }),
      render({ theme: [] }),
    ])
      send(data);

    expect(seen).toHaveLength(0);
  });

  it('gives a renderer added after the first render the latest one', () => {
    const { genki, send } = frame();
    send(render());
    const seen: unknown[] = [];

    genki.onRender((view) => seen.push(view));

    expect(seen).toHaveLength(1);
  });

  it('sends events only on its channel and only after the first render', () => {
    const { genki, posted, send, own } = frame();

    genki.emit('notify', { text: 'før' });
    send(render());
    genki.emit('notify', { text: 'etter' });

    expect(posted).toHaveLength(1);
    expect(own?.sent).toEqual([
      { genki: 1, type: 'event', name: 'notify', payload: { text: 'etter' } },
    ]);
  });

  it('clamps a resize to 2,000 pixels', () => {
    const { genki, own } = frame();

    genki.resize(99_999);

    expect(own?.sent).toEqual([{ genki: 1, type: 'resize', height: 2000 }]);
  });

  it('sets only Designsystemet theme values that cannot load anything', () => {
    const { set, send } = frame();

    send(
      render({
        theme: {
          '--ds-color-accent-base-default': '#0062ba',
          '--ds-border-radius-md': 'url(https://evil.example/x)',
          '--evil': 'red',
        },
      }),
    );

    expect(set).toEqual({ '--ds-color-accent-base-default': '#0062ba' });
  });

  it('is served at an address that holds its own hash, so a change never hits a stale cache', () => {
    const hash = createHash('sha256').update(blockRuntime, 'utf8').digest('hex');

    expect(blockRuntimePath).toBe(`/runtime/${hash.slice(0, 16)}.js`);
  });
});
