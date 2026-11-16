// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaygroundRunRequest, PlaygroundStreamEvent } from '../../../api/playground';
import { sseOf } from '../../../data/playground';
import { mockFetch } from '../../../mock';
import { go, renderAt } from '../../../test-utils';
import { gate, result } from './draft.test-utils';

const wide = 1440;
beforeEach(() => {
  window.location.hash = '';
  sessionStorage.clear();
  window.innerWidth = wide;
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

/** The mock portal, with each question's run streamed from its events, or refused. */
const streamed = (
  byQuestion: Record<string, readonly (PlaygroundStreamEvent | Promise<void>)[] | 'refused'>,
) => {
  const base = mockFetch();
  // The questions whose answer the portal stopped reading before it ended.
  const stopped: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/playground\/runs\/stream$/.test(url)) return base(input, init);
    const { input: asked } = JSON.parse(String(init?.body)) as PlaygroundRunRequest;
    const question = 'text' in asked ? (asked.text ?? '') : '';
    const events = byQuestion[question] ?? [];
    if (events === 'refused')
      return new Response(JSON.stringify(refusal), {
        status: 422,
        headers: { 'content-type': 'application/problem+json' },
      });
    const encoder = new TextEncoder();
    let gone = false;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of events) {
          if (event instanceof Promise) await event;
          if (gone) return;
          if (!(event instanceof Promise)) controller.enqueue(encoder.encode(sseOf([event])));
        }
        controller.close();
      },
      cancel() {
        gone = true;
        stopped.push(question);
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, stopped };
};

const delta = (text: string): PlaygroundStreamEvent => ({
  event: 'delta',
  setup: 'setup',
  text,
  channel: 'answer',
});
const finished: PlaygroundStreamEvent = {
  event: 'done',
  quota: { usedPercent: 0, monthlyTokens: 0 },
};
const failed: PlaygroundStreamEvent = {
  event: 'failed',
  setup: 'setup',
  problem: { status: 502, title: 'Tjenesten feilet underveis.' },
};
const refusal = {
  type: 'about:blank',
  title: 'Invalid setup',
  status: 422,
  errors: [{ path: 'setup.spec.purpose', message: 'Too small' }],
};
const notReady = /Oppsettet er ikke klart til å prøves ennå\./;

const question = 'Første spørsmål';
// What the preview on screen shows; an assistant kept out of sight is not in it.
const frame = () => document.querySelector<HTMLElement>('.service-preview-frame');
const answerText = () =>
  [...(frame()?.querySelectorAll('.uib-answer-text') ?? [])]
    .map((text) => text.textContent)
    .join(' ');
const questionOnScreen = () => {
  const shown = frame();
  return shown ? within(shown).queryByText(question, { selector: 'p' }) : null;
};

const openTry = async (fetch: typeof globalThis.fetch) => {
  await renderAt('#/services/rapportassistenten/interface', fetch);
  await screen.findByRole('group', { name: 'Byggeklosser og maler' });
};

const ask = async (text: string) => {
  const field = await screen.findByRole('textbox', { name: /^Spørsmål til/ });
  fireEvent.change(field, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
  });
};

/** Asks the question, whose answer comes as far as «Første» and waits there for the gate. */
const askHeld = async () => {
  const held = gate();
  const portal = streamed({
    [question]: [delta('Første '), held.shut, result('Første svar.'), finished],
  });
  await openTry(portal.fetch);
  await ask(question);
  await waitFor(() => expect(answerText()).toContain('Første'));
  const release = () =>
    act(async () => {
      held.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { ...portal, release };
};

const click = (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
  });

const resizeTo = (width: number) =>
  act(async () => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });

/** Renames the service on «Oppsett» and comes back to «Grensesnitt». */
const renameElsewhere = async (name: string) => {
  go('#/services/rapportassistenten/setup');
  await click(await screen.findByRole('button', { name: /^Formål og målgruppe/ }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Navn' }), {
    target: { value: name },
  });
  go('#/services/rapportassistenten/interface');
  await screen.findByRole('group', { name: 'Byggeklosser og maler' });
};

/** As in a browser, an element put into the page again has lost where it was scrolled to. */
const forgetScrollOnMove = () => {
  const append = Element.prototype.append;
  const appendChild = Node.prototype.appendChild;
  const insertBefore = Node.prototype.insertBefore;
  const forget = (node: unknown) => {
    if (node instanceof Element)
      for (const element of [node, ...node.querySelectorAll('*')]) element.scrollTop = 0;
  };
  Element.prototype.append = function (this: Element, ...nodes: (Node | string)[]) {
    append.apply(this, nodes);
    nodes.forEach(forget);
  };
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T) {
    appendChild.call(this, node);
    forget(node);
    return node;
  };
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null) {
    insertBefore.call(this, node, child);
    forget(node);
    return node;
  };
  return () => {
    Element.prototype.append = append;
    Node.prototype.appendChild = appendChild;
    Node.prototype.insertBefore = insertBefore;
  };
};

/** The answer on its way, and its thread, are on screen, and come in full once the run goes on. */
const stillComing = async ({ release, stopped }: Awaited<ReturnType<typeof askHeld>>) => {
  await waitFor(() => expect(questionOnScreen()).toBeTruthy());
  expect(answerText()).toContain('Første');
  await release();
  await waitFor(() => expect(answerText()).toBe('Første svar.'));
  expect(stopped).toEqual([]);
};

