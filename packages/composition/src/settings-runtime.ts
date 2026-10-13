import type { Input, Principal } from '@genai/contracts';
import {
  checkSettingValue,
  languageInstructionsSetting,
  platformSettingByKey,
  type CallOverrideAllowlist,
  type Effective,
  type SettingsRegistry,
} from '@genai/definitions';
import {
  answerLanguage,
  writtenStandards,
  type HouseStyle,
  type Language,
  type WrittenStandard,
} from '@genai/guardrails';
import { OVERRIDE_SCOPE } from '@genai/identity';
import type { InvocationContext, Strategy } from '@genai/kernel';

export const legacyOverrideAliases: Record<string, string> = {
  'retrieve-top-k': 'retrieval.retrieveTopK',
  'retrieve-auto-filter': 'retrieval.autoFilter.enabled',
};

export const passThroughOverrides = new Set(['retrieve-filter-by']);

export type OverrideCheck =
  { ok: true; settings: Record<string, unknown> } | { ok: false; message: string };

export const allowedOverridesOf = (principal: Principal): '*' | string[] =>
  principal.kind === 'operator'
    ? '*'
    : (principal.scopes ?? [])
        .filter((s) => s.startsWith(OVERRIDE_SCOPE))
        .map((s) => s.slice(OVERRIDE_SCOPE.length));

const allows = (allowed: '*' | string[], key: string) =>
  allowed === '*' ||
  allowed.some(
    (a) => a === key || a === '*' || (a.endsWith('.*') && key.startsWith(a.slice(0, -1))),
  );

export interface ServiceOverrides {
  entryPoint?: string;
  allowed: '*' | string[];
}

export const serviceOverridesOf = (config: unknown, entryPoint?: string): ServiceOverrides => {
  const list = (config as { callOverrides?: CallOverrideAllowlist } | undefined)?.callOverrides;
  const allowed = entryPoint ? list?.[entryPoint as keyof CallOverrideAllowlist] : undefined;
  return { ...(entryPoint ? { entryPoint } : {}), allowed: allowed ?? '*' };
};

export const checkOverrides = (
  registry: SettingsRegistry,
  principal: Principal,
  overrides: Record<string, unknown> = {},
  service: ServiceOverrides = { allowed: '*' },
): OverrideCheck => {
  const allowed = allowedOverridesOf(principal);
  const settings: Record<string, unknown> = {};
  const problems: string[] = [];
  const known = new Map(registry.definitions().map((d) => [d.key, d]));
  for (const [raw, value] of Object.entries(overrides)) {
    if (passThroughOverrides.has(raw)) continue;
    const alias = legacyOverrideAliases[raw];
    const key = alias ?? raw;
    const named = alias ? `${raw} (${key})` : key;
    const definition = known.get(key);
    if (!definition) {
      problems.push(`${raw} is not a setting`);
      continue;
    }
    const listed = (list: '*' | string[]) => allows(list, key) || (!!alias && allows(list, raw));
    if (!listed(allowed)) {
      problems.push(`${named} is not in the credential's list of overridable settings`);
      continue;
    }
    if (!listed(service.allowed)) {
      problems.push(`${named} cannot be overridden on ${service.entryPoint} for this service`);
      continue;
    }
    const checked = checkSettingValue(definition, 'call', value);
    if (!checked.ok) problems.push(`${key}: ${checked.reason}`);
    else settings[key] = checked.value;
  }
  if (problems.length === 0) return { ok: true, settings };
  const shown = (list: '*' | string[]) =>
    list === '*' ? 'all settings' : list.join(', ') || 'none';
  const onService =
    service.allowed === '*'
      ? ''
      : ` Overridable on ${service.entryPoint} for this service: ${shown(service.allowed)}.`;
  return {
    ok: false,
    message: `Overrides refused: ${problems.join('; ')}. Overridable with this credential: ${shown(allowed)}.${onService}`,
  };
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const merge = (base: unknown, top: unknown): unknown =>
  isObject(base) && isObject(top)
    ? Object.fromEntries(
        [...new Set([...Object.keys(base), ...Object.keys(top)])].map((k) => [
          k,
          k in top ? merge(base[k], top[k]) : base[k],
        ]),
      )
    : top === undefined
      ? base
      : top;

const setPath = (target: Record<string, unknown>, path: string[], value: unknown) => {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (value === null) Reflect.deleteProperty(target, head);
    else target[head] = value;
    return;
  }
  const next = isObject(target[head]) ? target[head] : {};
  target[head] = next;
  setPath(next, rest, value);
};

const targets = (strategy: string): Record<string, string[]> => ({
  'retrievalConfig@@genai/retrieval': ['knowledge', 'retrieval'],
  'plannerConfig@@genai/retrieval': ['knowledge', 'planner'],
  ...(strategy === 'agent-loop'
    ? { 'agentLoopConfig@@genai/strategy-agent-loop': ['strategy'] }
    : {}),
  ...(strategy === 'rag-single-shot' ? { 'ragConfig@@genai/strategy-rag': ['strategy'] } : {}),
});

const lowerSources = new Set(['platform', 'tenant', 'pin']);

