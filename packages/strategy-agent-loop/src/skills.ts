import type { ToolSpec } from '@genai/port-model';
import { skillText, type RuntimeSkill } from '@genai/strategy-single-call';

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

export const useSkill = (skills: RuntimeSkill[], args: unknown) => {
  const name = (args as { name?: unknown } | null)?.name;
  const skill = skills.find((s) => s.name === name);
  return skill
    ? skillText(skill)
    : `Error: unknown skill ${String(name)}. Available skills: ${skills.map((s) => s.name).join(', ')}`;
};
