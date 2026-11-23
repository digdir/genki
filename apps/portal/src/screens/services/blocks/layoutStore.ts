import {
  blockSpec,
  fromTemplate,
  isAssistantLayout,
  isBlockId,
  layoutProblems,
  normalised,
  templateIds,
  zones,
  type AssistantLayout,
  type HeldBlock,
  type LayoutProblem,
  type PlacedBlock,
  type Zone,
  type TemplateId,
} from '@genai/ui-blocks/builder';

/**
 * The layout the interface tab starts from, the template it came from when it did, and the blocks
 * the person chose that the draft cannot back yet, which come back once it can.
 */
export interface BlocksStart {
  layout: AssistantLayout;
  template?: TemplateId;
  held?: readonly HeldBlock[] | undefined;
}

/** The template a service's interface starts from: Kunnskapsassistenten's next look. */
export const startTemplate: TemplateId = 'knowledge-assistant-next';

/** What a text holds as a layout: one that keeps every rule, or why it is not one. */
export type ReadLayout =
  | { layout: AssistantLayout }
  | { problem: 'not-json' | 'not-a-layout' | 'pins-a-block' }
  | { problem: 'breaks-rules'; problems: LayoutProblem[]; pasted: AssistantLayout };

/** Reads a layout from JSON, the shape and the rules; a draft's needs are checked by the tab. */
export const readLayout = (text: string): ReadLayout => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'not-json' };
  }
  if (!isAssistantLayout(value)) return { problem: 'not-a-layout' };
  if (zones.some((zone) => value.zones[zone].some((placed) => placed.ref !== undefined)))
    return { problem: 'pins-a-block' };
  const problems = layoutProblems(value);
  if (problems.length > 0) return { problem: 'breaks-rules', problems, pasted: value };
  return { layout: normalised(value) };
};

/** A layout as «Kopier oppsettet» copies it. */
export const layoutJson = (layout: AssistantLayout) => `${JSON.stringify(layout, null, 2)}\n`;

const keyOf = (tenant: string, service: string) => `genki.blocks.${tenant}/${service}`;

/** The rules a profile's limits break, as `profileProblems` names them. */
const profileRules = new Set<LayoutProblem['rule']>([
  'profile-too-large',
  'text-too-long',
  'too-many',
  'link-not-https',
  'unknown-kind',
]);

/**
 * A held block as it was kept: a built block in a zone it may stand in, with options a layout may
 * hold. Anything else is passed over.
 */
const isHeld = (value: unknown): value is HeldBlock => {
  if (!value || typeof value !== 'object') return false;
  const { zone, placed } = value as { zone?: unknown; placed?: unknown };
  if (!zones.includes(zone as HeldBlock['zone']) || !placed || typeof placed !== 'object')
    return false;
  const { block, settings } = placed as { block?: unknown; settings?: unknown };
  if (!isBlockId(block)) return false;
  const spec = blockSpec(block);
  if (spec.status !== 'built' || !spec.zones.includes(zone as HeldBlock['zone'])) return false;
  return (
    settings === undefined ||
    (typeof settings === 'object' &&
      settings !== null &&
      !Array.isArray(settings) &&
      Object.values(settings).every((v) => typeof v === 'boolean' || typeof v === 'string'))
  );
};

const heldOf = (value: unknown): HeldBlock[] =>
  Array.isArray(value)
    ? value
        .filter(isHeld)
        .filter(
          (entry, at, all) =>
            all.findIndex(
              (other) => other.zone === entry.zone && other.placed.block === entry.placed.block,
            ) === at,
        )
    : [];

const editable = (layout: unknown): layout is AssistantLayout =>
  isAssistantLayout(layout) &&
  zones.every((zone) =>
    layout.zones[zone].every((placed) => isBlockId(placed.block) && placed.ref === undefined),
  ) &&
  // A text past a limit is kept as typed, where «Tekster» says what to shorten.
  !layoutProblems(layout).some((p) => !profileRules.has(p.rule));

/** The template a layout still is, so «Maler» shows it chosen after a reload. */
const templateOf = (layout: AssistantLayout): TemplateId | undefined => {
  const id = layout.template as TemplateId | undefined;
  if (!id || !templateIds.includes(id)) return undefined;
  const blocksOf = (l: AssistantLayout) => JSON.stringify([l.template, l.look, l.zones]);
  return blocksOf(normalised(layout)) === blocksOf(fromTemplate(id).layout) ? id : undefined;
};

const startOf = (layout: unknown, template: unknown, held: unknown): BlocksStart | undefined => {
  if (!editable(layout)) return undefined;
  // A held block that is also placed is the placed one.
  const waiting = heldOf(held).filter(
    (entry) =>
      !zones.some((zone) => layout.zones[zone].some((p) => p.block === entry.placed.block)),
  );
  return {
    layout: normalised(layout),
    ...(templateIds.includes(template as TemplateId) ? { template: template as TemplateId } : {}),
    ...(waiting.length > 0 ? { held: waiting } : {}),
  };
};

/** Reads a start kept in this browser, and gives nothing for one that is not a layout or breaks a rule. */
export const readStart = (raw: string | null): BlocksStart | undefined => {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const { layout, template, held } = value as {
    layout?: unknown;
    template?: unknown;
    held?: unknown;
  };
  return startOf(layout, template, held);
};

export const draftLayoutOf = (definition: Record<string, unknown>): unknown => {
  const spec = definition.spec as { interface?: { layout?: unknown } } | undefined;
  return spec?.interface?.layout;
};

/** `foreign` when the builder cannot edit the layout without losing something, such as an `x-` block or a `ref`. */
export const draftStart = (layout: unknown): BlocksStart | 'foreign' | undefined => {
  if (layout === undefined) return undefined;
  const start = startOf(layout, undefined, undefined);
  if (!start) return 'foreign';
  const template = templateOf(start.layout);
  return template ? { ...start, template } : start;
};

/** The layout as the draft stores it: the blocks the draft cannot back yet stand where they were chosen. */
export const storedLayout = (start: BlocksStart): AssistantLayout => {
  const placed = Object.fromEntries(
    zones.map((zone) => [zone, [...start.layout.zones[zone]]]),
  ) as Record<Zone, PlacedBlock[]>;
  for (const entry of start.held ?? [])
    if (!placed[entry.zone].some((p) => p.block === entry.placed.block))
      placed[entry.zone].push(entry.placed);
  return normalised({ ...start.layout, zones: placed });
};

/** The layout this browser kept for a service before layouts were saved in the draft, if any. */
export const keptStart = (tenant: string, service: string): BlocksStart | undefined => {
  try {
    return readStart(sessionStorage.getItem(keyOf(tenant, service)));
  } catch {
    return undefined;
  }
};

export const forgetKept = (tenant: string, service: string) => {
  try {
    sessionStorage.removeItem(keyOf(tenant, service));
  } catch {
    // Nothing kept to forget.
  }
};
