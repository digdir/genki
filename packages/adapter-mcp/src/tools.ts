import {
  plainHeading,
  publicSourceUrl,
  withPlainHeadings,
  type Input,
  type InputField,
  type JSONSchema,
  type Part,
  type Principal,
} from '@genai/contracts';

export interface CapabilityEntry {
  id: string;
  capability: string;
  title?: string;
  description?: string;
  agentId?: string;
  mode?: string;
  default?: boolean;
  inputSchema?: JSONSchema;
  inputFields?: InputField[];
  version?: number;
  datasets?: string[];
}

export type ResolveErrorCode =
  | 'model_not_found'
  | 'agent_not_found'
  | 'mode_not_allowed'
  | 'agent_disabled'
  | 'agent_not_authorized'
  | 'mode_not_authorized'
  | 'dataset_not_authorized'
  | 'no_dataset_scope'
  | 'service_paused'
  | 'version_not_found';

export type Resolution =
  { ok: true; entry: CapabilityEntry } | { ok: false; code: ResolveErrorCode; message: string };

export interface CapabilityResolver {
  list(principal: Principal): Promise<CapabilityEntry[]>;
  resolve(principal: Principal, name: string, options?: { version?: number }): Promise<Resolution>;
}

export interface Authenticator {
  authenticate(request: Request): Promise<Principal | undefined>;
}

export const invalidParamsCodes = new Set([
  'invalid_tool_name',
  'model_not_found',
  'agent_not_found',
  'mode_not_allowed',
  'invalid_overrides',
]);

export const SOURCES_MIME = 'application/vnd.genai.sources+json';
export const RETRIEVAL_MIME = 'application/vnd.genai.retrieval+json';

export interface SourceRecord {
  chunkId: string;
  title?: string;
  url?: string;
  text?: string;
  headers?: string[];
  document?: string;
  position?: number;
  version?: string | number;
  publishedAt?: string;
}

export const excerptLength = 300;

