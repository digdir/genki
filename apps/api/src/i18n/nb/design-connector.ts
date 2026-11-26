import { defineNamespace } from '@genai/i18n';

export const designConnector = defineNamespace({
  authorizeRefusedTitle: 'Kunne ikke koble til Claude',
  authorizeRefusedBody:
    'Lenken er ikke gyldig for genki. Start tilkoblingen på nytt fra Claude, eller følg veiledningen under «Koble til Claude» i Utforming.',
  otherBrowserTitle: 'Koble til Claude i samme nettleser',
  otherBrowserBody:
    'Koblingen ble startet i en annen nettleser, så genki fullførte den ikke. Start den på nytt fra Claude i denne nettleseren.',
  decisionInvalid: 'må være allow eller deny',
  requestGone: 'Tilkoblingen er utløpt eller allerede brukt. Start den på nytt fra Claude.',
});
