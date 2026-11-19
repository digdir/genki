// Finds sideways page overflow and badly scrolling dialogs in the portal on mock data; see docs/development.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type Page = import('playwright-core').Page;

export interface Overflow {
  route: string;
  width: number;
  scheme: string;
  scrollWidth: number;
  causes: string[];
}

export interface TableFault {
  route: string;
  width: number;
  faults: string[];
}

export interface DialogFault {
  route: string;
  width: number;
  opener: string;
  faults: string[];
}

const settle = (page: Page, ms = 350) => page.waitForTimeout(ms);

export const sameScreen = (hash: string) =>
  hash
    .replace(/^#/, '')
    .replace(/[?#].*$/, '')
    .split('/')
    .map((part) => (/\d{3,}|-v\d+$/.test(part) ? ':id' : part))
    .join('/');

const measureOverflow = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth <= vw + 1) return { scrollWidth, causes: [] as string[] };
    const clips = (e: Element) => getComputedStyle(e).overflowX !== 'visible';
    const describe = (e: Element) => {
      const cls = [...e.classList].slice(0, 3).join('.');
      const r = e.getBoundingClientRect();
      return `${e.tagName.toLowerCase()}${cls ? `.${cls}` : ''} right=${Math.round(r.right)} width=${Math.round(r.width)}`;
    };
    const clipped = (e: Element) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement)
        if (clips(p)) return true;
      return false;
    };
    const causes: string[] = [];
    for (const e of document.body.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.right <= vw + 1 || clipped(e)) continue;
      const p = e.parentElement;
      if (p && p !== document.body && p.getBoundingClientRect().right > vw + 1) continue;
      causes.push(describe(e));
      if (causes.length >= 5) break;
    }
    const text = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = text.nextNode(); node && causes.length < 5; node = text.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      const parent = node.parentElement;
      if (parent && box.width > 0 && box.right > vw + 1 && !clips(parent) && !clipped(parent))
        causes.push(`text "${(node.textContent ?? '').slice(0, 40)}" in ${describe(parent)}`);
    }
    if (causes.length === 0)
      for (const e of document.body.querySelectorAll('*')) {
        const r = e.getBoundingClientRect();
        if (r.right > vw + 1 && /absolute|fixed/.test(getComputedStyle(e).position))
          causes.push(`${describe(e)} positioned outside a clipping parent`);
        if (causes.length >= 5) break;
      }
    return { scrollWidth, causes };
  });

const measureDialog = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('dialog[open], .side-panel');
    if (!box) return undefined;
    const faults: string[] = [];
    const vh = window.innerHeight;
    const r = box.getBoundingClientRect();
    if (r.height > vh + 1)
      faults.push(`taller than the viewport (${Math.round(r.height)} > ${vh})`);
    if (box.scrollHeight > box.clientHeight + 1)
      faults.push(`the dialog itself scrolls (${box.scrollHeight} > ${box.clientHeight})`);
    if (box.scrollWidth > box.clientWidth + 1)
      faults.push(`the dialog scrolls sideways (${box.scrollWidth} > ${box.clientWidth})`);
    for (const e of box.querySelectorAll('*')) {
      const s = getComputedStyle(e);
      if (!/auto|scroll/.test(s.overflowY) || e.scrollHeight <= e.clientHeight + 1) continue;
      if (s.overscrollBehaviorY !== 'contain' && s.overscrollBehaviorY !== 'none')
        faults.push(`${e.className || e.tagName} scrolls without overscroll-behavior: contain`);
    }
    return faults;
  });

const measureTables = (page: Page) =>
  page.evaluate(() => {
    const bordered = (e: Element) => {
      const s = getComputedStyle(e);
      return parseFloat(s.borderLeftWidth) > 0 && parseFloat(s.borderRightWidth) > 0;
    };
    const faults: string[] = [];
    for (const table of document.querySelectorAll('table')) {
      let box: Element | null = table;
      for (let i = 0; i < 3 && box && !bordered(box); i++) box = box.parentElement;
      if (!box || !bordered(box) || table.getBoundingClientRect().width === 0) continue;
      const edge = box.getBoundingClientRect();
      const s = getComputedStyle(box);
      const inner = {
        left: edge.left + parseFloat(s.borderLeftWidth),
        right: edge.right - parseFloat(s.borderRightWidth),
      };
      for (const row of table.rows) {
        const first = row.cells[0];
        const last = row.cells[row.cells.length - 1];
        if (!first || !last) continue;
        const gap = (cell: HTMLTableCellElement, side: 'left' | 'right') => {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          let best = Infinity;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim() || node.parentElement?.closest('.visually-hidden'))
              continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const r = range.getBoundingClientRect();
            if (r.width === 0) continue;
            best = Math.min(best, side === 'left' ? r.left - inner.left : inner.right - r.right);
          }
          return best;
        };
        const scrolled = box.scrollWidth > box.clientWidth + 1;
        if (gap(first, 'left') < 4 || (!scrolled && gap(last, 'right') < 4)) {
          faults.push(`table.${[...table.classList].join('.')} touches its border`);
          break;
        }
      }
    }
    return faults;
  });

