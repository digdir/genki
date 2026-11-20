import type { AssistantLayout } from '@genai/ui-blocks/builder';
import type { PlaygroundSetup } from '../../api/playground';
import type { SetupChange } from '../../data/playground';
import { asServiceDefinition, forTenant, renamed, applySpec } from '../../data/service-definition';
import { autoPublicName, slug, withModel, withPublicName } from '../../data/service-form';
import type { TriedHere } from '../../components/playground/PlaygroundPanel';
import { withPlaygroundChanges } from '../../components/playground/startDraft';

/** What "Make a service of this" in the playground can carry into a new service, or not. */
export type HandoverItem =
  | 'layout'
  | 'model'
  | 'instructions'
  | 'datasets'
  | 'skills'
  | 'blocks'
  | 'output'
  | 'answerLanguage'
  | 'compare'
  | 'startService'
  | 'conversation';

/** What the new service got from the playground, and what it tried that the service did not get. */
export interface Handover {
  carried: HandoverItem[];
  left: HandoverItem[];
}

/** A new draft from the template with Frontend's layout and Backend's model, instructions and datasets. */
export const serviceFromPlayground = ({
  template,
  tenant,
  name,
  layout,
  tried,
}: {
  template: Record<string, unknown>;
  tenant: string;
  name: string;
  layout: AssistantLayout;
  tried: TriedHere | undefined;
}): { definition: Record<string, unknown>; files: Record<string, string>; handover: Handover } => {
  const carried: HandoverItem[] = ['layout'];
  const left: HandoverItem[] = [];
  const base = applySpec(renamed(asServiceDefinition(template), name), (d) => ({
    ...withPublicName(d.spec, autoPublicName(name)),
    interface: { ...d.spec.interface, layout },
  }));
  let definition = base as unknown as Record<string, unknown>;
  let files: Record<string, string> = {};
  if (tried) {
    const { setup } = tried;
    const changes: SetupChange[] = [];
    if (setup.model) {
      changes.push({ kind: 'model', to: setup.model });
      carried.push('model');
    }
    if (tried.instructions === undefined) left.push('instructions');
    else if (tried.instructions.trim()) {
      changes.push({ kind: 'instructions' });
      carried.push('instructions');
    }
    if (setup.datasets.length) {
      changes.push(...setup.datasets.map((id) => ({ kind: 'dataset' as const, id, on: true })));
      carried.push('datasets');
    }
    // The template's own variant is the one the changes go into, not the tried service's.
    const own: PlaygroundSetup = { ...setup, instructions: tried.instructions ?? '' };
    delete own.service;
    const next = withPlaygroundChanges(definition, own, changes);
    // A new service keeps its data where the tried model does, so the model is allowed in it.
    definition = tried.residency
      ? (applySpec(asServiceDefinition(next.definition), (d) =>
          withModel(d.spec, setup.model, tried.residency),
        ) as unknown as Record<string, unknown>)
      : next.definition;
    files = next.files;
    if (setup.skills.length) left.push('skills');
    if (tried.addedBlocks) left.push('blocks');
    if (setup.output === 'fields') left.push('output');
    if (setup.service) left.push('startService');
    if (tried.answerLanguage) left.push('answerLanguage');
    if (tried.compare) left.push('compare');
    if (tried.conversation) left.push('conversation');
  }
  const id = slug(name) || 'ny-tjeneste';
  return {
    definition: forTenant(asServiceDefinition(definition), {
      tenant,
      id,
      version: 1,
    }) as unknown as Record<string, unknown>,
    files,
    handover: { carried, left },
  };
};

/** A new draft's id, in the shape the builder gives its own new drafts. */
export const handoverDraftId = () => `utkast-${crypto.randomUUID().slice(0, 8)}`;

// Held in memory only: the notice belongs to the visit that made the service, and a reload drops it.
const handed = new Map<string, Handover>();

/** Keeps what the new draft got, for Oppsett to say once. */
export const handOver = (draft: string, handover: Handover) => {
  handed.set(draft, handover);
};

/** What the playground handed to this draft, if it just did. */
export const handoverFor = (draft: string): Handover | undefined => handed.get(draft);

export const forgetHandover = (draft: string) => {
  handed.delete(draft);
};
