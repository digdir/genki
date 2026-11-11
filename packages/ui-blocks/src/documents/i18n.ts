import { defineCatalogue, defineNamespace, type Translation } from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { enCorpus, nbCorpus } from '../corpus/i18n.js';

// `{types}` is the file types a host takes, as a list: «PDF og .docx».

export const nbDocuments = defineNamespace({
  title: 'Dokumenter',
  from: 'Fra {name}',
  empty: 'Dokumentene som er relevante for søket ditt vises her.',
  showing: 'Viser {shown} av {total} dokumenter.',
  showMore: 'Vis flere dokumenter',
  opensInNewTab: '(åpnes i ny fane)',
  noLink: 'uten lenke',
  noLinkAlone: 'Uten lenke',
  own: 'Dine dokumenter',
  ownNew: 'Ny',
  ownSoon: 'Kommer snart',
  upload: 'Last opp egne dokumenter',
  uploadHint: 'Slipp filer her, eller velg dem selv. Kun {types} for øyeblikket, maks {max}.',
  uploadSoon: 'Snart kan du laste opp {types} her, maks {max}.',
  chooseFiles: 'Velg filer',
  uploading: 'Laster opp {name}',
  uploaded: '{name} er lastet opp',
  notUploaded: '{name} ble ikke lastet opp. {reason}',
  progress: 'Laster opp … {percent} %',
  remove: 'Fjern {name}',
  tooLarge: 'Filen er større enn {max}.',
  wrongType: 'Bare {types} kan lastes opp.',
  failed: 'Opplastingen mislyktes. Prøv igjen.',
  unavailable: 'Opplasting er ikke tilgjengelig i denne tjenesten ennå.',
});

export const enDocuments = {
  title: 'Documents',
  from: 'From {name}',
  empty: 'The documents relevant to your search are shown here.',
  showing: 'Showing {shown} of {total} documents.',
  showMore: 'Show more documents',
  opensInNewTab: '(opens in a new tab)',
  noLink: 'no link',
  noLinkAlone: 'No link',
  own: 'Your documents',
  ownNew: 'New',
  ownSoon: 'Coming soon',
  upload: 'Upload your own documents',
  uploadHint: 'Drop files here, or choose them. Only {types} for now, at most {max}.',
  uploadSoon: 'Soon you can upload {types} here, at most {max}.',
  chooseFiles: 'Choose files',
  uploading: 'Uploading {name}',
  uploaded: '{name} is uploaded',
  notUploaded: '{name} was not uploaded. {reason}',
  progress: 'Uploading … {percent} %',
  remove: 'Remove {name}',
  tooLarge: 'The file is larger than {max}.',
  wrongType: 'Only {types} can be uploaded.',
  failed: 'The upload failed. Try again.',
  unavailable: 'Uploading is not available in this service yet.',
} satisfies Translation<typeof nbDocuments>;

/** The documents' own catalogue, with the collection's words, apart from the shared one. */
export const nb = defineCatalogue({ documents: nbDocuments, corpus: nbCorpus });
export const en = { documents: enDocuments, corpus: enCorpus } satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
