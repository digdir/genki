import type { BuilderIntent, BuilderTarget } from './types.js';

export const untrusted = (kind: string, value: unknown) =>
  `<untrusted_data kind="${kind}">\n${JSON.stringify(value, null, 1).replace(/</g, '\\u003c')}\n</untrusted_data>`;

const targetGuides: Record<BuilderTarget, string> = {
  service:
    'Utkastet er en tjeneste (kind: Service). Endringer foreslås som JSON Patch mot hele utkastet, for eksempel /spec/strategy/config/instructions. Ber brukeren om en ny variant med en egen arbeidsmåte, bruk propose_variant: velg en oppskrift og fyll ut innstillingene, og lag en ny stegflyt bare når ingen oppskrift passer.',
  skill:
    'Utkastet er en ferdighet (kind: Skill). Endringer foreslås som JSON Patch mot hele utkastet, for eksempel /spec/description eller /spec/instructions.',
  stepflow:
    'Utkastet er en stegflyt (kind: StepFlow). Endringer foreslås som JSON Patch mot hele utkastet, for eksempel /spec/steps/-. Et steg leser tidligere steg som {{<steg-id>.<felt>}}, inndata som {{input.query}} og innstillinger som {{settings.<navn>}}.',
};

const intentGuides: Record<BuilderIntent, string> = {
  chat: 'Hjelp brukeren med det de ber om.',
  'improve-instructions':
    'Brukeren vil ha bedre instruksjoner. Kall improve_instructions med hele den nye teksten og en kort liste over hva som er endret.',
  'suggest-test-cases':
    'Brukeren vil ha forslag til testtilfeller. Bruk formålet og dokumentutvalget, og kall suggest_test_cases. Oppgi kilden (source) når et tilfelle bygger på et dokument.',
  'suggest-description':
    'Foreslå en bedre beskrivelse av ferdigheten med propose_change mot /spec/description.',
  'suggest-instructions':
    'Foreslå bedre instruksjoner for ferdigheten med propose_change mot /spec/instructions.',
  'suggest-examples': 'Foreslå eksempler for ferdigheten med propose_change mot /spec/examples.',
  'fix-instructions':
    'Finn og rett feil og uklarheter i instruksjonene med propose_change mot /spec/instructions.',
};

export const guideFor = (target: BuilderTarget, intent: BuilderIntent) =>
  `${targetGuides[target]}\n${intentGuides[intent]}`;