const signIn = async (page: Page, url: string) => {
  await page.goto(`${url}/#/overview`);
  await page
    .getByRole('button', { name: /^(Logg inn|Sign in)$/ })
    .first()
    .click();
  await page.locator('a[href="#/services"]').first().waitFor({ state: 'attached' });
};

const linksOn = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('a[href^="#/"]')].map((a) => a.getAttribute('href') ?? ''),
  );

const crawl = async (page: Page, url: string, max: number) => {
  await signIn(page, url);
  const seen = new Map<string, string>();
  const queue = ['#/overview', ...(await linksOn(page))];
  while (queue.length > 0 && seen.size < max) {
    const hash = queue.shift() ?? '';
    const key = sameScreen(hash);
    if (seen.has(key)) continue;
    seen.set(key, hash);
    await page.evaluate((h) => (window.location.hash = h), hash);
    await settle(page, 500);
    for (const link of await linksOn(page)) if (!seen.has(sameScreen(link))) queue.push(link);
  }
  return [...seen.values()];
};

const openers = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    return [...main.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null && !b.disabled)
      .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim())
      .filter((name, i, all) => name && all.indexOf(name) === i)
      .slice(0, 40);
  });

const probeDialogs = async (page: Page, url: string, route: string, width: number) => {
  const found: DialogFault[] = [];
  for (const opener of await openers(page)) {
    await page.evaluate((h) => (window.location.hash = h), route);
    await settle(page);
    const button = page.locator('main button').filter({ hasText: opener }).first();
    if (!(await button.isVisible().catch(() => false))) continue;
    await button.click({ timeout: 2000 }).catch(() => undefined);
    await settle(page);
    const faults = await measureDialog(page);
    if (faults && faults.length > 0) found.push({ route, width, opener, faults });
    if (faults) {
      await page.keyboard.press('Escape');
      await settle(page, 200);
    }
    if (!page.url().startsWith(url)) await signIn(page, url);
  }
  return found;
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost:5173' },
      widths: { type: 'string', default: '390,768,990,1280' },
      schemes: { type: 'string', default: 'light,dark' },
      out: { type: 'string', default: 'layout-check' },
      dialogs: { type: 'boolean', default: false },
      max: { type: 'string', default: '300' },
      locale: { type: 'string', default: 'nb-NO' },
      only: { type: 'string' },
    },
  });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const out = values.out;
  mkdirSync(join(out, 'screens'), { recursive: true });
  const widths = values.widths.split(',').map(Number);
  const schemes = values.schemes.split(',');
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: values.locale,
  });
  const only = values.only?.split(',');
  const routes = (await crawl(await context.newPage(), values.url, Number(values.max))).filter(
    (route) => !only || only.some((part) => route.includes(part)),
  );
  await context.close();
  console.log(`${routes.length} screens`);
  const overflows: Overflow[] = [];
  const dialogs: DialogFault[] = [];
  const tables: TableFault[] = [];
  for (const scheme of schemes) {
    for (const width of widths) {
      const ctx = await browser.newContext({
        viewport: { width, height: 800 },
        locale: values.locale,
        colorScheme: scheme === 'dark' ? 'dark' : 'light',
      });
      const page = await ctx.newPage();
      await signIn(page, values.url);
      for (const route of routes) {
        await page.evaluate((h) => (window.location.hash = h), route);
        await settle(page, 500);
        const { scrollWidth, causes } = await measureOverflow(page);
        if (causes.length > 0 || scrollWidth > width + 1) {
          overflows.push({ route, width, scheme, scrollWidth, causes });
          const name = `${route.replace(/[^a-z0-9]+/gi, '-')}-${width}-${scheme}.png`;
          await page.screenshot({ path: join(out, 'screens', name) });
        }
        const edges = await measureTables(page);
        if (edges.length > 0 && scheme === schemes[0]) tables.push({ route, width, faults: edges });
        if (values.dialogs && scheme === schemes[0])
          dialogs.push(...(await probeDialogs(page, values.url, route, width)));
      }
      await ctx.close();
    }
  }
  await browser.close();
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify({ routes, overflows, dialogs, tables }, null, 2),
  );
  for (const o of overflows)
    console.log(
      `overflow ${o.route} @${o.width} ${o.scheme}: ${o.scrollWidth}px ${o.causes.join(' | ')}`,
    );
  for (const d of dialogs)
    console.log(`dialog ${d.route} @${d.width} "${d.opener}": ${d.faults.join('; ')}`);
  for (const t of tables) console.log(`table ${t.route} @${t.width}: ${t.faults.join('; ')}`);
  process.exitCode = overflows.length + dialogs.length + tables.length > 0 ? 1 : 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
