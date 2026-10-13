import pg from 'pg';

export interface StoppablePostgres {
  getConnectionUri(): string;
  stop(): Promise<unknown>;
}

interface EndablePool {
  ended?: boolean;
  end(): Promise<void>;
}

const otherClients = `select count(*)::int as n from pg_stat_activity
  where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`;

export const waitForNoClients = async (connectionUri: string, timeoutMs = 5_000) => {
  const client = new pg.Client({ connectionString: connectionUri });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await client.query<{ n: number }>(otherClients);
      if ((rows[0]?.n ?? 0) === 0) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await client.end().catch(() => undefined);
  }
};

export const stopPostgres = async (
  container: StoppablePostgres | undefined,
  pools: Iterable<EndablePool> = [],
) => {
  await Promise.allSettled([...pools].filter((p) => !p.ended).map((p) => p.end()));
  if (!container) return;
  await waitForNoClients(container.getConnectionUri()).catch(() => false);
  await container.stop();
};
