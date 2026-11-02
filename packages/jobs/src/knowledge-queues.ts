import { z } from 'zod';
import { defineQueue, maximumExpireInSeconds, type QueueDefinition } from './job-queue.js';

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
const convertPayload = z.strictObject({ run: id, tenant, file: sha256 });
const documentPayload = z.strictObject({ run: id, tenant, generation: id, record: id });
const buildPayload = z.strictObject({
  tenant,
  generation: id,
  kind: z.enum(['index', 'catch-up', 'vacuum', 'reindex']),
});
const nightlyPayload = z.strictObject({});

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
  knowledgeCleanupQueue,
  knowledgeExportQueue,
];

/** The queues whose jobs belong to an ingestion run and name it under `run`. */
export const runQueueNames = [
  'knowledge.ingest',
  'knowledge.push',
  'knowledge.convert',
  'knowledge.index',
  'knowledge.fill',
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
} as const;

/** Uploads before ingestion runs before candidates; pg-boss takes the highest first. */
export const convertPriority = { upload: 3, run: 2, candidate: 1 } as const;
