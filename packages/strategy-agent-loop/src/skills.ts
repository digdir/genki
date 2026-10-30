import type { ChatMessage, ToolSpec } from '@genai/port-model';
import { skillsSection, skillText, type RuntimeSkill } from '@genai/strategy-single-call';

export {
  runtimeSkill,
  runtimeSkills,
  skillsSection,
  skillText,
  type RuntimeSkill,
} from '@genai/strategy-single-call';

export const useSkillTool: ToolSpec = {
  name: 'use_skill',
  description:
    'Load the full instructions and examples of one of the skills listed in the system prompt. Call it before you use a skill.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The name of the skill' } },
    required: ['name'],
  },
};

export const skillCatalog = (skills: RuntimeSkill[]) =>
  skills.length === 0
    ? ''
    : `\n\n# Ferdigheter\n\nThese skills are available. Call use_skill with the name to load a skill's instructions when the question needs it:\n${skills
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n')}`;

export const useSkill = (
  skills: RuntimeSkill[],
  args: unknown,
  loadedSkills: Map<string, RuntimeSkill>,
) => {
  const name = (args as { name?: unknown } | null)?.name;
  const skill = skills.find((s) => s.name === name);
  if (skill) loadedSkills.set(skill.ref, skill);
  return skill
    ? skillText(skill)
    : `Error: unknown skill ${String(name)}. Available skills: ${skills.map((s) => s.name).join(', ')}`;
};

export const withLoadedSkills = (
  messages: ChatMessage[],
  loadedSkills: Map<string, RuntimeSkill>,
): ChatMessage[] => {
  const [first, ...rest] = messages;
  return loadedSkills.size && first?.role === 'system'
    ? [{ ...first, content: first.content + skillsSection([...loadedSkills.values()]) }, ...rest]
    : messages;
};
