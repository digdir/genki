import {
  allBlocks,
  panels,
  templateIds,
  type BlockId,
  type BlockLayout,
  type Panel,
  type TemplateId,
} from './rules';

/** The building blocks a new service starts with, when it is made from the playground. */
export interface BlocksStart {
  layout: BlockLayout;
  template?: TemplateId;
}

const key = 'genki.blocks.start';

const placements = (value: unknown): Partial<Record<BlockId, Panel>> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const out: Partial<Record<BlockId, Panel>> = {};
  for (const [id, panel] of Object.entries(value)) {
    if (!allBlocks.includes(id as BlockId) || !panels.includes(panel as Panel)) return undefined;
    out[id as BlockId] = panel as Panel;
  }
  return out;
};

/** Reads a stored start, and gives nothing for anything it does not recognise. */
export const readStart = (raw: string | null): BlocksStart | undefined => {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const { layout, template } = value as {
    layout?: { placed?: unknown; chosen?: unknown };
    template?: unknown;
  };
  const placed = placements(layout?.placed);
  const chosen = placements(layout?.chosen ?? {});
  if (!placed || !chosen) return undefined;
  return {
    layout: { placed, chosen },
    ...(templateIds.includes(template as TemplateId) ? { template: template as TemplateId } : {}),
  };
};

/** Keeps the blocks for the new service the person goes on to make. */
export const handOver = (start: BlocksStart) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(start));
  } catch {
    // Without storage the new service starts from the default blocks.
  }
};

/** Takes the blocks handed over, once. */
export const takeOver = (): BlocksStart | undefined => {
  try {
    const start = readStart(sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
    return start;
  } catch {
    return undefined;
  }
};
