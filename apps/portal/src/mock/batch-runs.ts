import type {
  BatchEstimate,
  BatchItem,
  BatchRunDetail,
  BatchSourceDataset,
} from '../api/batch-runs';
import type { MockHandler } from '../mock';

interface MockDocument {
  id: string;
  title: string;
  type: string;
  year: string;
  org: string;
}

export interface BatchRunsMockOptions {
  documents?: MockDocument[];
  runs?: (BatchRunDetail & { service: string })[];
  priced?: boolean;
  stayRunning?: boolean;
  failing?: string[];
  truncating?: string[];
  approvalLimitNok?: number;
  stopAfter?: number;
  perItemMicro?: { low: number; high: number };
}

const orgs = ['Digdir', 'Brreg', 'Skatteetaten', 'NAV', 'Statsbygg', 'Lånekassen'];

export const exampleBatchDocuments = (): MockDocument[] => [
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `ar-2024-${i + 1}`,
    title: `Årsrapport 2024 ${orgs[i % orgs.length] ?? ''} ${i + 1}`,
    type: 'Årsrapport',
    year: '2024',
    org: orgs[i % orgs.length] ?? 'Digdir',
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `ev-2023-${i + 1}`,
    title: `Evaluering 2023 nr. ${i + 1}`,
    type: 'Evaluering',
    year: '2023',
    org: 'Digdir',
  })),
];

const fields = { type: 'type', concerned_years: 'year', orgs_short: 'org' } as const;

const facet = (docs: MockDocument[], key: keyof MockDocument) => {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d[key], (counts.get(d[key]) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }));
};

