import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Where Git for Windows keeps its openssl, from the git.exe on PATH: Windows itself ships none,
 * and Git's is not on PATH outside Git Bash. git.exe is in Git\cmd, Git\bin or Git\mingw64\bin.
 */
export const opensslBesideGit = (gitExe: string) => {
  const dir = dirname(gitExe);
  return [
    join(dir, 'openssl.exe'),
    join(dir, '..', 'mingw64', 'bin', 'openssl.exe'),
    join(dir, '..', 'usr', 'bin', 'openssl.exe'),
  ];
};

const opensslCommand = async () => {
  if (process.platform !== 'win32') return 'openssl';
  const onPath = await run('where.exe', ['openssl']).then(
    () => true,
    () => false,
  );
  if (onPath) return 'openssl';
  const found = await run('where.exe', ['git']).then(
    (r) => r.stdout.split(/\r?\n/).filter(Boolean),
    () => [] as string[],
  );
  for (const git of found)
    for (const candidate of opensslBesideGit(git)) if (existsSync(candidate)) return candidate;
  return 'openssl';
};

/** Generate fresh TLS credentials for local tests; never persist them in the repository. */
export const testTlsCertificate = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'genki-test-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  try {
    await run(
      await opensslCommand(),
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=docs.example.test',
        '-addext',
        'subjectAltName=DNS:docs.example.test',
        '-days',
        '1',
        '-keyout',
        keyPath,
        '-out',
        certPath,
      ],
      { timeout: 10_000 },
    );
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    return { key, cert };
  } catch (cause) {
    throw new Error(
      'TLS test certificate generation failed; openssl is required on PATH, or Git for Windows installed',
      {
        cause,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
