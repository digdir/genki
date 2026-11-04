import { describe, expect, it } from 'vitest';
import type { Principal, Usage } from '@genai/contracts';
import {
  createGate,
  decodeBase64,
  GateError,
  isMediaRef,
  mediaAttachments,
  mediaOutputPolicy,
  mediaOutputRules,
  mediaPart,
  mediaRefsIn,
  walk,
  type GatePayload,
  type GateRecord,
  type GateTarget,
  type MediaOutput,
  type PortContext,
} from './index.js';
import { media, object, plain, text } from './payload.js';

const tenant = '999888777';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const bytes = Uint8Array.from({ length: 40 }, (_, i) => i);
const encoded = btoa(String.fromCharCode(...bytes));

const target: GateTarget = {
  port: 'described',
  operation: 'draw',
  model: { kind: 'model', id: 'lab/small' },
  endpoint: 'lab',
  residency: 'norway',
  admission: 'open',
};

const payload: GatePayload<unknown> = {
  shape: { request: object({ prompt: text }), result: object({ picture: media('image/png') }) },
  usage: () => ({ requests: 1 }),
};

const setup = (
  config = { types: [{ type: 'image/*', maxBytes: 64 }, { type: 'application/pdf' }], maxBytes: 8 },
) => {
  const kept: { body: Uint8Array; mediaType: string }[] = [];
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const output: MediaOutput = mediaOutputPolicy(config, async (ctx, body, mediaType) => {
    kept.push({ body, mediaType });
    return { tenant: ctx.tenant, path: `runs/${ctx.task}/media/m${kept.length}`, sha256: 'ab' };
  });
  const ctx: PortContext = {
    tenant,
    principal: kari,
    task: 't1',
    signal: new AbortController().signal,
    meter: async (usage) => {
      metered.push(usage);
    },
    audit: async (record) => {
      audit.push(record);
    },
  };
  return { gate: createGate({ media: output }), ctx, kept, audit, metered };
};

describe('media output in the gate', () => {
  it('media output is counted in bytes and kept as a blob reference, not inline', async () => {
    const { gate, ctx, kept, audit } = setup();
    const result = await gate.call(ctx, target, payload, { prompt: 'en sirkel' }, async () => ({
      picture: encoded,
    }));
    expect(result).toEqual({
      picture: {
        kind: 'media',
        mediaType: 'image/png',
        bytes: 40,
        sha256: 'ab',
        tenant,
        path: 'runs/t1/media/m1',
      },
    });
    expect(JSON.stringify(result)).not.toContain(encoded);
    expect(kept).toEqual([{ body: bytes, mediaType: 'image/png' }]);
    expect(audit).toEqual([expect.objectContaining({ outcome: 'ok', mediaBytes: 40 })]);
  });

  it('media output over its cap is refused, not truncated, and still metered', async () => {
    const { gate, ctx, kept, audit, metered } = setup({
      types: [{ type: 'image/png', maxBytes: 39 }],
      maxBytes: 1000,
    });
    await expect(
      gate.call(ctx, target, payload, { prompt: 'en sirkel' }, async () => ({ picture: encoded })),
    ).rejects.toThrow(GateError);
    expect(kept).toEqual([]);
    expect(metered).toEqual([{ requests: 1 }]);
    expect(audit).toEqual([
      expect.objectContaining({ outcome: 'refused', refusal: 'media', mediaBytes: 40 }),
    ]);
  });

  it('a media type the environment does not allow is refused before anything is sent', async () => {
    const { gate, ctx, audit } = setup({ types: [{ type: 'audio/*' }], maxBytes: 1000 });
    let sent = false;
    await expect(
      gate.call(ctx, target, payload, { prompt: 'en sirkel' }, async () => {
        sent = true;
        return { picture: encoded };
      }),
    ).rejects.toThrow('keeps no image/png output');
    expect(sent).toBe(false);
    expect(audit).toEqual([expect.objectContaining({ outcome: 'refused', refusal: 'media' })]);
  });

  it('a gate without a media store refuses media output', async () => {
    const { ctx } = setup();
    await expect(
      createGate().call(ctx, target, payload, { prompt: 'x' }, async () => ({ picture: encoded })),
    ).rejects.toThrow('keeps no image/png output');
  });

  it('media output that is not base64 is outside the shape', async () => {
    const { gate, ctx } = setup();
    await expect(
      gate.call(ctx, target, payload, { prompt: 'x' }, async () => ({ picture: 'not base64!' })),
    ).rejects.toThrow('must be base64 encoded image/png');
  });

  it('media in a request is refused as media input', () => {
    const walked = walk(
      object({ picture: media('image/png') }),
      { picture: encoded },
      {
        side: 'request',
      },
    );
    expect(walked.media).toEqual(['picture']);
  });

  it('a result walked again keeps its media references', () => {
    const shape = object({ picture: media('image/png'), note: plain() });
    const first = walk(shape, { picture: encoded, note: 'x' }, { side: 'result', keepMedia: true });
    const again = walk(shape, first.value, { side: 'result' });
    expect(again.problems).toEqual([]);
    expect(again.value).toEqual(first.value);
  });
});

describe('media output configuration', () => {
  it('the cap is per media type, the most specific rule first, with one default', () => {
    const policy = mediaOutputPolicy(
      {
        types: mediaOutputRules('image/*=100, image/png=50, audio/wav, application/pdf=2000'),
        maxBytes: 10,
      },
      async () => ({ tenant, path: 'p', sha256: '' }),
    );
    expect(
      ['image/png', 'image/jpeg', 'audio/wav', 'application/pdf'].map(policy.maxBytes),
    ).toEqual([50, 100, 10, 2000]);
    expect(['image/webp', 'audio/wav', 'video/mp4', 'text/csv'].map(policy.allows)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('a media type rule that is not a media type is refused', () => {
    expect(() => mediaOutputRules('image')).toThrow('not a media type');
    expect(() => mediaOutputRules('image/*=big')).toThrow('whole number of bytes');
  });
});

describe('media references', () => {
  it('a reference becomes a blob part of the result and an attachment again', () => {
    const ref = {
      kind: 'media' as const,
      mediaType: 'audio/wav',
      bytes: 3,
      sha256: 'cd',
      tenant,
      path: 'runs/t1/media/m9',
      step: 'tale',
    };
    expect(isMediaRef(ref)).toBe(true);
    expect(mediaRefsIn({ a: [ref, { b: ref }] })).toEqual([ref]);
    expect(mediaAttachments([mediaPart(ref)])).toEqual([
      {
        id: 'm9',
        mediaType: 'audio/wav',
        bytes: 3,
        sha256: 'cd',
        tenant,
        path: ref.path,
        step: 'tale',
      },
    ]);
  });

  it('decodes base64 and base64url, and nothing else', () => {
    expect(decodeBase64(encoded)).toEqual(bytes);
    expect(
      decodeBase64(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')),
    ).toEqual(bytes);
    expect(decodeBase64('ikke base64!')).toBeUndefined();
  });
});
