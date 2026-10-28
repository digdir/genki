// A pg-boss worker that pushes each job to the fake Marker service and logs every attempt.
// client "patient" turns off undici's 300 s header and body timeouts; "default" is Node's fetch as is.
import process from 'node:process';
import { PgBoss } from 'pg-boss';
import { Agent, fetch as undiciFetch } from 'undici';
import { appendFileSync } from 'node:fs';

const [queue, delaySeconds, mode, label, events, client = 'patient'] = process.argv.slice(2);
const log = (kind, extra = {}) =>
  appendFileSync(
    events,
    JSON.stringify({ t: Date.now(), kind, queue, label, pid: process.pid, ...extra }) + '\n',
  );
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const call = (url, init) =>
  client === 'default'
    ? globalThis.fetch(url, init)
    : undiciFetch(url, { ...init, dispatcher: patient });

const boss = new PgBoss({ connectionString: process.env.BOSS_URL, max: 4 });
boss.on('error', (e) => log('boss-error', { error: String(e) }));
await boss.start();
await boss.work(queue, { localConcurrency: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
  log('start', { job: job.id, retryCount: job.retryCount });
  if (mode === 'fail') throw new Error('Marker could not read this PDF');
  try {
    const res = await call(`http://127.0.0.1:18099/convert?seconds=${delaySeconds}`, {
      method: 'POST',
      signal: job.signal,
    });
    const body = await res.json();
    log('done', { job: job.id, retryCount: job.retryCount, pages: body.pages.length });
    return { pages: body.pages.length };
  } catch (error) {
    log('error', {
      job: job.id,
      retryCount: job.retryCount,
      error: String(error.cause?.code ?? error.message),
    });
    throw error;
  }
});
log('ready');
process.on('SIGTERM', async () => {
  await boss.stop({ graceful: false });
  process.exit(0);
});
