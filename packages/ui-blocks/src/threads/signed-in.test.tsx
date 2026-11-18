// @vitest-environment jsdom
import { InLocale } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignedIn } from './SignedIn.js';
import { Threads } from './Threads.js';

afterEach(cleanup);
// jsdom cannot follow the link, and says so; the tests only need the click to reach it.
const stayOnPage = (event: Event) => event.preventDefault();
document.addEventListener('click', stayOnPage);

describe('who is signed in', () => {
  it('names the reader, says «Innlogget som» to a screen reader, and has the address on hover', () => {
    render(<SignedIn name="Kari Nordmann" email="kari@digdir.no" signOutHref="/auth/logout" />);
    const name = screen.getByText('Kari Nordmann');
    expect(screen.getByText('Innlogget som').className).toContain('ds-sr-only');
    expect(name.closest('p')?.getAttribute('title')).toBe('kari@digdir.no');
  });

  it('signs out by a plain link to the host’s sign-out, a full navigation', () => {
    render(<SignedIn name="Kari Nordmann" signOutHref="/auth/logout" />);
    expect(screen.getByRole('link', { name: 'Logg ut' }).getAttribute('href')).toBe('/auth/logout');
  });

  it('tells the host before the browser leaves, so it can forget what this browser kept', () => {
    const onSignOut = vi.fn();
    render(<SignedIn name="Kari Nordmann" signOutHref="/auth/logout" onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole('link', { name: 'Logg ut' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('tells it on a middle click too, which opens the link in a new tab, and not on a right click', () => {
    const onSignOut = vi.fn();
    render(<SignedIn name="Kari Nordmann" signOutHref="/auth/logout" onSignOut={onSignOut} />);
    const link = screen.getByRole('link', { name: 'Logg ut' });

    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(onSignOut).not.toHaveBeenCalled();

    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('says who is signed in, with no «Logg ut», when the host gives no sign-out', () => {
    render(<SignedIn name="Kari Nordmann" />);
    expect(screen.getByText('Kari Nordmann')).toBeTruthy();
    expect(screen.queryByText('Logg ut')).toBeNull();
  });

  it('draws nothing when nobody is signed in', () => {
    const { container } = render(<SignedIn signOutHref="/auth/logout" />);
    expect(container.textContent).toBe('');
  });

  it('stands at the end of the thread list, after the last row, in its foot', () => {
    render(
      <Threads
        threads={[{ id: 'a', title: 'Måloppnåelse i Nkom', updatedAt: Date.now() }]}
        threadHref={(thread) => `/threads/${thread.id}`}
        foot={<SignedIn name="Kari Nordmann" signOutHref="/auth/logout" />}
      />,
    );
    const row = screen.getByRole('link', { name: 'Måloppnåelse i Nkom' });
    const signOut = screen.getByRole('link', { name: 'Logg ut' });
    expect(row.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <SignedIn name="Kari Nordmann" signOutHref="/auth/logout" />
      </InLocale>,
    );
    expect(screen.getByText('Signed in as')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign out' })).toBeTruthy();
  });
});
