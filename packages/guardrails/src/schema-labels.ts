import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  categories: {
    label: 'Hva som filtreres',
    values: {
      'national-id': 'Fødselsnummer',
      'd-number': 'D-nummer',
      phone: 'Telefonnummer',
      email: 'E-postadresse',
      'account-number': 'Kontonummer',
      health: 'Helseopplysninger',
    },
  },
  action: {
    label: 'Hva som skjer',
    values: { mask: 'Skjul opplysningene', refuse: 'Avslå spørsmålet' },
  },
  restore: { label: 'Sett opplysningene tilbake i svaret' },
  message: { label: 'Melding til brukeren', help: 'Tomt bruker plattformens melding.' },
  mode: {
    label: 'Språk i svaret',
    values: { same: 'Samme som spørsmålet', nb: 'Bokmål', nn: 'Nynorsk', en: 'Engelsk' },
  },
  rewrite: { label: 'Skriv om svar på feil språk' },
  topics: { label: 'Emner som avslås' },
  onError: {
    label: 'Hvis sjekken feiler',
    values: { refuse: 'Avslå', allow: 'Slipp gjennom' },
  },
  prompt: { label: 'Tekst til den som godkjenner' },
  expiresInMinutes: { label: 'Minutter før godkjenningen går ut' },
  model: { label: 'Modell som avgjør', help: 'En modell som kan ta beslutninger.' },
  threshold: {
    label: 'Hvor sikker modellen må være',
    help: 'Under denne grensen avgjør ikke modellen alene.',
  },
  uncertain: {
    label: 'Når modellen er usikker',
    values: { person: 'En person ser på det', allow: 'Slipp gjennom' },
  },
  refusal: {
    label: 'Når modellen ikke vil svare',
    values: { person: 'En person ser på det', allow: 'Slipp gjennom' },
  },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  categories: {
    label: 'What is filtered',
    values: {
      'national-id': 'National identity number',
      'd-number': 'D number',
      phone: 'Phone number',
      email: 'Email address',
      'account-number': 'Account number',
      health: 'Health data',
    },
  },
  action: {
    label: 'What happens',
    values: { mask: 'Hide the data', refuse: 'Refuse the question' },
  },
  restore: { label: 'Put the data back in the answer' },
  message: { label: 'Message to the user', help: 'Empty uses the platform message.' },
  mode: {
    label: 'Answer language',
    values: {
      same: 'Same as the question',
      nb: 'Norwegian Bokmål',
      nn: 'Norwegian Nynorsk',
      en: 'English',
    },
  },
  rewrite: { label: 'Rewrite answers in the wrong language' },
  topics: { label: 'Topics that are refused' },
  onError: {
    label: 'If the check fails',
    values: { refuse: 'Refuse', allow: 'Let it through' },
  },
  prompt: { label: 'Text for the person who approves' },
  expiresInMinutes: { label: 'Minutes before the approval expires' },
  model: { label: 'Model that decides', help: 'A model that can make decisions.' },
  threshold: {
    label: 'How sure the model must be',
    help: 'Below this limit the model does not decide alone.',
  },
  uncertain: {
    label: 'When the model is unsure',
    values: { person: 'A person looks at it', allow: 'Let it through' },
  },
  refusal: {
    label: 'When the model will not answer',
    values: { person: 'A person looks at it', allow: 'Let it through' },
  },
};

export const guardrailSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: { message: { 'x-widget': 'textarea' }, prompt: { 'x-widget': 'textarea' } },
  titles: {
    'pii-before-model': {
      nb: 'Fjern personopplysninger før modellkall',
      en: 'Remove personal data before model calls',
    },
    'pii-out-of-log': {
      nb: 'Hold personopplysninger ute av loggen',
      en: 'Keep personal data out of the log',
    },
    'require-sources': { nb: 'Krev kilder', en: 'Require sources' },
    language: { nb: 'Svarspråk', en: 'Answer language' },
    'refuse-topics': { nb: 'Avslå emner', en: 'Refuse topics' },
    'human-approval': { nb: 'Menneskelig godkjenning', en: 'Human approval' },
    'custom-rules': { nb: 'Egne regler', en: 'Custom rules' },
    'purpose-check': { nb: 'Sjekk av formålet', en: 'Purpose check' },
  },
};
