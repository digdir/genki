import type { PluginManifest } from './manifest.js';
import { PluginError } from './registry.js';

export interface DeclaredHost {
  host: string;
  port?: number;
}

export interface PermissionProblem {
  path: string;
  message: string;
}

const defaultPort = (protocol: string) => (protocol === 'https:' ? 443 : 80);

export const declaredHosts = (manifest: Pick<PluginManifest, 'hosts'>): DeclaredHost[] =>
  manifest.hosts.map((entry) => {
    const value = entry.trim().toLowerCase();
    const colon = value.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(value.slice(colon + 1)))
      return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
    return { host: value };
  });

const hostMatches = (declared: string, host: string) =>
  declared.startsWith('*.') ? host.endsWith(declared.slice(1)) : declared === host;

export const reachesDeclaredHost = (
  manifest: Pick<PluginManifest, 'hosts'>,
  host: string,
  port?: number,
) => {
  const wanted = host.replace(/^\[|\]$/g, '').toLowerCase();
  return declaredHosts(manifest).some(
    (d) => hostMatches(d.host, wanted) && (d.port === undefined || port === d.port),
  );
};

export const reachesDeclaredUrl = (manifest: Pick<PluginManifest, 'hosts'>, url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return reachesDeclaredHost(
    manifest,
    parsed.hostname,
    parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol),
  );
};

export const permissionProblems = (
  manifest: Pick<PluginManifest, 'hosts' | 'secrets'>,
  use: { urls?: { path: string; url: string }[]; secrets?: { path: string; ref: string }[] },
): PermissionProblem[] => [
  ...(use.urls ?? [])
    .filter((u) => !reachesDeclaredUrl(manifest, u.url))
    .map((u) => ({
      path: u.path,
      message: `${hostOf(u.url)} is not among the hosts the manifest declares`,
    })),
  ...(use.secrets ?? [])
    .filter((s) => !manifest.secrets.includes(s.ref))
    .map((s) => ({
      path: s.path,
      message: `${s.ref} is not among the secrets the manifest declares`,
    })),
];

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export interface SecretSource {
  resolve(ref: string): Promise<string>;
}

export const declaredSecrets = (
  manifest: Pick<PluginManifest, 'id' | 'secrets'>,
  inner: SecretSource,
): SecretSource => ({
  resolve: async (ref) => {
    if (!manifest.secrets.includes(ref))
      throw new PluginError(
        'forbidden',
        `plug-in ${manifest.id} may not read ${ref}; its manifest does not declare it`,
      );
    return inner.resolve(ref);
  },
});
