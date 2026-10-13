import type { Part } from '@genai/contracts';
import { BlobError, type BlobInfo, type BlobKey, type BlobStore } from './blob.js';
import { storeZip } from './zip.js';

export const blobRefKind = 'blob';

export const blobPart = (info: BlobInfo): Part => ({
  mime: info.contentType,
  body: { kind: 'blob', ref: { kind: blobRefKind, id: info.path, tenant: info.tenant } },
  meta: {
    sha256: info.sha256,
    size: info.size,
    name: info.path.slice(info.path.lastIndexOf('/') + 1),
  },
});

export const blobKeyOf = (part: Part): BlobKey | undefined =>
  part.body.kind === 'blob' && part.body.ref.kind === blobRefKind && part.body.ref.tenant
    ? { tenant: part.body.ref.tenant, path: part.body.ref.id }
    : undefined;

const decoder = new TextDecoder('utf-8', { fatal: true });

export const partText = async (
  store: BlobStore,
  part: Part,
  tenant: string,
): Promise<string | undefined> => {
  if (part.body.kind === 'text') return part.body.text;
  if (part.body.kind === 'json') return JSON.stringify(part.body.json);
  const key = blobKeyOf(part);
  if (!key) return undefined;
  if (key.tenant !== tenant) throw new BlobError('forbidden', 'a blob part from another tenant');
  if (!part.mime.startsWith('text/') && part.mime !== 'application/json') return undefined;
  const found = await store.get(key);
  if (!found) throw new BlobError('not_found', `no blob ${key.path}`);
  return decoder.decode(found.body);
};

const encoder = new TextEncoder();

export const writeArtifact = async (
  store: BlobStore,
  key: BlobKey,
  body: Uint8Array | string,
  contentType: string,
): Promise<Part> =>
  blobPart(
    await store.put(key, typeof body === 'string' ? encoder.encode(body) : body, contentType),
  );

export const jsonArtifact = (store: BlobStore, key: BlobKey, value: unknown) =>
  writeArtifact(store, key, `${JSON.stringify(value, null, 2)}\n`, 'application/json');

export const textArtifact = (store: BlobStore, key: BlobKey, text: string) =>
  writeArtifact(store, key, text, 'text/plain; charset=utf-8');

export const markdownArtifact = (store: BlobStore, key: BlobKey, markdown: string) =>
  writeArtifact(store, key, markdown, 'text/markdown; charset=utf-8');

const xmlEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const docxBytes = (paragraphs: string[]): Uint8Array => {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('');
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ];
  return storeZip(files.map(([name, xml]) => ({ name, data: encoder.encode(xml) })));
};

export const docxArtifact = (store: BlobStore, key: BlobKey, paragraphs: string[]) =>
  writeArtifact(
    store,
    key,
    docxBytes(paragraphs),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );

export const readablePart = (info: BlobInfo, body?: Uint8Array): Part => {
  if (body && (info.contentType.startsWith('text/') || info.contentType === 'application/json')) {
    return {
      mime: info.contentType.split(';')[0] ?? 'text/plain',
      body: { kind: 'text', text: new TextDecoder().decode(body) },
      meta: {
        name: info.path.slice(info.path.lastIndexOf('/') + 1),
        path: info.path,
        sha256: info.sha256,
      },
    };
  }
  return blobPart(info);
};
