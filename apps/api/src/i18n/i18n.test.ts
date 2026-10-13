import { catalogueProblems } from '@genai/i18n';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { problem } from '../http.js';
import { setup } from '../testkit.js';
import { en, localeMiddleware, nb, requestLocale, t, translateMessage } from './index.js';

const app = new Hono();
app.use('*', localeMiddleware);
app.get('/nope', (c) => problem(c, 401, 'Du er ikke logget inn'));
app.get('/missing', (c) => problem(c, 404, 'Not found'));
app.get('/reason', (c) =>
  problem(c, 400, t('problems.reasonTooShort', { count: 10 }), {
    errors: [{ path: 'change-reason', message: 'Skriv en begrunnelse på minst 10 tegn.' }],
  }),
);
app.get('/file', (c) => problem(c, 404, 'no file rapport.pdf'));
app.get('/input', (c) =>
  c.json(
    {
      type: 'about:blank',
      title: 'Ugyldig input',
      status: 400,
      detail: '«År» må fylles ut. Fyll ut skjemaet eller skriv et spørsmål.',
      code: 'invalid_input',
      errors: [
        { path: 'year', message: '«År» må fylles ut.' },
        { path: 'query', message: 'Fyll ut skjemaet eller skriv et spørsmål.' },
      ],
    },
    400,
  ),
);
app.get('/openai', (c) =>
  c.json({ error: { message: '`model` is required.', code: 'missing_model' } }, 400),
);
app.get('/plain', (c) => c.json({ locale: requestLocale() }));

interface Body {
  title: string;
  errors: { path: string; message: string }[];
  [field: string]: unknown;
}
const body = async (response: Response | Promise<Response>) =>
  (await (await response).json()) as Body;

const get = (path: string, language?: string) =>
  app.request(path, language ? { headers: { 'accept-language': language } } : {});

describe('API languages', () => {
  it('has a complete English catalogue', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('translates problem details to the requested language and keeps them without a header', async () => {
    expect((await body(get('/nope', 'en-GB,en;q=0.9'))).title).toBe('You are not signed in');
    expect((await body(get('/nope'))).title).toBe('Du er ikke logget inn');
    const reason = await body(get('/reason', 'en'));
    expect(reason.title).toBe('Write a reason of at least 10 characters.');
    expect(reason.errors[0]).toEqual({
      path: 'change-reason',
      message: 'Write a reason of at least 10 characters.',
    });
    const response = await get('/nope', 'en');
    expect(response.headers.get('content-language')).toBe('en');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.status).toBe(401);
  });

  it('shows residency and kernel limit messages in bokmål on bokmål screens', () => {
    expect(translateMessage('model foundry/x runs in global, outside norway', 'nb')).toBe(
      'Modellen «foundry/x» kan behandle data utenfor EU/EØS, men tjenesten krever at data behandles i Norge.',
    );
    expect(translateMessage('task emitted more than 10000 events', 'nb')).toBe(
      'Kjøringen ble stoppet fordi den laget mer enn 10000 hendelser.',
    );
  });

  it('names a variant a variant, never a mode, in bokmål validation messages', () => {
    expect(
      translateMessage('the first variant is the default and must be a chat variant', 'nb'),
    ).toBe('Den første varianten er standard og må kunne brukes i chat.');
    expect(translateMessage('duplicate variant rask', 'nb')).toBe(
      'Varianten «rask» finnes to ganger.',
    );
    expect(translateMessage('no published step flow arsrapport-forst@1', 'nb')).toBe(
      'Stegflyten arsrapport-forst@1 er ikke publisert.',
    );
  });

  it('shows version pin problems from metadata.version in bokmål on bokmål screens', () => {
    expect(translateMessage('`metadata.version` must be a positive whole number.', 'nb')).toBe(
      '`metadata.version` må være et positivt heltall.',
    );
    expect(
      translateMessage(
        '`GenAI-Version` asks for version 3 and `metadata.version` for version 2. Send one version.',
        'nb',
      ),
    ).toBe('`GenAI-Version` ber om versjon 3 og `metadata.version` om versjon 2. Send én versjon.');
  });

  it('exposes the request locale to handlers', async () => {
    expect(await body(get('/plain', 'en'))).toEqual({ locale: 'en' });
    expect(await body(get('/plain'))).toEqual({ locale: 'nb' });
    expect(await body(get('/reason', 'nb'))).toMatchObject({
      title: 'Skriv en begrunnelse på minst 10 tegn.',
    });
  });

  it('picks the most specific template and keeps machine-readable fields', async () => {
    expect((await body(get('/file', 'nb'))).title).toBe('ingen fil rapport.pdf');
    const input = await body(get('/input', 'en'));
    expect(input).toMatchObject({
      title: 'Invalid input',
      code: 'invalid_input',
      detail: '«År» must be filled in. Fill in the form or write a question.',
      errors: [{ path: 'year' }, { path: 'query' }],
    });
    expect(await body(get('/openai', 'nb'))).toEqual({
      error: { message: '`model` er påkrevd.', code: 'missing_model' },
    });
  });

  it('translates problems from the real app in both directions', async () => {
    const { app: real } = setup();
    const call = (path: string, language: string, init: RequestInit = {}) =>
      real.request(path, {
        ...init,
        headers: {
          'accept-language': language,
          'change-reason': 'kort',
          'content-type': 'application/json',
        },
      });
    expect((await body(call('/nowhere', 'nb'))).title).toBe('Fant ikke');
    expect((await body(call('/nowhere', 'en'))).title).toBe('Not found');
    const unreasoned = await call('/definitions', 'en', { method: 'POST', body: '{}' });
    expect(await body(unreasoned)).toMatchObject({
      title: 'Invalid request',
      errors: [{ path: 'change-reason', message: 'Write a reason of at least 10 characters.' }],
    });
    const nbInvalid = await call('/definitions', 'nb', { method: 'POST', body: '{}' });
    expect((await body(nbInvalid)).title).toBe('Ugyldig forespørsel');
    const unsigned = await call('/definitions/validate', 'nb', {
      method: 'POST',
      body: JSON.stringify({ definition: {} }),
    });
    expect(unsigned.status).toBe(401);
    expect((await body(unsigned)).title).toBe('Ikke autentisert');
    expect((await body(real.request('/nowhere'))).title).toBe('Not found');
  });
});
