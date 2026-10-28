export interface SecretResolver {
  resolve(ref: string): Promise<string>;
  hostsFor?(ref: string): Promise<readonly string[] | undefined>;
}

export const secretRefPattern = /^secret:\/\/[a-z0-9-]+\/[a-z0-9._-]+$/;

export const envSecrets = (env: NodeJS.ProcessEnv = process.env): SecretResolver => ({
  resolve: async (ref) => {
    const match = /^secret:\/\/env\/([a-z0-9._-]+)$/.exec(ref);
    if (!match?.[1]) throw new Error(`envSecrets cannot resolve ${ref}`);
    const name = match[1].toUpperCase().replace(/[.-]/g, '_');
    const value = env[name];
    if (!value) throw new Error(`secret ${ref} is not set`);
    return value;
  },
});