export const batchRunsMock = (options: BatchRunsMockOptions = {}): MockHandler => {
  const documents = options.documents ?? exampleBatchDocuments();
  const priced = options.priced ?? true;
  const failing = new Set(options.failing ?? ['ar-2024-3']);
  const truncating = new Set(options.truncating ?? []);
  const perItemMicro = options.perItemMicro ?? { low: 1500, high: 9000 };
  const limitNok = options.approvalLimitNok ?? 150;
  const overLimit = (high: number | undefined) =>
    limitNok > 0 && (high ?? 0) > limitNok * 1_000_000;
  const runs = structuredClone(options.runs ?? []);
  const estimates = new Map<string, BatchEstimate & { docs: MockDocument[] }>();
  let counter = 0;

  const summary = (run: BatchRunDetail & { service: string }) => {
    const counts = { queued: 0, running: 0, succeeded: 0, notFound: 0, failed: 0, skipped: 0 };
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const item of run.items) {
      counts[item.status] += 1;
      input += item.tokens?.input ?? 0;
      output += item.tokens?.output ?? 0;
      cost += item.costMicroNok ?? 0;
    }
    return { ...run, counts, tokens: { input, output }, costMicroNok: priced ? cost : null };
  };

  const finish = (item: BatchItem, at: string): BatchItem =>
    failing.has(item.document.id)
      ? { ...item, status: 'failed', attempts: item.attempts + 1, error: 'Modellen svarte ikke' }
      : {
          ...item,
          status: 'succeeded',
          attempts: item.attempts + 1,
          task: `task-batch-${item.document.id}`,
          output: `Sammendrag av ${item.document.title}`,
          ...(truncating.has(item.document.id) ? { truncated: true } : {}),
          tokens: { input: 2400, output: 300 },
          costMicroNok: priced ? 4200 : 0,
          startedAt: at,
          endedAt: at,
        };

  return ({ path, method, body, json, notFound, reason, reasonMissing }) => {
    const m = /^\/tenants\/([^/]+)\/services\/([^/]+)\/batch-runs(?:\/(.*))?$/.exec(path);
    if (!m) return undefined;
    const service = decodeURIComponent(m[2] ?? '');
    const rest = m[3] ?? '';
    const needsReason = method !== 'GET' && !reason;

    if (rest === 'sources' && method === 'GET') {
      const data: BatchSourceDataset[] = [
        {
          id: 'digdir/kudos',
          name: 'Kudos',
          usedByService: true,
          filters: Object.entries(fields).map(([field, key]) => ({
            field,
            values: facet(documents, key),
          })),
        },
      ];
      return json({ data });
    }

    if (rest === 'estimate' && method === 'POST') {
      if (needsReason) return reasonMissing();
      const req = body<{
        dataset: string;
        filters?: Record<string, string[]>;
        documents?: string[];
        prompt?: string;
        input?: Record<string, string | number | string[]>;
        sample?: boolean;
      }>();
      const docs = documents.filter(
        (d) =>
          (!req.documents || req.documents.includes(d.id)) &&
          Object.entries(req.filters ?? {}).every(([field, values]) => {
            const key = fields[field as keyof typeof fields];
            return !key || values.includes(d[key]);
          }),
      );
      if (docs.length === 0)
        return json({ title: 'Utvalget har ingen dokumenter', status: 422, errors: [] }, 422);
      const id = `est-${++counter}`;
      const measured = req.sample !== false;
      const estimate: BatchEstimate & { docs: MockDocument[] } = {
        id,
        service,
        version: 3,
        model: 'gpt-4o-2m-tps',
        priced,
        dataset: req.dataset,
        filters: req.filters ?? {},
        ...(req.prompt ? { prompt: req.prompt } : {}),
        ...(req.input ? { input: req.input } : {}),
        items: docs.length,
        preview: docs.slice(0, 20).map((d) => ({ id: d.id, title: d.title })),
        perItem: {
          inputTokens: { low: 1200, high: 6000 },
          outputTokens: { low: 150, high: measured ? 1200 : 4000 },
          costMicroNok: priced ? perItemMicro : null,
        },
        maxOutputTokens: measured ? 1800 : 4000,
        tokens: { low: docs.length * 1350, high: docs.length * 7200 },
        costMicroNok: priced
          ? { low: docs.length * perItemMicro.low, high: docs.length * perItemMicro.high }
          : null,
        basis: measured ? 'measured' : 'assumed',
        samples: measured
          ? docs.slice(0, 3).map((d) => ({
              document: d.id,
              inputTokens: 4200,
              outputTokens: 800,
              costMicroNok: priced ? 9000 : null,
              output: `Sammendrag av ${d.title}`,
            }))
          : [],
        expiresAt: '2026-10-09T12:00:00Z',
        approval: {
          limitNok,
          required: priced && overLimit(docs.length * perItemMicro.high),
        },
        docs,
      };
      estimates.set(id, estimate);
      const shown: Partial<typeof estimate> = { ...estimate };
      delete shown.docs;
      return json(shown, 201);
    }

    if (rest === '' && method === 'POST') {
      if (needsReason) return reasonMissing();
      const req = body<{
        estimate?: string;
        maxCostNok?: number;
        maxTokens?: number;
        approval?: string;
      }>();
      const estimate = req.estimate ? estimates.get(req.estimate) : undefined;
      if (!estimate)
        return json({ title: 'Beregn kostnaden før du starter', status: 400, errors: [] }, 400);
      const approve = estimate.approval?.required;
      if (approve && (req.approval?.trim().length ?? 0) < 10) {
        const title = `Anslaget er over grensen på ${limitNok} kr per jobb. Jobben må godkjennes med en begrunnelse på minst 10 tegn.`;
        return json({ title, status: 409, errors: [{ path: 'approval', message: title }] }, 409);
      }
      const at = new Date().toISOString();
      const items: BatchItem[] = estimate.docs.map((d, index) => ({
        index,
        document: { id: d.id, title: d.title },
        status: 'queued',
        attempts: 0,
        sources: [],
        tokens: { input: 0, output: 0 },
        costMicroNok: 0,
      }));
      const run = {
        id: `run-${++counter}`,
        service,
        version: estimate.version,
        model: estimate.model,
        priced,
        dataset: estimate.dataset,
        filters: estimate.filters,
        ...(estimate.input ? { input: estimate.input } : {}),
        startedBy: 'Kari Nordmann',
        ...(approve
          ? {
              costApproval: {
                by: 'Kari Nordmann',
                at,
                reason: req.approval?.trim() ?? '',
                limitNok,
              },
            }
          : {}),
        status: options.stayRunning
          ? 'running'
          : options.stopAfter !== undefined
            ? 'stopped'
            : 'succeeded',
        total: items.length,
        concurrency: 4,
        pass: 1,
        cap: req.maxCostNok
          ? { costMicroNok: req.maxCostNok * 1_000_000 }
          : { tokens: req.maxTokens ?? 0 },
        perItem: estimate.perItem,
        startedAt: at,
        endedAt: options.stayRunning ? null : at,
        items: options.stayRunning
          ? items
          : items.map((i) =>
              options.stopAfter !== undefined && i.index >= options.stopAfter
                ? { ...i, status: 'skipped' as const }
                : finish(i, at),
            ),
        counts: { queued: 0, running: 0, succeeded: 0, notFound: 0, failed: 0, skipped: 0 },
        tokens: { input: 0, output: 0 },
        costMicroNok: 0,
      } as BatchRunDetail & { service: string };
      runs.unshift(run);
      return json(summary(run), 202);
    }

    if (rest === '' && method === 'GET')
      return json({
        data: runs
          .filter((r) => r.service === service)
          .map((r) => {
            const shown: Partial<BatchRunDetail> = summary(r);
            delete shown.items;
            return shown;
          }),
      });

    const action = /^([^/]+)(?:\/(cancel|retry|export))?$/.exec(rest);
    const run = runs.find((r) => r.id === decodeURIComponent(action?.[1] ?? ''));
    if (!action || !run || run.service !== service) return notFound();
    if (!action[2] && method === 'GET') return json(summary(run));
    if (action[2] === 'cancel' && method === 'POST') {
      if (needsReason) return reasonMissing();
      run.status = 'cancelled';
      run.endedAt = new Date().toISOString();
      run.items = run.items.map((i) =>
        i.status === 'queued' || i.status === 'running' ? { ...i, status: 'skipped' } : i,
      );
      return json({ id: run.id, cancelling: true }, 202);
    }
    if (action[2] === 'retry' && method === 'POST') {
      if (needsReason) return reasonMissing();
      const wanted = body<{ items?: number[] }>().items;
      const retryable = (i: BatchItem) =>
        (i.status === 'failed' || i.status === 'skipped') && (!wanted || wanted.includes(i.index));
      const todo = run.items.filter(retryable);
      if (todo.length === 0)
        return json(
          { title: 'Ingen feilede elementer å kjøre på nytt', status: 409, errors: [] },
          409,
        );
      failing.clear();
      const at = new Date().toISOString();
      run.items = run.items.map((i) => (retryable(i) ? finish(i, at) : i));
      run.status = 'succeeded';
      run.pass += 1;
      return json({ ...summary(run), retried: todo.length }, 202);
    }
    if (action[2] === 'export' && method === 'GET')
      return new Response(`Nr;Dokument-ID;Tittel\r\n1;${run.items[0]?.document.id ?? ''};x\r\n`, {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      });
    return notFound();
  };
};
