import type { SecretResolver, TokenProviders } from '@genai/kernel';
import type { KnowledgeAdapter, KnowledgeEndpointConfig } from './adapter.js';
import { parseKnowledgeCatalog, type CatalogKnowledgeEndpoint } from './catalog.js';
import { KnowledgeError, type KnowledgeErrorCode } from './port.js';
import { endpointConfig } from './resolve.js';

export type EndpointProbe =
  | { ok: true; engine: string; ms: number }
  | { ok: false; engine?: string; code: KnowledgeErrorCode; message: string; ms: number };

export interface ProbeOptions {
  adapters: KnowledgeAdapter[];
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  timeoutMs?: number;
}

const aborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(new KnowledgeError('unavailable', 'the connection test timed out'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });

export const probeWith = async (
  endpoint: CatalogKnowledgeEndpoint,
  options: ProbeOptions,
  signal?: AbortSignal,
): Promise<EndpointProbe> => {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const { engine } = endpoint;
  const adapter = options.adapters.find((a) => a.engine === engine);
  if (!adapter)
    return { ok: false, code: 'unsupported', message: `no adapter for ${engine}`, ms: 0 };
  if (!adapter.probe)
    return {
      ok: false,
      engine,
      code: 'unsupported',
      message: `${engine} cannot test connections`,
      ms: 0,
    };
  const timeoutMs = options.timeoutMs ?? 10_000;
  const limit = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    const config = endpointConfig(
      endpoint,
      adapter.endpointOptions.parse(endpoint.options),
      options,
      timeoutMs,
    ) as KnowledgeEndpointConfig;
    await Promise.race([adapter.probe(config, limit), aborted(limit)]);
    return { ok: true, engine, ms: ms() };
  } catch (error) {
    if (error instanceof KnowledgeError)
      return { ok: false, engine, code: error.code, message: error.message, ms: ms() };
    return {
      ok: false,
      engine,
      code: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
      ms: ms(),
    };
  }
};

/** Tests an endpoint that need not be in the catalog yet, such as one being edited. */
export const probeKnowledgeEndpoint = async (
  endpoint: unknown,
  options: ProbeOptions,
  signal?: AbortSignal,
): Promise<EndpointProbe> => {
  const parsed = parseKnowledgeCatalog(
    { endpoints: { probe: endpoint }, datasets: [] },
    options.adapters,
  );
  if (!parsed.ok)
    return {
      ok: false,
      code: 'bad_request',
      message: parsed.errors
        .map((e) => `${e.path.replace(/^endpoints\.probe\.?/, '') || 'endpoint'}: ${e.message}`)
        .join('; '),
      ms: 0,
    };
  return probeWith(parsed.catalog.endpoints.probe as CatalogKnowledgeEndpoint, options, signal);
};
