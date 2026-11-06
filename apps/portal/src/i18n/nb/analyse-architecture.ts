import { defineNamespace } from '@genai/i18n';

export const architectureArea = {
  architecture: defineNamespace({
    title: 'Arkitekturassistent',
    draftTag: 'Utkast',
    lead: 'Analyserer arkitekturen i en løsning og peker på hva som bør vurderes.',
    draftTitle: 'Arkitekturassistenten er under utvikling',
    draft:
      'Dette er et utkast. Assistenten er ikke koblet til plattformen ennå, så den kan ikke svare.',
  }),
} as const;
