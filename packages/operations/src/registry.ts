import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseDescriptor, type Descriptor } from './descriptor.js';
import { DescriptorError } from './shape.js';

export const bundledDescriptorDir = join(import.meta.dirname, '..', 'descriptors');
export const bundledFixtureDir = join(import.meta.dirname, '..', 'fixtures');

export interface DescriptorRegistry {
  get(id: string): Descriptor | undefined;
  list(): Descriptor[];
  /** Reads descriptors uploaded since the last read; a registry of files alone has none. */
  refresh?(): Promise<void>;
}

export const descriptorRegistry = (descriptors: readonly Descriptor[]): DescriptorRegistry => {
  const byId = new Map<string, Descriptor>();
  for (const d of descriptors) {
    if (byId.has(d.id)) throw new DescriptorError(`two descriptors are called ${d.id}`);
    byId.set(d.id, d);
  }
  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
};

export const descriptorFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? descriptorFiles(join(dir, e.name))
          : e.name.endsWith('.yaml')
            ? [join(dir, e.name)]
            : [],
      )
    : [];

/** Reads every descriptor under a folder; a file is named after its id, `<provider>/<operation>@<version>.yaml`. */
export const loadDescriptors = (dir: string = bundledDescriptorDir): DescriptorRegistry =>
  descriptorRegistry(
    descriptorFiles(dir).map((file) => {
      const descriptor = parseDescriptor(readFileSync(file, 'utf8'));
      const named = relative(dir, file)
        .replace(/\\/g, '/')
        .replace(/\.yaml$/, '');
      if (named !== descriptor.id)
        throw new DescriptorError(`${named}.yaml holds ${descriptor.id}; name it after its id`);
      return descriptor;
    }),
  );
