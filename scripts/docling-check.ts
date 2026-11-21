// Checks the environment's Docling server from where the worker runs (ADR 0042, issue 476). In Azure:
//   az containerapp exec -g <resource group> -n genai-<env>-worker --command "node scripts/docling-check.ts <PDF URL>"
// It converts one PDF the way knowledge.convert does (Tesseract `nor`, TableFormer accurate, on the async route,
// polled every 30 s on one connection), then sends the same request without the key, which the server must refuse with 401. Reads DOCLING_URL and
// DOCLING_API_KEY; prints one JSON line per step, never the key or the converted text.
import { request, Agent } from 'node:http';
import { readFile } from 'node:fs/promises';

const usage = 'node scripts/docling-check.ts <PDF URL or path>';

// One connection for the whole conversion: the task lives on the replica that took it, and the ingress picks a
// replica per connection. Polled every 30 s, so it is never idle for the ingress's 300 s (issue 906).
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const pollMs = 30_000;

export const conversionForm = (pdf: Uint8Array, name: string) => {
  const form = new FormData();
  form.append('files', new Blob([pdf], { type: 'application/pdf' }), name);
  form.append('to_formats', 'json');
  form.append('ocr_preset', 'tesseract');
  form.append('ocr_lang', 'nor');
  form.append('table_mode', 'accurate');
  form.append('image_export_mode', 'placeholder');
  return form;
};

const call = async (
  base: string,
  path: string,
  key: string | undefined,
  form?: FormData,
): Promise<{ status: number; json: unknown }> => {
  const encoded = form ? new Response(form) : undefined;
  const body = encoded ? Buffer.from(await encoded.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, base),
      {
        method: form ? 'POST' : 'GET',
        agent,
        headers: {
          ...(encoded
            ? {
                'content-type': encoded.headers.get('content-type') ?? '',
                'content-length': body?.length ?? 0,
              }
            : {}),
          ...(key ? { 'x-api-key': key } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
};

/** Submits the file, polls its task and fetches the result, as the worker's client does. */
const post = async (base: string, form: FormData, key: string | undefined) => {
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  try {
    const submitted = await call(base, '/v1/convert/file/async', key, form);
    const id = (submitted.json as { task_id?: unknown } | undefined)?.task_id;
    if (submitted.status !== 200 || typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id))
      return { status: submitted.status, seconds: seconds(), json: submitted.json };
    for (;;) {
      const polled = await call(base, `/v1/status/poll/${id}`, key);
      const status = (polled.json as { task_status?: unknown } | undefined)?.task_status;
      if (polled.status !== 200)
        return { status: polled.status, seconds: seconds(), json: polled.json };
      if (status !== 'pending' && status !== 'started') break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const result = await call(base, `/v1/result/${id}`, key);
    return { ...result, seconds: seconds() };
  } catch (error) {
    throw Object.assign(error as Error, { seconds: seconds() });
  }
};

interface Converted {
  status?: string;
  processing_time?: number;
  errors?: unknown[];
  document?: { json_content?: { pages?: Record<string, unknown>; texts?: { text?: string }[] } };
}

const main = async () => {
  const source = process.argv[2];
  const base = process.env.DOCLING_URL;
  const key = process.env.DOCLING_API_KEY;
  if (!source || !base || !key) {
    console.error(`${usage}\nNeeds DOCLING_URL and DOCLING_API_KEY, as the worker has them.`);
    process.exit(2);
  }
  const pdf = /^https?:\/\//.test(source)
    ? new Uint8Array(await (await fetch(source)).arrayBuffer())
    : new Uint8Array(await readFile(source));
  const name = 'check.pdf';

  const converted = await post(base, conversionForm(pdf, name), key);
  const result = (converted.json ?? {}) as Converted;
  const doc = result.document?.json_content;
  console.log(
    JSON.stringify({
      step: 'convert',
      http: converted.status,
      seconds: converted.seconds,
      status: result.status,
      processingSeconds: result.processing_time,
      pages: doc?.pages ? Object.keys(doc.pages).length : undefined,
      textItems: doc?.texts?.length,
      characters: doc?.texts?.reduce((n, t) => n + (t.text?.length ?? 0), 0),
      errors: result.errors?.length ?? 0,
    }),
  );

  const refused = await post(base, conversionForm(pdf, name), undefined);
  console.log(
    JSON.stringify({ step: 'without key', http: refused.status, refused: refused.status === 401 }),
  );
  agent.destroy();
  if (converted.status !== 200 || result.status !== 'success' || refused.status !== 401)
    process.exit(1);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: Error & { seconds?: number; code?: string }) => {
    console.log(
      JSON.stringify({
        step: 'error',
        code: error.code,
        message: error.message,
        seconds: error.seconds,
      }),
    );
    process.exit(1);
  });
}
