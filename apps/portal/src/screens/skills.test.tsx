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

const openSkill = async (id: string, title: string, skills: SkillsMockOptions = {}) => {
  await renderAt(`#/skills?id=${id}`, fetchWith(skills));
  await screen.findByRole('heading', { level: 1, name: title });
};

const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));

const region = (name: string) => screen.getByRole('region', { name });

describe('Ferdigheter', () => {
  it('lists skills with version, publisher, users and status', async () => {
    await renderAt('#/skills', fetchWith());
    await screen.findByRole('heading', { level: 1, name: 'Ferdigheter' });
    const table = await screen.findByRole('table');
    const vedtak = within(table).getByRole('row', { name: /Skrive vedtaksbrev/ });
    expect(within(vedtak).getByText('Publisert')).toBeTruthy();
    expect(within(vedtak).getByText('Utkast til 4')).toBeTruthy();
    expect(within(vedtak).getByText('Vedtaksutkast')).toBeTruthy();
    const klar = within(table).getByRole('row', { name: /Klarspråk i brev/ });
    expect(within(klar).getByText('Digdir')).toBeTruthy();
    expect(within(klar).getByText('Delt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ny ferdighet' })).toBeTruthy();
    expect(screen.getByLabelText('Importer pakke')).toBeTruthy();
    expectAccessible();
  });

  it('creates a new skill and opens it in the editor', async () => {
    await renderAt('#/skills', fetchWith());
    fireEvent.click(await screen.findByRole('button', { name: 'Ny ferdighet' }));
    await screen.findByRole('heading', { level: 1, name: 'Ny ferdighet' });
    expect(
      screen.getByText(/Ikke publisert · utkast til versjon 1 · utgiver Testetaten/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publiser versjon 1' })).toBeTruthy();
    expect(screen.getByText('Ingen eksempler ennå.')).toBeTruthy();
    expectAccessible();
  });

  it('shows the editor header and tabs for a published skill with a draft', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    expect(
      screen.getByText('Versjon 3 i bruk · utkast til versjon 4 · utgiver Testetaten'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publiser versjon 4' })).toBeTruthy();
    for (const name of ['Oppsett', 'Testsett', 'Bruk og deling', 'YAML', 'Versjoner'])
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeTruthy();
    expect(screen.getAllByLabelText('Versjon')).toHaveLength(2);
    expect(screen.getByText('Malbrev vedtak.docx')).toBeTruthy();
    expectAccessible();
  });

  it('says there is nothing to publish when the draft equals the published version', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde');
    const button = screen.getByRole('button', { name: 'Ingen endringer å publisere' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Be assistenten foreslå shows a change card from the API and Angre restores the field', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const base = fetchWith();
    const recording: typeof fetch = (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/assistant/turns'))
        calls.push({ path, body: JSON.parse(String(init?.body)) as unknown });
      return base(input, init);
    };
    await renderAt('#/skills?id=svare-pa-innsynskrav', recording);
    await screen.findByRole('heading', { level: 1, name: 'Svare på innsynskrav' });
    const description = screen.getByRole('region', { name: 'Når skal ferdigheten brukes?' });
    fireEvent.click(within(description).getByRole('button', { name: 'Be assistenten foreslå' }));
    expect(within(description).getByRole('status').textContent).toContain('Assistenten skriver');
    await within(description).findByText('Forslag fra assistenten', {}, { timeout: 2000 });
    const field = screen.getByRole('textbox', {
      name: 'Når skal ferdigheten brukes?',
    }) as HTMLTextAreaElement;
    expect(field.value).toMatch(/offentleglova/);
    fireEvent.click(within(description).getByRole('button', { name: 'Vis endring' }));
    expect(within(description).getByText('Før')).toBeTruthy();
    expect(within(description).getByText('Svar på innsynskrav.')).toBeTruthy();
    expectAccessible();
    fireEvent.click(within(description).getByRole('button', { name: 'Angre' }));
    expect(within(description).getByText('Angret')).toBeTruthy();
    expect(within(description).getByText('Foreslo en ny beskrivelse').className).toContain(
      'undone',
    );
    expect(within(description).queryByRole('button', { name: 'Angre' })).toBeNull();
    expect(field.value).toBe('Svar på innsynskrav.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toMatch(/\/skills\/svare-pa-innsynskrav\/assistant\/turns$/);
    expect(calls[0]?.body).toMatchObject({
      intent: 'suggest-description',
      draft: { definition: { kind: 'Skill' } },
    });
  });

  it('a budget-exhausted assistant shows the message and changes nothing', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav', {
      assistant: { status: 'budget_exhausted' },
    });
    const description = screen.getByRole('region', { name: 'Når skal ferdigheten brukes?' });
    const field = screen.getByRole('textbox', {
      name: 'Når skal ferdigheten brukes?',
    }) as HTMLTextAreaElement;
    fireEvent.click(within(description).getByRole('button', { name: 'Be assistenten foreslå' }));
    const alert = await within(description).findByRole('alert');
    expect(alert.textContent).toMatch(/brukt opp dagens kvote på 200\s000 tokens/);
    expect(alert.textContent).toContain('Ingenting er endret');
    expect(within(description).queryByText('Forslag fra assistenten')).toBeNull();
    expect(field.value).toBe('Svar på innsynskrav.');
    expectAccessible();
  });

  it('a refused assistant turn names the missing right', async () => {
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input).endsWith('/assistant/turns')
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'about:blank',
                title: 'Du trenger rettigheten «Administrere tjenester»',
                status: 403,
              }),
              { status: 403, headers: { 'content-type': 'application/problem+json' } },
            ),
          )
        : base(input, init);
    await renderAt('#/skills?id=svare-pa-innsynskrav', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Svare på innsynskrav' });
    const description = screen.getByRole('region', { name: 'Når skal ferdigheten brukes?' });
    fireEvent.click(within(description).getByRole('button', { name: 'Be assistenten foreslå' }));

    expect((await within(description).findByRole('alert')).textContent).toBe(
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
    const examples = screen.getByRole('region', { name: 'Eksempler' });
    const before = within(examples).queryAllByRole('group').length;
    fireEvent.click(within(examples).getByRole('button', { name: 'Be assistenten foreslå' }));
    expect(await within(examples).findByText('Avvist av plattformen, ikke brukt')).toBeTruthy();
    expect(within(examples).getByText('VALIDATION_MAXIMUM')).toBeTruthy();
    expect(within(examples).getByText('Forslag fra assistenten')).toBeTruthy();
    expect(within(examples).getAllByRole('group').length).toBeGreaterThan(before);
    expectAccessible();
  });

  it('shows failed cases, the tab badge and lets the assistant fix the instructions', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { failing: true });
    expect(screen.getByRole('tab', { name: /Testsett.*2 feilet/ })).toBeTruthy();
    tab(/Testsett/);
    expect(screen.getByText('8 av 10 bestått (80 prosent)')).toBeTruthy();
    expect(screen.getByText('Krav for publisering: minst 90 prosent')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '2 testtilfeller feilet' })).toBeTruthy();
    expect(screen.getAllByText('Utkastet nevner ikke klagefristen på tre uker.').length).toBe(2);
    expect(within(region('Testtilfeller')).getAllByText('Feilet')).toHaveLength(2);
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Be assistenten rette instruksjonene' }));
    const proposal = await screen.findByRole('region', {
      name: 'Assistentens forslag til instruksjonene',
    });
    expect(within(proposal).getAllByText('Legges til').length).toBeGreaterThan(0);
    fireEvent.click(within(proposal).getByRole('button', { name: 'Bruk endringen' }));
    await screen.findByText(
      /Assistenten har rettet instruksjonene i utkastet/,
      {},
      { timeout: 2000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByText('10 av 10 bestått (100 prosent)', {}, { timeout: 2000 });
  });

  it('shows the instruction fix as a diff and writes nothing until Bruk endringen', async () => {
    const calls: { method: string; path: string }[] = [];
    const base = fetchWith({ failing: true });
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ method: init?.method ?? 'GET', path: url.replace(/^\/api/, '') });
      return base(input, init);
    };
    await renderAt('#/skills?id=skrive-vedtaksbrev', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    tab(/Testsett/);
    fireEvent.click(screen.getByRole('button', { name: 'Be assistenten rette instruksjonene' }));
    const proposal = await screen.findByRole('region', {
      name: 'Assistentens forslag til instruksjonene',
    });
    expect(within(proposal).getByRole('list', { name: 'Endringer i instruksjoner' })).toBeTruthy();
    const skill = '/tenants/999888777/skills/skrive-vedtaksbrev';
    expect(calls.filter((c) => c.method === 'POST' && c.path === `${skill}/fix`)).toHaveLength(1);
    expect(calls.some((c) => c.path.includes('/apply'))).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expectAccessible();
    fireEvent.click(within(proposal).getByRole('button', { name: 'Forkast' }));
    expect(
      screen.queryByRole('region', { name: 'Assistentens forslag til instruksjonene' }),
    ).toBeNull();
    expect(calls.some((c) => c.path.includes('/apply'))).toBe(false);
    tab(/Oppsett/);
    expect(
      (screen.getByRole('textbox', { name: 'Instruksjoner' }) as HTMLTextAreaElement).value,
    ).not.toMatch(/klagefrist/i);
  });

  it('adds a test case with source text and a dataset', async () => {
    const puts: unknown[] = [];
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return base(input, init);
    };
    await renderAt('#/skills?id=svare-pa-innsynskrav', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Svare på innsynskrav' });
    tab(/Testsett/);
    fireEvent.click(screen.getByRole('button', { name: 'Legg til testtilfelle' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    const row = within(region('Testtilfeller')).getByRole('row', { name: /Hva er fristen/ });
    expect(within(row).getByText('Med kildetekst')).toBeTruthy();
    expect(within(row).getByText(`Datasett: ${option.text}`)).toBeTruthy();
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

  it('deletes a test case through the API with If-Match', async () => {
    const deletes: { path: string; ifMatch: string | null }[] = [];
    const base = fetchWith({ failing: true });
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'DELETE')
        deletes.push({
          path: url.replace(/^\/api/, ''),
          ifMatch: new Headers(init.headers).get('if-match'),
        });
      return base(input, init);
    };
    await renderAt('#/skills?id=skrive-vedtaksbrev', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    tab(/Testsett/);
    const rows = within(region('Testtilfeller')).getAllByRole('row');
    const first = rows[1] as HTMLElement;
    const input = within(first).getByRole('rowheader').textContent ?? '';
    fireEvent.click(within(first).getByRole('button', { name: /^Slett testtilfellet/ }));
    await screen.findByText('Testtilfellet er slettet fra utkastet.');
    expect(deletes).toEqual([
      {
        path: '/tenants/999888777/skills/skrive-vedtaksbrev/testcases/0',
        ifMatch: expect.stringMatching(/^"\d+"$/),
      },
    ]);
    expect(within(region('Testtilfeller')).getAllByRole('row')).toHaveLength(rows.length - 1);
    expect(within(region('Testtilfeller')).queryByRole('rowheader', { name: input })).toBeNull();
  });

  it('the stale-result alert appears after editing', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { failing: true });
    tab(/Testsett/);
    const stale = /Utkastet er endret siden siste kjøring/;
    expect(screen.queryByText(stale)).toBeNull();
    tab(/Oppsett/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Instruksjoner' }), {
      target: { value: '# Skrive vedtaksbrev\n\nNy tekst.' },
    });
    tab(/Testsett/);
    expect(screen.getByText(stale)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /feilet/ })).toBeNull();
    expect(within(region('Testtilfeller')).getAllByText('Ikke kjørt')).toHaveLength(10);
    expectAccessible();
  });

  it('adds a test case inline and validates it', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav');
    tab(/Testsett/);
    expect(screen.getByText('Ingen testtilfeller ennå')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til testtilfelle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    expect(screen.getByText('Fyll ut både inn og forventet.')).toBeTruthy();
    const form = screen.getByRole('group', { name: 'Nytt testtilfelle' });
    fireEvent.change(within(form).getByLabelText('Inn'), { target: { value: 'Krav om innsyn' } });
    fireEvent.change(within(form).getByLabelText('Forventet'), { target: { value: 'Avslag' } });
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'must_reject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    const row = within(region('Testtilfeller')).getByRole('row', { name: /Krav om innsyn/ });
    expect(within(row).getByText('Skal avvise')).toBeTruthy();
    expectAccessible();
  });

  it('publish dialog lists four requirements with Oppfylt or Ikke oppfylt', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    fireEvent.click(screen.getByRole('button', { name: 'Publiser versjon 4' }));
    const dialog = await screen.findByRole('dialog', { name: /Publiser versjon 4 av Skrive/ });
    const gates = await within(dialog).findByRole('list', { name: 'Krav før publisering' });
    const items = within(gates).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    for (const item of items) expect(item.textContent).toMatch(/^(Oppfylt|Ikke oppfylt)/);
    expect(items[0]?.textContent).toContain('Testsettet er ikke kjørt.');
    expect(items[3]?.textContent).toMatch(/^Oppfylt/);
    expect(within(dialog).getByText('Endringer siden versjon 3')).toBeTruthy();
    expect(within(dialog).getByText('1 nytt eksempel')).toBeTruthy();
    expect(within(dialog).getByText('Lovdata: versjon 1.3 → 1.4')).toBeTruthy();
    expectAccessible();
  });

  it('publishes after a passing run with a reason', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    tab(/Testsett/);
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByText('10 av 10 bestått (100 prosent)');
    fireEvent.click(screen.getByRole('button', { name: 'Publiser versjon 4' }));
    const dialog = await screen.findByRole('dialog', { name: /Publiser versjon 4/ });
    const gates = await within(dialog).findByRole('list', { name: 'Krav før publisering' });
    expect(within(gates).getAllByText('Oppfylt')).toHaveLength(4);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));
    expect(within(dialog).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Ny versjon med flere eksempler' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));
    await screen.findByText(
      'Versjon 4 er publisert. Vedtaksutkast får «Oppdatering tilgjengelig».',
    );
    await screen.findByText('Versjon 4 i bruk · ingen endringer i utkastet · utgiver Testetaten');
  });

  it('a blocked publish disables Publiser and links to the test set', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { failing: true });
    fireEvent.click(screen.getByRole('button', { name: 'Publiser versjon 4' }));
    const dialog = await screen.findByRole('dialog', { name: /Publiser versjon 4/ });
    await within(dialog).findByText(/Publiseringen er stoppet fordi 1 krav ikke er oppfylt/);
    const publish = within(dialog).getByRole('button', { name: 'Publiser' });
    expect(publish.getAttribute('aria-disabled')).toBe('true');
    expect((within(dialog).getByLabelText('Begrunnelse') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect(within(dialog).getByText('8 av 10 bestått (80 prosent).')).toBeTruthy();
    expectAccessible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gå til testsettet' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('tab', { name: /Testsett/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('sharing needs the confirmation and a reason', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    tab(/Bruk og deling/);
    const services = await screen.findByRole('region', { name: 'Tjenester' });
    expect(within(services).getByText('Siste versjon')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Del med andre virksomheter' }));
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
    expect(screen.getByRole('heading', { name: 'Venter på godkjenning fra Digdir' })).toBeTruthy();
    expect(screen.getByText(/Sendt i dag kl\. \d\d\.\d\d av Kari Nordmann/)).toBeTruthy();
    expect(screen.getAllByText('Venter på Digdir').length).toBeGreaterThan(0);
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Trekk tilbake forespørselen' }));
    await screen.findByText('Forespørselen om deling er trukket tilbake.');
    expect(screen.getByRole('button', { name: 'Del med andre virksomheter' })).toBeTruthy();
  });

  it('says Digdir turned down the last request and lets the skill be shared again', async () => {
    const skills = exampleSkillRecords().map((r) =>
      r.id === 'skrive-vedtaksbrev' ? { ...r, share: 'rejected' as const } : r,
    );
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev', { skills });
    tab(/Bruk og deling/);

    expect(await screen.findByText(/Digdir avslo forrige forespørsel om deling/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Del med andre virksomheter' })).toBeTruthy();
  });

  it('cannot share an unpublished skill', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav');
    tab(/Bruk og deling/);
    expect(await screen.findByText('Publiser ferdigheten før du deler den.')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Del med andre virksomheter' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it("someone else's skill is read-only with Lag en kopi", async () => {
    await openSkill('klarsprak-i-brev&owner=991825827', 'Klarspråk i brev');
    expect(
      screen.getByText(/Denne ferdigheten er laget av Digdir\. Du kan bruke og prøve den/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Publiser/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Be assistenten foreslå' })).toBeNull();
    expect(
      (screen.getByRole('textbox', { name: 'Instruksjoner' }) as HTMLTextAreaElement).readOnly,
    ).toBe(true);
    expect(screen.getByText('Versjon 1 i bruk · utgiver Digdir')).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Lag en kopi' }));
    await screen.findByRole('button', { name: 'Publiser versjon 1' });
    expect(screen.getByRole('heading', { level: 1, name: 'Klarspråk i brev' })).toBeTruthy();
    expect(screen.getByText('Kopien er laget som et utkast hos Testetaten.')).toBeTruthy();
  });

  it('applies and discards YAML with the genai/v1 schema', async () => {
    await openSkill('sortere-post', 'Sortere post etter saksområde');
    tab(/YAML/);
    const box = screen.getByLabelText('Ferdighetsdefinisjon (YAML)') as HTMLTextAreaElement;
    expect(box.value).toContain('apiVersion: genai/v1');
    expect(box.value).toContain('kind: Skill');
    expect(box.value).toContain('version: 3');
    expect(box.value).toContain('- brreg@0.1');
    expect(box.value).toContain('passThreshold: 0.85');
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
    expect(screen.getByRole('button', { name: 'Publiser versjon 3' })).toBeTruthy();
    expectAccessible();
  });

  it('lists versions with the draft first', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    tab(/Versjoner/);
    const list = await screen.findByRole('list', { name: 'Versjoner' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Utkast til versjon 4');
    expect(items[1]?.textContent).toContain('Versjon 3');
    expect(items[1]?.textContent).toContain('I bruk');
    expect(items[1]?.textContent).toContain('10 av 10 (100 %)');
    expect(items[3]?.textContent).toContain('Ingen testsett');
    expectAccessible();
  });

  it('opens the playground panel beside the editor', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    const button = screen.getByRole('button', { name: 'Prøv' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.skill-try [data-context="skill"]')).toBeTruthy();
  });

  it('Prøv waits for a published version and names the skill by its display name', async () => {
    await openSkill('svare-pa-innsynskrav', 'Svare på innsynskrav');
    const unpublished = screen.getByRole('button', { name: 'Prøv' });
    expect(unpublished.getAttribute('aria-disabled')).toBe('true');
    expect(unpublished.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      screen.getByText('Du kan prøve ferdigheten når den har en publisert versjon.'),
    ).toBeTruthy();
    fireEvent.click(unpublished);
    expect(document.querySelector('.skill-try')).toBeNull();
    cleanup();

    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    fireEvent.click(screen.getByRole('button', { name: 'Prøv' }));
    expect(
      await screen.findByText(
        'Med ferdigheten Skrive vedtaksbrev slik den er i siste publiserte versjon',
      ),
    ).toBeTruthy();
  });

  it('a failed action shows a danger alert, not a success message', async () => {
    const base = fetchWith({ failing: true });
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'DELETE'
        ? Promise.resolve(
            new Response(JSON.stringify({ title: 'Feil' }), {
              status: 500,
              headers: { 'content-type': 'application/problem+json' },
            }),
          )
        : base(input, init);
    await renderAt('#/skills?id=skrive-vedtaksbrev', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    tab(/Testsett/);
    const first = within(region('Testtilfeller')).getAllByRole('row')[1] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: /^Slett testtilfellet/ }));

    const alert = (
      await screen.findByText('Vi kunne ikke slette testtilfellet. Prøv igjen om litt.')
    ).closest('[data-color]') as HTMLElement;
    expect(alert.getAttribute('data-color')).toBe('danger');
    expect(alert.getAttribute('role')).toBe('alert');
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
    await renderAt('#/skills?id=skrive-vedtaksbrev', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Skrive vedtaksbrev' });
    tab(/Bruk og deling/);
    fireEvent.click(await screen.findByRole('button', { name: 'Trekk tilbake forespørselen' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Vi kunne ikke trekke tilbake forespørselen. Prøv igjen om litt.',
    );
  });

  it('closing the publish dialog puts focus back on the publish button', async () => {
    await openSkill('skrive-vedtaksbrev', 'Skrive vedtaksbrev');
    const trigger = screen.getByRole('button', { name: 'Publiser versjon 4' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: /Publiser versjon 4/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
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
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await base(input, init);
      calls.push({
        method: init?.method ?? 'GET',
        path: url.replace(/^\/api/, ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        reply: await response.clone().json(),
      });
      return response;
    };
    const skill = '/tenants/999888777/skills/ny-ferdighet';
    const last = (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path).at(-1);

    await renderAt('#/skills', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Ny ferdighet' }));
    await screen.findByRole('heading', { level: 1, name: 'Ny ferdighet' });
    expect(last('POST', '/tenants/999888777/skills')).toMatchObject({
      body: { id: 'ny-ferdighet', name: '' },
      reply: {
        id: 'ny-ferdighet',
        owner: '999888777',
        version: null,
        readOnly: false,
        draft: { revision: 1, definition: { spec: { description: '', instructions: '' } } },
        requirements: [{ id: 'tested-on-draft', met: false, reason: 'no_cases' }, {}, {}, {}],
      },
    });

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Svare på klager' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Når skal ferdigheten brukes?' }), {
      target: { value: 'Bruk når noen klager på et vedtak.' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instruksjoner' }), {
      target: { value: '# Svare på klager\n\nSvar kort.' },
    });
    tab(/Testsett/);
    fireEvent.click(screen.getByRole('button', { name: 'Legg til testtilfelle' }));
    const form = screen.getByRole('group', { name: 'Nytt testtilfelle' });
    fireEvent.change(within(form).getByLabelText('Inn'), { target: { value: 'Klage på avslag' } });
    fireEvent.change(within(form).getByLabelText('Forventet'), {
      target: { value: 'Svar med klagefrist' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør testsettet' }));
    await screen.findByText('1 av 1 bestått (100 prosent)');
    const saved = calls.filter((c) => c.method === 'PUT' && c.path === skill);
    expect(saved[0]?.headers.get('if-match')).toBe('"1"');
    expect(saved.at(-1)).toMatchObject({
      body: {
        definition: {
          metadata: { id: 'ny-ferdighet', name: 'Svare på klager' },
          spec: { testset: { cases: [{ input: 'Klage på avslag', type: 'criteria' }] } },
        },
      },
      reply: { name: 'Svare på klager', hasChanges: true, draft: { revision: saved.length + 1 } },
    });
    expect(last('POST', `${skill}/test-runs`)).toMatchObject({
      body: {},
      reply: { draftRevision: saved.length + 1, passed: 1, total: 1, cases: [{ index: 0 }] },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Publiser versjon 1' }));
    const dialog = await screen.findByRole('dialog', { name: /Publiser versjon 1 av Svare/ });
    const gates = await within(dialog).findByRole('list', { name: 'Krav før publisering' });
    expect(within(gates).getAllByText('Oppfylt')).toHaveLength(4);
    expect(last('GET', `${skill}/requirements`)?.reply).toMatchObject({
      threshold: 0.9,
      requirements: [
        { id: 'tested-on-draft', met: true },
        { id: 'pass-rate', met: true, passedCases: 1, total: 1 },
        { id: 'must-reject', met: true },
        { id: 'published-tools', met: true },
      ],
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Første versjon for klagesaker' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publiser' }));
    await screen.findByText('Versjon 1 er publisert.');
    await screen.findByText('Versjon 1 i bruk · ingen endringer i utkastet · utgiver Testetaten');
    const published = last('POST', `${skill}/publish`);
    expect(decodeURIComponent(published?.headers.get('change-reason') ?? '')).toBe(
      'Første versjon for klagesaker',
    );
    expect(published?.reply).toMatchObject({ ok: true, version: 1 });
  });

  it('saves the draft with If-Match', async () => {
    const calls: { method: string; url: string; ifMatch: string | null }[] = [];
    const base = fetchWith();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        method: init?.method ?? 'GET',
        url,
        ifMatch: new Headers(init?.headers).get('if-match'),
      });
      return base(input, init);
    };
    await renderAt('#/skills?id=sortere-post', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Sortere post etter saksområde' });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Sortere post' } });
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
        url: '/api/tenants/999888777/skills/sortere-post',
        ifMatch: '"4"',
      }),
    );
  });
});
