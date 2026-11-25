import type { Locale } from '@genai/i18n';
import type { RefBlockPayload } from '@genai/ui-assembly';
import type { AssistantLayout } from '@genai/ui-blocks/builder';

export type Text = string | { nb: string; en: string };

export type MenuItem = { label: Text; page: string } | { label: Text; href: string };

export interface HostView {
  hostname: string;
  tenant: string;
  service: string;
  environment: string;
  name: Text;
  login: {
    issuer: string | null;
    clientId: string;
    audience: string;
    altinnResource: string | null;
  };
  icon?: string | null;
  menu: MenuItem[];
  pages: { id: string; title: Text }[];
}

export interface Page {
  id: string;
  title: Text;
  body: Text;
}

export const showIcon = (icon: string | null | undefined) => {
  if (!icon?.startsWith('data:image/')) return;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = icon;
};

export const textIn = (text: Text, locale: Locale) =>
  typeof text === 'string' ? text : text[locale === 'en' ? 'en' : 'nb'];

/** The menu's rule for a link: https without credentials, or a plain mailto address. */
export const isPageLink = (href: string) => {
  if (href.startsWith('mailto:')) return /^mailto:[^\s/?#@]+@[^\s/?#@]+$/.test(href);
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
};

const isTexts = (value: object): value is { nb: string; en: string } =>
  Object.keys(value).length === 2 &&
  typeof (value as { nb?: unknown }).nb === 'string' &&
  typeof (value as { en?: unknown }).en === 'string';

/** The value with every `{ nb, en }` text in the reader's language. */
export const inLanguage = <T>(value: T, locale: Locale): T => {
  if (Array.isArray(value)) return value.map((v: unknown) => inLanguage(v, locale)) as T;
  if (typeof value !== 'object' || value === null) return value;
  if (isTexts(value)) return textIn(value, locale) as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, inLanguage(v, locale)]),
  ) as T;
};

/** The hostname the page is served on; locally `VITE_GENKI_HOST` stands in for it. */
export const hostnameOf = (url: URL, stand: string | undefined) => stand || url.hostname;

const found = async <T>(response: Response): Promise<T | undefined> => {
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`genki answered ${response.status}`);
  return (await response.json()) as T;
};

const redirectLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const redirectAddress = (answer: unknown, path: string): string | undefined => {
  const to = (answer as { redirectTo?: unknown } | undefined)?.redirectTo;
  if (typeof to !== 'string' || to.length > 253) return undefined;
  const labels = to.split('.');
  if (labels.length < 2 || !labels.every((l) => redirectLabel.test(l))) return undefined;
  const rest = path.startsWith('/') && !path.startsWith('//') ? path : '/';
  return `https://${to}${rest}`;
};

export const loadHost = async (fetcher: typeof fetch, hostname: string) =>
  found<HostView>(await fetcher(`/api/v1/hosts/${encodeURIComponent(hostname)}`));

export const loadPage = async (fetcher: typeof fetch, hostname: string, id: string) =>
  found<Page>(
    await fetcher(`/api/v1/hosts/${encodeURIComponent(hostname)}/pages/${encodeURIComponent(id)}`),
  );

export interface ShownInterface {
  layout: AssistantLayout;
  blocks: Record<string, RefBlockPayload>;
}

/** The layout the service runs and its pinned blocks, read as the signed-in person through its first variant. */
export const loadLayout = async (
  fetcher: typeof fetch,
  service: string,
  credentials: Record<string, string>,
) => {
  const headers = { ...credentials, accept: 'application/json' };
  const models = await found<{ data: { id: string }[] }>(
    await fetcher('/api/v1/models', { headers }),
  );
  const model = models?.data.find((m) => m.id.startsWith(`${service}__`))?.id;
  if (!model) return undefined;
  const shown = await found<{ layout?: AssistantLayout; blocks?: Record<string, RefBlockPayload> }>(
    await fetcher(`/api/v1/models/${encodeURIComponent(model)}/interface`, { headers }),
  );
  return shown?.layout ? { layout: shown.layout, blocks: shown.blocks ?? {} } : undefined;
};
