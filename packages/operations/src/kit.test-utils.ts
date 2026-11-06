import type { Usage } from '@genai/contracts';
import {
  createGate,
  type GateRecord,
  type MediaRef,
  type PayloadGuard,
  type PortContext,
} from '@genai/kernel';
import { parseDescriptor, type Descriptor } from './descriptor.js';
import { describedCall, type DescribedEndpoint, type WireExchange } from './executor.js';

export const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const wav = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

export interface Reply {
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  body: unknown;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({
  status,
  body,
  headers,
});

export const call = async (
  descriptor: Descriptor,
  input: unknown,
  replies: Reply[],
  options: {
    synthetic?: boolean;
    unmaskedMedia?: string[];
    readMedia?: (ref: MediaRef) => Uint8Array | undefined;
    guards?: PayloadGuard[];
    endpoint?: Partial<DescribedEndpoint>;
    deployment?: string;
  } = {},
) => {
  const sent: { url: URL; init: RequestInit | undefined }[] = [];
  const slept: number[] = [];
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const exchanges: WireExchange[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    sent.push({ url: new URL(String(url)), init });
    const reply = replies[sent.length - 1];
    if (!reply) return Response.json({ error: { message: 'no more replies' } }, { status: 500 });
    const type = reply.type ?? 'application/json';
    const body =
      type === 'application/json' ? JSON.stringify(reply.body) : (reply.body as BodyInit);
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': type, ...reply.headers },
    });
  };
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'operator', issuer: 'test', subject: 'ola' },
    task: 't1',
    signal: new AbortController().signal,
    meter: async (usage) => {
      metered.push(usage);
    },
    audit: async (record) => {
      audit.push(record);
    },
    ...(options.unmaskedMedia ? { unmaskedMedia: options.unmaskedMedia } : {}),
    ...(options.guards ? { guards: options.guards } : {}),
  };
  const outcome = await describedCall(
    {
      gate: createGate({
        media: {
          allows: () => true,
          maxBytes: () => 1_000_000,
          keep: async (c) => ({ tenant: c.tenant, path: 'kept/1', sha256: 'abc' }),
        },
        ...(options.readMedia
          ? { mediaInput: { read: async (_c, ref) => options.readMedia?.(ref) } }
          : {}),
      }),
      ctx,
      target: {
        port: 'described',
        operation: descriptor.operation,
        model: { kind: 'model', id: 'lab/model' },
        endpoint: 'lab',
        residency: 'norway',
        admission: 'open',
        ...(options.synthetic === false ? {} : { synthetic: true }),
      },
      descriptor,
      endpoint: {
        baseURL: 'https://provider.example.test/base',
        credential: { kind: 'api-key', key: async () => 'connection-key' },
        fetch: fetcher,
        sleep: async (ms) => {
          slept.push(ms);
        },
        ...options.endpoint,
      },
      deployment: options.deployment ?? 'model-1',
      observe: (e) => exchanges.push(e),
    },
    input,
  ).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { outcome, sent, slept, audit, metered, exchanges };
};

export const refused = (yaml: string) => {
  try {
    parseDescriptor(yaml);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};
