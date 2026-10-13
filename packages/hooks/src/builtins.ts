import { z } from 'zod';
import type { HookCall, HookConfig, HookInvoker, HookVerdict } from './hook.js';

export interface BuiltinHook<C = unknown> {
  id: string;
  title: string;
  description: string;
  config: z.ZodType<C>;
  run(config: C, call: HookCall): HookVerdict | Promise<HookVerdict>;
  examples: { config: C; allow: HookCall; refuse?: HookCall };
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (typeof value === 'object' && value !== null)
    return Object.values(value as Record<string, unknown>)
      .map(textOf)
      .join('\n');
  return value === undefined || value === null ? '' : String(value);
};

export const hookText = (call: HookCall) => textOf(call.payload);

const example = (text: string): HookCall => ({
  point: 'before_model',
  tenant: '991825827',
  service: 'kontrakt',
  payload: { model: 'kontrakt/modell', messages: [{ role: 'user', content: text }] },
});

const blockTerms: BuiltinHook<{ terms: string[]; reason?: string | undefined }> = {
  id: 'block-terms',
  title: 'Stopp ord og uttrykk',
  description: 'Stopper kallet når teksten inneholder et av ordene.',
  config: z.strictObject({
    terms: z.array(z.string().trim().min(1)).min(1),
    reason: z.string().optional(),
  }),
  run: (config, call) => {
    const text = hookText(call).toLowerCase();
    const found = config.terms.find((t) => text.includes(t.toLowerCase()));
    return found
      ? { decision: 'refuse', reason: config.reason ?? `teksten inneholder «${found}»` }
      : { decision: 'allow' };
  },
  examples: {
    config: { terms: ['fødselsnummer'] },
    allow: example('Hva er fristen for tilskudd?'),
    refuse: example('Her er fødselsnummeret mitt'),
  },
};

const maxLength: BuiltinHook<{ chars: number }> = {
  id: 'max-length',
  title: 'Største lengde',
  description: 'Stopper kallet når teksten er lengre enn grensen.',
  config: z.strictObject({ chars: z.number().int().positive() }),
  run: (config, call) => {
    const length = hookText(call).length;
    return length > config.chars
      ? { decision: 'refuse', reason: `teksten er ${length} tegn, grensen er ${config.chars}` }
      : { decision: 'allow' };
  },
  examples: {
    config: { chars: 200 },
    allow: example('Kort spørsmål'),
    refuse: example('lang '.repeat(100)),
  },
};

const tag: BuiltinHook<{ labels: Record<string, string> }> = {
  id: 'tag',
  title: 'Merk kjøringen',
  description: 'Legger faste merker på kjøringen i revisjonsloggen.',
  config: z.strictObject({ labels: z.record(z.string(), z.string()) }),
  run: (config) => ({ decision: 'allow', annotations: { ...config.labels } }),
  examples: { config: { labels: { avdeling: 'okonomi' } }, allow: example('Hei') },
};

const measure: BuiltinHook<Record<string, never>> = {
  id: 'measure',
  title: 'Mål lengde',
  description: 'Teller tegn i teksten og legger tallet i revisjonsloggen.',
  config: z.strictObject({}),
  run: (_config, call) => ({ decision: 'allow', annotations: { chars: hookText(call).length } }),
  examples: { config: {}, allow: example('Hei') },
};

export const builtinHooks: BuiltinHook[] = [blockTerms, maxLength, tag, measure] as BuiltinHook[];

export const builtinHook = (id: string) => builtinHooks.find((h) => h.id === id);

export const checkBuiltinConfig = (id: string, config: unknown) => {
  const hook = builtinHook(id);
  if (!hook) return { ok: false as const, message: `no built-in hook ${id}` };
  const parsed = hook.config.safeParse(config);
  return parsed.success
    ? { ok: true as const, config: parsed.data }
    : {
        ok: false as const,
        message: parsed.error.issues
          .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
          .join('; '),
      };
};

export type WebhookHookSender = (
  hook: HookConfig & { handler: { kind: 'webhook' } },
  call: HookCall,
  signal: AbortSignal,
) => Promise<HookVerdict>;

export const hookInvoker =
  (webhook?: WebhookHookSender): HookInvoker =>
  async (hook, call, signal) => {
    const handler = hook.handler;
    if (handler.kind === 'webhook') {
      if (!webhook) throw new Error('webhook hooks are not available here');
      return webhook(hook as HookConfig & { handler: typeof handler }, call, signal);
    }
    const builtin = builtinHook(handler.id);
    if (!builtin) throw new Error(`no built-in hook ${handler.id}`);
    return builtin.run(builtin.config.parse(handler.config), call);
  };
