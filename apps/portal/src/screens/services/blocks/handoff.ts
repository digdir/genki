import {
  isAssistantLayout,
  layoutProblems,
  normalised,
  templateIds,
  type AssistantLayout,
  type TemplateId,
} from '@genai/ui-blocks/builder';

/** The building blocks a new service starts with, when it is made from the playground. */
export interface BlocksStart {
  layout: AssistantLayout;
  template?: TemplateId;
}

const key = 'genki.blocks.start';

/** Reads a stored start, and gives nothing for a layout that is not one or breaks a rule. */
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
