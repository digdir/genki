// Where the interface tab keeps a service's layout: in this browser's session storage only, per
// tenant and service. The service definition has no place for a layout yet; that waits for an ADR.
// «Kopier oppsettet» and «Lim inn oppsett» carry a layout as JSON to another browser or a host.
import {
  isAssistantLayout,
  layoutProblems,
  normalised,
  templateIds,
  type AssistantLayout,
  type LayoutProblem,
  type TemplateId,
} from '@genai/ui-blocks/builder';

/** The layout the interface tab starts from, and the template it came from when it did. */
export interface BlocksStart {
  layout: AssistantLayout;
  template?: TemplateId;
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
  const { layout, template } = value as { layout?: unknown; template?: unknown };
  if (!isAssistantLayout(layout) || layoutProblems(layout).length > 0) return undefined;
  return {
    layout: normalised(layout),
    ...(templateIds.includes(template as TemplateId) ? { template: template as TemplateId } : {}),
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
