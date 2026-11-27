import { codePointLength } from './code-points.js';
import type { ConversionPart, ConversionUnit } from './parts.js';
import {
  maxPartsAround,
  maxPartsBudget,
  type PartRead,
  type PartsRead,
  type ReadPart,
} from './port.js';

/** The kinds a section read starts at and stops before. */
export const sectionHeadingKinds: readonly string[] = ['section_header', 'title'];

/**
 * The parts around a hit in one conversion's units (ADR 0055, "Chunks and reads"), as `kn_parts`
 * reads them: an engine without SQL uses it, and it states what the SQL does. Only body parts are
 * returned, in `seq` order. The budget is spent from the hit outwards: the hit's parts first, then
 * the nearest part on each side, so a cut read always keeps what lies closest to the hit.
 */
export const readPartsAround = (
  units: readonly ConversionUnit[],
  hit: { seqFrom: number; seqTo: number },
  read: PartRead,
  wanted: number,
  wantedBudget: number,
): PartsRead => {
  const n = Math.min(Math.max(wanted, 0), maxPartsAround);
  const budget = Math.min(Math.max(wantedBudget, 0), maxPartsBudget);
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
    const end = heads.find((p) => p.seq > hit.seqTo)?.seq ?? Infinity;
    chosen = body.filter((p) => p.seq >= start && p.seq < end);
  } else {
    const hitUnits = body.filter(inHit).flatMap((p) => p.regions.map((r) => r.unit));
    if (hitUnits.length === 0) return { parts: [], units: [], cut: false };
    const a = Math.min(...hitUnits) - n;
    const b = Math.max(...hitUnits) + n;
    chosen = body.filter((p) => p.regions.some((r) => r.unit >= a && r.unit <= b));
  }
  const before = chosen.filter((p) => p.seq < hit.seqFrom).reverse();
  const after = chosen.filter((p) => p.seq > hit.seqTo);
  // Hit first, then one part a side at a time, each side counted from the hit.
  const nearest = [
    ...chosen.filter(inHit).map((p) => ({ p, rank: 0 })),
    ...before.map((p, i) => ({ p, rank: i + 1 })),
    ...after.map((p, i) => ({ p, rank: i + 1 })),
  ].sort((a, b) => a.rank - b.rank || a.p.seq - b.p.seq);
  const kept: ConversionPart[] = [];
  let total = 0;
  let cut = false;
  for (const { p } of nearest) {
    total += codePointLength(p.text);
    if (total > budget) {
      cut = true;
      break;
    }
    kept.push(p);
  }
  const parts: ReadPart[] = kept
    .sort((a, b) => a.seq - b.seq)
    .map((part) => ({
      seq: part.seq,
      kind: part.kind,
      level: part.level,
      headingPath: part.headingPath,
      text: part.text,
      start: part.start,
      end: part.end,
      regions: part.regions,
    }));
  const labels = new Map(units.map((u) => [u.unit, u.label]));
  const covered = [...new Set(parts.flatMap((p) => p.regions.map((r) => r.unit)))].sort(
    (a, b) => a - b,
  );
  return { parts, units: covered.map((unit) => ({ unit, label: labels.get(unit) ?? null })), cut };
};
