import type { AssistantLayout } from '@genai/ui-blocks/builder';
import type { PlaygroundSetup } from '../../api/playground';
import type { SetupChange } from '../../data/playground';
import { asServiceDefinition, forTenant, renamed, applySpec } from '../../data/service-definition';
import { autoPublicName, slug, withModel, withPublicName } from '../../data/service-form';
import type { TriedHere } from '../../components/playground/PlaygroundPanel';
import { withPlaygroundChanges } from '../../components/playground/startDraft';

/** What "Make a service of this" can carry into a new service, or not. */
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

/** What the new service got, and what was tried but not carried. */
export interface Handover {
  carried: HandoverItem[];
  left: HandoverItem[];
}

/** A new draft: Frontend's layout, Backend's model, instructions and datasets. */
export const serviceFromPlayground = ({
  template,
  tenant,
  draft,
  name: baseName,
  layout,
  tried,
}: {
  template: Record<string, unknown>;
  tenant: string;
  draft: string;
  name: string;
  layout: AssistantLayout;
  tried: TriedHere | undefined;
}): { definition: Record<string, unknown>; files: Record<string, string>; handover: Handover } => {
  // The draft id's tail keeps each new service's id apart.
  const name = `${baseName} ${draft.slice(-4)}`;
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
    // The changes go into the template's variant, not the tried service's.
    const own: PlaygroundSetup = { ...setup, instructions: tried.instructions ?? '' };
    delete own.service;
    const next = withPlaygroundChanges(definition, own, changes);
    // Keep data where the tried model does, so the model is allowed.
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

// In memory only, so a reload drops the notice.
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
