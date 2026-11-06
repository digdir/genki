// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentText } from './Attachments.js';
import { Composer, type ComposerAttachment, type ComposerAttachments } from './Composer.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const file = (name: string) => new File(['x'], name, { type: 'application/pdf' });
const uploading = (progress = 40): ComposerAttachment => ({
  id: 'a1',
  name: 'rapport.pdf',
  status: 'uploading',
  progress,
});
const ready: ComposerAttachment = { id: 'a1', name: 'rapport.pdf', status: 'ready' };

const Controlled = ({
  attachments,
  initial = '',
  sent = [],
}: {
  attachments: ComposerAttachments;
  initial?: string;
  sent?: string[];
}) => {
  const [value, setValue] = useState(initial);
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSubmit={(question) => sent.push(question)}
      attachments={attachments}
      followUps={['Kan du utdype?']}
    />
  );
};

const attachmentsWith = (overrides: Partial<ComposerAttachments> = {}): ComposerAttachments => ({
  items: [],
  onAdd: () => {},
  onRemove: () => {},
  ...overrides,
});

const field = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const picker = () => document.querySelector<HTMLInputElement>('input[type="file"]');
/** The box around the field and its buttons: the nearest element holding both. */
const frame = () => {
  const send = screen.getByRole('button', { name: 'Send spørsmålet' });
  let box = field().parentElement as HTMLElement;
  while (!box.contains(send)) box = box.parentElement as HTMLElement;
  return box;
};
const liveRegion = () => document.querySelector('[aria-live="polite"]') as HTMLElement;