describe('the try view drawn again', () => {
  it('keeps the answer coming, and its thread on screen, while the preview is shown larger and smaller', async () => {
    const run = await askHeld();
    await click(screen.getByRole('button', { name: 'Vis større' }));
    await screen.findByRole('button', { name: 'Vis mindre' });
    await stillComing(run);
    await click(screen.getByRole('button', { name: 'Vis mindre' }));
    await screen.findByRole('button', { name: 'Vis større' });
    expect(questionOnScreen()).toBeTruthy();
    expect(answerText()).toBe('Første svar.');
  });

  it('keeps the answer coming, and its thread on screen, while the reader looks at «Endre layout»', async () => {
    const run = await askHeld();
    await click(screen.getByRole('radio', { name: 'Endre layout' }));
    expect(questionOnScreen()).toBeNull();
    expect(screen.queryByRole('textbox', { name: /^Spørsmål til/ })).toBeNull();
    // Out of sight, but in the page.
    expect(screen.getByText(question, { selector: 'p' }).closest('[hidden]')).not.toBeNull();
    await click(screen.getByRole('radio', { name: 'Prøv tjenesten' }));
    await stillComing(run);
  });

  it('keeps the answer coming, and its thread on screen, while the reader is on another tab of the service', async () => {
    const run = await askHeld();
    go('#/services/rapportassistenten/setup');
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Byggeklosser og maler' })).toBeNull(),
    );
    await run.release();
    go('#/services/rapportassistenten/interface');
    await screen.findByRole('group', { name: 'Byggeklosser og maler' });
    await waitFor(() => expect(answerText()).toBe('Første svar.'));
    expect(questionOnScreen()).toBeTruthy();
    expect(run.stopped).toEqual([]);
  });

  it('keeps the answer coming, and its thread on screen, when the window turns narrow and wide again', async () => {
    const run = await askHeld();
    await resizeTo(390);
    await click(await screen.findByRole('tab', { name: 'Forhåndsvisning' }));
    await stillComing(run);
    await resizeTo(wide);
    await screen.findByRole('group', { name: 'Byggeklosser og maler' });
    expect(questionOnScreen()).toBeTruthy();
    expect(answerText()).toBe('Første svar.');
  });

  it('keeps why the answer on screen failed above the preview when it is shown larger', async () => {
    await openTry(streamed({ [question]: [delta('Første '), failed] }).fetch);
    await ask(question);
    await screen.findByText('Tjenesten feilet underveis.');
    await click(screen.getByRole('button', { name: 'Vis større' }));
    await screen.findByRole('button', { name: 'Vis mindre' });
    const why = screen.getByText('Tjenesten feilet underveis.');
    expect(why.closest('.service-preview')).not.toBeNull();
    expect(why.closest('.service-preview-frame')).toBeNull();
    expect(questionOnScreen()).toBeTruthy();
  });

  it('keeps where the reader had scrolled the thread to when the preview is shown larger', async () => {
    await openTry(streamed({ [question]: [delta('Ja.'), result('Ja.'), finished] }).fetch);
    await ask(question);
    await waitFor(() => expect(answerText()).toBe('Ja.'));
    // The shell's main column is what scrolls in the assistant.
    const scroller = () => frame()?.querySelector('.uib-shell-main');
    expect(scroller()).toBeTruthy();
    if (scroller()) (scroller() as Element).scrollTop = 300;
    const remember = forgetScrollOnMove();
    try {
      await click(screen.getByRole('button', { name: 'Vis større' }));
      await screen.findByRole('button', { name: 'Vis mindre' });
      expect(scroller()?.scrollTop).toBe(300);
    } finally {
      remember();
    }
  });

  it('reads the draft again, on the thread on screen, when the reader changed it on another tab', async () => {
    await openTry(streamed({ [question]: [delta('Ja.'), result('Ja.'), finished] }).fetch);
    await ask(question);
    await waitFor(() => expect(answerText()).toBe('Ja.'));
    await renameElsewhere('Tilsynshjelpen');
    expect(
      await screen.findByRole('textbox', { name: 'Spørsmål til Tilsynshjelpen' }),
    ).toBeTruthy();
    expect(questionOnScreen()).toBeTruthy();
  });

  it('keeps why the draft was refused when the reader comes back from another tab with the draft as it was', async () => {
    await openTry(streamed({ [question]: 'refused' }).fetch);
    await ask(question);
    await screen.findByText(notReady);
    go('#/services/rapportassistenten/setup');
    await screen.findByRole('button', { name: /^Formål og målgruppe/ });
    expect(screen.queryByText(notReady)).toBeNull();
    go('#/services/rapportassistenten/interface');
    expect(await screen.findByText(notReady)).toBeTruthy();
  });

  it('takes away why the draft was refused once the reader has changed the draft on another tab', async () => {
    await openTry(streamed({ [question]: 'refused' }).fetch);
    await ask(question);
    await screen.findByText(notReady);
    await renameElsewhere('Tilsynshjelpen');
    await screen.findByRole('textbox', { name: 'Spørsmål til Tilsynshjelpen' });
    expect(screen.queryByText(notReady)).toBeNull();
  });

  it('starts the conversation again on «Start samtalen på nytt», on a new thread, and stops the answer on its way', async () => {
    const { stopped } = await askHeld();
    await click(screen.getByRole('button', { name: 'Start samtalen på nytt' }));
    await waitFor(() => expect(stopped).toEqual([question]));
    await screen.findByRole('textbox', { name: /^Spørsmål til/ });
    expect(questionOnScreen()).toBeNull();
    expect(answerText()).toBe('');
  });
});
