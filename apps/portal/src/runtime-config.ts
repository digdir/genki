type RuntimeSettings = Partial<Record<string, string>>;

const fromServer = (globalThis as { __GENKI_CONFIG__?: RuntimeSettings }).__GENKI_CONFIG__ ?? {};
const fromBuild = import.meta.env as unknown as RuntimeSettings;

export const setting = (name: string): string | undefined =>
  fromServer[name] || fromBuild[`VITE_${name}`] || undefined;
