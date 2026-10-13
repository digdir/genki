import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateDefinition,
  type Definition,
  type DefinitionStore,
  type PluginSchemas,
  type PromptFiles,
} from '@genai/definitions';
import { defaultPlatformTenant, ownedByPlatformTenant } from '@genai/composition';
import type { Context } from 'hono';
import { parse as parseYaml } from 'yaml';
import { platformActor, type Admin } from './admin.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export const seedActor = 'platform:seed';
export const seedReason = 'local configuration';

export interface DefinitionSource {
  dir: string;
  promptsDir?: string;
}

export interface GitDefinition {
  file: string;
  kind: Definition['kind'];
  tenant: string;
  id: string;
  definition: Record<string, unknown>;
  files: PromptFiles;
}

export interface UnreadableFile {
  file: string;
  error: string;
}

export type DriftState = 'in-sync' | 'drifted' | 'not-published' | 'missing-from-git';

export interface DriftItem {
  kind: Definition['kind'];
  tenant: string;
  id: string;
  file?: string;
  state: DriftState;
  published?: { version: number; by: string; at: string; reason: string };
  differences?: string[];
}

export interface DriftReport {
  checkedAt: string;
  summary: Record<DriftState, number>;
  items: DriftItem[];
  unreadable: UnreadableFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const promptsOf = (dir: string | undefined): PromptFiles =>
  dir && existsSync(dir)
    ? Object.fromEntries(
        readdirSync(dir).map((f) => [`prompts/${f}`, readFileSync(join(dir, f), 'utf8')]),
      )
    : {};

export const readGitDefinitions = (
  sources: DefinitionSource[],
  platformTenant: string = defaultPlatformTenant,
) => {
  const definitions: GitDefinition[] = [];
  const unreadable: UnreadableFile[] = [];
  for (const source of sources) {
    if (!existsSync(source.dir)) continue;
    const prompts = promptsOf(source.promptsDir);
    for (const name of readdirSync(source.dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort()) {
      const file = join(source.dir, name);
      try {
        const parsed = parseYaml(readFileSync(file, 'utf8')) as unknown;
        if (!isRecord(parsed) || !isRecord(parsed.metadata))
          throw new Error('the file has no metadata');
        const definition = ownedByPlatformTenant(parsed, platformTenant);
        const metadata = definition.metadata as Record<string, unknown>;
        const text = JSON.stringify(definition);
        definitions.push({
          file,
          kind: (typeof definition.kind === 'string'
            ? definition.kind
            : 'Service') as Definition['kind'],
          tenant: String(metadata.tenant ?? ''),
          id: String(metadata.id ?? ''),
          definition,
          files: Object.fromEntries(
            Object.entries(prompts).filter(([path]) => text.includes(path)),
          ),
        });
      } catch (error) {
        unreadable.push({ file, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { definitions, unreadable };
};

export type SeedOutcome =
  | { file: string; state: 'published'; version: number; task: string }
  | { file: string; state: 'present' }
  | { file: string; state: 'skipped'; errors: unknown[]; task?: string };

export const seedDefinitions = async (
  admin: Admin,
  store: DefinitionStore,
  definitions: GitDefinition[],
): Promise<SeedOutcome[]> => {
  const outcomes: SeedOutcome[] = [];
  for (const entry of definitions) {
    if (await store.get(entry.kind, entry.tenant, entry.id)) {
      outcomes.push({ file: entry.file, state: 'present' });
      continue;
    }
    try {
      const result = await admin.publish(platformActor('seed', entry.tenant), {
        definition: entry.definition,
        files: entry.files,
        reason: seedReason,
      });
      outcomes.push(
        result.ok
          ? {
              file: entry.file,
              state: 'published',
              version: result.value.version,
              task: result.task,
            }
          : { file: entry.file, state: 'skipped', errors: result.errors, task: result.task },
      );
    } catch (error) {
      outcomes.push({
        file: entry.file,
        state: 'skipped',
        errors: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      });
    }
  }
  return outcomes;
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .filter((k) => value[k] !== undefined)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;

const differencesOf = (want: unknown, have: unknown, path: string, out: string[]) => {
  if (out.length >= 20) return;
  if (isRecord(want) && isRecord(have)) {
    for (const key of [...new Set([...Object.keys(want), ...Object.keys(have)])].sort())
      differencesOf(want[key], have[key], path ? `${path}.${key}` : key, out);
    return;
  }
  if (Array.isArray(want) && Array.isArray(have) && want.length === have.length) {
    want.forEach((w, i) => differencesOf(w, have[i], `${path}[${i}]`, out));
    return;
  }
  if (JSON.stringify(canonical(want)) !== JSON.stringify(canonical(have))) out.push(path || '.');
};

const withoutVersion = (definition: unknown) => {
  if (!isRecord(definition) || !isRecord(definition.metadata)) return definition;
  const metadata = { ...definition.metadata };
  delete metadata.version;
  return { ...definition, metadata };
};

export const driftReport = async (
  store: DefinitionStore,
  plugins: PluginSchemas,
  read: ReturnType<typeof readGitDefinitions>,
  now: () => Date = () => new Date(),
): Promise<DriftReport> => {
  const items: DriftItem[] = [];
  const inGit = new Set<string>();
  for (const entry of read.definitions) {
    inGit.add(`${entry.kind}:${entry.tenant}/${entry.id}`);
    const latest = await store.get(entry.kind, entry.tenant, entry.id);
    const base = { kind: entry.kind, tenant: entry.tenant, id: entry.id, file: entry.file };
    if (!latest) {
      items.push({ ...base, state: 'not-published' });
      continue;
    }
    const validated = validateDefinition(entry.definition, plugins);
    const want = {
      definition: withoutVersion(validated.ok ? validated.definition : entry.definition),
      files: entry.files,
    };
    const have = { definition: withoutVersion(latest.definition), files: latest.files };
    const differences: string[] = [];
    differencesOf(want, have, '', differences);
    items.push({
      ...base,
      state: differences.length === 0 ? 'in-sync' : 'drifted',
      published: {
        version: latest.version,
        by: latest.publishedBy,
        at: latest.publishedAt,
        reason: latest.reason,
      },
      ...(differences.length ? { differences } : {}),
    });
  }
  for (const tenant of new Set(read.definitions.map((d) => d.tenant)))
    for (const listed of await store.list(tenant)) {
      if (inGit.has(`${listed.kind}:${tenant}/${listed.id}`)) continue;
      const first = (await store.versions(listed.kind, tenant, listed.id))[0];
      if (first?.publishedBy !== seedActor) continue;
      const latest = await store.get(listed.kind, tenant, listed.id);
      items.push({
        kind: listed.kind,
        tenant,
        id: listed.id,
        state: 'missing-from-git',
        ...(latest
          ? {
              published: {
                version: latest.version,
                by: latest.publishedBy,
                at: latest.publishedAt,
                reason: latest.reason,
              },
            }
          : {}),
      });
    }
  const summary: Record<DriftState, number> = {
    'in-sync': 0,
    drifted: 0,
    'not-published': 0,
    'missing-from-git': 0,
  };
  for (const item of items) summary[item.state] += 1;
  return { checkedAt: now().toISOString(), summary, items, unreadable: read.unreadable };
};

const problem = (c: Context, status: 401 | 403, title: string) =>
  c.json({ type: 'about:blank', title, status }, status, {
    'content-type': 'application/problem+json',
  });

export const createDefinitionSourcesModule =
  (sources: DefinitionSource[], platformTenant?: string): PlatformModuleFactory =>
  (deps) => ({
    id: 'definition-sources',
    mount: (app, mounted) => {
      app.get('/operator/definitions/drift', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Unauthorized');
        if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
        return c.json(
          await driftReport(
            deps.definitions,
            deps.plugins,
            readGitDefinitions(sources, platformTenant),
          ),
        );
      });
    },
  });
