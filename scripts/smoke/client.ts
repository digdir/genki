// HTTP calls to genki-test for the smoke runner and the extra checks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpResult, Plan } from './assess.ts';

export const freeTimeout = 30_000;
export const runTimeout = 150_000;
export const changeReason = 'Smoke test after a deploy, archived again by the same run';

export const loadPlan = (): Plan =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'plan.json'), 'utf8')) as Plan;

export const serviceYaml = () =>
  readFileSync(join(import.meta.dirname, 'smoke-service.yaml'), 'utf8');

export const withId = (yaml: string, from: string, to: string) =>
  yaml.replace(`id: ${from},`, `id: ${to},`);

export const call = async (
  url: string,
  init: RequestInit & { timeout: number },
): Promise<HttpResult> => {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeout),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      text: await response.text(),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      status: timedOut ? 504 : 503,
      headers: {},
      text: timedOut ? 'timed out' : 'network error',
    };
  }
};

export const createClient = (api: string, key: string | undefined, plan: Plan) => {
  const auth = key ? { 'x-api-key': key } : undefined;
  const headers = (language: 'nb' | 'en' = 'en') => ({
    'accept-language': language,
    'content-type': 'application/json',
    ...auth,
  });
  const tenant = `${api}/tenants/${plan.tenant}`;
  const writeHeaders = (contentType = 'application/json') => ({
    ...headers(),
    'content-type': contentType,
    'change-reason': changeReason,
  });

  return {
    get: (path: string, language: 'nb' | 'en' = 'en', timeout = freeTimeout) =>
      call(`${api}${path}`, { headers: headers(language), timeout }),
    ask: (variant: string, question: string, stream: boolean) =>
      call(`${api}/v1/chat/completions`, {
        method: 'POST',
        headers: headers(),
        timeout: runTimeout,
        body: JSON.stringify({
          model: `${plan.service}__${variant}`,
          messages: [{ role: 'user', content: question }],
          ...(stream ? { stream: true, genai_steps: true } : {}),
        }),
      }),
    askWithoutKey: () =>
      call(`${api}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        timeout: freeTimeout,
        body: JSON.stringify({ model: `${plan.service}__default`, messages: [] }),
      }),
    timeline: (task: string, otherTenant = false) =>
      call(
        `${api}/tenants/${otherTenant ? plan.otherTenant : plan.tenant}/tasks/${encodeURIComponent(task)}/timeline`,
        { headers: headers(), timeout: freeTimeout },
      ),
    playgroundOptions: () =>
      call(`${tenant}/playground/options`, { headers: headers(), timeout: freeTimeout }),
    playground: (version: number, model: string, question: string) =>
      call(`${tenant}/playground/runs`, {
        method: 'POST',
        headers: headers(),
        timeout: runTimeout,
        body: JSON.stringify({
          setup: {
            service: { id: plan.service, version, variant: 'default' },
            model,
            output: 'text',
          },
          input: { text: question },
        }),
      }),
    validate: (yaml: string, language: 'nb' | 'en' = 'en') =>
      call(`${api}/definitions/validate`, {
        method: 'POST',
        headers: { ...headers(language), 'content-type': 'application/yaml' },
        timeout: freeTimeout,
        body: yaml,
      }),
    publish: (yaml: string) =>
      call(`${api}/definitions`, {
        method: 'POST',
        headers: writeHeaders('application/yaml'),
        timeout: freeTimeout,
        body: yaml,
      }),
    lifecycle: (id: string, state: 'active' | 'archived') =>
      call(`${tenant}/services/${encodeURIComponent(id)}/lifecycle`, {
        method: 'PUT',
        headers: writeHeaders(),
        timeout: freeTimeout,
        body: JSON.stringify({ state }),
      }),
    operatorWrite: () =>
      call(`${api}/operator/tenants`, {
        method: 'POST',
        headers: writeHeaders(),
        timeout: freeTimeout,
        body: '{}',
      }),
    feedback: (task: string, body: object) =>
      call(`${api}/api/feedback`, {
        method: 'POST',
        headers: headers(),
        timeout: freeTimeout,
        body: JSON.stringify({ task, ...body }),
      }),
  };
};

export type Client = ReturnType<typeof createClient>;
