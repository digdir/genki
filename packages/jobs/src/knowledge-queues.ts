import { z } from 'zod';
import {
  defineQueue,
  maximumExpireInSeconds,
  type JobQueue,
  type QueueDefinition,
} from './job-queue.js';

/** Ids only: a run, a record, a generation or a file hash, never a title, path or text (ADR 0041). */
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/, 'an id');

/** The organisation a job serves, only for filtering dead letters: a handler takes it from its record. */
const tenant = z.string().regex(/^(\d{9}|platform)$/, 'an organisation number or platform');

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256');

const minute = 60;
const hour = 60 * minute;

const runPayload = z.strictObject({ run: id, tenant });
const pushPayload = z.strictObject({ run: id, tenant, dataset: id, record: id });
const datasetPayload = z.strictObject({ tenant, dataset: id });
/** A deleted dataset, or one generation of it past its retention. */
const dropPayload = z.union([
  z.strictObject({ tenant, dataset: id }),
  z.strictObject({ tenant, dataset: id, generation: id }),
]);
/**
 * A file to convert, the record whose source fetches it, and every other organisation with a record
 * waiting on it, comma-separated and starting with its own, so the job's dead letter is shown to
 * each (ADR 0042, "Jobs"). Job data keeps 128 characters a value, so the list holds 12.
 */
const convertPayload = z.strictObject({
  run: id,
  tenant,
  file: sha256,
  dataset: id,
  record: id,
  tenants: z.string().regex(/^(\d{9}|platform)(,(\d{9}|platform))*$/, 'organisation numbers'),
});
const documentPayload = z.strictObject({ run: id, tenant, generation: id, record: id });
/**
 * A `vacuum` or `index` build that ends an ingestion run names the run, which stays open until the
 * job ends: `index` builds and attaches the run's standalone generation (ADR 0025, ADR 0042).
 */
const buildKind = z.enum(['index', 'catch-up', 'vacuum', 'freeze', 'reindex']);
const buildPayload = z.union([
  z.strictObject({ tenant, generation: id, kind: buildKind }),
  z.strictObject({ tenant, generation: id, kind: z.enum(['vacuum', 'index']), run: id }),
]);
const nightlyPayload = z.strictObject({});
/**
 * A batch of a seed: the native outputs in Blob of one converter, version and settings hash whose
 * file sha256 starts with `prefix`, stored as conversions (ADR 0042, issue 474).
 */
const seedPayload = z.strictObject({
  tenant,
  prefix: z.string().regex(/^[0-9a-f]{2}$/, 'two hex characters'),
  converter: id,
  version: id,
  settings: sha256,
});

const retried = { retryLimit: 2, retryDelaySeconds: 30, retryBackoff: true } as const;

