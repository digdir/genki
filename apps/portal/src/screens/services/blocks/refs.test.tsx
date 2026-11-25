// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fromTemplate, type AssistantLayout } from '@genai/ui-blocks/builder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../App';
import { mockAnsattporten } from '../../../auth';
import { exampleServices, mockFetch } from '../../../mock';
import { kari } from '../../../test-utils';
import { draftStart, storedLayout, withPinsOf } from './layoutStore';
import { heldStudio, withStudio } from '../../design/studio.test-utils';

beforeEach(() => {
  window.location.hash = '';
  sessionStorage.clear();
});
afterEach(cleanup);

const chatOnly = fromTemplate('chat-only').layout;

const pinnedAt = (ref: string): AssistantLayout => ({
  ...chatOnly,
  zones: {
    ...chatOnly.zones,
    main: [...chatOnly.zones.main, { block: 'ref' as never, ref }],
  },
});

const withLayout = (layout: AssistantLayout) =>
  exampleServices.map((s) => {
    if (s.id !== 'rapportassistenten') return s;
    const definition = structuredClone(s.latest.definition) as {
      spec: Record<string, unknown>;
    };
    definition.spec.interface = { ...(definition.spec.interface as object), layout };
    return { ...s, latest: { ...s.latest, definition } } as typeof s;
  });

let writes: { method: string; url: string; body: unknown }[] = [];
const recording = (
  layout: AssistantLayout | undefined,
  failSave = false,
  failPin = false,
): typeof fetch => {
  writes = [];
  const base = mockFetch(layout ? withLayout(layout) : undefined);
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && /\/draft(\/|$)/.test(url)) {
      if (failSave && url.endsWith('/draft'))
        return new Response(JSON.stringify({ title: 'Nede', status: 503 }), {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        });
      if (failPin && url.includes('/draft/blocks/'))
        return new Response(JSON.stringify({ title: 'Kan ikke stå i dette feltet', status: 422 }), {
          status: 422,
          headers: { 'content-type': 'application/problem+json' },
        });
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    }
    return base(input, init);
  };
};

const openInterface = async (
  layout: AssistantLayout | undefined,
  failSave = false,
  failPin = false,
) => {
  const fetch = recording(layout, failSave, failPin);
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services/rapportassistenten/interface';
  render(<App auth={auth} fetch={withStudio(fetch)} live />);
  await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
  await openBlocks();
  return within(await screen.findByRole('region', { name: 'Fra Utforming' }));
};

const openBlocks = async () => {
  const blocks = (await screen.findByRole('radio', {
    name: 'Designelementer',
  })) as HTMLInputElement;
  if (!blocks.checked) fireEvent.click(blocks);
};

const rowOf = (group: ReturnType<typeof within>, name: string) =>
  group.getByRole('link', { name }).closest('.ref-block-row') as HTMLElement;

