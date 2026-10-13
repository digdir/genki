import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configDir = join(repoRoot, 'apps', 'api', 'config', 'local');
const pricesFile = join(configDir, 'prices.yaml');

const retailPricesUrl = 'https://prices.azure.com/api/retail/prices';
const region = 'swedencentral';

export interface RetailItem {
  meterName: string;
  productName: string;
  skuName: string;
  unitOfMeasure: string;
  retailPrice: number;
  type: string;
}

export interface ModelRef {
  id: string;
  family?: string;
}

export interface Price {
  inputPerThousand: number;
  outputPerThousand: number;
}

export type Match = { ok: true; price: Price; meters: string[] } | { ok: false; reason: string };

interface Meter {
  family: string;
  version: string;
  direction: 'input' | 'output';
  perThousand: number;
  name: string;
}

const globalTokens = new Set(['glbl', 'global']);
const inputTokens = new Set(['inp', 'inpt', 'input']);
const outputTokens = new Set(['outp', 'outpt', 'output', 'out', 'opt']);
const unitTokens = new Set(['tokens', 'tkn', '1k', '1m']);
const excluded = new Set([
  'batch',
  'cached',
  'cchd',
  'ft',
  'dev',
  'rt',
  'aud',
  'audio',
  'realtime',
  'realtimeprvw',
  'prvw',
  'transcribe',
  'tcrb',
  'tts',
  'trng',
  'training',
  'hstng',
  'hosting',
  'txt',
  'img',
  'new',
]);

const tokensOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '');

const perThousand = (item: RetailItem) => {
  const unit = item.unitOfMeasure.trim().toUpperCase();
  if (unit === '1K') return item.retailPrice;
  if (unit === '1M') return item.retailPrice / 1000;
  return undefined;
};

export const parseMeter = (item: RetailItem): Meter | undefined => {
  if (item.type !== 'Consumption') return undefined;
  const tokens = tokensOf(item.meterName);
  if (!tokens.some((t) => globalTokens.has(t))) return undefined;
  if (tokens.some((t) => excluded.has(t))) return undefined;
  const price = perThousand(item);
  if (price === undefined) return undefined;
  const embedding = tokens.includes('embedding');
  const direction = tokens.some((t) => inputTokens.has(t))
    ? 'input'
    : tokens.some((t) => outputTokens.has(t))
      ? 'output'
      : embedding
        ? 'input'
        : undefined;
  if (!direction) return undefined;
  const version = tokens.find((t) => /^\d{4}$/.test(t)) ?? '';
  const family = tokens
    .filter(
      (t) =>
        !globalTokens.has(t) &&
        !inputTokens.has(t) &&
        !outputTokens.has(t) &&
        !unitTokens.has(t) &&
        t !== version,
    )
    .join(' ');
  return { family, version, direction, perThousand: price, name: item.meterName };
};

type Table = Map<string, Map<string, { input?: Meter; output?: Meter; conflict?: boolean }>>;

export const priceTable = (items: RetailItem[]): Table => {
  const table: Table = new Map();
  for (const item of items) {
    const meter = parseMeter(item);
    if (!meter) continue;
    const versions = table.get(meter.family) ?? new Map();
    table.set(meter.family, versions);
    const entry = versions.get(meter.version) ?? {};
    versions.set(meter.version, entry);
    const known = entry[meter.direction];
    if (known && known.perThousand !== meter.perThousand) entry.conflict = true;
    else entry[meter.direction] = meter;
  }
  return table;
};

const familyOf = (model: ModelRef) => {
  const name = (model.family ?? model.id.slice(model.id.indexOf('/') + 1)).toLowerCase();
  const dated = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  return dated
    ? { family: tokensOf(dated[1] ?? '').join(' '), version: `${dated[3]}${dated[4]}` }
    : { family: tokensOf(name).join(' '), version: undefined };
};

const round = (n: number) => Number(n.toPrecision(6));

