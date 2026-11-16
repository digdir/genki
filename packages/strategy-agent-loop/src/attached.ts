import type { Input } from '@genai/contracts';
import { untrustedData } from '@genai/port-model';
import type { Chunk } from './workspace.js';

export const attachedMeta = 'attached';

const chunkChars = 3000;
const totalChars = 24000;

export const attachedChunks = (input: Input): Chunk[] => {
  let left = totalChars;
  return (input.parts ?? []).flatMap((part, n) => {
    if (part.meta?.[attachedMeta] !== true || part.body.kind !== 'text') return [];
    const name = typeof part.meta.name === 'string' ? part.meta.name : `document-${n + 1}`;
    const id = typeof part.meta.sha256 === 'string' ? part.meta.sha256 : String(n);
    const text = part.body.text.slice(0, Math.max(left, 0));
    left -= text.length;
    const pieces: Chunk[] = [];
    for (let i = 0; i * chunkChars < text.length; i += 1)
      pieces.push({
        chunkId: `attached:${id}:${i}`,
        document: `attached:${id}`,
        position: i,
        title: name,
        content: text.slice(i * chunkChars, (i + 1) * chunkChars),
      });
    return pieces;
  });
};

export const attachedNote = (chunks: Chunk[], answerTool: boolean) => {
  const names = [...new Set(chunks.map((c) => c.title ?? ''))].filter(Boolean);
  if (!names.length) return '';
  const lead = `\n\nThe user attached these documents to the question: ${names.join(', ')}.`;
  if (answerTool)
    return `${lead} They are given to generate_response as sources; use them and cite them like other sources.`;
  const texts = new Map<string, { title: string; text: string }>();
  for (const c of chunks) {
    const doc = texts.get(c.document ?? c.chunkId) ?? { title: c.title ?? '', text: '' };
    texts.set(c.document ?? c.chunkId, { ...doc, text: doc.text + c.content });
  }
  const documents = [...texts.values()].map((d) =>
    untrustedData('attached-document', d.text, { title: d.title }),
  );
  return `${lead} Their text follows; use it to answer.\n\n${documents.join('\n\n')}`;
};
