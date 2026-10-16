// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { answerHtml, Atlas } from './screens/Atlas';

afterEach(cleanup);

interface Call {
  url: string;
  body: { model?: string; messages?: { role: string; content: string }[]; stream?: boolean };
  headers: Headers;
  signal?: AbortSignal | null | undefined;
}

const stream = (...frames: unknown[]) =>
  new Response(
    [...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n'].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const text = (content: string) => ({ choices: [{ delta: { content } }] });

const guide = (answer: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Call['body'],
      headers: new Headers(init?.headers),
      signal: init?.signal,
    };
    calls.push(call);
    return answer(call);
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'ops' }) };
};

const mount = (api: ReturnType<typeof guide>['api']) => {
  render(<Atlas api={api} />);
  const frame = screen.getByTitle('Systematlas for GenKI') as HTMLIFrameElement;
  const atlas = frame.contentWindow as Window;
  const replies: { message: Record<string, unknown>; origin: string }[] = [];
  atlas.postMessage = ((message: Record<string, unknown>, origin: string) =>
    replies.push({ message, origin })) as typeof atlas.postMessage;
  const send = (data: unknown, origin = window.location.origin, source: Window | null = atlas) =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    });
  return { frame, replies, send };
};

const question = [{ role: 'user', content: 'Hvordan kjører jeg GenKI lokalt?' }];

describe('the atlas screen relays the GenKI guide for its atlas frame', () => {
  it('fills the view with the atlas page and no console chat of its own', () => {
    const { api } = guide(() => stream(text('Svar.')));
    const { frame } = mount(api);

    expect(frame.getAttribute('src')).toBe('/system-atlas.html');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('relays an ask from its own atlas frame to genki-guide with the signed-in token and streams the reply back to that frame only', async () => {
    const url = 'https://github.com/digdir/genki/blob/main/docs/development.md';
    const { api, calls } = guide(() =>
      stream(text('Kjør **npm start** '), text('[1].'), {
        choices: [{ delta: {} }],
        sources: [{ index: 1, title: 'Development', url }],
      }),
    );
    const { replies, send } = mount(api);

    send({ type: 'genki-atlas:ask', id: 'ask-1', messages: question });

    await waitFor(() => expect(replies.at(-1)?.message.type).toBe('genki-atlas:answer'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/v1/chat/completions');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ops');
    expect(calls[0]?.body).toMatchObject({
      model: 'genki-guide__default',
      stream: true,
      messages: question,
    });
    expect(replies.every((r) => r.origin === window.location.origin)).toBe(true);
    expect(replies[0]?.message).toEqual({
      type: 'genki-atlas:delta',
      id: 'ask-1',
      text: 'Kjør **npm start** ',
    });
    const answer = replies.at(-1)?.message ?? {};
    expect(answer).toMatchObject({
      id: 'ask-1',
      text: 'Kjør **npm start** [1].',
      sources: [{ index: 1, title: 'Development', url }],
    });
    expect(answer.html).toContain('<strong>npm start</strong>');
    expect(answer.html).toContain(`href="${url}"`);
  });

  it('ignores messages from other origins, other windows and malformed asks', async () => {
    const { api, calls } = guide(() => stream(text('Svar.')));
    const { send } = mount(api);

    send({ type: 'genki-atlas:ask', id: 'a', messages: question }, 'https://evil.example');
    send({ type: 'genki-atlas:ask', id: 'b', messages: question }, window.location.origin, window);
    send({ type: 'genki-atlas:ask', id: 'c', messages: [{ role: 'assistant', content: 'x' }] });
    send({ type: 'genki-atlas:ask', id: 'd', messages: [{ role: 'system', content: 'x' }] });
    send({ type: 'genki-atlas:ask', messages: question });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toHaveLength(0);
  });

  it('relays the locked-environment title and detail as the API words them', async () => {
    const { api } = guide(() =>
      Response.json(
        {
          type: 'urn:genai:problem:locked-environment',
          status: 403,
          title: 'Miljøet er låst',
          detail: 'Bare Entra ID-innlogging kan bruke modeller her.',
        },
        { status: 403, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    const { replies, send } = mount(api);

    send({ type: 'genki-atlas:ask', id: 'ask-1', messages: question });

    await waitFor(() =>
      expect(replies.at(-1)?.message).toEqual({
        type: 'genki-atlas:error',
        id: 'ask-1',
        code: 'locked',
        title: 'Miljøet er låst',
        detail: 'Bare Entra ID-innlogging kan bruke modeller her.',
      }),
    );
  });

  it('tells the atlas when the person has no access to the guide', async () => {
    const { api } = guide(() =>
      Response.json(
        { error: { message: 'not authorized', code: 'agent_not_authorized' } },
        { status: 403 },
      ),
    );
    const { replies, send } = mount(api);

    send({ type: 'genki-atlas:ask', id: 'ask-1', messages: question });

    await waitFor(() =>
      expect(replies.at(-1)?.message).toEqual({
        type: 'genki-atlas:error',
        id: 'ask-1',
        code: 'no-access',
      }),
    );
  });

  it('cancels a running ask when the atlas clears the conversation', async () => {
    let aborted = false;
    const { api, calls } = guide(
      (call) =>
        new Promise<Response>((_, reject) =>
          call.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }),
        ),
    );
    const { replies, send } = mount(api);

    send({ type: 'genki-atlas:ask', id: 'ask-1', messages: question });
    await waitFor(() => expect(calls).toHaveLength(1));
    send({ type: 'genki-atlas:cancel', id: 'ask-1' });

    await waitFor(() => expect(aborted).toBe(true));
    expect(replies).toEqual([]);
  });
});

describe('answer HTML sent to the atlas', () => {
  it('has no script and only http(s) links', () => {
    const html = answerHtml(
      '<script>alert(1)</script> <img src=x onerror=alert(1)> [klikk](javascript:alert(1)) [ok](https://example.no/a) [1] [2]',
      [
        { index: 1, title: 'Bra', url: 'https://github.com/digdir/genki' },
        { index: 2, title: 'Farlig', url: 'javascript:alert(1)' },
      ],
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');

    expect(doc.querySelectorAll('script, img, [onerror]')).toHaveLength(0);
    const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.no/a', 'https://github.com/digdir/genki']);
    expect(html).not.toMatch(/javascript:alert\(1\)"/);
  });
});