export const matchModel = (model: ModelRef, table: Table): Match => {
  const { family, version } = familyOf(model);
  const versions = table.get(family);
  if (!versions) return { ok: false, reason: `no global meter for "${family}"` };
  const embedding = family.includes('embedding');
  const candidates = [...versions.entries()].filter(
    ([v]) => version === undefined || v === version || v === '',
  );
  const priced = candidates.flatMap(([, e]) => {
    if (e.conflict || !e.input || (!e.output && !embedding)) return [];
    return [
      {
        price: {
          inputPerThousand: round(e.input.perThousand),
          outputPerThousand: e.output ? round(e.output.perThousand) : 0,
        },
        meters: [e.input.name, ...(e.output ? [e.output.name] : [])],
      },
    ];
  });
  if (priced.length === 0)
    return { ok: false, reason: `no complete input and output meter pair for "${family}"` };
  const distinct = new Set(
    priced.map((p) => `${p.price.inputPerThousand}/${p.price.outputPerThousand}`),
  );
  if (distinct.size > 1)
    return {
      ok: false,
      reason: `"${family}" has versions with different prices (${[...distinct].join(', ')}) and the deployment does not say which`,
    };
  return {
    ok: true,
    price: priced[0]?.price as Price,
    meters: [...new Set(priced.flatMap((p) => p.meters))],
  };
};

const fetchItems = async (): Promise<RetailItem[]> => {
  const filter = `serviceName eq 'Foundry Models' and armRegionName eq '${region}'`;
  let url: string | undefined =
    `${retailPricesUrl}?currencyCode='NOK'&$filter=${encodeURIComponent(filter)}`;
  const items: RetailItem[] = [];
  while (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Azure Retail Prices answered HTTP ${response.status}`);
    const page = (await response.json()) as { Items: RetailItem[]; NextPageLink?: string | null };
    items.push(...page.Items);
    url = page.NextPageLink ?? undefined;
  }
  return items;
};

const yamlModels = (file: string): ModelRef[] => {
  const path = join(configDir, file);
  if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, 'utf8')) as { models?: { id?: string }[] } | null;
  return (raw?.models ?? []).flatMap((m) => (m.id ? [{ id: m.id }] : []));
};

const serviceModels = (): ModelRef[] => {
  const dir = join(configDir, 'services');
  if (!existsSync(dir)) return [];
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) =>
      [
        ...readFileSync(join(dir, f), 'utf8').matchAll(
          /(?:primary|fallback|synthesis|planner|judge):\s*['"]?([a-z0-9-]+\/[A-Za-z0-9._-]+)/g,
        ),
      ].map((m) => m[1] as string),
    );
  return ids.map((id) => ({ id }));
};

const discoveredModels = async (): Promise<ModelRef[] | undefined> => {
  const base = process.env.GENAI_API_URL;
  const key = process.env.GENAI_API_KEY;
  if (!base || !key) return undefined;
  const response = await fetch(`${base.replace(/\/$/, '')}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    console.log(`${base}/models answered HTTP ${response.status}; using configured ids only`);
    return undefined;
  }
  const body = (await response.json()) as { data?: { id: string; family?: string }[] };
  return (body.data ?? []).map((m) => ({ id: m.id, ...(m.family ? { family: m.family } : {}) }));
};

export interface DiscoveryEndpoint {
  name: string;
  from: string;
  include: string[];
  exclude: string[];
}

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export const globMatches = (name: string, include: string[], exclude: string[]) =>
  include.some((p) => glob(p).test(name)) && !exclude.some((p) => glob(p).test(name));

export const discoveredIds = (
  endpoints: DiscoveryEndpoint[],
  listings: Map<string, { id: string; model?: string }[]>,
): ModelRef[] =>
  endpoints.flatMap((e) =>
    (listings.get(e.from) ?? [])
      .filter((d) => globMatches(d.id, e.include, e.exclude))
      .map((d) => ({
        id: `${e.name}/${d.id}`.toLowerCase(),
        ...(d.model ? { family: d.model } : {}),
      })),
  );

interface CatalogEndpoint {
  baseURL?: string;
  auth?: { secret?: string };
  discovery?: { source?: string; from?: string; include?: string[]; exclude?: string[] };
}

const fromEnv = (value: string | undefined) =>
  value?.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '');

const secretFromEnv = (ref: string | undefined) => {
  const name = /^secret:\/\/env\/(.+)$/.exec(ref ?? '')?.[1];
  return name ? process.env[name.toUpperCase().replace(/-/g, '_')] : undefined;
};

const azureRoot = (baseURL: string) =>
  baseURL
    .replace(/\/+$/, '')
    .replace(/\/openai(\/v1)?$/, '')
    .replace(/\/anthropic$/, '');