export const knowledgeIngestQueue = defineQueue({
  name: 'knowledge.ingest',
  policy: 'exclusive',
  payload: runPayload,
  expireInSeconds: 2 * hour,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

export const knowledgePushQueue = defineQueue({
  name: 'knowledge.push',
  policy: 'exclusive',
  payload: pushPayload,
  expireInSeconds: 15 * minute,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

export const knowledgeActivateQueue = defineQueue({
  name: 'knowledge.activate',
  policy: 'singleton',
  payload: datasetPayload,
  expireInSeconds: 15 * minute,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

export const knowledgeDropQueue = defineQueue({
  name: 'knowledge.drop',
  policy: 'singleton',
  payload: dropPayload,
  expireInSeconds: hour,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

/** The Marker client's own default, `markerTimeoutMs` in packages/ingest/src/converter.ts. */
export const defaultMarkerTimeoutMs = 6 * hour * 1000;

/** Conversions wait up to the Marker client's own timeout, plus an hour, within pg-boss's 24 hours. */
export const conversionExpireInSeconds = (markerTimeoutMs: number) =>
  Math.min(maximumExpireInSeconds, Math.ceil(markerTimeoutMs / 1000) + hour);

export const knowledgeConvertQueue = (markerTimeoutMs: number) =>
  defineQueue({
    name: 'knowledge.convert',
    policy: 'exclusive',
    payload: convertPayload,
    expireInSeconds: conversionExpireInSeconds(markerTimeoutMs),
    heartbeatSeconds: minute,
    ...retried,
    deadLetter: true,
  });

export const knowledgeIndexQueue = defineQueue({
  name: 'knowledge.index',
  policy: 'exclusive',
  payload: documentPayload,
  expireInSeconds: 30 * minute,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

export const knowledgeFillQueue = defineQueue({
  name: 'knowledge.fill',
  policy: 'exclusive',
  payload: documentPayload,
  expireInSeconds: 30 * minute,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

export const knowledgeBuildQueue = defineQueue({
  name: 'knowledge.build',
  policy: 'singleton',
  payload: buildPayload,
  expireInSeconds: 24 * hour,
  heartbeatSeconds: minute,
  retryLimit: 1,
  deadLetter: false,
});

/** Nightly at the window's start: the freeze check and the recall check (ADR 0042, "Heavy work"). */
export const knowledgeCheckQueue = defineQueue({
  name: 'knowledge.check',
  policy: 'singleton',
  payload: nightlyPayload,
  expireInSeconds: 2 * hour,
  heartbeatSeconds: minute,
  retryLimit: 2,
  deadLetter: false,
});

export const knowledgeCleanupQueue = defineQueue({
  name: 'knowledge.cleanup',
  policy: 'singleton',
  payload: nightlyPayload,
  expireInSeconds: 2 * hour,
  heartbeatSeconds: minute,
  retryLimit: 2,
  deadLetter: false,
});

export const knowledgeExportQueue = defineQueue({
  name: 'knowledge.export',
  policy: 'singleton',
  payload: nightlyPayload,
  expireInSeconds: 2 * hour,
  heartbeatSeconds: minute,
  retryLimit: 2,
  deadLetter: false,
});

export const knowledgeSeedQueue = defineQueue({
  name: 'knowledge.seed',
  policy: 'exclusive',
  payload: seedPayload,
  expireInSeconds: hour,
  heartbeatSeconds: minute,
  ...retried,
  deadLetter: true,
});

/** Jobs that follow a platform record: on the platform server, sent by the API as genai_runtime. */
export const knowledgePlatformQueues: QueueDefinition[] = [
  knowledgeIngestQueue,
  knowledgePushQueue,
  knowledgeActivateQueue,
  knowledgeDropQueue,
];

/** Jobs that follow a document record: on the knowledge server, sent and worked by the writer. */
export const knowledgeServerQueues = (markerTimeoutMs: number): QueueDefinition[] => [
  knowledgeConvertQueue(markerTimeoutMs),
  knowledgeIndexQueue,
  knowledgeFillQueue,
  knowledgeBuildQueue,
  knowledgeCheckQueue,
  knowledgeCleanupQueue,
  knowledgeExportQueue,
  knowledgeSeedQueue,
];

/** Heavy queues: sent to start at the window and worked only inside it (ADR 0042, "Jobs"). */
export const heavyQueueNames = ['knowledge.build', 'knowledge.fill'] as const;

/** The queues whose jobs belong to an ingestion run and name it under `run`. */
export const runQueueNames = [
  'knowledge.ingest',
  'knowledge.push',
  'knowledge.convert',
  'knowledge.index',
  'knowledge.fill',
  'knowledge.build',
] as const;

/** Each queue's key, given with every send (ADR 0042, "Jobs"). */
export const knowledgeKeys = {
  ingest: (pipeline: { dataset: string; id: string }) => `${pipeline.dataset}#${pipeline.id}`,
  push: (dataset: string, record: string) => `${dataset}#${record}`,
  activate: (dataset: string) => dataset,
  drop: (dataset: string) => dataset,
  convert: (file: { sha256: string; converter: string; version: string; settings: string }) =>
    `${file.sha256}:${file.converter}:${file.version}:${file.settings}`,
  index: (generation: string, record: string) => `${generation}#${record}`,
  fill: (generation: string, record: string) => `${generation}#${record}`,
  build: () => 'knowledge-server',
  check: () => 'knowledge-server',
  seed: (batch: { prefix: string; converter: string; version: string; settings: string }) =>
    `${batch.converter}:${batch.version}:${batch.settings}:${batch.prefix}`,
} as const;

/** The two-character sha256 prefixes a seed is split by: 256 batches. */
export const seedPrefixes = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Uploads before ingestion runs before candidates; pg-boss takes the highest first. */
export const convertPriority = { upload: 3, run: 2, candidate: 1 } as const;

/** Sends a seed's batches, one job per prefix; a batch whose job still waits or runs is not sent again. */
export const sendSeed = async (
  queue: Pick<JobQueue, 'send'>,
  target: { converter: string; version: string; settings: string },
) => {
  let sent = 0;
  for (const prefix of seedPrefixes) {
    const batch = { prefix, ...target };
    if (
      await queue.send(
        knowledgeSeedQueue,
        { tenant: 'platform', ...batch },
        { key: knowledgeKeys.seed(batch) },
      )
    )
      sent += 1;
  }
  return sent;
};
