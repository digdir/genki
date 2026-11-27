import { codePointLength } from './code-points.js';
import type { ConversionPart, ConversionUnit } from './parts.js';
import type { PartRead, PartsRead, ReadPart } from './port.js';

/** The kinds a section read starts at and stops before. */
export const sectionHeadingKinds: readonly string[] = ['section_header', 'title'];

/**
 * The parts around a hit in one conversion's units (ADR 0055, "Chunks and reads"), as `kn_parts`
 * reads them: an engine without SQL uses it, and it states what the SQL does. Only body parts are
 * returned, in `seq` order, until their text passes `budget` code points.
 */
export const readPartsAround = (
  units: readonly ConversionUnit[],
  hit: { seqFrom: number; seqTo: number },
  read: PartRead,
  n: number,
  budget: number,
): PartsRead => {
  const body = units
    .flatMap((u) => u.parts)
    .filter((p) => p.layer === 'body')
    .sort((a, b) => a.seq - b.seq);
  const inHit = (p: ConversionPart) => p.seq >= hit.seqFrom && p.seq <= hit.seqTo;
  let chosen: ConversionPart[];
  if (read === 'neighbours') {
    const before = body.filter((p) => p.seq < hit.seqFrom);
    const after = body.filter((p) => p.seq > hit.seqTo).slice(0, n);
    chosen = [...before.slice(before.length - n), ...body.filter(inHit), ...after];
  } else if (read === 'section') {
    const heads = body.filter((p) => sectionHeadingKinds.includes(p.kind));
    const start = heads.filter((p) => p.seq <= hit.seqFrom).at(-1)?.seq ?? -1;
    const end = heads.find((p) => p.seq > hit.seqFrom)?.seq ?? Infinity;
    chosen = body.filter((p) => p.seq >= start && p.seq < end);
  } else {
    const hitUnits = body.filter(inHit).flatMap((p) => p.regions.map((r) => r.unit));
    if (hitUnits.length === 0) return { parts: [], units: [], cut: false };
    const a = Math.min(...hitUnits) - n;
    const b = Math.max(...hitUnits) + n;
    chosen = body.filter((p) => p.regions.some((r) => r.unit >= a && r.unit <= b));
  }
  const parts: ReadPart[] = [];
  let total = 0;
  let cut = false;
  for (const part of chosen) {
    total += codePointLength(part.text);
    if (total > budget) {
      cut = true;
      break;
    }
    parts.push({
      seq: part.seq,
      kind: part.kind,
      level: part.level,
      headingPath: part.headingPath,
      text: part.text,
      start: part.start,
      end: part.end,
      regions: part.regions,
    });
  }
  const labels = new Map(units.map((u) => [u.unit, u.label]));
  const covered = [...new Set(parts.flatMap((p) => p.regions.map((r) => r.unit)))].sort(
    (a, b) => a - b,
  );
  return { parts, units: covered.map((unit) => ({ unit, label: labels.get(unit) ?? null })), cut };
};
