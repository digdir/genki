import { defineNamespace } from '@genai/i18n';

export const architectureArea = {
  architecture: defineNamespace({
    title: 'Arkitekturassistent',
    draftTag: 'Utkast',
    lead: 'Svarer på spørsmål om nasjonal arkitektur: kapabiliteter, prinsipper og fellesressurser.',
    loading: 'Henter arkitekturassistenten',
    draft:
      'Assistenten er under utprøving, og svarene kan være feil eller ufullstendige. Sjekk kildene under hvert svar før du bruker det.',
    missingTitle: 'Arkitekturassistenten finnes ikke i {tenant}',
    missing:
      'Siden bruker tjenesten med id-en «{service}», og den er ikke publisert hos dere, eller du har ikke tilgang til den. Be en som forvalter tjenester hos dere om å publisere den eller gi deg tilgang.',
    toServices: 'Gå til tjenestene',
  }),
} as const;
