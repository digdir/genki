// Browser checks of the portal and console with playwright-core; see docs/smoke-tests.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScreenObservation } from './assess.ts';

export interface BrowserTarget {
  portal: string;
  console: string;
  tenant: string;
  key: string | undefined;
  portalClientId: string;
  out: string;
  redact(text: string): string;
}

type Page = import('playwright-core').Page;
type BrowserContext = import('playwright-core').BrowserContext;

const expiredToken = 'expired-smoke-token';
const settle = 30_000;

export const screenFile = (app: string, path: string) =>
  `${app}-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}`;

export const publishedVersionOf = (values: string[]) =>
  values
    .filter((v) => /^\d+$/.test(v))
    .sort((a, b) => Number(b) - Number(a))
    .at(0);

export const playgroundRun = (question: string) => async (page: Page) => {
  const picker = page.locator('select[id$="-ver"]').first();
  const published = publishedVersionOf(
    await picker.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value)),
  );
  if (published) await picker.selectOption(published);
  const form = page
    .locator('form')
    .filter({ has: page.locator('textarea') })
    .last();
  await form.locator('textarea').fill(question);
  await form.getByRole('button', { name: 'Send' }).click();
  await page
    .waitForResponse((r) => r.url().includes('/playground/runs'), { timeout: 150_000 })
    .catch(() => undefined);
  await page.waitForTimeout(2_000);
};

export const sessionFor = (
  app: 'portal' | 'console',
  token: string,
  tenant: string,
  now: number,
) =>
  app === 'portal'
    ? {
        name: 'Smoke test',
        organisations: [{ orgNumber: tenant, name: 'Smoke test' }],
        token,
        expiresAt: now + 3_600_000,
      }
    : { name: 'Smoke test', roles: ['GenAI.Operator'], token };

export const openBrowser = async (target: BrowserTarget) => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  mkdirSync(join(target.out, 'screens'), { recursive: true });

  const contextFor = async (
    app: 'portal' | 'console',
    token: string | undefined,
    locale: 'nb' | 'en',
  ): Promise<BrowserContext> => {
    const context = await browser.newContext({
      locale: locale === 'en' ? 'en-GB' : 'nb-NO',
      viewport: { width: 1280, height: 900 },
    });
    if (token) {
      const storageKey = app === 'portal' ? `${target.portalClientId}.session` : 'console.session';
      await context.addInitScript(
        ([k, v]) => {
          if (!sessionStorage.getItem(k as string))
            sessionStorage.setItem(k as string, v as string);
        },
        [storageKey, JSON.stringify(sessionFor(app, token, target.tenant, Date.now()))],
      );
    }
    return context;
  };

  const watch = (page: Page, origin: string) => {
    const api: ScreenObservation['api'] = [];
    const pageErrors: string[] = [];
    const bodies: Promise<void>[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!(url.origin === origin && url.pathname.startsWith('/api/'))) return;
      const call: ScreenObservation['api'][number] = {
        path: url.pathname.slice(4),
        status: response.status(),
      };
      api.push(call);
      if (call.status === 403)
        bodies.push(
          response.json().then(
            (body: { type?: unknown } | null) => {
              if (typeof body?.type === 'string') call.problem = body.type;
            },
            () => undefined,
          ),
        );
    });
    page.on('pageerror', (error) => pageErrors.push(target.redact(error.message)));
    return { api, pageErrors, bodies };
  };

  const observe = async (
    page: Page,
    app: 'portal' | 'console',
    path: string,
    seen: { api: ScreenObservation['api']; pageErrors: string[]; bodies: Promise<void>[] },
    status: number,
    name: string,
    keep: boolean,
  ): Promise<ScreenObservation> => {
    await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => undefined);
    await Promise.all(seen.bodies);
    const alerts = (await page.locator('.ds-alert[data-color="danger"]').allInnerTexts()).map(
      target.redact,
    );
    const heading = (await page.locator('h1').count()) > 0;
    const text = target.redact(
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
    if (keep) {
      await page
        .screenshot({ path: join(target.out, 'screens', `${name}.png`) })
        .catch(() => undefined);
      writeFileSync(join(target.out, 'screens', `${name}.txt`), text.slice(0, 6000));
    }
    return { app, path, status, api: seen.api, pageErrors: seen.pageErrors, alerts, heading, text };
  };

  const visit = async (
    app: 'portal' | 'console',
    path: string,
    options: {
      token: 'key' | 'expired';
      locale?: 'nb' | 'en';
      act?: (page: Page) => Promise<void>;
      personal?: boolean;
    },
  ): Promise<ScreenObservation> => {
    const base = app === 'portal' ? target.portal : target.console;
    const token = options.token === 'key' ? target.key : expiredToken;
    const context = await contextFor(app, token, options.locale ?? 'nb');
    const page = await context.newPage();
    const seen = watch(page, new URL(base).origin);
    const query = app === 'portal' && options.token === 'key' ? `?org=${target.tenant}` : '';
    const name = `${screenFile(app, path)}${options.locale === 'en' ? '-en' : ''}${options.act ? '-act' : ''}`;
    try {
      const response = await page.goto(`${base}/${query}${path}`, { timeout: settle });
      await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => undefined);
      if (options.act) await options.act(page);
      return await observe(page, app, path, seen, response?.status() ?? 0, name, !options.personal);
    } catch (error) {
      return {
        app,
        path,
        status: 0,
        api: seen.api,
        pageErrors: [...seen.pageErrors, target.redact(String(error))],
        alerts: [],
        heading: false,
        text: '',
      };
    } finally {
      await context.close();
    }
  };

  const runPlayground = playgroundRun;

  return { visit, runPlayground, close: () => browser.close() };
};

export type Browser = Awaited<ReturnType<typeof openBrowser>>;
