import type { TestSetStore } from '@genai/eval';
import { appendVersion, type ConfigEntryStore } from './config-store.js';
import type { ApiLog } from './failure-log.js';

/** What a dataset needs of a trace connection; trace-connections.ts owns the full shape. */
interface Connection {
  id: string;
  host: string;
  publicKey: string;
  services: string[];
  removing?: true;
}

interface DatasetSink {
  dataset?(
    tenant: string,
    connection: Connection,
    service: string,
    testSet: string,
  ): Promise<{ id: string; name: string }>;
}

const connectionsOf = async (configEntries: ConfigEntryStore, tenant: string) =>
  (await configEntries.latest({ kind: 'trace-connection', scope: tenant }))
    .filter((e) => !e.deleted)
    .map((e) => e.spec as Connection);

export const traceDatasetKind = 'trace-dataset';

/** The environment every agency's test runs land in, apart from its live traffic (ADR 0040). */
export const testRunEnvironment = 'genki-test-runs';

/**
 * The Langfuse dataset of a test set in a connection's project (ADR 0040). It holds no items: a
 * run is linked to it by its id, so the agency can point a judge at one test set.
 */
export interface TraceDataset {
  connection: string;
  service: string;
  testSet: string;
  name: string;
  /** Langfuse's id for the dataset, which every span of a sent run carries. */
  id: string;
  /** The project it is in: a connection moved to another one needs its datasets made there. */
  host: string;
  publicKey: string;
}

const keyOf = (connection: string, service: string, testSet: string) =>
  `${connection}/${service}/${testSet}`;

const inProject = (d: TraceDataset, connection: Pick<Connection, 'host' | 'publicKey'>) =>
  d.host === connection.host && d.publicKey === connection.publicKey;

/**
 * The datasets genki has made that a connection uses now: in the project it points to, for a
 * service it covers and a test set that is still in that service.
 */
export const datasetsOf = async (
  configEntries: ConfigEntryStore,
  testSets: Pick<TestSetStore, 'list'>,
  tenant: string,
) => {
  const connections = new Map((await connectionsOf(configEntries, tenant)).map((c) => [c.id, c]));
  const inService = new Set(
    (await testSets.list(tenant)).map((s) => `${s.spec.service ?? ''}/${s.metadata.id}`),
  );
  return (await configEntries.latest({ kind: traceDatasetKind, scope: tenant }))
    .filter((e) => !e.deleted)
    .map((e) => e.spec as TraceDataset)
    .filter((d) => {
      const connection = connections.get(d.connection);
      return (
        connection !== undefined &&
        inProject(d, connection) &&
        connection.services.includes(d.service) &&
        inService.has(`${d.service}/${d.testSet}`)
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const traceDatasets = (deps: {
  configEntries: ConfigEntryStore;
  traceSinks?: DatasetSink;
  testSets: Pick<TestSetStore, 'list'>;
  log?: ApiLog;
}) => {
  /** Langfuse not answering never stops a save, so what it could not make is logged instead. */
  const logged =
    (tenant: string, connection: string, testSet: string) =>
    (error: unknown): undefined => {
      deps.log?.('langfuse dataset not made', {
        tenant,
        connection,
        testSet,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    };
  const recorded = async (
    tenant: string,
    connection: Connection,
    service: string,
    testSet: string,
  ) => {
    const latest = (
      await deps.configEntries.history(
        traceDatasetKind,
        tenant,
        keyOf(connection.id, service, testSet),
      )
    ).at(-1);
    const spec = latest && !latest.deleted ? (latest.spec as TraceDataset) : undefined;
    return spec && inProject(spec, connection) ? spec : undefined;
  };

  /**
   * The test set's dataset as Langfuse has it now: reused by its name, or made again when it was
   * deleted there. Its id is kept with the test set and the connection.
   */
  const ensure = async (
    tenant: string,
    connection: Connection,
    service: string,
    testSet: string,
  ): Promise<TraceDataset | undefined> => {
    if (!deps.traceSinks?.dataset) return undefined;
    const found = await deps.traceSinks.dataset(tenant, connection, service, testSet);
    const spec: TraceDataset = {
      connection: connection.id,
      service,
      testSet,
      name: found.name,
      id: found.id,
      host: connection.host,
      publicKey: connection.publicKey,
    };
    const before = await recorded(tenant, connection, service, testSet);
    if (!before || before.id !== spec.id || before.name !== spec.name)
      await appendVersion<TraceDataset>(deps.configEntries, {
        kind: traceDatasetKind,
        scope: tenant,
        id: keyOf(connection.id, service, testSet),
        spec,
        deleted: false,
        by: 'platform:trace-datasets',
        reason: `The dataset ${spec.name} is in the project of the connection ${connection.id}`,
      });
    return spec;
  };

  /** Made only where genki has none recorded in the connection's project. */
  const ensureMissing = async (
    tenant: string,
    connection: Connection,
    service: string,
    testSet: string,
  ) =>
    (await recorded(tenant, connection, service, testSet)) ??
    ensure(tenant, connection, service, testSet);

  return {
    ensure,
    /** The dataset genki recorded for the test set in the connection's project, without asking it. */
    recorded,
    /** Each test set of the services the connection covers, when the connection is saved. */
    forConnection: async (tenant: string, connection: Connection) => {
      const sets = (
        await Promise.all(
          connection.services.map(async (service) =>
            (await deps.testSets.list(tenant, service)).map((set) => ({
              service,
              id: set.metadata.id,
            })),
          ),
        )
      ).flat();
      return Promise.all(
        sets.map((set) =>
          ensureMissing(tenant, connection, set.service, set.id).catch(
            logged(tenant, connection.id, set.id),
          ),
        ),
      );
    },
    /** A test set saved for a service a connection covers, such as one just added to it. */
    forTestSet: async (tenant: string, service: string, testSet: string) => {
      const covering = (await connectionsOf(deps.configEntries, tenant)).filter(
        (c) => !c.removing && c.services.includes(service),
      );
      // A service covered twice is sent nowhere, so neither connection gets its datasets.
      const connection = covering.length === 1 ? covering[0] : undefined;
      return connection
        ? ensureMissing(tenant, connection, service, testSet).catch(
            logged(tenant, connection.id, testSet),
          )
        : undefined;
    },
  };
};

export type TraceDatasets = ReturnType<typeof traceDatasets>;

/**
 * A test set saved for a service a connection covers gets its dataset, whichever way it was
 * added. Langfuse not answering never fails the save: the next run makes the dataset.
 */
export const withTraceDatasets = (store: TestSetStore, datasets: TraceDatasets): TestSetStore => ({
  put: async (set) => {
    await store.put(set);
    if (set.spec.service)
      await datasets
        .forTestSet(set.metadata.tenant, set.spec.service, set.metadata.id)
        // Logged by forTestSet; the save stands.
        .catch(() => undefined);
  },
  get: (tenant, id, version) => store.get(tenant, id, version),
  list: (tenant, service) => store.list(tenant, service),
});
