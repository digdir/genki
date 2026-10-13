import { z } from 'zod';

export const runtimeSkill = z.looseObject({
  ref: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  examples: z.array(z.looseObject({ input: z.string(), expectedOutput: z.string() })).default([]),
});

export type RuntimeSkill = z.input<typeof runtimeSkill>;

export const runtimeSkills = z.array(runtimeSkill).optional();

const examplesText = (examples: RuntimeSkill['examples']) =>
  (examples ?? []).length === 0
    ? ''
    : `\n\nEksempler:\n${(examples ?? [])
        .map((e) => `Inn: ${e.input}\nForventet resultat: ${e.expectedOutput}`)
        .join('\n\n')}`;

export const skillText = (skill: RuntimeSkill) =>
  `## ${skill.name}\n${skill.description}\n\n${skill.instructions}${examplesText(skill.examples)}`;

export const skillsSection = (skills: RuntimeSkill[] | undefined) =>
  skills?.length ? `\n\n# Ferdigheter\n\n${skills.map(skillText).join('\n\n')}` : '';