const azureDeployments = async (): Promise<ModelRef[] | undefined> => {
  const raw = parse(readFileSync(join(configDir, 'models.yaml'), 'utf8')) as {
    endpoints?: Record<string, CatalogEndpoint>;
  } | null;
  const catalog = raw?.endpoints ?? {};
  const endpoints: DiscoveryEndpoint[] = Object.entries(catalog).flatMap(([name, e]) =>
    e.discovery?.source === 'azure-deployments'
      ? [
          {
            name,
            from: e.discovery.from ?? name,
            include: e.discovery.include ?? ['*'],
            exclude: e.discovery.exclude ?? [],
          },
        ]
      : [],
  );
  const listings = new Map<string, { id: string; model?: string }[]>();
  for (const from of new Set(endpoints.map((e) => e.from))) {
    const baseURL = fromEnv(catalog[from]?.baseURL);
    const key = secretFromEnv(catalog[from]?.auth?.secret);
    if (!baseURL || !key) {
      console.log(`no base URL or key in the environment for ${from}; skipping its deployments`);
      continue;
    }
    const response = await fetch(
      `${azureRoot(baseURL)}/openai/deployments?api-version=2022-12-01`,
      {
        headers: { 'api-key': key },
      },
    );
    if (!response.ok) {
      console.log(`listing deployments for ${from} answered HTTP ${response.status}`);
      continue;
    }
    const body = (await response.json()) as {
      data?: { id?: string; model?: string; status?: string }[];
    };
    listings.set(
      from,
      (body.data ?? []).flatMap((d) =>
        d.id && d.status === 'succeeded'
          ? [{ id: d.id, ...(d.model ? { model: d.model } : {}) }]
          : [],
      ),
    );
  }
  return listings.size > 0 ? discoveredIds(endpoints, listings) : undefined;
};

export const listedModels = (list: string | undefined): ModelRef[] =>
  (list ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [id, family] = entry.split('=');
      return { id: id as string, ...(family ? { family } : {}) };
    });

const existingPrices = (): Record<string, Price> => {
  if (!existsSync(pricesFile)) return {};
  const raw = parse(readFileSync(pricesFile, 'utf8')) as { models?: Record<string, Price> } | null;
  return raw?.models ?? {};
};

export const renderPrices = (prices: Record<string, Price>, date: string) =>
  [
    `# Azure Retail Prices API (prices.azure.com), NOK per 1,000 tokens, GlobalStandard, Sweden Central, ${date}`,
    'models:',
    ...Object.keys(prices)
      .sort()
      .map((id) => {
        const p = prices[id] as Price;
        return `  ${id}: { inputPerThousand: ${p.inputPerThousand}, outputPerThousand: ${p.outputPerThousand} }`;
      }),
    '',
  ].join('\n');

const main = async () => {
  const discovered = (await azureDeployments()) ?? (await discoveredModels());
  const models = new Map<string, ModelRef>();
  for (const m of [
    ...yamlModels('models.yaml'),
    ...yamlModels('embeddings.yaml'),
    ...(discovered ?? serviceModels()),
    ...listedModels(process.env.GENAI_MODEL_IDS),
  ])
    models.set(m.id, { ...models.get(m.id), ...m });
  const table = priceTable(await fetchItems());
  const previous = existingPrices();
  const prices: Record<string, Price> = {};
  const unmatched: string[] = [];
  for (const model of [...models.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const match = matchModel(model, table);
    if (match.ok) {
      prices[model.id] = match.price;
      const note = match.price.outputPerThousand === 0 ? ' (embedding: input-only meter)' : '';
      console.log(
        `priced ${model.id}: in ${match.price.inputPerThousand}, out ${match.price.outputPerThousand}${note} from ${match.meters.join('; ')}`,
      );
    } else {
      unmatched.push(model.id);
      const kept = previous[model.id] ? '; kept the existing entry' : '';
      console.log(`unmatched ${model.id}: ${match.reason}${kept}`);
    }
  }
  for (const [id, price] of Object.entries(previous))
    if (!prices[id]) {
      prices[id] = price;
      if (!models.has(id)) console.log(`kept ${id}: not among the known model ids`);
    }
  writeFileSync(pricesFile, renderPrices(prices, new Date().toISOString().slice(0, 10)));
  console.log(`wrote ${Object.keys(prices).length} prices, ${unmatched.length} unmatched`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
