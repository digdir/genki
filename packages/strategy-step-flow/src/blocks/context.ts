import type { FlowChunk } from '../services.js';

export const formatHeaders = (headers: string[] | undefined) =>
  headers?.length
    ? headers.map((h, i) => `${'#'.repeat(Math.min(4, 3 + i))} ${h}`).join('\n')
    : undefined;

export const contextFromChunks = (
  chunks: FlowChunk[],
  contextTopK: number,
  maxContextLength: number,
) => {
  const seen = new Set<string>();
  const docs: { content: string; source: string }[] = [];
  const used: FlowChunk[] = [];
  let length = 0;
  for (const chunk of chunks) {
    if (length >= maxContextLength || docs.length >= contextTopK) break;
    if (!chunk.content || seen.has(chunk.chunkId)) continue;
    seen.add(chunk.chunkId);
    const headers = formatHeaders(chunk.headers);
    const description = `\n\`\`\`\nTitle: ${chunk.title ?? ''}${headers ? `\n${headers}` : ''}\n\`\`\`\n\n`;
    const content = description + chunk.content.replace(/\{(\d+)\}/g, '');
    length += content.length;
    docs.push({ content, source: chunk.chunkId });
    used.push(chunk);
  }
  return { docs, used, length };
};
