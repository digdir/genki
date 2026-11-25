import { isDevMode } from '@genai/composition';
import {
  genkiZones,
  hostedHostnamesFrom,
  reservedDomainsFrom,
  type HostingRules,
} from './hosts.js';

type Env = Record<string, string | undefined>;

export interface FramedEdition {
  publisher: string;
  id: string;
  version: number;
  sha256: string;
}

export type BlockFrameUrl = (edition: FramedEdition) => string | undefined;

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

const originOf = (value: string, devMode: boolean): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not an address`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error(`${value} must be an origin only, with no path, query or login`);
  const local = url.protocol === 'http:' && devMode && loopback.has(url.hostname);
  if (url.protocol !== 'https:' && !local)
    throw new Error(`${value} must be https, or http on localhost in dev mode`);
  return url.origin;
};

/** The origin code blocks are framed from; code blocks are off while it is unset. */
export const blockOriginFrom = (env: Env): string | undefined => {
  const value = env.GENAI_BLOCK_ORIGIN?.trim();
  if (!value) return undefined;
  const origin = originOf(value, isDevMode(env));
  const hostname = new URL(origin).hostname;
  const taken = [
    ...reservedDomainsFrom(env),
    ...hostedHostnamesFrom(env).keys(),
    ...genkiZones.map((zone) => zone.split('.').slice(-2).join('.')),
  ];
  if (taken.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)))
    throw new Error(
      `${value} must be on a site of its own, not under genki's parent domain or a service's hostname`,
    );
  return origin;
};

export const blockPortFrom = (env: Env): number => {
  const port = Number(env.GENAI_BLOCK_PORT ?? 8090);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('GENAI_BLOCK_PORT must be a port number');
  return port;
};

const segment = (value: string) => encodeURIComponent(value);

export const editionPath = (edition: Omit<FramedEdition, 'sha256'>) =>
  `${segment(edition.publisher)}/${segment(edition.id)}/${edition.version}`;

/** Where a code edition's frame is served; nowhere while no block origin is set. */
export const blockFrameUrl =
  (origin: string | undefined): BlockFrameUrl =>
  (edition) =>
    origin ? `${origin}/frame/${editionPath(edition)}/${edition.sha256}` : undefined;

const zonesOf = (hosting: HostingRules) => {
  const own = genkiZones.filter((zone) => hosting.assistantHostname?.endsWith(`.${zone}`));
  return own.length > 0 ? own : genkiZones;
};

/** The pages that may frame a block: the hosted service hostnames, genki's own names and the portal. */
export const frameAncestorsFrom = (env: Env, hosting: HostingRules): string[] => {
  const devMode = isDevMode(env);
  const extra = (env.GENAI_BLOCK_FRAME_ANCESTORS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => originOf(value, devMode));
  return [
    ...new Set([
      ...[...hosting.hostnames.keys()].map((hostname) => `https://${hostname}`),
      ...(hosting.assistantHostname ? [`https://${hosting.assistantHostname}`] : []),
      ...zonesOf(hosting).map((zone) => `https://*.apps.${zone}`),
      ...extra,
      ...(devMode ? ['http://localhost:*', 'http://127.0.0.1:*'] : []),
    ]),
  ];
};
