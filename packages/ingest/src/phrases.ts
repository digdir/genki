import type { BlobStore } from '@genai/port-blob';
import type { ModelPort } from '@genai/port-model';
import { shortHash } from '@genai/valuehash';
import type { Chunk } from './chunk-document.js';
import { phraseId } from './ids.js';
import { clojureTrim, isBlank, javaSplit, splitLines } from './text.js';

export const parserVersion = 'v2';

const firstJsonObject = (content: string): unknown => {
  const start = content.search(/\S/);
  if (start < 0 || content[start] !== '{') {
    try {
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  let depth = 0;
  let inString = false;
  for (let i = start; i < content.length; i += 1) {
    const c = content[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(content.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
};

const parseJson = (content: string): string[] | undefined => {
  const parsed = firstJsonObject(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const phrases = (parsed as { phrases?: unknown }).phrases;
  if (!Array.isArray(phrases)) return undefined;
  return phrases
    .filter((p): p is string => typeof p === 'string')
    .map(clojureTrim)
    .filter((p) => !isBlank(p));
};

const metaLine = /^(?:[-*#>`][\s\S]*|\d+[.)][ \t\n\v\f\r][\s\S]*)$/;

const parseHeuristic = (content: string): string[] | undefined => {
  for (const line of splitLines(content).reverse()) {
    const trimmed = clojureTrim(line);
    const commas = [...trimmed].filter((c) => c === ',').length;
    if (commas >= 1 && !metaLine.test(trimmed) && trimmed.length >= 10)
      return javaSplit(trimmed, /,/)
        .map(clojureTrim)
        .filter((p) => !isBlank(p));
  }
  return undefined;
};

export const parsePhrases = (content: string | null | undefined): string[] =>
  parseJson(content ?? '') ?? parseHeuristic(content ?? '') ?? [];

export interface PhraseCache {
  get(key: string): Promise<string[] | undefined>;
  put(key: string, phrases: string[]): Promise<void>;
}

export const memoryPhraseCache = (): PhraseCache => {
  const entries = new Map<string, string[]>();
  return {
    get: async (key) => entries.get(key),
    put: async (key, phrases) => {
      entries.set(key, [...phrases]);
    },
  };
};

export const blobPhraseCache = (
  blobs: Pick<BlobStore, 'get' | 'put'>,
  tenant: string,
  directory: string,
): PhraseCache => {
  const key = (k: string) => ({ tenant, path: `phrase-cache/${directory}/${k}.json` });
  return {
    get: async (k) => {
      const found = await blobs.get(key(k));
      if (!found) return undefined;
      const parsed = JSON.parse(new TextDecoder().decode(found.body)) as unknown;
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    },
    put: async (k, phrases) => {
      await blobs.put(
        key(k),
        new TextEncoder().encode(JSON.stringify(phrases)),
        'application/json',
      );
    },
  };
};

export interface PhraseIdentity {
  provider: string;
  model: string;
}

export interface DeclaredPhraseArchive {
  identity: PhraseIdentity;
  entries: ReadonlyMap<string, string[]>;
}

export interface PhraseGeneration {
  prompt: string;
  identity: string | PhraseIdentity;
  cache: PhraseCache;
  fallback?: ModelPort;
  cacheEmpty?: boolean;
  declared?: DeclaredPhraseArchive;
}

const identityOf = (identity: string | PhraseIdentity): PhraseIdentity =>
  typeof identity === 'string' ? { provider: 'platform', model: identity } : identity;

export const phraseIdentitySegments = (identity: PhraseIdentity) => [
  shortHash(identity.provider),
  shortHash(identity.model),
];

export const phraseCacheKey = (
  content: string,
  identity: string | PhraseIdentity,
  prompt: string,
) => {
  const [provider, model] = phraseIdentitySegments(identityOf(identity));
  return `${shortHash(content)}-${provider}-${model}-${shortHash(prompt)}-${parserVersion}`;
};

export const legacyPhraseCacheKey = (content: string, identity: PhraseIdentity, prompt: string) =>
  `${shortHash(content)}-${shortHash(identity.model)}-${shortHash(prompt)}-${parserVersion}`;

const declaredEntry = (
  archive: DeclaredPhraseArchive | undefined,
  content: string,
  prompt: string,
) =>
  archive
    ? [
        phraseCacheKey(content, archive.identity, prompt),
        legacyPhraseCacheKey(content, archive.identity, prompt),
      ]
        .map((k) => archive.entries.get(k))
        .find((entry) => entry !== undefined && entry.length > 0)
    : undefined;

export const generatePhrases = async (
  model: ModelPort,
  content: string,
  options: PhraseGeneration,
): Promise<string[]> => {
  const key = phraseCacheKey(content, options.identity, options.prompt);
  const local = await options.cache.get(key);
  if (local && local.length > 0) return local;
  const declared = declaredEntry(options.declared, content, options.prompt);
  if (declared) return [...declared];
  if (local) return local;
  const ask = async (port: ModelPort) => {
    const result = await port.chat({
      messages: [{ role: 'user', content: options.prompt.replaceAll('REPLACE_ME', content) }],
    });
    return {
      phrases: parsePhrases(result.content),
      settled: result.finishReason === 'stop' && !isBlank(result.content),
    };
  };
  let outcome: { phrases: string[]; settled: boolean };
  try {
    outcome = await ask(model);
  } catch (error) {
    if (!options.fallback) throw error;
    outcome = { phrases: (await ask(options.fallback)).phrases, settled: false };
  }
  const cacheEmpty = options.cacheEmpty ?? true;
  if (outcome.phrases.length > 0 || (cacheEmpty && outcome.settled))
    await options.cache.put(key, outcome.phrases);
  return outcome.phrases;
};

export interface PhraseRow {
  id: string;
  search_phrase: string;
  chunk_id: string;
  doc_num: string;
}

export type ChunkWithPhrases = Chunk & { searchPhrases?: string[] };

export const pipelinePhraseRows = (chunks: ChunkWithPhrases[], docNum: string): PhraseRow[] =>
  chunks.flatMap((chunk) =>
    (chunk.searchPhrases ?? [])
      .filter((p) => typeof p === 'string' && !isBlank(p))
      .map((p) => ({
        id: phraseId(chunk.chunk_id, p),
        search_phrase: p,
        chunk_id: chunk.chunk_id,
        doc_num: docNum,
      })),
  );

export const legacyKudosPhraseRows = (chunks: ChunkWithPhrases[], docNum: string): PhraseRow[] =>
  chunks.flatMap((chunk) =>
    (chunk.searchPhrases ?? []).map((p) => ({
      id: phraseId(chunk.chunk_id, p),
      search_phrase: p,
      chunk_id: chunk.chunk_id,
      doc_num: docNum,
    })),
  );
