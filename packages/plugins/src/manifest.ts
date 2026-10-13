import { z } from 'zod';

export const pluginKinds = [
  'model',
  'embedding',
  'rerank',
  'knowledge',
  'tool-source',
  'blob',
  'step-block',
  'hook',
  'agent',
  'evaluator',
] as const;
export type PluginKind = (typeof pluginKinds)[number];

export const dataLocations = ['norway', 'eu', 'global'] as const;
export type DataLocation = (typeof dataLocations)[number];

const pluginId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, . _ -');
const contractRef = z.string().regex(/^[a-z][a-z-]*@\d+$/, 'kind@major, for example model@1');

export const pluginManifest = z
  .strictObject({
    kind: z.enum(pluginKinds),
    id: pluginId,
    version: z.string().regex(/^\d+(\.\d+){0,2}$/),
    contract: contractRef,
    title: z.string().min(1),
    description: z.string().default(''),
    publisher: z.string().min(1).default('digdir'),
    origin: z.enum(['builtin', 'external']).default('builtin'),
    capabilities: z.array(z.string().min(1)).default([]),
    dataLocation: z.enum(dataLocations).nullable().default(null),
    configSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
    secrets: z.array(z.string().min(1)).default([]),
    hosts: z.array(z.string().min(1)).default([]),
  })
  .refine((m) => m.contract.split('@')[0] === m.kind, {
    path: ['contract'],
    message: 'the contract names the kind of the plug-in',
  });

export type PluginManifest = z.output<typeof pluginManifest>;
export type PluginManifestInput = z.input<typeof pluginManifest>;

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: { path: string; message: string }[] };

export const parseManifest = (input: unknown): ManifestResult => {
  const parsed = pluginManifest.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.') || '(root)',
      message: i.message,
    })),
  };
};

export const manifest = (input: PluginManifestInput): PluginManifest => pluginManifest.parse(input);

export const contractMajor = (contract: string) => Number(contract.split('@')[1]);