describe('Fra Utforming in the service’s Utforming tab', () => {
  it('puts an edition in the service’s testutgave', async () => {
    const group = await openInterface(chatOnly);
    const row = within(await waitFor(() => rowOf(group, 'Kildeliste kompakt')));
    const edition = row.getByRole('combobox', { name: 'Utgave' });
    await waitFor(() => expect(within(edition).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(edition, { target: { value: '2' } });
    fireEvent.click(row.getByRole('button', { name: 'Legg i testutgaven, Kildeliste kompakt' }));
    expect(
      await screen.findByText('Lagt i testutgaven. Publiser for å ta det i bruk.'),
    ).toBeTruthy();
    const pin = writes.find((w) => w.url.includes('/draft/blocks/999888777/kildeliste-kompakt'));
    expect(pin).toMatchObject({ method: 'PUT', body: { version: 2, zone: 'main' } });
    expect(await waitFor(() => rowOf(group, 'Kildeliste kompakt').textContent)).toContain(
      'Utgave 17. nov. · Midten',
    );
  });

  it('stays on Designelementer after a pin, so the person sees what happened', async () => {
    const group = await openInterface(chatOnly);
    const row = within(await waitFor(() => rowOf(group, 'Kildeliste kompakt')));
    fireEvent.click(row.getByRole('button', { name: 'Legg i testutgaven, Kildeliste kompakt' }));
    await screen.findByText('Lagt i testutgaven. Publiser for å ta det i bruk.');
    expect(
      (screen.getByRole('radio', { name: 'Designelementer' }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('pins in the testutgave only and never touches the version in use', async () => {
    await openInterface(chatOnly);
    const group = within(screen.getByRole('region', { name: 'Fra Utforming' }));
    const row = within(await waitFor(() => rowOf(group, 'Kildeliste kompakt')));
    fireEvent.click(row.getByRole('button', { name: 'Legg i testutgaven, Kildeliste kompakt' }));
    await screen.findByText('Lagt i testutgaven. Publiser for å ta det i bruk.');
    expect(writes.every((w) => /\/draft(\/blocks\/|$)/.test(w.url))).toBe(true);
    expect(writes.some((w) => /\/definitions(\?|$)|\/promote|\/environments/.test(w.url))).toBe(
      false,
    );
  });

  it('offers only the zones the designelement allows', async () => {
    const group = await openInterface(chatOnly);
    const row = within(await waitFor(() => rowOf(group, 'Kudos-dokumentkort')));
    const zones = within(row.getByRole('combobox', { name: 'Felt' })).getAllByRole('option');
    expect(zones.map((o) => o.textContent)).toEqual(['Høyre']);
    expect(row.getByText('Digdir')).toBeTruthy();
  });

  it('shows that a newer edition exists without changing the service', async () => {
    const group = await openInterface(pinnedAt('999888777/kildeliste-kompakt@2'));
    const row = await waitFor(() => {
      const found = rowOf(group, 'Kildeliste kompakt');
      expect(found.textContent).toContain('Nyere utgave: 21. nov.');
      return within(found);
    });
    expect(row.getByText('Utgave 17. nov. · Midten')).toBeTruthy();
    expect(row.getByRole('button', { name: 'Bruk den, Kildeliste kompakt' })).toBeTruthy();
    expect(writes).toEqual([]);
    fireEvent.click(row.getByRole('button', { name: 'Bruk den, Kildeliste kompakt' }));
    await waitFor(() =>
      expect(writes.at(-1)).toMatchObject({ method: 'PUT', body: { version: 3 } }),
    );
  });

  it('takes a designelement out of the testutgave', async () => {
    const group = await openInterface(pinnedAt('999888777/kildeliste-kompakt@3'));
    const row = within(await waitFor(() => rowOf(group, 'Kildeliste kompakt')));
    fireEvent.click(await row.findByRole('button', { name: 'Ta ut, Kildeliste kompakt' }));
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'DELETE' }));
    await waitFor(() =>
      expect(
        within(rowOf(group, 'Kildeliste kompakt')).getByRole('button', {
          name: 'Legg i testutgaven, Kildeliste kompakt',
        }),
      ).toBeTruthy(),
    );
  });

  it('pins into a service with no layout yet, with the layout the person sees', async () => {
    const group = await openInterface(undefined);
    const row = within(await waitFor(() => rowOf(group, 'Kildeliste kompakt')));
    fireEvent.click(row.getByRole('button', { name: 'Legg i testutgaven, Kildeliste kompakt' }));
    expect(
      await screen.findByText('Lagt i testutgaven. Publiser for å ta det i bruk.'),
    ).toBeTruthy();
    expect(writes.map((w) => w.url.replace(/.*\/services\/rapportassistenten/, ''))).toEqual([
      '/draft',
      '/draft/blocks/999888777/kildeliste-kompakt',
    ]);
  });

  it('says why a pin was refused in a service with no layout yet', async () => {
    const group = await openInterface(undefined, false, true);
    const row = within(await waitFor(() => rowOf(group, 'Kildeliste kompakt')));
    fireEvent.click(row.getByRole('button', { name: 'Legg i testutgaven, Kildeliste kompakt' }));
    const again = within(
      await waitFor(() =>
        rowOf(within(screen.getByRole('region', { name: 'Fra Utforming' })), 'Kildeliste kompakt'),
      ),
    );
    expect(await again.findByText(/Kan ikke stå i dette feltet/)).toBeTruthy();
    expect(screen.queryByText('Lagt i testutgaven. Publiser for å ta det i bruk.')).toBeNull();
  });

  it('never calls a pinned layout one the builder cannot change while the flags load', async () => {
    const { fetch, release } = heldStudio(recording(pinnedAt('999888777/kildeliste-kompakt@3')));
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/interface';
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Byggeren kan ikke endre dette oppsettet')).toBeNull();
    release();
    await openBlocks();
    expect(await screen.findByRole('region', { name: 'Fra Utforming' })).toBeTruthy();
  });

  it('pins nothing while what the person changed could not be saved', async () => {
    await openInterface(chatOnly, true);
    await screen.findByRole('group', { name: 'Designelementer og maler' });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Høyre' })).getByRole('switch', { name: 'Kilder' }),
    );
    const group = within(screen.getByRole('region', { name: 'Fra Utforming' }));
    const row = within(rowOf(group, 'Kildeliste kompakt'));
    fireEvent.click(row.getByRole('button', { name: 'Legg i testutgaven, Kildeliste kompakt' }));
    expect(await row.findByText('Kunne ikke lagre utkastet. Prøv igjen om litt.')).toBeTruthy();
    expect(writes).toEqual([]);
    expect(
      (
        within(screen.getByRole('group', { name: 'Høyre' })).getByRole('switch', {
          name: 'Kilder',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('keeps a ref in the layout when the Utforming tab saves', async () => {
    const layout = pinnedAt('999888777/kildeliste-kompakt@3');
    await openInterface(layout);
    await screen.findByRole('group', { name: 'Designelementer og maler' });
    const right = within(screen.getByRole('group', { name: 'Høyre' }));
    fireEvent.click(right.getByRole('switch', { name: 'Kilder' }));
    await waitFor(
      () => expect(writes.some((w) => w.method === 'PUT' && w.url.endsWith('/draft'))).toBe(true),
      { timeout: 5000 },
    );
    const saved = writes.filter((w) => w.url.endsWith('/draft')).at(-1)?.body as {
      definition: { spec: { interface: { layout: AssistantLayout } } };
    };
    expect(saved.definition.spec.interface.layout.zones.main).toContainEqual({
      block: 'ref',
      ref: '999888777/kildeliste-kompakt@3',
    });
  });
});

describe('the layout store and refs', () => {
  it('keeps a pinned design element through the builder while pins are kept aside', () => {
    const layout = pinnedAt('999888777/kildeliste-kompakt@3');
    const start = draftStart(layout, true);
    expect(start).not.toBe('foreign');
    if (!start || start === 'foreign') return;
    expect(storedLayout(start).zones.main).toContainEqual({
      block: 'ref',
      ref: '999888777/kildeliste-kompakt@3',
    });
  });
});

describe('pins kept aside by the builder', () => {
  const sources = { block: 'sources' } as AssistantLayout['zones']['main'][number];
  const pin = { block: 'ref', ref: '999888777/kildeliste-kompakt@3' } as never;

  it('puts a pinned design element back where it stood after a builder edit', () => {
    const layout: AssistantLayout = {
      ...chatOnly,
      zones: { ...chatOnly.zones, main: [pin, ...chatOnly.zones.main] },
    };
    const start = draftStart(layout, true);
    if (!start || start === 'foreign') throw new Error('not editable');
    const edited = { ...start, layout: { ...start.layout, zones: { ...start.layout.zones } } };
    expect(storedLayout(edited).zones.main[0]).toEqual(pin);
  });

  it('keeps what the person changed while a pin was on its way, with the pin the server placed', () => {
    const local: AssistantLayout = {
      ...chatOnly,
      zones: { ...chatOnly.zones, secondary: [sources] },
    };
    const merged = withPinsOf(local, pinnedAt('999888777/kildeliste-kompakt@3'));
    expect(merged.zones.secondary).toEqual([sources]);
    expect(merged.zones.main).toContainEqual(pin);
  });
});

describe('the service’s Utforming tab with blockStudio off', () => {
  it('treats a layout with a pinned design element as one the builder cannot change', () => {
    expect(draftStart(pinnedAt('999888777/kildeliste-kompakt@3'))).toBe('foreign');
  });

  it('offers no Fra Utforming section', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten/interface';
    render(<App auth={auth} fetch={recording(chatOnly)} live />);
    await screen.findByRole('group', { name: 'Designelementer og maler' });
    await openBlocks();
    await screen.findByRole('group', { name: 'Høyre' });
    expect(screen.queryByRole('region', { name: 'Fra Utforming' })).toBeNull();
  });
});
