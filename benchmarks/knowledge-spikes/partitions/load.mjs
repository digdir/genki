// Spike 1 load: 8 clients running hybrid searches (HNSW + full text) on the live generation,
// logging one line per search: epoch ms, latency ms, ok.
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createWriteStream } from 'node:fs';
const [url, out, clients = '8'] = process.argv.slice(2);
const log = createWriteStream(out);
let running = true;
process.on('SIGTERM', () => {
  running = false;
});
const client = async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('set hnsw.ef_search = 100');
  while (running) {
    const n = 1 + Math.floor(Math.random() * 2000),
      w = 1 + Math.floor(Math.random() * 50000);
    const t = Date.now(),
      s = performance.now();
    let ok = 1;
    try {
      await c.query(
        "select id from kn where generation = 'g1' order by vec <=> (select vec from qv where n = $1) limit 10",
        [n],
      );
      await c.query(
        "select id from kn where generation = 'g1' and tsv @@ to_tsquery('simple', $1) limit 50",
        ['w' + w],
      );
    } catch (e) {
      ok = 0;
      log.write(`# error ${String(e.message)}\n`);
    }
    log.write(`${t} ${(performance.now() - s).toFixed(2)} ${ok}\n`);
  }
  await c.end();
};
await Promise.all(Array.from({ length: Number(clients) }, client));
log.end(() => process.exit(0));
