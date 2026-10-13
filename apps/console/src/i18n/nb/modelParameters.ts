import { defineNamespace } from '@genai/i18n';

export const modelParameters = defineNamespace({
  open: 'Parametere',
  openFor: 'Parametere for {model}',
  title: 'Parametere for {model}',
  text: 'Noen modeller avviser parametere som tjenestene sender. Her bestemmer du hva plattformen sender til denne modellen, uavhengig av hva tjenestene har satt.',
  save: 'Lagre parametere',
  temperature: 'Temperatur',
  reasoning: 'Resonneringsnivå',
  maxTokens: 'Lengste svar (tokens)',
  modeSend: 'Send slik tjenesten har satt den',
  modeUnsupported: 'Modellen støtter den ikke, ikke send',
  modeFixed: 'Send alltid en fast verdi',
  fixedValue: 'Fast verdi for {name}',
  invalid: 'Den faste verdien er ikke gyldig for {name}.',
  reasoningLow: 'Lav',
  reasoningMedium: 'Middels',
  reasoningHigh: 'Høy',
  ruleUnsupported: '{name}: sendes ikke',
  ruleFixed: '{name}: fast {value}',
  rejectedTitle: 'Modellen har avvist {name}',
  rejectedText:
    'Modellen svarte at den ikke godtar {name}. Plattformen prøvde på nytt uten, så tjenestene fungerer. Sist sett {when}. Velg «Modellen støtter den ikke» under Parametere for å gjøre det til en fast regel.',
  rejectedHint: 'Har avvist {name}',
  saved: 'Parameterne for {model} er lagret. Endringen er logget i Revisjon.',
});
