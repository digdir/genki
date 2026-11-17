import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { opensslBesideGit, testTlsCertificate } from './test-tls.ts';

describe('the TLS test certificate', () => {
  it('looks for openssl where Git for Windows keeps it, next to and beside the git.exe on PATH', () => {
    const git = join('C:\\Programs', 'Git', 'cmd', 'git.exe');
    expect(opensslBesideGit(git)).toEqual([
      join('C:\\Programs', 'Git', 'cmd', 'openssl.exe'),
      join('C:\\Programs', 'Git', 'cmd', '..', 'mingw64', 'bin', 'openssl.exe'),
      join('C:\\Programs', 'Git', 'cmd', '..', 'usr', 'bin', 'openssl.exe'),
    ]);
  });

  it('is a fresh key and certificate for docs.example.test', async () => {
    const { key, cert } = await testTlsCertificate();
    expect(String(key)).toContain('PRIVATE KEY');
    expect(String(cert)).toContain('BEGIN CERTIFICATE');
  }, 30_000);
});
