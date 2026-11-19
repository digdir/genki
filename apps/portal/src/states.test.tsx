// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyButton } from './components/BusyButton';
import { parseRoute, useAsync } from './hooks';
import { ScreenLoading } from './signed-in-page';
import { Loading, PageLoading } from './states';

document.getAnimations ??= () => [];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('loading a page or a section', () => {
  it('shows no skeleton before 300 ms, so a fast answer does not flash', async () => {
    const { container } = render(<Loading label="Henter tjenester" />);
    const status = screen.getByRole('status', { name: 'Henter tjenester' });

    await wait(299);
    expect(status.childElementCount).toBe(0);

    await wait(1);
    expect(status.childElementCount).toBeGreaterThan(0);
    expect(container.querySelectorAll('.skeleton-list-row')).toHaveLength(5);
  });

  it('shows what it is fetching as a visible line above the skeleton', async () => {
    render(<Loading label="Henter tjenester" />);
    await wait(300);

    const line = screen.getByText('Henter tjenester ...');
    expect(line.closest('.visually-hidden')).toBeNull();
  });

  it('shows the loading line once when the label already ends in an ellipsis', async () => {
    render(<Loading label="Henter …" />);
    await wait(300);

    expect(screen.getAllByText('Henter …')).toHaveLength(1);
    expect(screen.queryByText('Henter … ...')).toBeNull();
  });

  it('keeps the page title from the menu while a top-level page loads its code', async () => {
    render(<ScreenLoading route={parseRoute('#/statistics')} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Statistikk' })).toBeTruthy();
    await wait(300);
    expect(document.querySelector('.page-loading')).toBeNull();
  });

  it('draws a table skeleton under the real column headings', async () => {
    render(<Loading label="Henter logg" shape="table" columns={['Tid', 'Tjeneste']} />);
    await wait(300);

    expect(screen.getByRole('columnheader', { name: 'Tid', hidden: true })).toBeTruthy();
    expect(screen.getAllByRole('row', { hidden: true })).toHaveLength(5);
  });

  it('says the load is slow after 10 seconds', async () => {
    render(<Loading label="Henter kjøringer" shape="detail" />);
    await wait(9_999);
    expect(screen.queryByText(/tar lengre tid enn vanlig/)).toBeNull();

    await wait(1);
    expect(screen.getByRole('status', { name: 'Henter kjøringer' }).textContent).toContain(
      'Dette tar lengre tid enn vanlig.',
    );
  });

  it('gives up after 30 seconds with Prøv igjen, which retries and starts the wait over', async () => {
    const onRetry = vi.fn();
    render(<PageLoading label="Henter tjenesten" shape="service" onRetry={onRetry} />);
    await wait(30_000);

    expect(screen.getByRole('heading', { name: 'Det tok for lang tid' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Henter tjenesten' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('status', { name: 'Henter tjenesten' }).childElementCount).toBe(0);
    expect(screen.queryByRole('heading', { name: 'Det tok for lang tid' })).toBeNull();
  });

  it('titles the give-up alert at the heading level of its section', async () => {
    render(<Loading label="Henter filer" headingLevel={4} />);
    await wait(30_000);

    expect(screen.getByRole('heading', { level: 4, name: 'Det tok for lang tid' })).toBeTruthy();
  });

  it('starts the wait over without reloading the page when no retry is given', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<Loading label="Henter filer" />);
    await wait(30_000);
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Henter filer' })).toBeTruthy();
  });
});

describe('BusyButton', () => {
  const Publish = ({ onPublish }: { onPublish: () => void }) => {
    const [busy, setBusy] = useState(false);
    return (
      <BusyButton
        busy={busy}
        busyLabel="Publiserer ..."
        onClick={() => {
          setBusy(true);
          onPublish();
        }}
      >
        Publiser
      </BusyButton>
    );
  };

  it('disables itself after the click and announces what it is doing', () => {
    const onPublish = vi.fn();
    render(<Publish onPublish={onPublish} />);
    const button = screen.getByRole('button', { name: 'Publiser' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(onPublish).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Publiserer ...' })).toBe(button);
    expect(screen.getByRole('status').textContent).toBe('Publiserer ...');
  });

  it('shows no spinner before it is clicked', () => {
    render(<Publish onPublish={() => undefined} />);

    expect(screen.getByRole('button', { name: 'Publiser' }).getAttribute('aria-busy')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('fetching again', () => {
  const Rows = ({ load }: { load: () => Promise<string[]> }) => {
    const [state, retry, pending] = useAsync(load, []);
    if (state.status !== 'ready') return <Loading label="Henter rader" />;
    return (
      <>
        <button type="button" onClick={retry}>
          Oppdater
        </button>
        <ul aria-label="Rader" aria-busy={pending || undefined}>
          {state.data.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      </>
    );
  };

  it('keeps the rows on screen, dimmed, until the new ones arrive', async () => {
    let release: (rows: string[]) => void = () => undefined;
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['Første'])
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    render(<Rows load={load} />);
    await wait(0);
    expect(screen.getByRole('listitem').textContent).toBe('Første');

    fireEvent.click(screen.getByRole('button', { name: 'Oppdater' }));
    await wait(400);

    expect(screen.queryByRole('status', { name: 'Henter rader' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Rader' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('listitem').textContent).toBe('Første');

    await act(async () => release(['Andre']));
    expect(screen.getByRole('listitem').textContent).toBe('Andre');
    expect(screen.getByRole('list', { name: 'Rader' }).getAttribute('aria-busy')).toBeNull();
  });
});