export const excerptOf = (text: string | undefined, max = excerptLength): string | undefined => {
  const flat = (text ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return undefined;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export const FIELDS_MIME = 'application/json';
export const NO_ANSWER_NOTICE = 'Fant ikke noe svar.';

export const maxChunkText = 8000;

export const defaultOutputSchema: JSONSchema = {
  type: 'object',
  properties: {
    conversation_id: {
      type: 'string',
      description: 'Handle for this conversation; pass it back to continue.',
    },
    chunks: {
      type: 'array',
      description: 'Retrieved source chunks the answer drew on.',
      items: {
        type: 'object',
        properties: {
          chunk_id: { type: 'string' },
          doc_num: { type: 'string' },
          chunk_index: { type: 'integer' },
          content_length: { type: 'integer' },
          content_markdown: {
            type: 'string',
            description: `The chunk's text. PRESENT ONLY when the skill graph read it; at most ${maxChunkText} characters, so a value shorter than content_length was cut.`,
          },
          total_chunks: { type: 'integer' },
          title: { type: 'string' },
          url: {
            type: 'string',
            description:
              'Public URL of the source document. PRESENT ONLY when the corpus has one: website-sourced chunks always carry it, folder-sourced chunks only when the dataset supplies a base URL. Absent otherwise — do not build a link without checking.',
          },
          excerpt: {
            type: 'string',
            description: `The cited passage, at most ${excerptLength} characters.`,
          },
          version: { type: 'string', description: 'The document version, when known.' },
          published_at: { type: 'string', description: 'The publish date, when known.' },
          metadata: { type: 'object' },
        },
      },
    },
    queries: {
      type: 'array',
      description: 'Search queries that were run.',
      items: { type: 'string' },
    },
    search_attribution: {
      type: 'object',
      description: 'Which retrieval strategy contributed each hit.',
    },
    filters_applied: {
      type: 'array',
      description:
        'Each distinct filter retrieval ran with. `source` is explicit (caller or model), auto (detected from the query) or merged. `auto_detected` is the detected part; `auto_detected_dropped` means it found nothing and the search ran without it.',
      items: { type: 'object' },
    },
    clarification: {
      type: 'object',
      description: 'Present when the agent needs a clarifying answer before proceeding.',
    },
    no_answer: {
      type: 'boolean',
      description:
        'Present and true when the service produced no answer; the text is empty. Show `notice` instead. Chunks may still be present.',
    },
    notice: {
      type: 'string',
      description:
        'A Norwegian message for the user when `no_answer` is true: "Fant ikke noe svar."',
    },
    fields: {
      type: 'object',
      description: 'The structured output of a service whose output kind is fields.',
    },
  },
  required: ['conversation_id'],
};

export const defaultInstructions = [
  'This server exposes one tool per (service, variant) pair, named `<service>__<variant>` - `kunnskapsassistenten__default`. Call `tools/list` to see which pairs this API key can reach.',
  'Ask a question with the `query` argument - `user-query` is accepted as an alias. The answer comes back as text, with `structuredContent` carrying the retrieved chunks, the queries that were run, and `conversation_id`.',
  'To continue a conversation, pass the `conversation_id` from the previous response back in the next call. Earlier turns are retained server-side and supplied to the model automatically; omit it to start fresh.',
  'Scope a call with `tenant` and `dataset_config_key` when the API key or agent does not already fix one.',
  'Errors: a result with `isError: true` carries a message you can act on - fix the arguments or choose another tool. A JSON-RPC error means the request could not be dispatched (-32602) or the server failed (-32603); neither is worth retrying unchanged.',
].join('\n\n');

const protocolProperties: Record<string, JSONSchema> = {
  conversation_id: {
    type: 'string',
    description:
      'Handle for an ongoing conversation. Omit on the first call; the response returns the handle in structuredContent.conversation_id. Pass it back on later calls to continue the same conversation — prior turns are retained server-side and supplied to the model automatically.',
  },
  tenant: {
    type: 'string',
    description:
      'Dataset tenant to scope this call to. Optional when the API key or agent already fixes a scope.',
  },
  dataset_config_key: {
    type: 'string',
    description: 'Dataset configuration key to scope this call to. Optional, as for `tenant`.',
  },
  overrides: {
    type: 'object',
    description:
      'Per-call overrides. Accepts `retrieve-filter-by`, `retrieve-auto-filter` and `retrieve-top-k` (1 to 200); any other key is refused. Optional.',
  },
};

export const descriptionSuffix =
  ' Multi-turn: the response carries structuredContent.conversation_id; pass it back as the conversation_id argument to continue the same conversation, and earlier turns are supplied to the model automatically.';

const fallbackInput: JSONSchema = {
  type: 'object',
  properties: { 'user-query': { type: 'string' } },
  required: ['user-query'],
};

export const advertisedInput = (input: JSONSchema): JSONSchema => {
  const base =
    input && typeof input.properties === 'object' && input.properties !== null
      ? structuredClone(input)
      : structuredClone(fallbackInput);
  const properties = Object.fromEntries(
    Object.entries(base.properties as Record<string, JSONSchema>).map(([key, value]) =>
      key === 'user-query'
        ? [
            'query',
            {
              ...value,
              description:
                'The question to ask. Also accepted as `user-query`, the name used internally.',
            },
          ]
        : [key, value],
    ),
  );
  const required = Array.isArray(base.required)
    ? (base.required as string[]).map((r) => (r === 'user-query' ? 'query' : r))
    : undefined;
  return {
    ...base,
    properties: { ...protocolProperties, ...properties },
    ...(required ? { required } : {}),
  };
};

export const toolEntry = (entry: CapabilityEntry) => ({
  name: entry.id,
  title: entry.title ?? entry.id,
  outputSchema: defaultOutputSchema,
  description: `${entry.description ?? entry.title ?? entry.id}${descriptionSuffix}`,
  inputSchema: advertisedInput(entry.inputSchema ?? {}),
  _meta: {
    ...(entry.agentId === undefined ? {} : { 'agent-id': entry.agentId }),
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.default ? { default: true } : {}),
  },
});

export const requiresQuery = (input: JSONSchema | undefined) => {
  const schema = advertisedInput(input ?? {});
  return Array.isArray(schema.required) && (schema.required as string[]).includes('query');
};

export const readQuery = (args: Record<string, unknown>) => {
  for (const key of ['query', 'user-query']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
};

const acceptedOverrides = ['retrieve-auto-filter', 'retrieve-filter-by', 'retrieve-top-k'];
const unsafeChar = (s: string) =>
  [...s].some((c) => c === '`' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

const filterErrors = (filter: unknown): string[] => {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter))
    return ['must be an object with `fields`.'];
  const fields = (filter as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return ['`fields` must be an array.'];
  if (fields.length > 20) return ['at most 20 fields.'];
  if (fields.length === 0) return ['`fields` must not be empty.'];
  const errors: string[] = [];
  for (const f of fields as Record<string, unknown>[]) {
    if (!isRecord(f)) {
      errors.push('each field must be an object.');
      continue;
    }
    const options =
      f['selected-options'] ??
      f.selected_options ??
      (f.value === undefined || f.value === null ? [] : [f.value]);
    if (typeof f.field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(f.field))
      errors.push('each field needs a plain field name.');
    if (f.type !== undefined && !['multiselect', 'contains', 'not-in-set'].includes(String(f.type)))
      errors.push('type must be multiselect, contains or not-in-set.');
    const valueType = f['value-type'] ?? f.value_type;
    if (valueType !== undefined && valueType !== 'string' && valueType !== 'integer')
      errors.push('value-type must be string or integer.');
    if (!Array.isArray(options) || options.length === 0 || options.length > 100)
      errors.push('each field takes 1 to 100 options.');
    else if (options.some((o) => typeof o !== 'string' && !Number.isInteger(o)))
      errors.push('options must be strings or integers.');
    else if (options.some((o) => typeof o === 'string' && (unsafeChar(o) || o.length > 256)))
      errors.push(
        'options cannot contain backticks, backslashes or control characters, and are at most 256 characters.',
      );
  }
  return errors;
};

const shown = (keys: string[]) => {
  const text = `[${keys
    .slice(0, 5)
    .map((k) => JSON.stringify(k))
    .join(' ')}]`;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

export const settingKeyPattern = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

type OverrideOutcome = { ok: true } | { ok: false; message: string };

export interface OverridePolicy {
  check(
    principal: Principal,
    overrides?: Record<string, unknown>,
    target?: { capability: string; entryPoint: string },
  ): OverrideOutcome | Promise<OverrideOutcome>;
}

export const readOverrides = (
  raw: unknown,
  options: { settings?: boolean } = {},
): { overrides?: Record<string, unknown>; error?: string } => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { error: '`overrides` must be an object.' };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter(
    (k) => !acceptedOverrides.includes(k) && !(options.settings && settingKeyPattern.test(k)),
  );
  if (unknown.length > 0) {
    return {
      error: `Unsupported override keys: ${shown(unknown)}. Accepted: ${acceptedOverrides.join(', ')}.`,
    };
  }
  if ('retrieve-auto-filter' in o && typeof o['retrieve-auto-filter'] !== 'boolean')
    return { error: '`retrieve-auto-filter` must be true or false.' };
  const topK = o['retrieve-top-k'];
  if (
    'retrieve-top-k' in o &&
    !(Number.isInteger(topK) && (topK as number) >= 1 && (topK as number) <= 200)
  )
    return { error: '`retrieve-top-k` must be an integer from 1 to 200.' };
  if ('retrieve-filter-by' in o) {
    const errors = filterErrors(o['retrieve-filter-by']);
    if (errors.length > 0) return { error: `Invalid \`retrieve-filter-by\`: ${errors.join(' ')}` };
  }
  return { overrides: o };
};

export interface History {
  role: string;
  text: string;
}

export const defaultInput = (
  args: Record<string, unknown>,
  query: string | undefined,
  history: History[],
): Input => ({
  ...(query ? { parts: [{ mime: 'text/plain', body: { kind: 'text', text: query } }] } : {}),
  data: { ...args, query: query ?? '', history },
});

export interface ToolOutput {
  text: string;
  structured: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isSource = (v: unknown): v is SourceRecord => isRecord(v) && typeof v.chunkId === 'string';

const toChunk = (record: SourceRecord): Record<string, unknown> => {
  const s = withPlainHeadings(record);
  return {
    chunk_id: s.chunkId,
    ...(s.document === undefined ? {} : { doc_num: s.document }),
    ...(s.position === undefined ? {} : { chunk_index: s.position }),
    ...(s.title === undefined ? {} : { title: s.title }),
    ...(publicSourceUrl(s) === undefined ? {} : { url: publicSourceUrl(s) }),
    ...(s.text === undefined ? {} : { content_markdown: s.text, content_length: s.text.length }),
    ...(excerptOf(s.text) === undefined ? {} : { excerpt: excerptOf(s.text) }),
    ...(s.version === undefined || s.version === '' ? {} : { version: String(s.version) }),
    ...(s.publishedAt ? { published_at: s.publishedAt } : {}),
    ...(s.headers?.length
      ? { metadata: Object.fromEntries(s.headers.map((h, i) => [`Header ${i + 1}`, h])) }
      : {}),
  };
};

const extras: Record<string, string> = {
  queries: 'queries',
  searchAttribution: 'search_attribution',
  search_attribution: 'search_attribution',
  filtersApplied: 'filters_applied',
  filters_applied: 'filters_applied',
  clarification: 'clarification',
  insufficient: 'insufficient',
  executionMetadata: 'execution_metadata',
};

const numberOf = (v: unknown) => (typeof v === 'number' ? v : undefined);

const autoFilterOf = (a: Record<string, unknown>) => {
  const auto = isRecord(a.autoFilter) ? a.autoFilter : undefined;
  if (!auto || typeof auto.field !== 'string' || !Array.isArray(auto.options)) return undefined;
  return {
    fields: [
      {
        type: auto.field === 'title' ? 'contains' : 'multiselect',
        field: auto.field,
        'selected-options': auto.options.map(String),
        'value-type': 'string',
      },
    ],
  };
};

const callerFieldsOf = (a: Record<string, unknown>) =>
  Array.isArray(a.callerFilter) ? (a.callerFilter as Record<string, unknown>[]) : [];

export const searchAttribution = (a: Record<string, unknown>): Record<string, unknown> => {
  const auto = autoFilterOf(a);
  const dropped = a.autoFilterFallback === true;
  const caller = callerFieldsOf(a);
  const out: Record<string, unknown> = {};
  for (const key of ['phrase', 'metadata', 'content'] as const) {
    const n = numberOf(a[key]);
    if (n !== undefined) out[key] = n;
  }
  if (caller.length > 0) {
    const named = new Set(caller.map((f) => f.field));
    const detected = auto && !dropped ? auto.fields.filter((f) => !named.has(f.field)) : [];
    Object.assign(out, {
      'filter-applied': { fields: [...caller, ...detected] },
      'filter-source': auto && !dropped ? 'merged' : 'explicit',
    });
  } else if (auto && !dropped)
    Object.assign(out, { 'filter-applied': auto, 'filter-source': 'auto' });
  if (auto) out['auto-filter-applied'] = auto;
  if (dropped) out['auto-filter-fallback'] = true;
  if (a.rerankEnabled === true) {
    out['rerank-enabled?'] = true;
    const ms = numberOf(a.rerankMs);
    if (ms !== undefined) out['rerank-ms'] = ms;
  }
  return out;
};

const appliedFrom = (attribution: Record<string, unknown>) => {
  const filter = attribution['filter-applied'];
  if (!filter) return [];
  return [
    {
      filter,
      source: attribution['filter-source'],
      ...(attribution['auto-filter-applied']
        ? { auto_detected: attribution['auto-filter-applied'] }
        : {}),
      ...(attribution['auto-filter-fallback'] ? { auto_detected_dropped: true } : {}),
    },
  ];
};

const fieldsOf = (parts: Part[]) => {
  const part = parts.find((p) => p.mime === FIELDS_MIME && p.body.kind === 'json');
  return part?.body.kind === 'json' && isRecord(part.body.json) ? part.body.json : undefined;
};

const textOf = (parts: Part[], fields: Record<string, unknown> | undefined) => {
  const text = parts
    .flatMap((p) => (p.body.kind === 'text' && p.mime !== SOURCES_MIME ? [p.body.text] : []))
    .join('');
  if (text.trim() || !fields || Object.keys(fields).length === 0) return text;
  return typeof fields.text === 'string' && fields.text.trim()
    ? fields.text
    : JSON.stringify(fields, null, 2);
};

export const defaultOutput = (parts: Part[]): ToolOutput => {
  const fields = fieldsOf(parts);
  const text = textOf(parts, fields);
  const structured: Record<string, unknown> = {};
  if (fields) structured.fields = fields;
  if (!text.trim()) Object.assign(structured, { no_answer: true, notice: NO_ANSWER_NOTICE });
  const chunks: Record<string, unknown>[] = [];
  for (const p of parts) {
    if (p.mime !== SOURCES_MIME || p.body.kind !== 'json' || !isRecord(p.body.json)) continue;
    const body = p.body.json;
    if (Array.isArray(body.sources)) chunks.push(...body.sources.filter(isSource).map(toChunk));
    for (const [from, to] of Object.entries(extras))
      if (body[from] !== undefined) structured[to] = body[from];
  }
  for (const p of parts) {
    if (p.mime !== RETRIEVAL_MIME || p.body.kind !== 'json' || !isRecord(p.body.json)) continue;
    const body = p.body.json;
    if (structured.queries === undefined && Array.isArray(body.queries))
      structured.queries = body.queries;
    if (structured.search_attribution === undefined && isRecord(body.attribution)) {
      const attribution = searchAttribution(body.attribution);
      structured.search_attribution = attribution;
      if (structured.filters_applied === undefined) {
        const applied = appliedFrom(attribution);
        if (applied.length) structured.filters_applied = applied;
      }
    }
  }
  if (chunks.length > 0) structured.chunks = chunks;
  return { text, structured };
};

const chunkForWire = (chunk: Record<string, unknown>) => {
  const keep = [
    'chunk_id',
    'doc_num',
    'chunk_index',
    'content_length',
    'total_chunks',
    'title',
    'url',
    'excerpt',
    'version',
    'published_at',
    'metadata',
  ];
  const out = Object.fromEntries(
    keep.filter((k) => chunk[k] !== undefined).map((k) => [k, chunk[k]]),
  );
  const text = chunk.content_markdown;
  if (typeof text === 'string' && text.trim() !== '')
    out.content_markdown = text.slice(0, maxChunkText);
  return out;
};

const present = (v: unknown) =>
  (Array.isArray(v) && v.length > 0) || (isRecord(v) && Object.keys(v).length > 0);

export const structuredContent = (structured: Record<string, unknown>, conversationId: string) => {
  const out: Record<string, unknown> = { conversation_id: conversationId };
  const chunks = Array.isArray(structured.chunks)
    ? (structured.chunks as Record<string, unknown>[])
    : [];
  const wire = chunks.length > 0 ? chunks.slice(0, 20).map(chunkForWire) : undefined;
  // KA's capability probe regex needs chunks followed by "queries" or the closing brace.
  const queries = present(structured.queries);
  if (wire && queries) out.chunks = wire;
  for (const key of ['queries', 'search_attribution', 'filters_applied'])
    if (present(structured[key])) out[key] = structured[key];
  if (structured.clarification) out.clarification = structured.clarification;
  for (const key of ['fields', 'no_answer', 'notice'])
    if (structured[key] !== undefined) out[key] = structured[key];
  if (wire && !queries) out.chunks = wire;
  return out;
};

export const resourceLinks = (structured: Record<string, unknown>) => {
  const chunks = Array.isArray(structured.chunks)
    ? (structured.chunks as Record<string, unknown>[])
    : [];
  const seen = new Set<string>();
  const links: Record<string, unknown>[] = [];
  for (const c of chunks) {
    const doc = typeof c.doc_num === 'string' && c.doc_num !== '' ? c.doc_num : undefined;
    const metaUrl =
      isRecord(c.metadata) && typeof c.metadata.url === 'string' ? c.metadata.url : undefined;
    const url = typeof c.url === 'string' && c.url !== '' ? c.url : undefined;
    const key = doc ?? url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const excerpt = typeof c.excerpt === 'string' ? c.excerpt : undefined;
    links.push({
      type: 'resource_link',
      uri:
        publicSourceUrl({
          url: url ?? (metaUrl || `digdir://doc/${doc}`),
          ...(typeof c.title === 'string' && c.title !== '' ? { title: c.title } : {}),
        }) ?? `digdir://doc/${doc}`,
      name: (typeof c.title === 'string' && plainHeading(c.title)) || `Document ${doc}`,
      mimeType: 'text/html',
      ...(excerpt ? { description: excerpt } : {}),
    });
  }
  return links;
};
