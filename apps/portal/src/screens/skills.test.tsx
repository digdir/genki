// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockFetch } from '../mock';
import { exampleSkillRecords } from '../data/skills';
import type { SkillsMockOptions } from '../mock/skills';
import { expectAccessible, renderAt } from '../test-utils';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const fetchWith = (skills: SkillsMockOptions = {}) =>
  mockFetch(undefined, undefined, undefined, undefined, { features: { skills } });

const skillPath = (id: string) => `#/building-blocks/skill/${id}`;

const openSkill = async (
  id: string,
  title: string,
  skills: SkillsMockOptions = {},
  suffix = '',
) => {
  await renderAt(`${skillPath(id)}${suffix}`, fetchWith(skills));
  await screen.findByRole('heading', { level: 1, name: title });
};

const openWith = async (id: string, title: string, fetch: typeof globalThis.fetch) => {
  await renderAt(skillPath(id), fetch);
  await screen.findByRole('heading', { level: 1, name: title });
};

const tab = async (name: RegExp) => {
  fireEvent.click(screen.getByRole('tab', { name }));
  await waitFor(() =>
    expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('true'),
  );
};

const region = (name: string) => screen.getByRole('region', { name });

const cases = () => within(screen.getByRole('list', { name: 'Testtilfeller' }));

const urlOf = (input: Parameters<typeof globalThis.fetch>[0]) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const problem = (status: number, title = 'Feil') =>
  Promise.resolve(
    new Response(JSON.stringify({ type: 'about:blank', title, status }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    }),
  );

