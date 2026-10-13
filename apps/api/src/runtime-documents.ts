import { randomUUID } from 'node:crypto';
import type { RuntimeDocumentStore } from '@genai/adapter-openai';
import { attachedMeta } from '@genai/strategy-agent-loop';
import { runDocumentFolder, runDocumentsFolder } from '@genai/jobs';
import { readablePart, type BlobStore } from '@genai/port-blob';

const readableTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export const runtimeDocumentTypes = (spec: unknown): string[] => {
  const s = (spec ?? {}) as {
    knowledge?: { runtimeDocuments?: unknown };
    input?: { accepts?: unknown };
  };
  if (s.knowledge?.runtimeDocuments !== true) return [];
  const accepts = Array.isArray(s.input?.accepts) ? s.input.accepts : [];
  return [
    ...new Set(
      accepts.flatMap((a) => {
        const type = typeof a === 'string' ? (a.split(';')[0]?.trim().toLowerCase() ?? '') : '';
        return readableTypes.has(type) ? [type] : [];
      }),
    ),
  ];
};

const safeName = (name: string) =>
  name
    .slice(name.lastIndexOf('/') + 1)
    .replace(/[^A-Za-z0-9æøåÆØÅ._-]+/g, '_')
    .replace(/^[^A-Za-z0-9æøåÆØÅ]+/, '')
    .slice(0, 120) || 'dokument';

const conversationSegment = (conversation: string) =>
  `conversations/c-${conversation.replace(/[^A-Za-z0-9._-]+/g, '.')}`;

export const deleteConversationDocuments = async (
  blobs: Pick<BlobStore, 'list' | 'delete'>,
  tenant: string,
  conversation: string,
): Promise<number> => {
  const segment = conversationSegment(conversation);
  let deleted = 0;
  for (const blob of await blobs.list(tenant, `${runDocumentsFolder}/`))
    if (
      blob.path.split('/').slice(2, 4).join('/') === segment &&
      (await blobs.delete({ tenant, path: blob.path }))
    )
      deleted += 1;
  return deleted;
};

export const runtimeDocumentStore = (blobs: BlobStore): RuntimeDocumentStore => ({
  store: async (principal, documents, capability, conversation) => {
    const tenant = principal.tenant;
    if (!tenant) throw new Error('documents need an organisation');
    const folder = conversation
      ? `${runDocumentFolder(capability)}/${conversationSegment(conversation)}`
      : runDocumentFolder(capability);
    return Promise.all(
      documents.map(async (d) => {
        const info = await blobs.put(
          { tenant, path: `${folder}/${randomUUID()}/${safeName(d.name)}` },
          d.body,
          d.mediaType,
        );
        const part = readablePart(info, d.body);
        return { ...part, meta: { ...part.meta, [attachedMeta]: true } };
      }),
    );
  },
});
