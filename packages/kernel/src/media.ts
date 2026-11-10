import type { Part } from '@genai/contracts';
import type { PortContext } from './spi.js';

export const mediaRefKind = 'media';

export interface MediaRef {
  kind: typeof mediaRefKind;
  mediaType: string;
  bytes: number;
  sha256: string;
  tenant: string;
  path: string;
  step?: string;
}

export interface KeptMedia {
  tenant: string;
  path: string;
  sha256: string;
}

export interface MediaOutputRule {
  type: string;
  maxBytes?: number;
}

export interface MediaOutputConfig {
  types: readonly MediaOutputRule[];
  maxBytes: number;
}

export interface MediaOutput {
  allows(mediaType: string): boolean;
  maxBytes(mediaType: string): number;
  keep(ctx: PortContext, body: Uint8Array, mediaType: string): Promise<KeptMedia>;
}

export const defaultMediaOutputMaxBytes = 10 * 1024 * 1024;

export const mediaTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const rulePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/;

const ruleMatches = (rule: string, mediaType: string) =>
  rule === mediaType || (rule.endsWith('/*') && mediaType.startsWith(rule.slice(0, -1)));

const ruleFor = (config: MediaOutputConfig, mediaType: string) =>
  config.types.find((r) => r.type === mediaType) ??
  config.types.find((r) => ruleMatches(r.type, mediaType));

export const mediaOutputPolicy = (
  config: MediaOutputConfig,
  keep: MediaOutput['keep'],
): MediaOutput => ({
  allows: (mediaType) => ruleFor(config, mediaType) !== undefined,
  maxBytes: (mediaType) => ruleFor(config, mediaType)?.maxBytes ?? config.maxBytes,
  keep,
});

/** Reads `type[=bytes]` entries, comma separated, such as `image/*=10485760,application/pdf`. */
export const mediaOutputRules = (text: string): MediaOutputRule[] =>
  text
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const [type = '', cap] = entry.split('=').map((s) => s.trim());
      if (!rulePattern.test(type)) throw new Error(`not a media type: ${type}`);
      if (cap === undefined) return { type };
      const maxBytes = Number(cap);
      if (!Number.isInteger(maxBytes) || maxBytes <= 0)
        throw new Error(`the cap for ${type} must be a whole number of bytes`);
      return { type, maxBytes };
    });

export const isMediaRef = (value: unknown): value is MediaRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === mediaRefKind &&
    typeof v.mediaType === 'string' &&
    typeof v.bytes === 'number' &&
    typeof v.sha256 === 'string' &&
    typeof v.tenant === 'string' &&
    typeof v.path === 'string'
  );
};

export const mediaRefsIn = (value: unknown): MediaRef[] => {
  const found = new Map<string, MediaRef>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 64 || typeof v !== 'object' || v === null) return;
    if (isMediaRef(v)) {
      const key = `${v.tenant}/${v.path}`;
      if (!found.has(key)) found.set(key, v);
      return;
    }
    for (const item of Array.isArray(v) ? v : Object.values(v)) visit(item, depth + 1);
  };
  visit(value, 0);
  return [...found.values()];
};

export const mediaIdOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const mediaPart = (ref: MediaRef): Part => ({
  mime: ref.mediaType,
  body: { kind: 'blob', ref: { kind: mediaRefKind, id: ref.path, tenant: ref.tenant } },
  meta: {
    bytes: ref.bytes,
    sha256: ref.sha256,
    ...(ref.step ? { step: ref.step } : {}),
  },
});

export interface MediaAttachment {
  id: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  tenant: string;
  path: string;
  step?: string;
}

export const mediaAttachments = (parts: readonly Part[]): MediaAttachment[] =>
  parts.flatMap((p) => {
    if (p.body.kind !== 'blob' || p.body.ref.kind !== mediaRefKind || !p.body.ref.tenant) return [];
    const meta = p.meta ?? {};
    return [
      {
        id: mediaIdOf(p.body.ref.id),
        mediaType: p.mime,
        bytes: typeof meta.bytes === 'number' ? meta.bytes : 0,
        sha256: typeof meta.sha256 === 'string' ? meta.sha256 : '',
        tenant: p.body.ref.tenant,
        path: p.body.ref.id,
        ...(typeof meta.step === 'string' ? { step: meta.step } : {}),
      },
    ];
  });

const base64Text = /^[A-Za-z0-9+/_-]*={0,2}$/;

export const decodeBase64 = (text: string): Uint8Array | undefined => {
  const compact = text.replace(/\s+/g, '');
  if (!base64Text.test(compact)) return undefined;
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
};

export const mediaInputKind = 'media-input';

/** Media input the gate has admitted and read: its bytes, ready for the executor to encode. */
export interface MediaInput {
  kind: typeof mediaInputKind;
  mediaType: string;
  bytes: number;
  sha256: string;
  body: Uint8Array;
}

/** Media given inline in an input: a media type and its base64 data. */
export interface InlineMedia {
  mediaType: string;
  data: string;
}

export interface MediaInputSource {
  read(ctx: PortContext, ref: MediaRef): Promise<Uint8Array | undefined>;
}

export const isMediaInput = (value: unknown): value is MediaInput =>
  typeof value === 'object' &&
  value !== null &&
  (value as { kind?: unknown }).kind === mediaInputKind &&
  (value as { body?: unknown }).body instanceof Uint8Array;

export const isInlineMedia = (value: unknown): value is InlineMedia => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 2 && typeof v.mediaType === 'string' && typeof v.data === 'string'
  );
};

/** Whether a media type rule (`type/subtype` or `type/*`) covers a media type, which may itself be `type/*`. */
export const mediaTypeCovers = (rule: string, mediaType: string) =>
  rule === mediaType ||
  (rule.endsWith('/*') && !mediaType.endsWith('/*') && mediaType.startsWith(rule.slice(0, -1)));

export const sha256Hex = async (body: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', body as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const encodeBase64 = (body: Uint8Array) => Buffer.from(body).toString('base64');
