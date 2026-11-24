// Validates every stored definition (seeds, examples, fixtures, tenant exports) against the current schema.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import {
  definitionKinds,
  exportFormat,
  validateDefinition,
  type PluginSchemas,
  type ValidationError,
} from '@genai/definitions';

export interface StoredDefinition {
  source: string;
  definition: unknown;
}

export interface Broken {
  source: string;
  errors: ValidationError[];
}

const kinds = new Set<string>(definitionKinds);
const kindLine = /^kind:[ \t]*['"]?(Service|StepFlow|Skill|Block)['"]?[ \t]*(#.*)?$/m;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDefinition = (value: unknown) => isRecord(value) && kinds.has(String(value.kind));

export const readStored = (
  source: string,
  text: string,
): { definitions: StoredDefinition[]; broken: Broken[] } => {
  if (source.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        definitions: [],
        broken:
          text.includes(exportFormat) || /"kind":\s*"(Service|StepFlow|Skill|Block)"/.test(text)
            ? [
                {
                  source,
                  errors: [{ path: '', message: `not valid JSON: ${(error as Error).message}` }],
                },
              ]
            : [],
      };
    }
    if (isRecord(parsed) && parsed.format === exportFormat && Array.isArray(parsed.definitions))
      return {
        definitions: parsed.definitions.map((entry, i) => ({
          source: `${source}#definitions[${i}]`,
          definition: isRecord(entry) ? entry.definition : entry,
        })),
        broken: [],
      };
    return {
      definitions: isDefinition(parsed) ? [{ source, definition: parsed }] : [],
      broken: [],
    };
  }
  if (!kindLine.test(text)) return { definitions: [], broken: [] };
  const documents = parseAllDocuments(text);
  const list = Array.isArray(documents) ? documents : [documents];
  const definitions: StoredDefinition[] = [];
  const broken: Broken[] = [];
  list.forEach((doc, i) => {
    const at = list.length > 1 ? `${source}#${i}` : source;
    if (doc.errors.length > 0)
      broken.push({
        source: at,
        errors: [{ path: '', message: `not valid YAML: ${doc.errors[0]?.message}` }],
      });
    else if (isDefinition(doc.toJS())) definitions.push({ source: at, definition: doc.toJS() });
  });
  return { definitions, broken };
};

class AnyId<V> extends Map<string, V> {
  readonly #fallback: V;
  constructor(known: Iterable<[string, V]>, fallback: V) {
    super(known);
    this.#fallback = fallback;
  }
  override get(id: string) {
    return super.get(id) ?? this.#fallback;
  }
  override has() {
    return true;
  }
}

class AnyName extends Set<string> {
  override has() {
    return true;
  }
}

const everything = { includes: () => true } as unknown as string[];

export const schemaOnly = (plugins: PluginSchemas): PluginSchemas => {
  const { strategies, guardrails, settings, retrieval, strategyResidency } = plugins;
  return {
    strategies,
    guardrails,
    ...(settings ? { settings } : {}),
    ...(retrieval ? { retrieval } : {}),
    ...(strategyResidency ? { strategyResidency } : {}),
    tools: new AnyId(plugins.tools, z.unknown()),
    blocks: new AnyName(),
    rerankers: new AnyName(),
    models: new AnyId([], {
      residency: 'norway',
      capabilities: everything,
      operations: everything,
    }),
    allowHighRisk: true,
    allowPublicAudience: true,
  };
};

export const checkDefinitions = (stored: StoredDefinition[], plugins: PluginSchemas): Broken[] => {
  const open = schemaOnly(plugins);
  return stored.flatMap(({ source, definition }) => {
    const result = validateDefinition(definition, open);
    return result.ok ? [] : [{ source, errors: result.errors }];
  });
};

const definitionFile = /\.(ya?ml|json)$/;

const filesIn = (path: string): string[] =>
  statSync(path).isDirectory()
    ? readdirSync(path)
        .sort()
        .flatMap((name) => filesIn(join(path, name)))
    : definitionFile.test(path)
      ? [path]
      : [];

const trackedFiles = (root: string) =>
  execFileSync('git', ['ls-files', '-z', '--', '*.yaml', '*.yml', '*.json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .map((file) => join(root, file))
    .filter((file) => existsSync(file));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, '..');
  const paths = process.argv.slice(2);
  const files = paths.length > 0 ? paths.flatMap(filesIn) : trackedFiles(root);
  const read = files.map((file) => readStored(relative(root, file), readFileSync(file, 'utf8')));
  const stored = read.flatMap((r) => r.definitions);
  const { bootPlatform } = await import('../apps/api/src/testkit.ts');
  const { platform } = await bootPlatform();
  const broken = [...read.flatMap((r) => r.broken), ...checkDefinitions(stored, platform.plugins)];
  if (broken.length === 0) {
    console.log(`${stored.length} stored definitions validate against the current schema.`);
    process.exit(0);
  }
  console.error(
    `${broken.length} stored definitions no longer validate against the current schema:`,
  );
  for (const { source, errors } of broken)
    for (const error of errors)
      console.error(`  ${source}  ${error.path || '.'}: ${error.message}`);
  process.exit(1);
}
