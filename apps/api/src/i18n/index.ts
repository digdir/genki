import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createRetranslator,
  createTranslator,
  defineCatalogue,
  interpolate,
  negotiate,
  type Locale,
  type MessageKey,
  type ParamArgs,
  type Translation,
} from '@genai/i18n';
import type { MiddlewareHandler } from 'hono';
import { content as enContent } from './en/content.js';
import { errors as enErrors } from './en/errors.js';
import { problems as enProblems } from './en/problems.js';
import { content } from './nb/content.js';
import { errors } from './nb/errors.js';
import { problems } from './nb/problems.js';

export const nb = defineCatalogue({ problems, ...errors, ...content });
export const en = {
  problems: enProblems,
  ...enErrors,
  ...enContent,
} satisfies Translation<typeof nb>;
export type ApiKey = MessageKey<typeof nb>;

const requests = new AsyncLocalStorage<Locale>();

export const requestLocale = (): Locale => requests.getStore() ?? 'nb';

const translators = {
  nb: createTranslator({ nb, en }, 'nb'),
  en: createTranslator({ nb, en }, 'en'),
};

export const translatorFor = (locale: Locale) => translators[locale];

export const t = <K extends ApiKey>(key: K, ...params: ParamArgs<typeof nb, K>) =>
  translators[requestLocale()](key, ...params);

export const translate = (key: ApiKey, params?: Record<string, unknown>) =>
  interpolate(translators[requestLocale()].template(key, params), params, requestLocale());

const toEnglish = createRetranslator(nb, { en }, 'en');
const toBokmal = createRetranslator(en, { nb }, 'nb');

export const translateMessage = (text: string, locale: Locale) =>
  (locale === 'en' ? toEnglish(text) : toBokmal(text)) ?? text;

interface ErrorBody {
  title?: unknown;
  detail?: unknown;
  errors?: unknown;
  error?: unknown;
}

const messagesOf = (errors: unknown) =>
  Array.isArray(errors)
    ? errors
        .map((e) => (e as { message?: unknown } | null)?.message)
        .filter((m) => typeof m === 'string')
    : [];

const translateErrors = (errors: unknown, locale: Locale) =>
  Array.isArray(errors)
    ? errors.map((e: unknown) => {
        const message = (e as { message?: unknown } | null)?.message;
        return typeof message === 'string'
          ? { ...(e as object), message: translateMessage(message, locale) }
          : e;
      })
    : errors;

const translateDetail = (body: ErrorBody, locale: Locale, errors: unknown) => {
  if (typeof body.detail !== 'string') return {};
  const whole = translateMessage(body.detail, locale);
  if (whole !== body.detail) return { detail: whole };
  const parts = messagesOf(body.errors);
  return parts.length > 0 && parts.join(' ') === body.detail
    ? { detail: messagesOf(errors).join(' ') }
    : {};
};

const translateBody = (body: ErrorBody, locale: Locale): ErrorBody => {
  const errors = translateErrors(body.errors, locale);
  const error = body.error;
  return {
    ...body,
    ...(typeof body.title === 'string' ? { title: translateMessage(body.title, locale) } : {}),
    ...translateDetail(body, locale, errors),
    ...(Array.isArray(body.errors) ? { errors } : {}),
    ...(typeof error === 'string' ? { error: translateMessage(error, locale) } : {}),
    ...(error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
      ? {
          error: {
            ...error,
            message: translateMessage((error as { message: string }).message, locale),
          },
        }
      : {}),
  };
};

export const localeMiddleware: MiddlewareHandler = async (c, next) => {
  const negotiated = negotiate(c.req.header('accept-language'));
  await requests.run(negotiated ?? 'nb', () => next());
  if (!negotiated) return;
  c.res.headers.append('vary', 'Accept-Language');
  const type = c.res.headers.get('content-type') ?? '';
  if (c.res.status < 400 || !/application\/(problem\+)?json/.test(type)) return;
  const body = (await c.res
    .clone()
    .json()
    .catch(() => undefined)) as ErrorBody | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const { status } = c.res;
  const headers = new Headers(c.res.headers);
  headers.delete('content-length');
  headers.set('content-language', negotiated);
  c.res = undefined;
  c.res = new Response(JSON.stringify(translateBody(body, negotiated)), { status, headers });
};
