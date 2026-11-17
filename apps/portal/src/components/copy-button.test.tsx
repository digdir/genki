// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './CopyButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withClipboard = (writeText: (text: string) => Promise<void>) =>
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

describe('CopyButton', () => {
  it('says Kopiert only after the clipboard took the text', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withClipboard(writeText);
    const onCopied = vi.fn();
    render(<CopyButton text="gp_secret" onCopied={onCopied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kopier' }));
    expect(await screen.findByText('Kopiert')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('gp_secret');
    expect(onCopied).toHaveBeenCalledOnce();
  });

  it('says the copy failed when the clipboard refuses, and does not count it as copied', async () => {
    withClipboard(() => Promise.reject(new Error('denied')));
    const onCopied = vi.fn();
    render(<CopyButton text="gp_secret" onCopied={onCopied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kopier' }));
    expect(await screen.findByText(/Fikk ikke kopiert/)).toBeTruthy();
    expect(screen.queryByText('Kopiert')).toBeNull();
    expect(onCopied).not.toHaveBeenCalled();
  });
});
