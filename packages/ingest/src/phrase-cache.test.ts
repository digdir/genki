import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ChatResult, ModelPort } from '@genai/port-model';
import {
  blobPhraseCache,
  defaultSearchPhrasesPrompt,
  generatePhrases,
  legacyPhraseCacheKey,
  loadPhraseArchive,
  memoryPhraseCache,
  phraseCacheKey,
  readDeclaredIdentity,
  type DeclaredPhraseArchive,
} from './index.js';

const reply = (content: string, finishReason: ChatResult['finishReason'] = 'stop'): ChatResult => ({
  content,
  toolCalls: [],
  finishReason,
  usage: {},
  servedModel: 'stub',
});

const model = (answer: () => ChatResult, calls: string[] = []): ModelPort => ({
  info: () => ({ id: 'stub', residency: 'norway', capabilities: [] }),
  chat: async (request) => {
    calls.push(request.messages[0]?.content ?? '');
    return answer();
  },
  chatStream: async function* () {
    yield* [];
  },
});

const gpt4o = { provider: 'azure', model: 'gpt-4o' };

describe('search phrase cache', () => {
  it('keys entries like headless-rag: content, provider, model and prompt hashes plus the parser version', () => {
    const key = phraseCacheKey('Tekst', gpt4o, defaultSearchPhrasesPrompt);
    const legacy = legacyPhraseCacheKey('Tekst', gpt4o, defaultSearchPhrasesPrompt);

    expect(key.split('-')).toHaveLength(5);
    expect(key.endsWith('-v2')).toBe(true);
    expect(legacy).toMatch(/^[0-9a-f]{12}-a2a69af70d1b-871d369894de-v2$/);
  });

  it('stores phrases in the blob store, so a later ingest of the same chunk reuses them without a model call', async () => {
    const blobs = new InMemoryBlobStore();
    const calls: string[] = [];
    const primary = model(() => reply('{"phrases":["tilskudd kommuner"]}'), calls);
    const options = () => ({
      prompt: defaultSearchPhrasesPrompt,
      identity: { provider: 'platform', model: 'fake/gpt' },
      cache: blobPhraseCache(blobs, '991825827', 'folder-search-phrases'),
    });

    expect(await generatePhrases(primary, 'Tilskudd til kommuner', options())).toEqual([
      'tilskudd kommuner',
    ]);
    expect(await generatePhrases(primary, 'Tilskudd til kommuner', options())).toEqual([
      'tilskudd kommuner',
    ]);
    expect(calls).toHaveLength(1);
    expect((await blobs.list('991825827', 'phrase-cache/folder-search-phrases/'))[0]?.path).toBe(
      `phrase-cache/folder-search-phrases/${phraseCacheKey('Tilskudd til kommuner', { provider: 'platform', model: 'fake/gpt' }, defaultSearchPhrasesPrompt)}.json`,
    );
  });

  it('does not cache an empty answer when the source caches only phrases it found, as headless-rag pipelines do', async () => {
    const calls: string[] = [];
    const empty = model(() => reply('{"phrases":[]}'), calls);
    const cache = memoryPhraseCache();
    const options = { prompt: 'REPLACE_ME', identity: 'm', cache, cacheEmpty: false };

    await generatePhrases(empty, 'x', options);
    await generatePhrases(empty, 'x', options);

    expect(calls).toHaveLength(2);
  });

  it('serves a local positive entry first, then the declared archive, and a local empty entry only after both', async () => {
    const calls: string[] = [];
    const never = model(() => reply('{"phrases":["ny"]}'), calls);
    const archive: DeclaredPhraseArchive = {
      identity: gpt4o,
      entries: new Map([
        [legacyPhraseCacheKey('arkivert', gpt4o, 'P REPLACE_ME'), ['fra arkivet']],
        [legacyPhraseCacheKey('tom', gpt4o, 'P REPLACE_ME'), []],
      ]),
    };
    const cache = memoryPhraseCache();
    const identity = { provider: 'platform', model: 'fake/gpt' };
    await cache.put(phraseCacheKey('arkivert', identity, 'P REPLACE_ME'), []);
    await cache.put(phraseCacheKey('lokal', identity, 'P REPLACE_ME'), ['lokal frase']);
    await cache.put(phraseCacheKey('tom', identity, 'P REPLACE_ME'), []);
    const options = { prompt: 'P REPLACE_ME', identity, cache, declared: archive };

    expect(await generatePhrases(never, 'arkivert', options)).toEqual(['fra arkivet']);
    expect(await generatePhrases(never, 'lokal', options)).toEqual(['lokal frase']);
    expect(await generatePhrases(never, 'tom', options)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('warm phrase archive', () => {
  const identityEdn =
    ';; who generated it\n{:provider :azure\n :model "gpt-4o"\n :generated "2026-09-03"}';
  const edn = (entries: Record<string, string[]>) =>
    gzipSync(
      `{${Object.entries(entries)
        .map(([k, v]) => `${JSON.stringify(k)} [${v.map((p) => JSON.stringify(p)).join(' ')}]`)
        .join(', ')}}`,
    );

  it('loads an archive whose five-segment keys match the declared provider and model', () => {
    const key = phraseCacheKey('Tekst', gpt4o, defaultSearchPhrasesPrompt);
    const loaded = loadPhraseArchive(edn({ [key]: ['frase én', 'frase "to"'] }), identityEdn);

    expect(loaded).toMatchObject({ action: 'loaded', entries: 1, verified: ['provider', 'model'] });
    if (loaded.action === 'loaded')
      expect(loaded.archive.entries.get(key)).toEqual(['frase én', 'frase "to"']);
  });

  it('refuses an archive whose keys another generator produced', () => {
    const key = phraseCacheKey('Tekst', { provider: 'azure', model: 'gpt-5' }, 'p');
    expect(loadPhraseArchive(edn({ [key]: ['a'] }), identityEdn)).toEqual({
      action: 'skipped',
      reason: 'declaration-mismatch',
    });
  });

  it('accepts four-segment keys only from the pinned shipped archive', () => {
    const key = legacyPhraseCacheKey('Tekst', gpt4o, 'p');
    const archive = edn({ [key]: ['a'] });

    expect(loadPhraseArchive(archive, identityEdn)).toEqual({
      action: 'skipped',
      reason: 'four-segment-archive-not-the-shipped-one',
    });
    const pinned = createHash('sha256')
      .update(`{${JSON.stringify(key)} ["a"]}`)
      .digest('hex');
    expect(loadPhraseArchive(archive, identityEdn, pinned)).toMatchObject({
      action: 'loaded',
      verified: ['configured-model'],
    });
  });

  it('refuses a declaration that is a list of identities rather than one', () => {
    expect(() => readDeclaredIdentity('[{:provider :azure :model "gpt-4o"}]')).toThrow(/one map/);
    expect(readDeclaredIdentity(identityEdn)).toEqual(gpt4o);
  });
});
