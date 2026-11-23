import { hkdfSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPool,
  LocalKeyWrapper,
  postgresSourceFromEnv,
  rewrapContentKeys,
} from '@genai/providers-postgres';

export interface RewrapArgs {
  dryRun: boolean;
  batchSize: number;
  platformLoginSubjectKey: boolean;
}

export const parseRewrapArgs = (argv: readonly string[]): RewrapArgs => {
  const args: RewrapArgs = { dryRun: false, batchSize: 500, platformLoginSubjectKey: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--platform-login-subject-key') args.platformLoginSubjectKey = true;
    else if (arg.startsWith('--batch-size=')) {
      const value = arg.slice('--batch-size='.length);
      args.batchSize = Number(value);
      if (!/^[1-9][0-9]{0,5}$/.test(value))
        throw new Error('--batch-size must be a whole number from 1 to 999999');
    } else
      throw new Error(
        `unknown argument ${arg}: use --dry-run, --batch-size=<n> or --platform-login-subject-key`,
      );
  }
  return args;
};

export const platformLoginSubjectKeyFrom = (env: NodeJS.ProcessEnv): string => {
  const master = Buffer.from(env.CONTENT_MASTER_KEY?.trim() ?? '', 'base64');
  if (master.length !== 32) throw new Error('CONTENT_MASTER_KEY must be 32 bytes in base64');
  return Buffer.from(hkdfSync('sha256', master, '', 'genki platform login subject', 32)).toString(
    'base64',
  );
};
export const runRewrap = async (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
): Promise<number> => {
  const args = parseRewrapArgs(argv);
  if (args.platformLoginSubjectKey) {
    write(platformLoginSubjectKeyFrom(env));
    return 0;
  }
  const wrapper = LocalKeyWrapper.fromEnv(env);
  const source = postgresSourceFromEnv(env);
  if (!source) throw new Error('DATABASE_URL or PGHOST is not set');
  const pool = createPool({ ...source, max: 2 });
  try {
    write(
      JSON.stringify({ msg: 'master keys', versions: wrapper.versions, active: wrapper.active }),
    );
    const result = await rewrapContentKeys(pool, wrapper, {
      dryRun: args.dryRun,
      batchSize: args.batchSize,
      onProgress: (progress) => write(JSON.stringify({ msg: 'progress', ...progress })),
    });
    write(JSON.stringify({ msg: 'done', ...result }));
    return result.failed === 0 ? 0 : 1;
  } finally {
    await pool.end();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const envFile = join(import.meta.dirname, '..', '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  try {
    process.exitCode = await runRewrap(process.argv.slice(2), process.env, (line) =>
      console.log(line),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'the re-wrap failed');
    process.exitCode = 1;
  }
}