export const applySettings = (
  config: unknown,
  effective: Record<string, Effective>,
  strategy: string,
): Record<string, unknown> => {
  const lower: Record<string, unknown> = {};
  const upper: Record<string, unknown> = {};
  const where = targets(strategy);
  for (const resolved of Object.values(effective)) {
    if (resolved.source === 'default') continue;
    const layer = lowerSources.has(resolved.source) ? lower : upper;
    if (layer === lower && resolved.value === null) continue;
    for (const consumer of platformSettingByKey.get(resolved.key)?.consumers ?? []) {
      const [root, ...field] = consumer.field.split('.');
      const base = where[`${root}@${consumer.package}`];
      if (base && field.length > 0) setPath(layer, [...base, ...field], resolved.value);
    }
  }
  const withLower = merge(lower, config ?? {}) as Record<string, unknown>;
  const result = structuredClone(withLower);
  const apply = (node: unknown, path: string[]) => {
    if (!isObject(node)) return setPath(result, path, node);
    for (const [k, v] of Object.entries(node)) apply(v, [...path, k]);
  };
  apply(upper, []);
  return result;
};

const callOverrides = (input: Input) => {
  const data = input.data as { overrides?: unknown } | undefined;
  return isObject(data?.overrides) ? data.overrides : undefined;
};

export const settingsFor = (
  registry: SettingsRegistry,
  ctx: InvocationContext,
  config: unknown,
  call?: Record<string, unknown>,
) => {
  const runtime = (config ?? {}) as {
    settings?: Record<string, unknown>;
    model?: { tenant?: string };
  };
  const tenant = runtime.model?.tenant ?? ctx.tenant;
  return registry.effective(
    tenant,
    {
      tenant,
      service: ctx.capability.id,
      version: Number(ctx.capability.version) || 1,
      settings: runtime.settings ?? {},
    },
    call,
  );
};

export const writtenStandardSetting = 'answers.writtenStandard';

const standardSetting = (
  registry: SettingsRegistry,
  ctx: InvocationContext,
  input: Input,
  config: unknown,
) => {
  const checked = checkOverrides(
    registry,
    ctx.principal,
    callOverrides(input),
    serviceOverridesOf(config, ctx.entryPoint),
  );
  const call =
    checked.ok && Object.keys(checked.settings).length > 0 ? checked.settings : undefined;
  const resolved = settingsFor(registry, ctx, config, call)[writtenStandardSetting];
  return {
    value: resolved?.value,
    fixed: resolved?.source === 'service' || resolved?.source === 'call',
  };
};

export const writtenStandardFor = (
  registry: SettingsRegistry,
  ctx: InvocationContext,
  input: Input,
  config: unknown,
  preference?: WrittenStandard,
): WrittenStandard | undefined => {
  const { value, fixed } = standardSetting(registry, ctx, input, config);
  const chosen = !fixed && preference ? preference : value;
  return writtenStandards.find((s) => s === chosen);
};

export const answerLanguageFor = (
  registry: SettingsRegistry,
  ctx: InvocationContext,
  input: Input,
  config: unknown,
  question: string,
  person: { writtenStandard?: WrittenStandard; language?: string } = {},
): Language | undefined => {
  if (person.language === 'en' && !standardSetting(registry, ctx, input, config).fixed) return 'en';
  return answerLanguage(
    writtenStandardFor(registry, ctx, input, config, person.writtenStandard),
    question,
  );
};

export const houseStyleFor = (
  registry: SettingsRegistry,
  ctx: InvocationContext,
  config: unknown,
  language: Language,
): HouseStyle | undefined => {
  const resolved = settingsFor(registry, ctx, config)[languageInstructionsSetting(language)];
  if (typeof resolved?.value !== 'string' || !resolved.value.trim()) return undefined;
  const layer =
    resolved.source === 'tenant' || resolved.source === 'service' ? resolved.source : 'platform';
  return { text: resolved.value, layer };
};

export const withSettings = <C>(registry: SettingsRegistry, inner: Strategy<C>): Strategy<C> => ({
  ...inner,
  run: async function* (ctx, input, config) {
    const checked = checkOverrides(
      registry,
      ctx.principal,
      callOverrides(input),
      serviceOverridesOf(config, ctx.entryPoint),
    );
    if (!checked.ok) throw new Error(checked.message);
    const call = Object.keys(checked.settings).length > 0 ? checked.settings : undefined;
    const effective = settingsFor(registry, ctx, config, call);
    yield {
      type: 'x.settings.applied',
      audience: 'audit',
      data: {
        ...(call ? { overrides: call } : {}),
        effective: Object.fromEntries(
          Object.values(effective)
            .filter((r) => r.source !== 'default')
            .map((r) => [r.key, { value: r.value, source: r.source }]),
        ),
      },
    };
    yield* inner.run(ctx, input, applySettings(config, effective, inner.id) as C);
  },
  ...(inner.resume
    ? {
        resume: (ctx: InvocationContext, checkpoint: unknown, response: Input, config: C) =>
          (inner.resume as NonNullable<Strategy<C>['resume']>)(
            ctx,
            checkpoint,
            response,
            applySettings(config, settingsFor(registry, ctx, config), inner.id) as C,
          ),
      }
    : {}),
});
