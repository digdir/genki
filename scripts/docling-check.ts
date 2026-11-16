// Checks the environment's Docling server from where the worker runs (ADR 0042, issue 476). In Azure:
//   az containerapp exec -g <resource group> -n genai-<env>-worker --command "node scripts/docling-check.ts <PDF URL>"
// It converts one PDF the way knowledge.convert will (Tesseract `nor`, TableFormer accurate, one held request),
// then sends the same request without the key, which the server must refuse with 401. Reads DOCLING_URL and
// DOCLING_API_KEY; prints one JSON line per step, never the key or the converted text.
import { request, Agent } from 'node:http';
import { readFile } from 'node:fs/promises';

const usage = 'node scripts/docling-check.ts <PDF URL or path>';

// One request held open until Docling answers: no header or body timeout, and TCP keepalive probes every 30 s so
// a silent connection is not taken for an idle one while Docling converts.
const agent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

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

const post = async (base: string, form: FormData, key: string | undefined) => {
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const url = new URL('/v1/convert/file', base);
  const started = Date.now();
  return new Promise<{ status: number; seconds: number; json: unknown }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        agent,
        headers: {
          'content-type': encoded.headers.get('content-type') ?? '',
          'content-length': body.length,
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
          resolve({ status: res.statusCode ?? 0, seconds: (Date.now() - started) / 1000, json });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(0);
    req.on('error', (error) =>
      reject(Object.assign(error, { seconds: (Date.now() - started) / 1000 })),
    );
    req.end(body);
  });
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
