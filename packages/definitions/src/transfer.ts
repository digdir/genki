import { z } from 'zod';
import type { SettingsRegistry, TenantSettings } from './config.js';
import type { PromptFiles } from './prompts.js';
import { definitionKinds, type Definition } from './schema.js';
import type { DefinitionStore } from './store.js';
import type { ValidationError } from './validate.js';

export const exportFormat = 'genai-tenant-export/v1';

const bundleSchema = z.strictObject({
  format: z.literal(exportFormat),
  tenant: z.string().regex(/^\d{9}$/),
  exportedAt: z.string(),
  definitions: z.array(
    z.strictObject({
      definition: z.looseObject({ kind: z.enum(definitionKinds) }),
      files: z.record(z.string(), z.string()).default({}),
    }),
  ),
  settings: z.strictObject({
    values: z.record(z.string(), z.unknown()).default({}),
    pins: z.record(z.string(), z.number().int().positive()).default({}),
  }),
});

export type TenantBundle = z.infer<typeof bundleSchema>;

export type ImportAction = 'create' | 'update' | 'unchanged' | 'skip';

export interface ImportPlanItem {
  target: string;
  action: ImportAction;
  conflict: boolean;
}

export interface ImportOptions {
  tenant: string;
  dryRun: boolean;
  onConflict: 'skip' | 'overwrite';
  actor: string;
  reason: string;
  check?: (definition: unknown, files: PromptFiles) => ValidationError[];
}

export type ImportResult =
  | { ok: true; dryRun: boolean; plan: ImportPlanItem[] }
  | { ok: false; errors: ValidationError[]; plan: ImportPlanItem[] };

const dropVersion = (metadata: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== 'version'));

const withoutVersion = (d: Definition) => ({ ...d, metadata: dropVersion(d.metadata) });

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

const publishOrder: Record<Definition['kind'], number> = { StepFlow: 0, Skill: 1, Service: 2 };

const comparable = (definition: unknown, files: PromptFiles) => stable({ definition, files });

export const exportTenant = async (
  tenant: string,
  store: DefinitionStore,
  settings: SettingsRegistry,
  now: () => Date = () => new Date(),
): Promise<TenantBundle> => {
  const entries = await store.list(tenant);
  const latest = await Promise.all(entries.map(({ kind, id }) => store.get(kind, tenant, id)));
  const ordered = latest
    .flatMap((v) => (v ? [v] : []))
    .sort((a, b) => publishOrder[a.definition.kind] - publishOrder[b.definition.kind]);
  const { values, pins } = settings.tenant(tenant);
  return {
    format: exportFormat,
    tenant,
    exportedAt: now().toISOString(),
    definitions: ordered.map((v) => ({
      definition: withoutVersion(
        v.definition,
      ) as unknown as TenantBundle['definitions'][number]['definition'],
      files: v.files,
    })),
    settings: { values, pins },
  };
};

const retarget = (definition: Record<string, unknown>, tenant: string): Record<string, unknown> => {
  return { ...definition, metadata: { ...dropVersion(definition.metadata as object), tenant } };
};

export const parseBundle = (input: unknown) => bundleSchema.safeParse(input);

export const importTenant = async (
  input: unknown,
  store: DefinitionStore,
  settings: SettingsRegistry,
  options: ImportOptions,
): Promise<ImportResult> => {
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      plan: [],
      errors: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    };
  }
  const bundle = parsed.data;
  const plan: ImportPlanItem[] = [];
  const definitions = bundle.definitions.map((d) => ({
    definition: retarget(d.definition, options.tenant),
    files: d.files,
  }));

  for (const { definition, files } of definitions) {
    const kind = definition.kind as Definition['kind'];
    const id = String((definition.metadata as { id?: unknown }).id);
    const current = await store.get(kind, options.tenant, id);
    const target = `${kind}:${id}`;
    if (!current) plan.push({ target, action: 'create', conflict: false });
    else if (
      comparable(withoutVersion(current.definition), current.files) ===
      comparable(definition, files)
    )
      plan.push({ target, action: 'unchanged', conflict: false });
    else
      plan.push({
        target,
        action: options.onConflict === 'overwrite' ? 'update' : 'skip',
        conflict: true,
      });
  }

  const existing = settings.tenant(options.tenant);
  for (const [key, value] of Object.entries(bundle.settings.values)) {
    const target = `setting:${key}`;
    if (!(key in existing.values)) plan.push({ target, action: 'create', conflict: false });
    else if (stable(existing.values[key]) === stable(value))
      plan.push({ target, action: 'unchanged', conflict: false });
    else
      plan.push({
        target,
        action: options.onConflict === 'overwrite' ? 'update' : 'skip',
        conflict: true,
      });
  }
  for (const [key, version] of Object.entries(bundle.settings.pins)) {
    const target = `pin:${key}`;
    if (!(key in existing.pins)) plan.push({ target, action: 'create', conflict: false });
    else if (existing.pins[key] === version)
      plan.push({ target, action: 'unchanged', conflict: false });
    else
      plan.push({
        target,
        action: options.onConflict === 'overwrite' ? 'update' : 'skip',
        conflict: true,
      });
  }

  const errors: ValidationError[] = [];
  for (const { definition, files } of definitions) {
    const target = `${String(definition.kind)}:${String((definition.metadata as { id?: unknown }).id)}`;
    const action = plan.find((p) => p.target === target)?.action;
    if (options.check && (action === 'create' || action === 'update'))
      errors.push(
        ...options.check(definition, files).map((e) => ({ ...e, path: `${target}.${e.path}` })),
      );
  }
  for (const [key, version] of Object.entries(bundle.settings.pins)) {
    if (!settings.defaultOf(key, version))
      errors.push({
        path: `settings.pins.${key}`,
        message: `no platform default version ${version}`,
      });
  }
  for (const [key, value] of Object.entries(bundle.settings.values)) {
    const preview = settings.previewTenant(options.tenant, key, value, []);
    if (!preview.ok)
      errors.push(...preview.errors.map((e) => ({ ...e, path: `settings.values.${e.path}` })));
  }
  if (errors.length > 0) return { ok: false, errors, plan };
  if (options.dryRun) return { ok: true, dryRun: true, plan };

  const before: TenantSettings = settings.tenant(options.tenant);
  const applies = (target: string) => plan.find((p) => p.target === target)?.action;
  for (const { definition, files } of definitions) {
    const target = `${String(definition.kind)}:${String((definition.metadata as { id?: unknown }).id)}`;
    const action = applies(target);
    if (action !== 'create' && action !== 'update') continue;
    const result = await store.publish(definition, options.actor, options.reason, files);
    if (!result.ok) {
      settings.restoreTenant(options.tenant, before);
      return {
        ok: false,
        plan,
        errors: result.errors.map((e) => ({ ...e, path: `${target}.${e.path}` })),
      };
    }
  }
  for (const [key, value] of Object.entries(bundle.settings.values)) {
    const action = applies(`setting:${key}`);
    if (action === 'create' || action === 'update') settings.setTenant(options.tenant, key, value);
  }
  for (const [key, version] of Object.entries(bundle.settings.pins)) {
    const action = applies(`pin:${key}`);
    if (action === 'create' || action === 'update') {
      const pinned = settings.pin(options.tenant, key, version);
      if (!pinned.ok)
        errors.push(...pinned.errors.map((e) => ({ ...e, path: `settings.pins.${e.path}` })));
    }
  }
  return errors.length > 0 ? { ok: false, errors, plan } : { ok: true, dryRun: false, plan };
};
