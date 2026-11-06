// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import { Composer, ComposerDisclaimer, type ComposerProps } from './Composer.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Props = Partial<Omit<ComposerProps, 'value' | 'onChange'>> & { initial?: string };

const Controlled = ({ initial = '', onSubmit = () => {}, ...props }: Props) => {
  const [value, setValue] = useState(initial);
  return <Composer value={value} onChange={setValue} onSubmit={onSubmit} {...props} />;
};

const draw = (props: Props = {}) => {
  const sent: string[] = [];
  const view = render(<Controlled onSubmit={(question) => sent.push(question)} {...props} />);
  return { sent, ...view };
};

const field = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const sendButton = () =>
  screen.getByRole('button', { name: 'Send spørsmålet' }) as HTMLButtonElement;
const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the question field', () => {
  it('sends with Enter, and keeps Shift+Enter for a new line', () => {
    const { sent } = draw();
    type('Hva sier rapporten?');
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(sent).toEqual([]);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sent).toEqual(['Hva sier rapporten?']);
  });

  it('never sends while an input method is still composing a word', () => {
    const { sent } = draw();
    type('Hva');
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    expect(sent).toEqual([]);
  });

  it('sends the question trimmed, and offers no send for an empty one', () => {
    const { sent } = draw();
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(field(), { key: 'Enter' });
    type('  Hva sier rapporten?  ');
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    expect(sent).toEqual(['Hva sier rapporten?']);
  });

  it('sends nothing while the assistant answers, and offers «Avbryt» in words instead', () => {
    const cancelled = vi.fn();
    const { sent } = draw({ initial: 'Neste spørsmål', working: true, onCancel: cancelled });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sent).toEqual([]);
    const stop = screen.getByRole('button', { name: 'Avbryt genereringen' });
    expect(stop.textContent).toBe('Avbryt');
    expect(stop.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Send spørsmålet' })).toBeNull();
  });

  it('puts the caret back in the field when the answer is cancelled', () => {
    const cancelled = vi.fn();
    draw({ working: true, onCancel: cancelled });
    const stop = screen.getByRole('button', { name: 'Avbryt genereringen' });
    stop.focus();
    fireEvent.click(stop);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(field());
  });

  it('names the field and the disclaimer after the assistant, and says «assistenten» without a name', () => {
    const { rerender } = render(
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        assistantName="Kunnskapsassistenten"
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Spørsmål til Kunnskapsassistenten' })).toBeTruthy();
    expect(
      screen.getByText('Kunnskapsassistenten kan gjøre feil. Husk å sjekke viktig informasjon.'),
    ).toBeTruthy();
    rerender(<Composer value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Spørsmål til assistenten' })).toBeTruthy();
    expect(
      screen.getByText('Assistenten kan gjøre feil. Husk å sjekke viktig informasjon.'),
    ).toBeTruthy();
  });

  it('asks «Hva vil du vite mer om?» unless the host asks something else', () => {
    const { rerender } = render(<Composer value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(field().placeholder).toBe('Hva vil du vite mer om?');
    rerender(
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        placeholder="Svar på spørsmålet over …"
      />,
    );
    expect(field().placeholder).toBe('Svar på spørsmålet over …');
  });

  it('has the field over the buttons, with the paperclip first, the host’s controls next and send last', () => {
    draw({
      attachments: { items: [], onAdd: () => {}, onRemove: () => {} },
      actions: <button type="button">Agent: Standard</button>,
    });
    const attach = screen.getByRole('button', { name: 'Legg ved dokument' });
    const agent = screen.getByRole('button', { name: 'Agent: Standard' });
    expect(before(field(), attach)).toBe(true);
    expect(before(attach, agent)).toBe(true);
    expect(before(agent, sendButton())).toBe(true);
  });

  // The variant picker's place, as kunnskapsassistenten decided on 6 October 2026.
  it('lets a control in the host’s slot take Enter without sending, and reach the field by Ctrl+/', () => {
    const { sent } = draw({
      initial: 'Hva sier årsrapportene om måloppnåelse?',
      actions: <button type="button">Variant: Svar med kilder</button>,
    });
    const picker = screen.getByRole('button', { name: 'Variant: Svar med kilder' });
    picker.focus();
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(sent).toEqual([]);
    expect(field().value).toBe('Hva sier årsrapportene om måloppnåelse?');
    fireEvent.keyDown(picker, { key: '/', ctrlKey: true });
    expect(document.activeElement).toBe(field());
  });

  it('sends a follow-up as it is, and has the follow-ups under the box and the disclaimer last', () => {
    const { sent } = draw({ followUps: ['Kan du utdype?', 'Identifiser utfordringer'] });
    const followUp = screen.getByRole('button', { name: 'Kan du utdype?' });
    const disclaimer = screen.getByText(/kan gjøre feil/);
    expect(before(sendButton(), followUp)).toBe(true);
    expect(before(followUp, disclaimer)).toBe(true);
    fireEvent.click(followUp);
    expect(sent).toEqual(['Kan du utdype?']);
  });

  it('draws no follow-ups without any', () => {
    draw({ followUps: [] });
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('leaves the disclaimer to the host when asked, which can draw it elsewhere', () => {
    draw({ showDisclaimer: false });
    expect(screen.queryByText(/kan gjøre feil/)).toBeNull();
    cleanup();
    render(<ComposerDisclaimer assistantName="Kunnskapsassistenten" />);
    expect(
      screen.getByText('Kunnskapsassistenten kan gjøre feil. Husk å sjekke viktig informasjon.'),
    ).toBeTruthy();
  });

  it('is neutral unless the host gives it another colour family, as a field is in Designsystemet', () => {
    const { container, rerender } = render(
      <Composer value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(container.firstElementChild?.getAttribute('data-color')).toBe('neutral');
    rerender(<Composer value="" onChange={() => {}} onSubmit={() => {}} color="brand1" />);
    expect(container.firstElementChild?.getAttribute('data-color')).toBe('brand1');
    expect(screen.getByText(/kan gjøre feil/).getAttribute('data-color')).toBe('brand1');
    cleanup();
    render(<ComposerDisclaimer />);
    expect(screen.getByText(/kan gjøre feil/).getAttribute('data-color')).toBe('neutral');
  });

  it('gives the send button and the follow-ups accent, or the family the host gives them', () => {
    const { rerender } = render(
      <Composer
        value="Hei"
        onChange={() => {}}
        onSubmit={() => {}}
        followUps={['Kan du utdype?']}
      />,
    );
    const followUp = () => screen.getByRole('button', { name: 'Kan du utdype?' });
    expect(sendButton().getAttribute('data-color')).toBe('accent');
    expect(followUp().getAttribute('data-color')).toBe('accent');
    rerender(
      <Composer
        value="Hei"
        onChange={() => {}}
        onSubmit={() => {}}
        followUps={['Kan du utdype?']}
        actionColor="brand2"
      />,
    );
    expect(sendButton().getAttribute('data-color')).toBe('brand2');
    expect(followUp().getAttribute('data-color')).toBe('brand2');
  });

  it('keeps its own height clear under what the browser scrolls to in its column, when docked', () => {
    const observed: ResizeObserverCallback[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observed.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { container, unmount } = render(
        <div className="column">
          <p>Svaret</p>
          <Composer value="" onChange={() => {}} onSubmit={() => {}} sticky />
        </div>,
      );
      const column = container.querySelector<HTMLElement>('.column');
      observed[0]?.([], {} as ResizeObserver);
      expect(column?.style.getPropertyValue('--uib-composer-block-size')).toMatch(/^\d+px$/);
      unmount();
      expect(column?.style.getPropertyValue('--uib-composer-block-size')).toBe('');
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('stays at the foot of a scrolling conversation only when the host asks', () => {
    const { container, rerender } = render(
      <Composer value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(container.firstElementChild?.hasAttribute('data-sticky')).toBe(false);
    rerender(<Composer value="" onChange={() => {}} onSubmit={() => {}} sticky />);
    expect(container.firstElementChild?.hasAttribute('data-sticky')).toBe(true);
  });
});

describe('the shortcut to the field', () => {
  const elsewhere = () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    return button;
  };

  it('puts the caret in the field on Ctrl+/ from anywhere on the page, with Shift held', () => {
    draw();
    const from = elsewhere();
    fireEvent.keyDown(from, { key: '/', ctrlKey: true, shiftKey: true });
    expect(document.activeElement).toBe(field());
    from.remove();
  });

  it('answers to Cmd+/ as well, for a Mac', () => {
    draw();
    const from = elsewhere();
    fireEvent.keyDown(from, { key: '/', metaKey: true, shiftKey: true });
    expect(document.activeElement).toBe(field());
    from.remove();
  });

  it('does nothing on a bare «/», which a reader may be typing', () => {
    draw();
    const from = elsewhere();
    const notSwallowed = fireEvent.keyDown(from, { key: '/', cancelable: true });
    expect(document.activeElement).toBe(from);
    expect(notSwallowed).toBe(true);
    from.remove();
  });

  it('leaves Ctrl+Alt+/ alone, because that is AltGr on Windows', () => {
    draw();
    const from = elsewhere();
    fireEvent.keyDown(from, { key: '/', ctrlKey: true, altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(from);
    from.remove();
  });

  it('reaches the field from inside a shadow root', () => {
    draw();
    const host = document.createElement('div');
    document.body.append(host);
    const inner = document.createElement('input');
    host.attachShadow({ mode: 'open' }).append(inner);
    inner.focus();
    inner.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '/',
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(field());
    host.remove();
  });

  it('says how to reach the field, to a pointer on the field and to a screen reader in words', () => {
    draw();
    expect(field().title).toBe('Trykk Ctrl + / for å hoppe hit');
    expect(screen.queryByText('Trykk Ctrl + / for å hoppe hit')).toBeNull();
    const described = field().getAttribute('aria-describedby');
    expect(document.getElementById(described ?? '')?.textContent).toBe(
      'Trykk Ctrl og skråstrek, eller Cmd og skråstrek, for å flytte skrivemerket hit fra hvor som helst på siden.',
    );
  });

  it('names Cmd on a Mac', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15',
    );
    draw();
    expect(field().title).toBe('Trykk Cmd + / for å hoppe hit');
  });

  it('can be switched off, and then says nothing about it', () => {
    draw({ shortcut: false });
    const from = elsewhere();
    fireEvent.keyDown(from, { key: '/', ctrlKey: true });
    expect(document.activeElement).toBe(from);
    expect(field().hasAttribute('title')).toBe(false);
    expect(field().hasAttribute('aria-describedby')).toBe(false);
    from.remove();
  });
});

describe('«Bla til bunnen»', () => {
  it('stands over the field only when the host asks for it', () => {
    const { rerender } = render(<Composer value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Bla til bunnen' })).toBeNull();
    rerender(
      <Composer value="" onChange={() => {}} onSubmit={() => {}} onScrollToBottom={() => {}} />,
    );
    expect(before(screen.getByRole('button', { name: 'Bla til bunnen' }), field())).toBe(true);
  });

  it('scrolls, and hands the keyboard on to the field', () => {
    const scrolled = vi.fn();
    draw({ onScrollToBottom: scrolled });
    const button = screen.getByRole('button', { name: 'Bla til bunnen' });
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(scrolled).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(field());
  });

  it('scrolls after a tap and leaves the focus where it was, since the field would open the keyboard on a phone', () => {
    const scrolled = vi.fn();
    draw({ onScrollToBottom: scrolled });
    const button = screen.getByRole('button', { name: 'Bla til bunnen' });
    button.focus();
    fireEvent.click(button, { detail: 1 });
    expect(scrolled).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(button);
  });
});

describe('the composer’s language', () => {
  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <Controlled assistantName="Kunnskapsassistenten" working onCancel={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('textbox', { name: 'Question for Kunnskapsassistenten' })).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'Cancel the generation' })).getByText('Cancel'),
    );
    expect(field().placeholder).toBe('What would you like to know more about?');
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