describe('Ferdighet under Byggeklosser', () => {
  it('edits the skill as YAML in a tab after Versjoner, kept until Lagre', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde', {}, '/yaml');
    const tabs = screen.getAllByRole('tab').map((x) => x.textContent);
    expect(tabs.slice(-2)).toEqual(['Versjoner', 'YAML']);
    const box = screen.getByLabelText('Ferdighetsdefinisjon (YAML)') as HTMLTextAreaElement;
    expect(box.value).toContain('apiVersion: genai/v1');
    expect(box.value).toContain('kind: Skill');
    expect(
      screen.getByRole('button', { name: 'Bruk endringene' }).getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.change(box, {
      target: {
        value: box.value.replace('name: Sortere post etter saksområde', 'name: Sortere post'),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));
    expect(screen.getByText('Endringene er brukt i ferdigheten.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Sortere post' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Ulagrede endringer' })).toBeTruthy();
    expectAccessible();
  });

  it('opens Prøv beside the tabs once the skill has a published version', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    const button = screen.getByRole('button', { name: 'Prøv' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.skill-layout .skill-try [data-context="skill"]')).toBeTruthy();
    expect(
      await screen.findByText(
        'Med ferdigheten Skrive vedtaksbrev slik den er i siste publiserte versjon',
      ),
    ).toBeTruthy();
  });

  it('Prøv waits for a published version and says why', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav');
    const unpublished = screen.getByRole('button', { name: 'Prøv' });
    expect(unpublished.getAttribute('aria-disabled')).toBe('true');
    expect(unpublished.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      screen.getByText('Du kan prøve ferdigheten når den har en publisert versjon.'),
    ).toBeTruthy();
    fireEvent.click(unpublished);
    expect(document.querySelector('.skill-try')).toBeNull();
  });

  it('exports the skill package from the Flere valg menu', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    fireEvent.click(screen.getByRole('button', { name: 'Flere valg for ferdigheten' }));
    fireEvent.click(screen.getByRole('button', { name: 'Eksporter pakke', hidden: true }));
    expect(await screen.findByText(/^Pakken skrive-vedtaksbrev\.zip er lastet ned\./)).toBeTruthy();
  });

  it('an old skill address is replaced by the address under Byggeklosser', async () => {
    await renderAt('#/skills?id=klarsprak-i-brev&owner=991825827', fetchWith());
    await screen.findByRole('heading', { level: 1, name: 'Klarspråk i brev' });
    expect(window.location.hash).toBe('#/building-blocks/skill/klarsprak-i-brev?owner=991825827');
  });

  it('the old skill list address goes to Byggeklosser filtered on skills', async () => {
    await renderAt('#/skills', fetchWith());
    await waitFor(() => expect(window.location.hash).toBe('#/building-blocks/in-use?type=skill'));
  });

  it('shows the header from the design with one back link, maker, version and unpublished changes', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    const back = within(screen.getByRole('main')).getByRole('link', { name: 'Byggeklosser' });
    expect(back.getAttribute('href')).toBe('#/building-blocks/in-use');
    expect(screen.queryByRole('navigation', { name: /brødsmule|breadcrumb/i })).toBeNull();
    expect(screen.getByText('Ferdighet · laget av Per Hansen')).toBeTruthy();
    expect(screen.getByText('Publisert, versjon 3')).toBeTruthy();
    expect(screen.getByText('Endringer ikke publisert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publiser' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('href')]);
    expect(tabs).toEqual([
      ['Oppsett', '#/building-blocks/skill/skrive-vedtaksbrev'],
      ['Testsett', '#/building-blocks/skill/skrive-vedtaksbrev/tests'],
      ['Bruk og deling', '#/building-blocks/skill/skrive-vedtaksbrev/sharing'],
      ['Versjoner', '#/building-blocks/skill/skrive-vedtaksbrev/versions'],
      ['YAML', '#/building-blocks/skill/skrive-vedtaksbrev/yaml'],
    ]);
    expect(screen.getByText('Malbrev vedtak.docx')).toBeTruthy();
    expectAccessible();
  });

  it('opens the tab named in the address and moves between tabs with the arrow keys', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', {}, '/versions');
    const versions = screen.getByRole('tab', { name: 'Versjoner' });
    expect(versions.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(versions, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(window.location.hash).toBe('#/building-blocks/skill/skrive-vedtaksbrev/sharing'),
    );
    expect(await screen.findByRole('heading', { name: 'Brukes i 1 tjeneste' })).toBeTruthy();
  });

  it('says there is nothing to publish when the draft equals the published version', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde');
    expect(screen.queryByText('Endringer ikke publisert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Det er ingen endringer å publisere.');
  });

  it('shows the error from the design when the skill cannot be fetched, and retries', async () => {
    let fail = true;
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) =>
      fail && /\/skills\/sortere-post$/.test(urlOf(input)) ? problem(500) : base(input, init);
    await renderAt(skillPath('sortere-post'), fetch);
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Vi fikk ikke hentet ferdigheten' }),
    ).toBeTruthy();
    expect(alert.textContent).toContain('Det er bare visningen her som mangler.');
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Byggeklosser' }),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Prøv igjen' }));
    await screen.findByRole('heading', { level: 1, name: 'Sortere post etter saksområde' });
  });

  it('keeps edits local until Lagre endringene, which saves with If-Match', async () => {
    const calls: { method: string; url: string; ifMatch: string | null }[] = [];
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: urlOf(input),
        ifMatch: new Headers(init?.headers).get('if-match'),
      });
      return base(input, init);
    };
    await openWith('sortere-post', 'Sortere post etter saksområde', fetch);
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Sortere post' } });
    const bar = region('Ulagrede endringer');
    expect(within(bar).getByText('Du har endringer som ikke er lagret')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(
      await screen.findByText(/^Lagret kl\. \d\d[.:]\d\d\. Endringene er ikke publisert ennå\.$/),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/tenants/999888777/skills/sortere-post',
      ifMatch: '"4"',
    });
    expect(screen.queryByRole('region', { name: 'Ulagrede endringer' })).toBeNull();
    expectAccessible();
  });

  it('asks before leaving the skill with unsaved changes, and stays when asked to', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde');
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Sortere post' } });
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    const away = within(menu).getByRole('link', { name: 'Byggeklosser' });
    fireEvent.click(away);
    const dialog = await screen.findByRole('dialog', { name: 'Forlate ferdigheten uten å lagre?' });
    expect(window.location.hash).toBe('#/building-blocks/skill/sortere-post');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bli på siden' }));
    expect((screen.getByLabelText('Navn') as HTMLInputElement).value).toBe('Sortere post');
    fireEvent.click(away);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Forlat uten å lagre',
      }),
    );
    await waitFor(() => expect(window.location.hash).toBe(away.getAttribute('href')));
  });

  it('moves between the tabs of the same skill without asking', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde');
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Sortere post' } });
    await tab(/Versjoner/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Ulagrede endringer' })).toBeTruthy();
  });

  it('Forkast puts back what was saved', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde');
    const name = screen.getByLabelText('Navn') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Noe annet' } });
    fireEvent.click(within(region('Ulagrede endringer')).getByRole('button', { name: 'Forkast' }));
    expect(name.value).toBe('Sortere post etter saksområde');
    expect(screen.queryByRole('region', { name: 'Ulagrede endringer' })).toBeNull();
  });

  it('a save someone else got to first shows the conflict and keeps the edit', async () => {
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'PUT' ? problem(409) : base(input, init);
    await openWith('sortere-post', 'Sortere post etter saksområde', fetch);
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Sortere post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Noen andre har endret utkastet/,
    );
    expect((screen.getByLabelText('Navn') as HTMLInputElement).value).toBe('Sortere post');
  });

  it("the build assistant's suggestion changes nothing until Legg til i beskrivelsen", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const base = fetchWith();
    const recording: typeof fetch = (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/assistant/turns'))
        calls.push({ path, body: JSON.parse(String(init?.body)) as unknown });
      return base(input, init);
    };
    await openWith('svare-pa-innsynskrav', 'Svare på innsynskrav', recording);
    const what = region('Hva ferdigheten gjør');
    const field = within(what).getByRole('textbox', { name: 'Beskrivelse' }) as HTMLTextAreaElement;
    const ask = within(what).getByRole('button', { name: 'Når bør tjenester bruke den?' });
    fireEvent.click(ask);
    expect(ask.getAttribute('aria-expanded')).toBe('true');
    expect(within(what).getByRole('status').textContent).toContain('Assistenten skriver');
    expect(await within(what).findByText(/offentleglova/, {}, { timeout: 2000 })).toBeTruthy();
    expect(within(what).getByText('Forslag fra byggeassistenten')).toBeTruthy();
    expect(field.value).toBe('Svar på innsynskrav.');
    expectAccessible();
    fireEvent.click(within(what).getByRole('button', { name: 'Legg til i beskrivelsen' }));
    expect(field.value).toMatch(/offentleglova/);
    expect(ask.getAttribute('aria-expanded')).toBe('false');
    expect(region('Ulagrede endringer')).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      intent: 'suggest-description',
      draft: { definition: { kind: 'Skill' } },
    });
  });

  it('Lukk closes the suggestion and leaves the field as it was', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav');
    const what = region('Hva ferdigheten gjør');
    fireEvent.click(within(what).getByRole('button', { name: 'Når bør tjenester bruke den?' }));
    await within(what).findByText(/offentleglova/, {}, { timeout: 2000 });
    fireEvent.click(within(what).getByRole('button', { name: 'Lukk' }));
    expect(within(what).queryByText('Forslag fra byggeassistenten')).toBeNull();
    expect(
      (within(what).getByRole('textbox', { name: 'Beskrivelse' }) as HTMLTextAreaElement).value,
    ).toBe('Svar på innsynskrav.');
  });

  it('a budget-exhausted assistant shows the message and changes nothing', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav', {
      assistant: { status: 'budget_exhausted' },
    });
    const what = region('Hva ferdigheten gjør');
    fireEvent.click(within(what).getByRole('button', { name: 'Når bør tjenester bruke den?' }));
    const alert = await within(what).findByRole('alert');
    expect(alert.textContent).toMatch(/brukt opp dagens kvote på 200\s000 tokens/);
    expect(within(what).queryByRole('button', { name: 'Legg til i beskrivelsen' })).toBeNull();
    expectAccessible();
  });

  it('a refused assistant turn names the missing right', async () => {
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input).endsWith('/assistant/turns')
        ? problem(403, 'Du trenger rettigheten «Administrere tjenester»')
        : base(input, init);
    await openWith('svare-pa-innsynskrav', 'Svare på innsynskrav', fetch);
    const what = region('Hva ferdigheten gjør');
    fireEvent.click(within(what).getByRole('button', { name: 'Når bør tjenester bruke den?' }));
    expect((await within(what).findByRole('alert')).textContent).toBe(
      'Du trenger rettigheten «Administrere tjenester»',
    );
  });

  it('rejected changes are shown as cards and never applied', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav', {
      assistant: {
        rejected: [
          {
            attempted: 'Satte maks lengde til 50 000 tegn',
            reason: 'Grensen er 20 000 tegn.',
            code: 'VALIDATION_MAXIMUM',
          },
        ],
      },
    });
    const examples = region('Eksempler');
    const before = within(examples).queryAllByRole('group').length;
    fireEvent.click(within(examples).getByRole('button', { name: 'Hvilke eksempler mangler?' }));
    expect(await within(examples).findByText('Avvist av plattformen, ikke brukt')).toBeTruthy();
    expect(within(examples).getByText('VALIDATION_MAXIMUM')).toBeTruthy();
    expect(within(examples).queryAllByRole('group')).toHaveLength(before);
    fireEvent.click(within(examples).getByRole('button', { name: 'Legg til eksemplene' }));
    expect(within(examples).getAllByRole('group').length).toBeGreaterThan(before);
    expectAccessible();
  });

  it('counts the instruction characters', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav');
    fireEvent.change(screen.getByRole('textbox', { name: 'Instruksjoner til modellen' }), {
      target: { value: 'Kort.' },
    });
    expect(screen.getByText('5 tegn')).toBeTruthy();
  });

  it('shows failed cases with their note and lets the assistant fix the instructions', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { failing: true }, '/tests');
    expect(screen.getByRole('heading', { level: 2, name: 'Testsett' })).toBeTruthy();
    expect(screen.getByText(/^10 saker · sist kjørt .*: 8 av 10 bestått$/)).toBeTruthy();
    expect(cases().getAllByText('Ikke bestått')).toHaveLength(2);
    expect(cases().getByText('Utkastet nevner ikke klagefristen på tre uker.')).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Be assistenten rette instruksjonene' }));
    const proposal = await screen.findByRole('region', {
      name: 'Assistentens forslag til instruksjonene',
    });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Bruk endringen' }));
    await screen.findByText(
      /Assistenten har rettet instruksjonene i utkastet/,
      {},
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    expect(
      await screen.findByText(
        '10 av 10 bestått med utkastet. Forrige versjon: 10 av 10.',
        {},
        { timeout: 2000 },
      ),
    ).toBeTruthy();
  });

  it('shows the instruction fix as a diff and writes nothing until Bruk endringen', async () => {
    const calls: { method: string; path: string }[] = [];
    const base = fetchWith({ failing: true });
    const fetch: typeof globalThis.fetch = (input, init) => {
      calls.push({ method: init?.method ?? 'GET', path: urlOf(input).replace(/^\/api/, '') });
      return base(input, init);
    };
    await renderAt(`${skillPath('skrive-vedtaksbrev')}/tests`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    fireEvent.click(screen.getByRole('button', { name: 'Be assistenten rette instruksjonene' }));
    const proposal = await screen.findByRole('region', {
      name: 'Assistentens forslag til instruksjonene',
    });
    const skill = '/tenants/999888777/skills/skrive-vedtaksbrev';
    expect(calls.filter((c) => c.method === 'POST' && c.path === `${skill}/fix`)).toHaveLength(1);
    expect(calls.some((c) => c.path.includes('/apply'))).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(proposal).getByRole('button', { name: 'Forkast' }));
    expect(
      screen.queryByRole('region', { name: 'Assistentens forslag til instruksjonene' }),
    ).toBeNull();
    await tab(/Oppsett/);
    expect(
      (screen.getByRole('textbox', { name: 'Instruksjoner til modellen' }) as HTMLTextAreaElement)
        .value,
    ).not.toMatch(/klagefrist/i);
  });

  it('adds a test case with source text and a dataset, saved by Lagre endringene', async () => {
    const puts: unknown[] = [];
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return base(input, init);
    };
    await renderAt(`${skillPath('svare-pa-innsynskrav')}/tests`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Svare på innsynskrav' });
    fireEvent.click(screen.getByRole('button', { name: 'Lag et testsett' }));
    const form = screen.getByRole('group', { name: 'Nytt testtilfelle' });
    fireEvent.change(within(form).getByLabelText('Inn'), { target: { value: 'Hva er fristen?' } });
    fireEvent.change(within(form).getByLabelText('Forventet'), { target: { value: 'Tre uker' } });
    fireEvent.change(within(form).getByLabelText(/Tekst ferdigheten får som kilde/), {
      target: { value: 'Klagefristen er tre uker.' },
    });
    const dataset = within(form).getByLabelText('Datasett (valgfritt)') as HTMLSelectElement;
    await waitFor(() => expect(dataset.options.length).toBeGreaterThan(1));
    const option = Array.from(dataset.options).find((o) => o.value) as HTMLOptionElement;
    fireEvent.change(dataset, { target: { value: option.value } });
    fireEvent.click(within(form).getByRole('button', { name: 'Legg til' }));
    const item = cases()
      .getByText(/Hva er fristen/)
      .closest('li') as HTMLElement;
    expect(within(item).getByText('Med kildetekst')).toBeTruthy();
    expect(within(item).getByText(`Datasett: ${option.text}`)).toBeTruthy();
    expect(puts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    await waitFor(() =>
      expect(puts.at(-1)).toMatchObject({
        definition: {
          spec: {
            testset: {
              cases: [
                {
                  input: 'Hva er fristen?',
                  context: 'Klagefristen er tre uker.',
                  dataset: option.value,
                },
              ],
            },
          },
        },
      }),
    );
    expectAccessible();
  });

  it('an empty test set offers Lag et testsett and validates the new case', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav', {}, '/tests');
    expect(screen.getByRole('heading', { name: 'Ingen testsett ennå' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lag et testsett' }));
    const form = screen.getByRole('group', { name: 'Nytt testtilfelle' });
    fireEvent.click(within(form).getByRole('button', { name: 'Legg til' }));
    expect(screen.getByText('Fyll ut både inn og forventet.')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Inn'), { target: { value: 'Krav om innsyn' } });
    fireEvent.change(within(form).getByLabelText('Forventet'), { target: { value: 'Avslag' } });
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'must_reject' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Legg til' }));
    const item = cases()
      .getByText(/Krav om innsyn/)
      .closest('li') as HTMLElement;
    expect(within(item).getByText('Skal avvise')).toBeTruthy();
    expectAccessible();
  });

  it('deletes a test case through the API with If-Match', async () => {
    const deletes: { path: string; ifMatch: string | null }[] = [];
    const base = fetchWith({ failing: true });
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (init?.method === 'DELETE')
        deletes.push({
          path: urlOf(input).replace(/^\/api/, ''),
          ifMatch: new Headers(init.headers).get('if-match'),
        });
      return base(input, init);
    };
    await renderAt(`${skillPath('skrive-vedtaksbrev')}/tests`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    const before = cases().getAllByRole('listitem').length;
    fireEvent.click(
      cases().getAllByRole('button', { name: /^Slett testtilfellet/ })[0] as HTMLElement,
    );
    await screen.findByText('Testtilfellet er slettet fra utkastet.');
    expect(deletes).toEqual([
      {
        path: '/tenants/999888777/skills/skrive-vedtaksbrev/testcases/0',
        ifMatch: expect.stringMatching(/^"\d+"$/),
      },
    ]);
    expect(cases().getAllByRole('listitem')).toHaveLength(before - 1);
  });

  it('gives the reason for deleting a test case in the language the user has chosen', async () => {
    const reasons: (string | null)[] = [];
    const base = mockFetch(undefined, undefined, undefined, undefined, {
      features: { skills: { failing: true }, preferences: { language: 'en' } },
    });
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (init?.method === 'DELETE') {
        const raw = new Headers(init.headers).get('change-reason');
        reasons.push(raw === null ? null : decodeURIComponent(raw));
      }
      return base(input, init);
    };
    await renderAt(`${skillPath('skrive-vedtaksbrev')}/tests`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    fireEvent.click(
      (await screen.findAllByRole('button', { name: /^Delete the test case/ }))[0] as HTMLElement,
    );
    await waitFor(() => expect(reasons).toEqual(['Deleted a test case']));
  });

  it('a failed delete shows a danger alert, not a success message', async () => {
    const base = fetchWith({ failing: true });
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'DELETE' ? problem(500) : base(input, init);
    await renderAt(`${skillPath('skrive-vedtaksbrev')}/tests`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    fireEvent.click(
      cases().getAllByRole('button', { name: /^Slett testtilfellet/ })[0] as HTMLElement,
    );
    const alert = (
      await screen.findByText('Vi kunne ikke slette testtilfellet. Prøv igjen om litt.')
    ).closest('[data-color]') as HTMLElement;
    expect(alert.getAttribute('data-color')).toBe('danger');
    expect(alert.getAttribute('role')).toBe('alert');
  });

  it('the stale-result alert appears after editing', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { failing: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instruksjoner til modellen' }), {
      target: { value: '# Skrive vedtaksbrev\n\nNy tekst.' },
    });
    await tab(/Testsett/);
    expect(screen.getByText(/Utkastet eller dommeren er endret siden siste kjøring/)).toBeTruthy();
    expect(cases().getAllByText('Ikke kjørt')).toHaveLength(10);
    expectAccessible();
  });

  it('a run the API marks stale for an earlier judge does not count on the current draft', async () => {
    await openSkill(
      'skrive-vedtaksbrev',
      'Skrive vedtaksbrev',
      { failing: true, judgeChanged: true },
      '/tests',
    );
    expect(screen.getByText(/Utkastet eller dommeren er endret siden siste kjøring/)).toBeTruthy();
    expect(cases().getAllByText('Ikke kjørt')).toHaveLength(10);
  });

  it('a blocked publish lists the requirements, disables publishing and links to the test set', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { failing: true });
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publiser Skrive vedtaksbrev' });
    await within(dialog).findByText(/Publiseringen er stoppet fordi 1 krav ikke er oppfylt/);
    const gates = within(dialog).getByRole('list', { name: 'Krav før publisering' });
    expect(within(gates).getAllByRole('listitem')).toHaveLength(4);
    const publish = within(dialog).getByRole('button', { name: 'Publiser versjon 4' });
    expect(publish.getAttribute('aria-disabled')).toBe('true');
    expect(
      (within(dialog).getByLabelText('Hvorfor endrer du dette?') as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gå til testsettet' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(window.location.hash).toBe('#/building-blocks/skill/skrive-vedtaksbrev/tests'),
    );
  });

  it('publishes after a passing run with a reason and says when the services get it', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', {}, '/tests');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByText(/10 av 10 bestått med utkastet/);
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publiser Skrive vedtaksbrev' });
    expect(
      within(dialog).getByText(
        'Versjon 4 blir den som brukes. Vedtaksutkast får den neste gang tjenesten publiseres.',
      ),
    ).toBeTruthy();
    const publish = within(dialog).getByRole('button', { name: 'Publiser versjon 4' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(publish);
    expect(within(dialog).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Hvorfor endrer du dette?'), {
      target: { value: 'Ny versjon med flere eksempler' },
    });
    fireEvent.click(publish);
    expect(
      await screen.findByText(
        'Versjon 4 er publisert. Vedtaksutkast får den neste gang tjenesten publiseres.',
      ),
    ).toBeTruthy();
    await screen.findByText('Publisert, versjon 4');
    expect(screen.queryByText('Endringer ikke publisert')).toBeNull();
  });

  it('a publish refused for a missing right says which right and that the changes are saved', async () => {
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'POST' && urlOf(input).endsWith('/publish')
        ? problem(403)
        : base(input, init);
    await openWith('skrive-vedtaksbrev', 'Skrive vedtaksbrev', fetch);
    await tab(/Testsett/);
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByText(/10 av 10 bestått med utkastet/);
    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publiser Skrive vedtaksbrev' });
    fireEvent.change(within(dialog).getByLabelText('Hvorfor endrer du dette?'), {
      target: { value: 'Ny versjon med flere eksempler' },
    });
    const publish = within(dialog).getByRole('button', { name: 'Publiser versjon 4' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(publish);
    const alert = await within(dialog).findByRole('alert');
    expect(
      within(alert).getByRole('heading', { name: 'Du har ikke lov til å publisere ferdigheter' }),
    ).toBeTruthy();
    expect(alert.textContent).toContain('«Administrere tjenester» i Altinn');
  });

  it('closing the publish dialog puts focus back on the publish button', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    const trigger = screen.getByRole('button', { name: 'Publiser' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Publiser Skrive vedtaksbrev' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('lists the services that use the skill with the version they use', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', {}, '/sharing');
    await screen.findByRole('heading', { name: 'Brukes i 1 tjeneste' });
    const link = screen.getByRole('link', { name: 'Vedtaksutkast' });
    expect(link.getAttribute('href')).toBe('#/services/vedtaksutkast');
    expect(screen.getByText('Bruker versjon 3')).toBeTruthy();
  });

  it('choosing all organisations asks for the confirmation and a reason before it goes to Digdir', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', {}, '/sharing');
    const group = await screen.findByRole('group', { name: 'Hvem kan bruke den' });
    expect(
      (within(group).getByRole('radio', { name: /Bare Testetaten/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(group).getByRole('radio', { name: /Alle virksomheter i genki/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send til Digdir' }));
    expect(screen.getByText('Bekreft at ferdigheten kan deles.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /inneholder ikke personopplysninger/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send til Digdir' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Andre etater skriver samme vedtak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send til Digdir' }));
    await screen.findByText('Forespørselen er sendt til Digdir.');
    expect(screen.getByText('Venter på at Digdir godkjenner delingen.')).toBeTruthy();
    expectAccessible();
    fireEvent.click(within(group).getByRole('radio', { name: /Bare Testetaten/ }));
    await screen.findByText('Forespørselen om deling er trukket tilbake.');
    expect(
      (within(group).getByRole('radio', { name: /Bare Testetaten/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('says Digdir turned down the last request and lets the skill be shared again', async () => {
    const skills = exampleSkillRecords().map((r) =>
      r.id === 'skrive-vedtaksbrev' ? { ...r, share: 'rejected' as const } : r,
    );
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { skills }, '/sharing');
    expect(await screen.findByText(/Digdir avslo forrige forespørsel om deling/)).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: /Alle virksomheter i genki/ }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it('cannot share an unpublished skill', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav', {}, '/sharing');
    const all = (await screen.findByRole('radio', {
      name: /Alle virksomheter i genki/,
    })) as HTMLInputElement;
    expect(all.disabled).toBe(true);
    expect(screen.getByText('Publiser ferdigheten før du deler den.')).toBeTruthy();
  });

  it('says so when withdrawing the share request fails', async () => {
    const skills = exampleSkillRecords().map((r) =>
      r.id === 'skrive-vedtaksbrev' ? { ...r, share: 'pending_digdir' as const } : r,
    );
    const base = fetchWith({ skills });
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'DELETE'
        ? Promise.resolve(new Response('{}', { status: 503 }))
        : base(input, init);
    await renderAt(`${skillPath('skrive-vedtaksbrev')}/sharing`, fetch);
    fireEvent.click(await screen.findByRole('radio', { name: /Bare Testetaten/ }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Vi kunne ikke trekke tilbake forespørselen. Prøv igjen om litt.',
    );
  });

  it('lists versions newest first with who, when, which is in use and the reason', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', {}, '/versions');
    const items = within(screen.getByRole('list', { name: 'Versjoner' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toMatch(/^Versjon 3 · .* av Kari Nordmann · i bruk/);
    expect(items[2]?.textContent).toMatch(/^Versjon 1 · .* av Per Hansen/);
    expect(items[2]?.textContent).not.toContain('i bruk');
    expectAccessible();
  });

  it("someone else's skill is read-only, and Lag en kopi lands on the copy's address", async () => {
    await openSkill('klarsprak-i-brev', 'Klarspråk i brev', {}, '?owner=991825827');
    expect(
      screen.getByText(/Denne ferdigheten er laget av Digdir\. Du kan bruke og prøve den/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publiser' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Når bør tjenester bruke den?' })).toBeNull();
    expect(
      (screen.getByRole('textbox', { name: 'Instruksjoner til modellen' }) as HTMLTextAreaElement)
        .readOnly,
    ).toBe(true);
    expect(screen.getByText('Ferdighet · laget av Digdir')).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Lag en kopi' }));
    await screen.findByRole('button', { name: 'Publiser' });
    expect(window.location.hash).toBe('#/building-blocks/skill/klarsprak-i-brev');
    expect(screen.getByRole('heading', { level: 1, name: 'Klarspråk i brev' })).toBeTruthy();
  });

  it('creates, edits, tests and publishes a skill through the API paths and shapes', async () => {
    const calls: {
      method: string;
      path: string;
      body: unknown;
      headers: Headers;
      reply: unknown;
    }[] = [];
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await base(input, init);
      calls.push({
        method: init?.method ?? 'GET',
        path: urlOf(input).replace(/^\/api/, ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        reply: await response
          .clone()
          .json()
          .catch(() => undefined),
      });
      return response;
    };
    const skill = '/tenants/999888777/skills/ny-ferdighet';
    const last = (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path).at(-1);

    await renderAt('#/building-blocks/in-use?type=skill', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Ny ferdighet' }));
    await screen.findByRole('heading', { level: 1, name: 'Ny ferdighet' });
    expect(window.location.hash).toBe('#/building-blocks/skill/ny-ferdighet');
    expect(screen.getByText('Ikke publisert')).toBeTruthy();
    expect(last('POST', '/tenants/999888777/skills')).toMatchObject({
      body: { id: 'ny-ferdighet', name: '' },
      reply: { id: 'ny-ferdighet', version: null, draft: { revision: 1 } },
    });

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Svare på klager' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Beskrivelse' }), {
      target: { value: 'Bruk når noen klager på et vedtak.' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instruksjoner til modellen' }), {
      target: { value: '# Svare på klager\n\nSvar kort.' },
    });
    await tab(/Testsett/);
    fireEvent.click(screen.getByRole('button', { name: 'Lag et testsett' }));
    const form = screen.getByRole('group', { name: 'Nytt testtilfelle' });
    fireEvent.change(within(form).getByLabelText('Inn'), { target: { value: 'Klage på avslag' } });
    fireEvent.change(within(form).getByLabelText('Forventet'), {
      target: { value: 'Svar med klagefrist' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Legg til' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByText('1 av 1 bestått med utkastet.');
    const saved = calls.filter((c) => c.method === 'PUT' && c.path === skill);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.headers.get('if-match')).toBe('"1"');
    expect(saved[0]).toMatchObject({
      body: {
        definition: {
          metadata: { id: 'ny-ferdighet', name: 'Svare på klager' },
          spec: { testset: { cases: [{ input: 'Klage på avslag', type: 'criteria' }] } },
        },
      },
    });
    expect(last('POST', `${skill}/test-runs`)).toMatchObject({
      reply: { draftRevision: 2, passed: 1, total: 1 },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publiser Svare på klager' });
    const publish = within(dialog).getByRole('button', { name: 'Publiser versjon 1' });
    await waitFor(() => expect(publish.getAttribute('aria-disabled')).toBeNull());
    expect(last('GET', `${skill}/requirements`)?.reply).toMatchObject({
      requirements: [
        { id: 'tested-on-draft', met: true },
        { id: 'pass-rate', met: true },
        { id: 'must-reject', met: true },
        { id: 'published-tools', met: true },
      ],
    });
    fireEvent.change(within(dialog).getByLabelText('Hvorfor endrer du dette?'), {
      target: { value: 'Første versjon for klagesaker' },
    });
    fireEvent.click(publish);
    await screen.findByText('Versjon 1 er publisert.');
    await screen.findByText('Publisert, versjon 1');
    const published = last('POST', `${skill}/publish`);
    expect(decodeURIComponent(published?.headers.get('change-reason') ?? '')).toBe(
      'Første versjon for klagesaker',
    );
    expect(published?.reply).toMatchObject({ ok: true, version: 1 });
  });
});
