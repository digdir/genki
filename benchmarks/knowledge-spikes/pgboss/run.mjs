// Spike 3: pg-boss as genki's durable queue, pushing conversions to an HTTP service.
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const url = process.env.BOSS_URL;
const events = new URL('./events.jsonl', import.meta.url).pathname;
writeFileSync(events, '');
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
};
const read = () =>
  readFileSync(events, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, timeoutMs) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = pred(read());
    if (hit) return hit;
    await sleep(500);
  }
  return undefined;
};
const workers = [];
const startWorker = (queue, delay, mode, label, client = 'patient') => {
  const p = spawn(
    process.execPath,
    ['worker.mjs', queue, String(delay), mode, label, events, client],
    { cwd: new URL('.', import.meta.url).pathname, env: process.env, stdio: 'inherit' },
  );
  workers.push(p);
  return p;
};

const marker = spawn(process.execPath, ['fake-marker.mjs', '18099'], {
  cwd: new URL('.', import.meta.url).pathname,
  stdio: 'inherit',
});
await sleep(500);
const boss = new PgBoss({ connectionString: url, max: 10 });
boss.on('error', (e) => console.error('boss error', e));
const t0 = Date.now();
await boss.start();
const db = new pg.Client({ connectionString: url });
await db.connect();
const version = (await db.query('select version from pgboss.version')).rows[0]?.version;
record('install as a role with only CREATE on the database', true, {
  schemaVersion: version,
  startMs: Date.now() - t0,
});

// T1: a job sent inside a transaction that rolls back never exists
await boss.createQueue('tx');
const adapter = (client) => ({ executeSql: (text, values) => client.query(text, values) });
await db.query('begin');
const rolledBack = await boss.send('tx', { file: 'a' }, { db: adapter(db) });
await db.query('rollback');
await db.query('begin');
const committed = await boss.send('tx', { file: 'b' }, { db: adapter(db) });
await db.query('commit');
const rb = await boss.getJobById('tx', rolledBack);
const cm = await boss.getJobById('tx', committed);
record('send inside a rolled-back transaction leaves no job', rb === null && cm !== null, {
  rolledBackFound: rb !== null,
  committedFound: cm !== null,
});

// T2: one queued job per singletonKey (the file's sha256)
await boss.createQueue('convert-short', { policy: 'short' });
const s1 = await boss.send('convert-short', { sha: 'abc' }, { singletonKey: 'sha256:abc' });
const s2 = await boss.send('convert-short', { sha: 'abc' }, { singletonKey: 'sha256:abc' });
const s3 = await boss.send('convert-short', { sha: 'def' }, { singletonKey: 'sha256:def' });
const perKey = (
  await db.query(
    "select singleton_key, count(*)::int as n from pgboss.job where name = 'convert-short' and state = 'created' group by 1 order by 1",
  )
).rows;
record(
  'one queued job per singletonKey',
  s1 !== null &&
    s2 === null &&
    s3 !== null &&
    perKey.length === 2 &&
    perKey.every((r) => r.n === 1),
  { first: !!s1, duplicate: s2, other: !!s3, queuedPerKey: perKey },
);

// T3: priority order
await boss.createQueue('prio');
for (const p of [1, 10, 5]) await boss.send('prio', { p }, { priority: p });
const order = [];
for (let i = 0; i < 3; i++) {
  const [job] = await boss.fetch('prio', { batchSize: 1 });
  order.push(job.data.p);
  await boss.complete('prio', job.id);
}
record('jobs are taken in priority order', JSON.stringify(order) === '[10,5,1]', { order });

// T4, T5, T6 run in parallel
await boss.createQueue('long', { expireInSeconds: 1200, heartbeatSeconds: 30, retryLimit: 2 });
await boss.createQueue('kill', { expireInSeconds: 1200, heartbeatSeconds: 30, retryLimit: 2 });
await boss.createQueue('dlq');
await boss.createQueue('fails', { retryLimit: 2, retryDelay: 1, deadLetter: 'dlq' });

