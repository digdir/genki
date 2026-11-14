// Where the interface tab keeps a service's layout: in this browser's session storage only, per
// tenant and service. The service definition has no place for a layout yet; that waits for an ADR.
// «Kopier oppsettet» and «Lim inn oppsett» carry a layout as JSON to another browser or a host.
import {
  blockSpec,
  isAssistantLayout,
  isBlockId,
  layoutProblems,
  normalised,
  templateIds,
  zones,
  type AssistantLayout,
  type HeldBlock,
  type LayoutProblem,
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
  | { problem: 'not-json' | 'not-a-layout' }
  | { problem: 'breaks-rules'; problems: LayoutProblem[] };

/** Reads a layout from JSON, the shape and the rules; a draft's needs are checked by the tab. */
export const readLayout = (text: string): ReadLayout => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'not-json' };
  }
  if (!isAssistantLayout(value)) return { problem: 'not-a-layout' };
  const problems = layoutProblems(value);
  if (problems.length > 0) return { problem: 'breaks-rules', problems };
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

/** Reads a kept start, and gives nothing for one that is not a layout or breaks a rule. */
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
  // A text past a limit is kept as typed, where «Tekster» says what to shorten; a block that
  // breaks a rule is not.
  if (!isAssistantLayout(layout) || layoutProblems(layout).some((p) => !profileRules.has(p.rule)))
    return undefined;
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

/** The layout this browser keeps for a service in this session, if any. */
export const keptStart = (tenant: string, service: string): BlocksStart | undefined => {
  try {
    return readStart(sessionStorage.getItem(keyOf(tenant, service)));
  } catch {
    return undefined;
  }
};

/** Keeps a service's layout in this browser for this session. */
export const keepStart = (tenant: string, service: string, start: BlocksStart) => {
  try {
    sessionStorage.setItem(keyOf(tenant, service), JSON.stringify(start));
  } catch {
    // Without storage the tab starts from the template the next time it is opened.
  }
};
