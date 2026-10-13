import { clojureTrim, ednStringMap, isBlank, javaSplit, splitLines } from './text.js';

export interface ChunkingConfig {
  minimumLength: number;
  splitMaxLength?: number;
  overlap?: number;
}

export interface HeaderChunk {
  content: string;
  metadata: Map<string, string>;
}

const filterHeaders = ['Table of Contents', 'This Page', 'Navigation'];
const lineEnd = '[^\\n\\r\\u0085\\u2028\\u2029]';
const asciiSpace = '[ \\t\\n\\x0B\\f\\r]';
const headerLine = new RegExp(`^(#{1,6})${asciiSpace}+(${lineEnd}*)$`);
const codeBlockLine = new RegExp(`^${asciiSpace}*\`\`\`$`);
const paragraphLink = new RegExp(`\\[¶\\]\\(${lineEnd}*?\\)`, 'g');

const cleanHeaderText = (text: string) =>
  clojureTrim(text.replace(/\\/g, '').replace(paragraphLink, ''));

const splitByHeaders = (text: string): HeaderChunk[] => {
  const chunks: HeaderChunk[] = [];
  let current = { metadata: new Map<string, string>(), content: '' };
  let headers = new Map<string, string>();
  let previousLevel = 0;
  let inCodeBlock = false;
  for (const line of splitLines(text)) {
    const isCodeBlock: boolean = codeBlockLine.test(line);
    const nextInCodeBlock: boolean = isCodeBlock ? !inCodeBlock : inCodeBlock;
    const match = inCodeBlock ? null : headerLine.exec(line);
    if (match) {
      const level = (match[1] as string).length;
      const key = `Header ${level}`;
      const next = new Map(headers);
      if (level <= previousLevel) next.delete(`Header ${previousLevel}`);
      next.set(key, cleanHeaderText(match[2] as string));
      if (current.content !== '')
        chunks.push({ content: clojureTrim(current.content), metadata: current.metadata });
      current = { metadata: next, content: '' };
      headers = next;
      previousLevel = level;
    } else {
      current = { ...current, content: `${current.content}${line}\n` };
    }
    inCodeBlock = nextInCodeBlock;
  }
  if (current.content !== '')
    chunks.push({ content: clojureTrim(current.content), metadata: current.metadata });
  return chunks;
};

const filtered = (chunk: HeaderChunk) =>
  chunk.metadata.size > 0 &&
  [...chunk.metadata.values()].some((value) => filterHeaders.some((f) => value.includes(f)));

export const concatenateTooSmallChunks = (minimumLength: number, chunks: HeaderChunk[]) => {
  const groups: number[][] = [];
  let group: number[] = [];
  chunks.forEach((chunk, index) => {
    if (chunk.content.length < minimumLength) group.push(index);
    else if (group.length > 0) {
      groups.push([...group, index]);
      group = [];
    }
  });
  if (group.length > 0) groups.push(group);
  const grouped = new Set(groups.flat());
  const out: HeaderChunk[] = [];
  for (let index = 0; index < chunks.length;) {
    if (!grouped.has(index)) {
      out.push(chunks[index] as HeaderChunk);
      index += 1;
      continue;
    }
    const members = groups.find((g) => g.includes(index)) as number[];
    if (members[0] !== index) {
      index += 1;
      continue;
    }
    const parts = members.map((i) => chunks[i] as HeaderChunk);
    out.push({
      content: parts.map((p) => p.content).join('\n\n'),
      metadata: parts.find((p) => p.metadata.size > 0)?.metadata ?? new Map(),
    });
    index += members.length;
  }
  return out;
};

const hardWindows = (s: string, max: number) => {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    out.push(rest.slice(0, max));
    rest = rest.slice(max);
  }
  out.push(rest);
  return out;
};

const atomize = (content: string, max: number) =>
  javaSplit(content, /\n{2,}/)
    .filter((p) => !isBlank(p))
    .flatMap((p) =>
      p.length <= max
        ? [p]
        : javaSplit(p, /(?<=[.!?])[ \t\n\v\f\r]+/)
            .filter((s) => !isBlank(s))
            .flatMap((s) => (s.length <= max ? [s] : hardWindows(s, max))),
    );

const tailOverlap = (s: string, overlap: number): string | undefined => {
  if (overlap <= 0 || s.length <= overlap) return overlap > 0 ? s : undefined;
  const tail = s.slice(s.length - overlap);
  const space = tail.indexOf(' ');
  return space >= 0 ? tail.slice(space + 1) : tail;
};

const packSegments = (segments: string[], max: number, overlap: number) => {
  const out: string[] = [];
  let current = '';
  for (const segment of segments) {
    const candidate = isBlank(current) ? segment : `${current}\n\n${segment}`;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    const carried = tailOverlap(current, overlap);
    out.push(current);
    current = isBlank(carried) ? segment : `${carried}\n\n${segment}`;
  }
  if (!isBlank(current)) out.push(current);
  return out;
};

export const splitOversizedContent = (content: string, max: number, overlap: number) =>
  content.length <= max ? [content] : packSegments(atomize(content, max), max, overlap);

export const splitOversizedChunks = (
  max: number | undefined,
  overlap: number | undefined,
  chunks: HeaderChunk[],
) =>
  max && max > 0
    ? chunks.flatMap((chunk) => {
        const parts = splitOversizedContent(chunk.content, max, overlap ?? 0);
        return parts.length <= 1 ? [chunk] : parts.map((content) => ({ ...chunk, content }));
      })
    : chunks;

export const splitIntoChunksByHeaders = (config: ChunkingConfig, text: string): HeaderChunk[] =>
  splitOversizedChunks(
    config.splitMaxLength,
    config.overlap,
    concatenateTooSmallChunks(
      config.minimumLength,
      splitByHeaders(text).filter((c) => !filtered(c)),
    ),
  );

export type MetadataStyle = 'pr' | 'prn';

export interface RawChunk {
  content_markdown: string;
  metadata?: string;
}

export const headerBasedChunks = (
  config: ChunkingConfig,
  text: string,
  style: MetadataStyle,
): RawChunk[] =>
  splitIntoChunksByHeaders(config, text).map((c) => ({
    content_markdown: c.content,
    metadata: `${ednStringMap(c.metadata)}${style === 'prn' ? '\n' : ''}`,
  }));

export const fixedWidthChunks = (text: string, width: number, overlap: number): RawChunk[] => {
  const step = width - overlap;
  if (step <= 0) throw new RangeError('fixed-width overlap must be smaller than the width');
  const out: RawChunk[] = [];
  for (let start = 0; start < text.length; start += step)
    out.push({ content_markdown: text.slice(start, start + width) });
  return out;
};