startWorker('long', 600, 'ok', 'W-long');
await boss.createQueue('default-fetch', {
  expireInSeconds: 1200,
  heartbeatSeconds: 30,
  retryLimit: 0,
});
startWorker('default-fetch', 360, 'ok', 'W-default', 'default');
startWorker('fails', 1, 'fail', 'W-fails');
const killed = startWorker('kill', 300, 'ok', 'W-kill-1');
await sleep(3000);
const longId = await boss.send('long', { sha: 'long' });
const killId = await boss.send('kill', { sha: 'kill' });
const failId = await boss.send('fails', { sha: 'broken' });
const defaultId = await boss.send('default-fetch', { sha: 'six-minutes' });

// T6: always-failing job lands in the dead-letter queue after retryLimit + 1 attempts
const dlqT = Date.now();
let dlq;
while (Date.now() - dlqT < 180000) {
  dlq = await boss.getQueue('dlq');
  if (dlq.totalCount >= 1 || dlq.queuedCount >= 1) break;
  await sleep(1000);
}
const failAttempts = read().filter((e) => e.kind === 'start' && e.job === failId).length;
const failed = await boss.getJobById('fails', failId);
record(
  'a job that always fails lands in the dead-letter queue',
  (dlq?.queuedCount ?? 0) + (dlq?.totalCount ?? 0) >= 1 && failAttempts === 3,
  {
    attempts: failAttempts,
    state: failed?.state,
    dlqQueued: dlq?.queuedCount,
    dlqTotal: dlq?.totalCount,
    secondsToDlq: Math.round((Date.now() - dlqT) / 1000),
  },
);

// T5: kill the worker mid-job; another worker gets it after heartbeat + monitor interval
const firstStart = await waitFor(
  (ev) => ev.find((e) => e.kind === 'start' && e.job === killId),
  60000,
);
await sleep(30000);
const conns = (
  await db.query("select count(*)::int as n from pg_stat_activity where usename = 'boss_app'")
).rows[0].n;
const tKill = Date.now();
killed.kill('SIGKILL');
startWorker('kill', 5, 'ok', 'W-kill-2');
const second = await waitFor(
  (ev) => ev.find((e) => e.kind === 'start' && e.job === killId && e.label === 'W-kill-2'),
  300000,
);
const takeover = second ? Math.round((second.t - tKill) / 1000) : null;
record(
  "a killed worker's job is retried within heartbeat + 60 s",
  second !== undefined && takeover <= 95,
  {
    secondsFromKillToRetry: takeover,
    retryCount: second?.retryCount,
    firstStartedBy: firstStart?.label,
  },
);
const killDone = await waitFor(
  (ev) => ev.find((e) => e.kind === 'done' && e.job === killId),
  120000,
);
record('the retried job completes', killDone !== undefined, { by: killDone?.label });
record('connections held by boss_app (4 processes)', true, { connections: conns });

// T7: Node's default fetch gives up on a 6-minute response after 300 s without headers
const defaultErr = await waitFor(
  (ev) => ev.find((e) => (e.kind === 'error' || e.kind === 'done') && e.job === defaultId),
  600000,
);
const defaultStart = read().find((e) => e.kind === 'start' && e.job === defaultId);
record(
  "Node's default fetch fails a 6-minute call after about 300 s (genki's Marker client uses it)",
  defaultErr?.kind === 'error',
  {
    outcome: defaultErr?.kind,
    error: defaultErr?.error,
    secondsUntil:
      defaultErr && defaultStart ? Math.round((defaultErr.t - defaultStart.t) / 1000) : null,
  },
);

// T4: the 10-minute job with a 30 s heartbeat is never handed out twice
const longDone = await waitFor(
  (ev) => ev.find((e) => e.kind === 'done' && e.job === longId),
  900000,
);
const longStarts = read().filter((e) => e.kind === 'start' && e.job === longId).length;
const longJob = await boss.getJobById('long', longId);
record(
  'a 10-minute job with heartbeats is handed out once',
  longDone !== undefined && longStarts === 1 && longJob?.state === 'completed',
  {
    starts: longStarts,
    state: longJob?.state,
    minutes: longDone
      ? Math.round(
          ((longDone.t - read().find((e) => e.kind === 'start' && e.job === longId).t) / 60000) *
            10,
        ) / 10
      : null,
  },
);

for (const w of workers) {
  try {
    w.kill('SIGTERM');
  } catch {
    // already stopped
  }
}
marker.kill();
await db.end();
await boss.stop({ graceful: false });
writeFileSync(
  new URL('./results.json', import.meta.url).pathname,
  JSON.stringify(results, null, 2),
);
console.log(`SUMMARY ${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(0);
