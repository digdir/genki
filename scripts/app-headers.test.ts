import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const headersFor = (env: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'genki-headers-'));
  dirs.push(dir);
  for (const sub of ['tmp', 'etc-nginx/conf.d', 'etc-genki'])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'etc-nginx/genki-headers.conf'), read('docker/apps/headers.conf'));
  writeFileSync(
    join(dir, 'etc-genki/default.conf.template'),
    read('docker/apps/default.conf.template'),
  );
  const script = read('docker/apps/30-genki-config.sh')
    .replaceAll('/tmp/genki', join(dir, 'tmp'))
    .replaceAll('/etc/nginx', join(dir, 'etc-nginx'))
    .replaceAll('/etc/genki', join(dir, 'etc-genki'));
  writeFileSync(join(dir, 'config.sh'), script);
  execFileSync('sh', [join(dir, 'config.sh')], {
    env: {
      PATH: process.env.PATH ?? '',
      APP: 'assistant',
      API_UPSTREAM: 'https://api.example.test',
      ...env,
    },
  });
  return readFileSync(join(dir, 'tmp/headers.conf'), 'utf8');
};

const bffFor = (env: Record<string, string>) => {
  headersFor(env);
  const dir = dirs.at(-1) ?? '';
  return {
    auth: readFileSync(join(dir, 'tmp/bff.conf'), 'utf8'),
    api: readFileSync(join(dir, 'tmp/bff-api.conf'), 'utf8'),
  };
};

const frameSrc = (headers: string) => /frame-src ([^;]*);/.exec(headers)?.[1];

describe.skipIf(process.platform === 'win32')('the app headers', () => {
  it('lets the apps frame the block origin when one is set, and nothing more', () => {
    expect(frameSrc(headersFor({}))).toBe("'self'");
    expect(frameSrc(headersFor({ GENAI_BLOCK_ORIGIN: 'https://blocks.example.test' }))).toBe(
      "'self' https://blocks.example.test",
    );
    expect(frameSrc(headersFor({ GENAI_BLOCK_ORIGIN: 'http://blocks.example.test' }))).toBe(
      "'self'",
    );
  });

  it('never lets the apps load scripts from or call the block origin', () => {
    const headers = headersFor({ GENAI_BLOCK_ORIGIN: 'https://blocks.example.test' });

    expect(/script-src ([^;]*);/.exec(headers)?.[1]).toBe("'self'");
    expect(/connect-src ([^;]*);/.exec(headers)?.[1]).toBe("'self'");
  });

  it('lets the apps play videos from blob URLs', () => {
    const headers = headersFor({});

    expect(/media-src ([^;]*);/.exec(headers)?.[1]).toBe("'self' blob:");
  });

  it.each(['portal', 'workspace', 'console'])(
    'the %s sends /auth/ and /api/ through the BFF with its hostname and the proxy key',
    (app) => {
      const key = 'p'.repeat(40);
      const { auth, api } = bffFor({ APP: app, GENAI_PROXY_KEY: key });
      expect(auth).toContain('location /auth/ {');
      expect(auth).toContain('proxy_pass https://genki_api/bff$request_uri;');
      expect(auth).toContain('access_log off;');
      expect(api).toContain('proxy_set_header X-Forwarded-Host $host;');
      expect(api).toContain(`proxy_set_header GenAI-Proxy-Key "${key}";`);
      expect(bffFor({ APP: app }).auth).toBe('');
    },
  );

  it('maps each old hostname in GENAI_REDIRECT_HOSTS to its new one, and nothing without it', () => {
    headersFor({
      APP: 'portal',
      GENAI_REDIRECT_HOSTS:
        'portal.genki-test.digdir.cloud=portal.genki.digdir.cloud,a.example.test=b.example.test',
    });
    const dir = dirs.at(-1) ?? '';
    expect(readFileSync(join(dir, 'tmp/redirects.conf'), 'utf8')).toBe(
      'portal.genki-test.digdir.cloud portal.genki.digdir.cloud;\na.example.test b.example.test;\n',
    );
    headersFor({ APP: 'portal' });
    expect(readFileSync(join(dirs.at(-1) ?? '', 'tmp/redirects.conf'), 'utf8')).toBe('');
  });

  it.each(['a.test=b.test;return 200', 'A.test=b.test', 'a.test', 'a.test=', '=b.test', 'a=b=c'])(
    'refuses to start with the redirect %s',
    (pair) => {
      expect(() => headersFor({ APP: 'portal', GENAI_REDIRECT_HOSTS: pair })).toThrow();
    },
  );

  it('answers 301 from an old hostname with path and query, but never on /healthz', () => {
    const conf = read('docker/apps/default.conf.template');
    expect(conf).toContain('return 301 https://$genki_moved_to$request_uri;');
    expect(conf).toMatch(
      /map \$uri \$genki_moved_to \{\s*\/healthz "";\s*default \$genki_moved_host;/,
    );
  });
});
