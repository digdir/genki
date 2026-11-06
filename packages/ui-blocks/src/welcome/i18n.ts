import { defineNamespace, type Translation } from '@genai/i18n';

export const nbWelcome = defineNamespace({
  greeting: 'Hei, {name}',
  greetingUnnamed: 'Hei',
  question: 'Hva lurer du på?',
  suggestions: 'Forslag',
});

export const enWelcome = {
  greeting: 'Hi, {name}',
  greetingUnnamed: 'Hi',
  question: 'What would you like to know?',
  suggestions: 'Suggestions',
} satisfies Translation<typeof nbWelcome>;
