import type { Input } from '@genai/contracts';
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

export const attachedNote = (chunks: Chunk[]) => {
  const names = [...new Set(chunks.map((c) => c.title ?? ''))].filter(Boolean);
  return names.length
    ? `\n\nThe user attached these documents to the question: ${names.join(', ')}. They are given to generate_response as sources; use them and cite them like other sources.`
    : '';
};
