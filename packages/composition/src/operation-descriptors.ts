import {
  descriptorDocument,
  DescriptorError,
  toDescriptor,
  type Descriptor,
  type DescriptorRegistry,
} from '@genai/operations';
import {
  contractFailures,
  operationContract,
  OperationFixtureSpec,
  type OperationFixture,
} from '@genai/operations/contract';
import { z } from 'zod';
import { platformScope, type ConfigEntry, type ConfigEntryStore } from './config-store.js';

export const descriptorEntryKind = 'operation-descriptor';
export const uploadStatuses = ['review', 'described'] as const;
export type UploadStatus = (typeof uploadStatuses)[number];
export const maxDescriptorFixtures = 20;
export const maxDescriptorUploadBytes = 512 * 1024;

export interface UploadedDescriptor {
  document: Record<string, unknown>;
  fixtures: OperationFixture[];
  status: UploadStatus;
}

export interface UploadProblem {
  path: string;
  message: string;
}

export const DescriptorUploadBody = z.strictObject({
  descriptor: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  fixtures: z.array(OperationFixtureSpec).max(maxDescriptorFixtures).default([]),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const uploadedDescriptorOf = (spec: UploadedDescriptor): Descriptor =>
  toDescriptor({ ...spec.document, status: spec.status });

const loads = (spec: UploadedDescriptor): Descriptor | Error => {
  try {
    return uploadedDescriptorOf(spec);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

/** Why a stored upload no longer loads, when the loader rules have tightened since it was stored. */
export const uploadLoadProblem = (spec: UploadedDescriptor): string | undefined => {
  const loaded = loads(spec);
  return loaded instanceof Error ? loaded.message : undefined;
};

export type UploadCheck =
  | { ok: true; upload: UploadedDescriptor; descriptor: Descriptor; checks: number }
  | { ok: false; problems: UploadProblem[] };

/** The loader rules, and `operation@1` with the masking probe on any fixtures, run on an upload before it is stored. */
export const checkDescriptorUpload = async (id: string, body: unknown): Promise<UploadCheck> => {
  const refuse = (problems: UploadProblem[]): UploadCheck => ({ ok: false, problems });
  const parsed = DescriptorUploadBody.safeParse(body);
  if (!parsed.success)
    return refuse(
      parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'body', message: i.message })),
    );
  let document: unknown;
  try {
    document =
      typeof parsed.data.descriptor === 'string'
        ? descriptorDocument(parsed.data.descriptor)
        : parsed.data.descriptor;
  } catch (error) {
    return refuse([{ path: 'descriptor', message: messageOf(error) }]);
  }
  if (!isRecord(document))
    return refuse([{ path: 'descriptor', message: 'a descriptor is a mapping of fields' }]);
  const problems: UploadProblem[] = [];
  const status = document.status ?? 'review';
  if (status === 'typed')
    problems.push({
      path: 'descriptor.status',
      message: 'typed means Genki has its own code for the operation, so an upload is never typed',
    });
  else if (status !== 'review')
    problems.push({
      path: 'descriptor.status',
      message: 'an uploaded descriptor starts in review; an operator moves it to described after',
    });
  if (document.id !== id)
    problems.push({ path: 'id', message: `the descriptor is called ${String(document.id)}` });
  const fixtures = parsed.data.fixtures as OperationFixture[];
  const names = fixtures.map((f) => f.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length > 0)
    problems.push({
      path: 'fixtures',
      message: `two fixtures are called ${[...new Set(twice)].join(', ')}`,
    });
  if (problems.length > 0) return refuse(problems);
  const upload: UploadedDescriptor = {
    document: { ...document, status: 'review' },
    fixtures,
    status: 'review',
  };
  let descriptor: Descriptor;
  try {
    descriptor = uploadedDescriptorOf(upload);
  } catch (error) {
    if (!(error instanceof DescriptorError)) throw error;
    return refuse(error.message.split('; ').map((message) => ({ path: 'descriptor', message })));
  }
  if (fixtures.length === 0) return { ok: true, upload, descriptor, checks: 0 };
  const results = await operationContract(descriptor, fixtures);
  const failed = contractFailures(results);
  if (failed.length > 0)
    return refuse(
      failed.flatMap((r) =>
        r.problems.map((p) => ({
          path: `fixtures.${r.check.slice(0, r.check.indexOf(':'))}`,
          message: `${r.check}: ${p}`,
        })),
      ),
    );
  return { ok: true, upload, descriptor, checks: results.length };
};

export const uploadedDescriptors = async (store: ConfigEntryStore) =>
  (await store.latest({ kind: descriptorEntryKind, scope: platformScope })).filter(
    (e) => !e.deleted,
  ) as ConfigEntry<UploadedDescriptor>[];

export const uploadedDescriptor = async (store: ConfigEntryStore, id: string) => {
  const latest = (await store.history(descriptorEntryKind, platformScope, id)).at(-1);
  return latest && !latest.deleted ? (latest as ConfigEntry<UploadedDescriptor>) : undefined;
};

export interface LiveDescriptorRegistry extends DescriptorRegistry {
  bundled: DescriptorRegistry;
  refresh(): Promise<void>;
}

/** The bundled descriptors and the uploaded ones in the config store, read again on every refresh. */
export const liveDescriptors = (
  bundled: DescriptorRegistry,
  store: ConfigEntryStore,
): LiveDescriptorRegistry => {
  let uploaded = new Map<string, { version: number; descriptor: Descriptor }>();
  let started = 0;
  let applied = 0;
  return {
    bundled,
    get: (id) => bundled.get(id) ?? uploaded.get(id)?.descriptor,
    list: () =>
      [...bundled.list(), ...[...uploaded.values()].map((u) => u.descriptor)].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    refresh: async () => {
      const mine = ++started;
      const next = new Map<string, { version: number; descriptor: Descriptor }>();
      for (const entry of await uploadedDescriptors(store)) {
        if (bundled.get(entry.id)) continue;
        const known = uploaded.get(entry.id);
        if (known?.version === entry.version) {
          next.set(entry.id, known);
          continue;
        }
        const descriptor = loads(entry.spec);
        if (!(descriptor instanceof Error))
          next.set(entry.id, { version: entry.version, descriptor });
      }
      if (mine < applied) return;
      applied = mine;
      uploaded = next;
    },
  };
};
