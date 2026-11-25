/**
 * The `parts-unit` chunker (ADR 0055, "Chunks and reads"): one chunk per unit, a page of a PDF,
 * from the body parts stored in its row, split on part boundaries at the size limit.
 */
import type { ConversionPart, ConversionUnit } from '@genai/port-knowledge';

/** A chunk made from conversion parts: its text is exactly its span of the conversion's text. */
export interface PartsChunk {
  text: string;
  seqFrom: number;
  seqTo: number;
  /** Code points into the conversion's text, end exclusive. */
  textStart: number;
  textEnd: number;
  /** The first and last unit its parts' regions reach. */
  pageFrom: number;
  pageTo: number;
  /** Its first part's. */
  headingPath: string[];
}

/** The separator the conversion's text joins its body parts with (`conversionText`). */
const joiner = '\n\n';

type BodyPart = ConversionPart & { start: number; end: number };

const isBody = (part: ConversionPart): part is BodyPart =>
  part.layer === 'body' && part.text !== '' && part.start !== null && part.end !== null;

const chunkOf = (parts: BodyPart[], unit: number): PartsChunk => {
  const first = parts[0] as BodyPart;
  const last = parts[parts.length - 1] as BodyPart;
  const reached = parts.flatMap((part) => part.regions.map((region) => region.unit));
  return {
    text: parts.map((part) => part.text).join(joiner),
    seqFrom: first.seq,
    seqTo: last.seq,
    textStart: first.start,
    textEnd: last.end,
    pageFrom: Math.min(unit, ...reached),
    pageTo: Math.max(unit, ...reached),
    headingPath: first.headingPath,
  };
};

/**
 * One chunk per unit from the body parts stored in its row, in `seq` order. A unit whose parts come
 * to more than `splitMaxLength` is split on part boundaries, and a single part over it is a chunk
 * of its own: nothing is dropped. A unit with no body part gives no chunk.
 */
export const partsUnitChunks = (
  units: readonly ConversionUnit[],
  options: { splitMaxLength: number },
): PartsChunk[] =>
  units.flatMap((unit) => {
    const chunks: PartsChunk[] = [];
    let open: BodyPart[] = [];
    let length = 0;
    for (const part of [...unit.parts].sort((a, b) => a.seq - b.seq)) {
      if (!isBody(part)) continue;
      const added = (open.length > 0 ? joiner.length : 0) + part.text.length;
      if (open.length > 0 && length + added > options.splitMaxLength) {
        chunks.push(chunkOf(open, unit.unit));
        open = [];
        length = 0;
      }
      length += open.length > 0 ? joiner.length + part.text.length : part.text.length;
      open.push(part);
    }
    if (open.length > 0) chunks.push(chunkOf(open, unit.unit));
    return chunks;
  });
