import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IndexDocument } from '@genai/port-knowledge';
import type { TypesenseDatasetOptions } from './index.js';

type Row = Record<string, unknown>;

export interface FakeTypesense {
  url: string;
  writes: string[];
  close(): Promise<void>;
}

const topLevel = (expression: string, separator: string) => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (c === '`') quoted = !quoted;
    if (quoted) continue;
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && expression.startsWith(separator, i)) {
      parts.push(expression.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

const values = (raw: string): (string | number)[] => {
  const inner = raw.startsWith('[') ? raw.slice(1, -1) : raw;
  return topLevel(inner, ',').map((v) =>
    v.startsWith('`') ? v.slice(1, -1) : Number.isNaN(Number(v)) ? v : Number(v),
  );
};

const listOf = (value: unknown) => (Array.isArray(value) ? value : [value]);

const matches = (row: Row, expression: string, joined: (row: Row) => Row): boolean =>
  topLevel(expression, '&&').every((clause) => {
    if (clause.startsWith('(') && clause.endsWith(')'))
      return topLevel(clause.slice(1, -1), '||').some((c) => matches(row, c, joined));
    const join = /^\$[^(]+\((.*)\)$/.exec(clause);
    if (join) return matches(joined(row), join[1] ?? '', joined);
    const parsed = /^([A-Za-z0-9_.]+):(=|!=|>=|<=)?(.*)$/.exec(clause);
    if (!parsed) return false;
    const [, field = '', op, raw = ''] = parsed;
    const have = listOf(row[field]);
    const wanted = values(raw);
    if (op === '=') return have.some((h) => wanted.some((w) => String(w) === String(h)));
    if (op === '!=') return !have.some((h) => wanted.some((w) => String(w) === String(h)));
    if (op === '>=') return have.some((h) => Number(h) >= Number(wanted[0]));
    if (op === '<=') return have.some((h) => Number(h) <= Number(wanted[0]));
    return have.some((h) => String(h).toLowerCase().includes(String(wanted[0]).toLowerCase()));
  });

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export const fakeTypesense = async (
  documents: IndexDocument[],
  options: TypesenseDatasetOptions,
): Promise<FakeTypesense> => {
  const { fields, collections } = options;
  const docs: Row[] = documents.map((d) => ({
    id: d.id,
    [fields.document]: d.id,
    [fields.title]: d.title,
    [fields.url]: d.url,
    total_chunks: d.chunks.length,
    ...d.fields,
  }));
  const chunks: Row[] = documents.flatMap((d) =>
    d.chunks.map((c) => ({
      id: c.id,
      [fields.id]: c.id,
      [fields.document]: d.id,
      [fields.position]: c.position,
      [fields.text]: c.text,
      ...c.metadata,
    })),
  );
  const phrases: Row[] = documents.flatMap((d) =>
    d.phrases.map((p) => ({
      id: p.id,
      [fields.id]: p.chunkId,
      [fields.document]: d.id,
      search_phrase: p.text,
    })),
  );
  const tables = new Map<string, Row[]>([
    [String(collections.docs), docs],
    [String(collections.chunks), chunks],
    ...(collections.phrases ? [[String(collections.phrases), phrases] as [string, Row[]]] : []),
  ]);
  const docOf = (row: Row) => docs.find((d) => d[fields.document] === row[fields.document]) ?? {};
  const writes: string[] = [];

  const search = (s: Record<string, unknown>) => {
    const table = tables.get(String(s.collection));
    if (!table) return { code: 404, error: `no collection ${String(s.collection)}` };
    const q = String(s.q ?? '*');
    const queryBy = String(s.query_by ?? '').split(',');
    const filter = typeof s.filter_by === 'string' ? s.filter_by : '';
    const words = q === '*' ? [] : tokens(q);
    let rows = table
      .filter((row) => !filter || matches(row, filter, docOf))
      .map((row) => ({
        row,
        score: words.length
          ? words.filter((w) => queryBy.some((f) => tokens(String(row[f] ?? '')).includes(w)))
              .length
          : 1,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    if (typeof s.sort_by === 'string' && s.sort_by.endsWith(':asc')) {
      const field = s.sort_by.split(':')[0] ?? '';
      rows = rows.sort((a, b) => Number(a.row[field]) - Number(b.row[field]));
    }
    const facetBy = typeof s.facet_by === 'string' ? s.facet_by.split(',') : [];
    const facet_counts = facetBy.map((field) => {
      const counts = new Map<string, number>();
      for (const { row } of rows)
        for (const v of listOf(row[field])) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      return { field_name: field, counts: [...counts].map(([value, count]) => ({ value, count })) };
    });
    const perPage = Number(s.per_page ?? 10);
    return {
      found: rows.length,
      hits: rows.slice(0, perPage).map(({ row, score }) => ({
        document:
          s.collection === collections.docs
            ? row
            : { ...row, [String(collections.docs)]: docOf(row) },
        text_match_info: { score },
      })),
      ...(facetBy.length ? { facet_counts } : {}),
    };
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://typesense');
      const send = (status: number, body: unknown, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method === 'POST' && url.pathname === '/multi_search') {
        const { searches } = JSON.parse(raw || '{}') as { searches?: Record<string, unknown>[] };
        return send(200, { results: (searches ?? []).map(search) });
      }
      if (req.method !== 'GET') {
        writes.push(`${req.method} ${url.pathname}`);
        return send(403, { message: 'the contract fake is read-only' });
      }
      if (url.pathname === '/health') return send(200, { ok: true });
      if (url.pathname === '/collections') return send(200, []);
      const exported = /^\/collections\/([^/]+)\/documents\/export$/.exec(url.pathname);
      const table = exported ? tables.get(decodeURIComponent(exported[1] ?? '')) : undefined;
      if (!table) return send(404, { message: 'not found' });
      const filter = url.searchParams.get('filter_by');
      const rows = table.filter((row) => !filter || matches(row, filter, docOf));
      return send(200, rows.map((r) => JSON.stringify(r)).join('\n'), 'application/jsonl');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    writes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
