import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Generate fresh TLS credentials for local tests; never persist them in the repository. */
export const testTlsCertificate = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'genki-test-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  try {
    await run(
      'openssl',
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
    throw new Error('TLS test certificate generation failed; openssl is required on PATH', {
      cause,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