describe('attaching files to the question', () => {
  it('opens the file picker from the paperclip, so nothing depends on dragging', () => {
    render(<Controlled attachments={attachmentsWith()} />);
    const opened = vi.spyOn(picker() as HTMLInputElement, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Legg ved dokument' }));
    expect(opened).toHaveBeenCalledOnce();
  });

  it('keeps the file picker out of the tab order and out of the accessibility tree', () => {
    render(<Controlled attachments={attachmentsWith({ accept: '.pdf,.docx' })} />);
    expect(picker()?.tabIndex).toBe(-1);
    expect(picker()?.accept).toBe('.pdf,.docx');
    expect(screen.queryByLabelText(/fil/i, { selector: 'input[type="file"]' })).toBeNull();
  });

  it('hands picked files to the host, and lets the same file be picked again', () => {
    const added: File[][] = [];
    render(<Controlled attachments={attachmentsWith({ onAdd: (files) => added.push(files) })} />);
    const input = picker() as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file('rapport.pdf'), file('notat.pdf')] } });
    expect(added.map((files) => files.map((f) => f.name))).toEqual([['rapport.pdf', 'notat.pdf']]);
    expect(input.value).toBe('');
  });

  it('names the file types it takes on the paperclip, since the picker filters silently', () => {
    render(<Controlled attachments={attachmentsWith({ types: ['PDF', '.docx'] })} />);
    expect(
      screen.getByRole('button', { name: 'Legg ved dokument (PDF eller .docx)' }),
    ).toBeTruthy();
  });

  it('draws a file from uploading to ready, with the percentage only while it uploads', () => {
    const { rerender } = render(
      <Controlled attachments={attachmentsWith({ items: [uploading(40)] })} />,
    );
    const chip = () => screen.getByRole('button', { name: 'Fjern vedlegget rapport.pdf' });
    expect(chip().textContent).toMatch(/rapport\.pdf 40\s%/u);
    rerender(<Controlled attachments={attachmentsWith({ items: [ready] })} />);
    expect(chip().textContent).toBe('rapport.pdf');
  });

  it('lists the files as attachments to the question', () => {
    render(<Controlled attachments={attachmentsWith({ items: [ready] })} />);
    expect(screen.getByRole('list', { name: 'Vedlegg til spørsmålet' })).toBeTruthy();
  });

  it('does not send with Enter while a file is on its way, and says why in a live region that was already there', () => {
    const sent: string[] = [];
    render(
      <Controlled
        attachments={attachmentsWith({ items: [uploading()] })}
        initial="Hva står der?"
        sent={sent}
      />,
    );
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sent).toEqual([]);
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Vent til vedlegget er lastet opp.');
    expect(document.activeElement).toBe(field());
  });

  it('does not send with the button or a follow-up either while a file is on its way', () => {
    const sent: string[] = [];
    render(
      <Controlled
        attachments={attachmentsWith({ items: [uploading()] })}
        initial="Hva står der?"
        sent={sent}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kan du utdype?' }));
    expect(sent).toEqual([]);
  });

  it('takes the wait message away when there is nothing to wait for, and never sends by itself', () => {
    const sent: string[] = [];
    const { rerender } = render(
      <Controlled
        attachments={attachmentsWith({ items: [uploading()] })}
        initial="Hva står der?"
        sent={sent}
      />,
    );
    fireEvent.keyDown(field(), { key: 'Enter' });
    rerender(
      <Controlled
        attachments={attachmentsWith({ items: [ready] })}
        initial="Hva står der?"
        sent={sent}
      />,
    );
    expect(screen.queryByText('Vent til vedlegget er lastet opp.')).toBeNull();
    expect(sent).toEqual([]);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(sent).toEqual(['Hva står der?']);
  });

  it('gives focus back to the field when an attachment is removed', () => {
    const removed: string[] = [];
    render(
      <Controlled
        attachments={attachmentsWith({ items: [ready], onRemove: (id) => removed.push(id) })}
      />,
    );
    const chip = screen.getByRole('button', { name: 'Fjern vedlegget rapport.pdf' });
    chip.focus();
    fireEvent.click(chip);
    expect(removed).toEqual(['a1']);
    expect(document.activeElement).toBe(field());
  });

  it('says why an upload failed, and gives focus back to the field when it is tried again', () => {
    const retried: string[] = [];
    const failed: ComposerAttachment = { ...ready, status: 'failed', error: 'failed' };
    render(
      <Controlled
        attachments={attachmentsWith({ items: [failed], onRetry: (id) => retried.push(id) })}
      />,
    );
    expect(screen.getByText('Opplastingen gikk ikke gjennom.')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Prøv å laste opp rapport.pdf på nytt' });
    expect(retry.textContent).toBe('Prøv igjen');
    retry.focus();
    fireEvent.click(retry);
    expect(retried).toEqual(['a1']);
    expect(document.activeElement).toBe(field());
  });

  it('offers no retry for a file that would fail the same way again', () => {
    render(
      <Controlled
        attachments={attachmentsWith({
          items: [
            { id: 'big', name: 'stor.pdf', status: 'failed', error: 'too-large' },
            { id: 'odd', name: 'bilde.png', status: 'failed', error: 'wrong-type' },
          ],
          onRetry: () => {},
          maxBytes: 20 * 1024 * 1024,
          types: ['PDF', '.docx'],
        })}
      />,
    );
    expect(screen.getByText('Filen er større enn 20 MB.')).toBeTruthy();
    expect(screen.getByText('Filtypen støttes ikke. Last opp PDF eller .docx.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prøv å laste opp/u })).toBeNull();
  });

  it('says only what it knows about a refused file when the host names no limit or types', () => {
    render(
      <Controlled
        attachments={attachmentsWith({
          items: [
            { id: 'big', name: 'stor.pdf', status: 'failed', error: 'too-large' },
            { id: 'odd', name: 'bilde.png', status: 'failed', error: 'wrong-type' },
          ],
        })}
      />,
    );
    expect(screen.getByText('Filen er for stor.')).toBeTruthy();
    expect(screen.getByText('Filtypen støttes ikke.')).toBeTruthy();
  });

  it('announces start and done, not every percent', () => {
    const { rerender } = render(<Controlled attachments={attachmentsWith({ items: [] })} />);
    const heard: string[] = [];
    rerender(<Controlled attachments={attachmentsWith({ items: [uploading(10)] })} />);
    heard.push(liveRegion().textContent ?? '');
    rerender(<Controlled attachments={attachmentsWith({ items: [uploading(60)] })} />);
    heard.push(liveRegion().textContent ?? '');
    rerender(<Controlled attachments={attachmentsWith({ items: [ready] })} />);
    heard.push(liveRegion().textContent ?? '');
    expect(heard).toEqual([
      'Laster opp rapport.pdf.',
      'Laster opp rapport.pdf.',
      'rapport.pdf er lastet opp og lagt ved.',
    ]);
  });

  it('announces a refused file with the reason', () => {
    render(
      <Controlled
        attachments={attachmentsWith({
          items: [{ id: 'big', name: 'stor.pdf', status: 'failed', error: 'too-large' }],
        })}
      />,
    );
    expect(liveRegion().textContent).toBe('stor.pdf ble ikke lagt ved. Filen er for stor.');
  });

  it('attaches a file dropped on the field, as a shortcut to the paperclip', () => {
    const added: string[] = [];
    render(
      <Controlled
        attachments={attachmentsWith({ onAdd: (files) => added.push(...files.map((f) => f.name)) })}
      />,
    );
    fireEvent.drop(frame(), {
      dataTransfer: { files: [file('rapport.pdf')], types: ['Files'] },
    });
    expect(added).toEqual(['rapport.pdf']);
  });

  it('lights the frame up while a file is dragged over it, and says the file will be attached', () => {
    render(<Controlled attachments={attachmentsWith()} />);
    fireEvent.dragEnter(frame(), { dataTransfer: { files: [], types: ['Files'] } });
    expect(frame().getAttribute('data-dragging')).toBe('true');
    expect(screen.getByText('Slipp filen for å legge den ved')).toBeTruthy();
    fireEvent.dragLeave(frame());
    expect(screen.queryByText('Slipp filen for å legge den ved')).toBeNull();
  });

  it('does not light up for dragged text, which is not a file', () => {
    render(<Controlled attachments={attachmentsWith()} />);
    fireEvent.dragEnter(frame(), { dataTransfer: { files: [], types: ['text/plain'] } });
    expect(frame().hasAttribute('data-dragging')).toBe(false);
  });
});

describe('attaching where uploading is coming', () => {
  const soon = (): ComposerAttachments => ({ items: [], onRemove: () => {} });

  it('draws the paperclip switched off, with its words on it, and keeps it in the tab order', () => {
    render(<Controlled attachments={soon()} />);
    const attach = screen.getByRole('button', { name: 'Legg ved dokument, kommer snart' });
    expect(attach.getAttribute('aria-disabled')).toBe('true');
    expect(attach.hasAttribute('disabled')).toBe(false);
    expect(attach.textContent).toBe('Kommer snart');
  });

  it('has no file picker behind the switched-off paperclip', () => {
    render(<Controlled attachments={soon()} />);
    expect(picker()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Legg ved dokument, kommer snart' }));
    expect(screen.queryByRole('list', { name: 'Vedlegg til spørsmålet' })).toBeNull();
  });

  it('refuses a file dropped on the field, and says why in a live region that was already there', () => {
    render(<Controlled attachments={soon()} />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    fireEvent.drop(frame(), { dataTransfer: { files: [file('rapport.pdf')], types: ['Files'] } });
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('Opplasting er ikke tilgjengelig i denne tjenesten ennå.');
  });

  it('does not promise an attachment while a file is dragged over the field', () => {
    render(<Controlled attachments={soon()} />);
    fireEvent.dragEnter(frame(), { dataTransfer: { files: [], types: ['Files'] } });
    expect(frame().getAttribute('data-dragging')).toBe('true');
    expect(screen.queryByText('Slipp filen for å legge den ved')).toBeNull();
  });

  it('still takes fileTypes and maxMegabytes, the old names, until hosts have moved', () => {
    let text!: ReturnType<typeof useAttachmentText>;
    const Probe = () => {
      text = useAttachmentText(attachmentsWith({ fileTypes: ['PDF'], maxMegabytes: 20 }));
      return null;
    };
    render(<Probe />);
    const { error } = text;
    expect(error('too-large')).toBe('Filen er større enn 20 MB.');
    expect(error('wrong-type')).toMatch(/PDF/);
  });
});

describe('a composer without attachments', () => {
  it('draws no paperclip and takes no dropped file', () => {
    render(<Composer value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByRole('button', { name: /Legg ved/u })).toBeNull();
    expect(picker()).toBeNull();
    const notSwallowed = fireEvent.dragOver(field().parentElement as HTMLElement, {
      dataTransfer: { files: [], types: ['Files'] },
    });
    expect(notSwallowed).toBe(true);
  });
});
