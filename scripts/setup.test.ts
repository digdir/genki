import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureEnvFile,
  fillEnv,
  knowledgeSetupWanted,
  localDatabaseUrl,
  localModelUrl,
  nodeProblem,
  repoRoot,
} from './setup.ts';

const dirs: string[] = [];
const tempRoot = (example = readFileSync(join(repoRoot, '.env.example'), 'utf8')) => {
  const dir = mkdtempSync(join(tmpdir(), 'genai-setup-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.env.example'), example);
  return dir;
};
const counter = () => {
  let n = 0;
  return (size: number) => Buffer.alloc(size, ++n);
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('setup env file', () => {
  it('creates .env.local from .env.example with the local database and generated keys', () => {
    const root = tempRoot();
    const result = ensureEnvFile(root, counter());
    expect(result.created).toBe(true);
    const env = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
    expect(env.DATABASE_URL).toBe(localDatabaseUrl);
    expect(Buffer.from(env.CONTENT_MASTER_KEY ?? '', 'base64')).toHaveLength(32);
    expect(env.DEV_API_KEY).toMatch(/^dev-[\w-]{32}$/);
    expect(env.DEV_SERVICE_API_KEY).toMatch(/^dev-service-[\w-]{32}$/);
    expect(env.DEV_API_KEY).not.toBe(env.DEV_SERVICE_API_KEY);
    expect(env.LOCAL_MODEL_URL).toBe(localModelUrl);
    expect(env.FOUNDRY_OPENAI_KEY).toBe('');
  });

  it('turns on dev mode in the .env.local it creates', () => {
    const root = tempRoot();
    ensureEnvFile(root, counter());
    expect(parseEnv(readFileSync(join(root, '.env.local'), 'utf8')).GENAI_DEV_MODE).toBe('true');
  });

  it('points .env.local at the Postgres and model ports given in GENAI_POSTGRES_PORT and GENAI_MODEL_PORT', () => {
    const root = tempRoot();
    ensureEnvFile(root, counter(), { GENAI_POSTGRES_PORT: '8110', GENAI_MODEL_PORT: '8104' });
    const env = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
    expect(env.DATABASE_URL).toBe('postgres://genai:genai-local-only@127.0.0.1:8110/genai');
    expect(env.LOCAL_MODEL_URL).toBe('http://127.0.0.1:8104/v1');
  });

  it('publishes Postgres on the host port GENAI_POSTGRES_PORT names, 55432 by default', () => {
    const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
    expect(compose).toContain("'127.0.0.1:${GENAI_POSTGRES_PORT:-55432}:5432'");
  });

  it('keeps every other line of .env.example', () => {
    const root = tempRoot();
    ensureEnvFile(root, counter());
    const example = readFileSync(join(root, '.env.example'), 'utf8').split('\n');
    const written = readFileSync(join(root, '.env.local'), 'utf8').split('\n');
    expect(written).toHaveLength(example.length);
    const changed = written.filter((line, i) => line !== example[i]);
    expect(changed.map((line) => line.split('=')[0]).sort()).toEqual([
      'CONTENT_MASTER_KEY',
      'DATABASE_URL',
      'DEV_API_KEY',
      'DEV_SERVICE_API_KEY',
      'GENAI_DEV_MODE',
      'KNOWLEDGE_API_PASSWORD',
      'KNOWLEDGE_DATABASE_URL',
      'KNOWLEDGE_WORKER_PASSWORD',
      'LOCAL_MODEL_KEY',
      'LOCAL_MODEL_URL',
    ]);
  });

  it('writes .env.local readable by the owner only', () => {
    const root = tempRoot();
    ensureEnvFile(root, counter());
    expect(statSync(join(root, '.env.local')).mode & 0o077).toBe(0);
  });

  it('never overwrites an existing .env.local and names the settings it lacks', () => {
    const root = tempRoot();
    writeFileSync(join(root, '.env.local'), 'DATABASE_URL=postgres://mine\nDEV_API_KEY=\n');
    const result = ensureEnvFile(root, counter());
    expect(result.created).toBe(false);
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toMatch(
      /^DATABASE_URL=postgres:\/\/mine\nDEV_API_KEY=\n/,
    );
    expect(result.missing).toEqual([
      'GENAI_DEV_MODE',
      'CONTENT_MASTER_KEY',
      'DEV_API_KEY',
      'DEV_SERVICE_API_KEY',
      'LOCAL_MODEL_URL',
      'LOCAL_MODEL_KEY',
    ]);
  });

  it('setup adds the missing local knowledge settings and keeps the ones already set', () => {
    const root = tempRoot();
    const mine =
      'DATABASE_URL=postgres://mine\nKNOWLEDGE_API_PASSWORD=kept\nKNOWLEDGE_DATABASE_URL=\n';
    writeFileSync(join(root, '.env.local'), mine);
    const result = ensureEnvFile(root, counter(), { GENAI_KNOWLEDGE_PORT: '8111' });
    const text = readFileSync(join(root, '.env.local'), 'utf8');
    expect(text.startsWith(mine)).toBe(true);
    const env = parseEnv(text);
    expect(env.KNOWLEDGE_DATABASE_URL).toBe('');
    expect(env.KNOWLEDGE_API_PASSWORD).toBe('kept');
    expect(env.KNOWLEDGE_WORKER_PASSWORD).toMatch(/^[\w-]{32}$/);
    expect(result.missing).not.toContain('KNOWLEDGE_WORKER_PASSWORD');
    ensureEnvFile(root);
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(text);
  });

  it('setup leaves the knowledge server out when KNOWLEDGE_DATABASE_URL is empty', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, '.env.local'),
      'DATABASE_URL=postgres://mine\nKNOWLEDGE_DATABASE_URL=\n',
    );
    ensureEnvFile(root, counter());
    expect(knowledgeSetupWanted(root)).toBe(false);
    writeFileSync(
      join(root, '.env.local'),
      'KNOWLEDGE_DATABASE_URL=postgres://127.0.0.1:55433/genai_knowledge\n',
    );
    expect(knowledgeSetupWanted(root)).toBe(true);
  });

  it('is idempotent: a second run keeps the keys from the first', () => {
    const root = tempRoot();
    ensureEnvFile(root);
    const first = readFileSync(join(root, '.env.local'), 'utf8');
    expect(ensureEnvFile(root)).toMatchObject({ created: false, missing: [] });
    expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(first);
  });

  it('fills commented-out settings and appends ones the template lacks', () => {
    expect(fillEnv('# A=\nB=old\n', { A: '1', B: '2', C: '3' })).toBe('A=1\nB=2\nC=3\n');
  });

  it('writes values with dollar signs literally', () => {
    expect(fillEnv('A=\n', { A: 'x$&y' })).toBe('A=x$&y\n');
  });
});

describe('setup node check', () => {
  it('refuses Node older than 24 and warns when the pin differs', () => {
    expect(nodeProblem('22.23.2', '24.21.0')).toMatch(/too old/);
    expect(nodeProblem('24.1.0', '24.21.0')).toMatch(/pins 24.21.0/);
    expect(nodeProblem('24.21.0', '24.21.0')).toBeUndefined();
  });
});
