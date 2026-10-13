import type { DefinitionStore, ServiceDefinition, SkillDefinition } from '@genai/definitions';
import type { Capability as KernelCapability } from '@genai/kernel';
import type { RuntimeSkill } from '@genai/strategy-single-call';
import type { ConfigEntryStore } from './config-store.js';

export const skillShareKind = 'skill-share';

export const parseSkillRef = (ref: string) => {
  const at = ref.lastIndexOf('@');
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
};

export const skillResolver = (deps: {
  definitions: Pick<DefinitionStore, 'get'>;
  configEntries: Pick<ConfigEntryStore, 'latest'>;
}) => {
  const toRuntime = (definition: SkillDefinition, ref: string): RuntimeSkill => ({
    ref,
    name: definition.metadata.id,
    description: definition.spec.description,
    instructions: definition.spec.instructions,
    examples: definition.spec.examples,
  });

  const sharedOwners = async (skill: string, except: string) =>
    (await deps.configEntries.latest({ kind: skillShareKind }))
      .filter((e) => {
        const spec = e.spec as { skill?: string; state?: string };
        return !e.deleted && spec.skill === skill && spec.state === 'shared' && e.scope !== except;
      })
      .map((e) => e.scope);

  const resolveSkill = async (tenant: string, id: string, version: number) => {
    const own = await deps.definitions.get('Skill', tenant, id, version);
    if (own) return { owner: tenant, definition: own.definition as SkillDefinition };
    for (const owner of await sharedOwners(id, tenant)) {
      const found = await deps.definitions.get('Skill', owner, id, version);
      if (found) return { owner, definition: found.definition as SkillDefinition };
    }
    return undefined;
  };

  return { toRuntime, resolveSkill };
};

export type SkillResolver = ReturnType<typeof skillResolver>;

export const skillDecorator =
  (
    resolver: SkillResolver,
    draftFor?: (tenant: string, service: string) => RuntimeSkill | undefined,
  ) =>
  async (
    capability: KernelCapability,
    context: { definition: unknown },
  ): Promise<KernelCapability> => {
    const definition = context.definition as ServiceDefinition | undefined;
    const metadata = definition?.metadata;
    const draft = metadata ? draftFor?.(metadata.tenant, metadata.id) : undefined;
    const refs = definition?.spec?.skills ?? [];
    if (!metadata || (!draft && refs.length === 0)) return capability;
    const skills: RuntimeSkill[] = draft ? [draft] : [];
    for (const ref of refs) {
      const { id, version } = parseSkillRef(ref);
      const found = await resolver.resolveSkill(metadata.tenant, id, version);
      if (found) skills.push(resolver.toRuntime(found.definition, ref));
    }
    if (skills.length === 0) return capability;
    return {
      ...capability,
      config: { ...(capability.config as Record<string, unknown>), skills },
    };
  };
