import type { PlainKey } from '../i18n';
import type { JobId, ServiceStatus } from './services';

export const jobKeys: Record<JobId, { label: PlainKey; example: PlainKey; tag: PlainKey }> = {
  answers: {
    label: 'services.jobAnswers',
    example: 'services.jobAnswersExample',
    tag: 'services.tagAnswers',
  },
  drafts: {
    label: 'services.jobDrafts',
    example: 'services.jobDraftsExample',
    tag: 'services.jobDrafts',
  },
  rewrites: {
    label: 'services.jobRewrites',
    example: 'services.jobRewritesExample',
    tag: 'services.jobRewrites',
  },
  summarises: {
    label: 'services.jobSummarises',
    example: 'services.jobSummarisesExample',
    tag: 'services.jobSummarises',
  },
  extracts: {
    label: 'services.jobExtracts',
    example: 'services.jobExtractsExample',
    tag: 'services.jobExtracts',
  },
  sorts: {
    label: 'services.jobSorts',
    example: 'services.jobSortsExample',
    tag: 'services.jobSorts',
  },
  prepares: {
    label: 'services.jobPrepares',
    example: 'services.jobPreparesExample',
    tag: 'services.jobPrepares',
  },
  transcribes: {
    label: 'services.jobTranscribes',
    example: 'services.jobTranscribesExample',
    tag: 'services.jobTranscribes',
  },
};

export const templateKeys: Record<string, { name: PlainKey; io: PlainKey }> = {
  'Spør dokumentene våre': { name: 'services.tplAnswers', io: 'services.tplAnswersIo' },
  'Utkast til svarbrev': { name: 'services.tplDrafts', io: 'services.tplDraftsIo' },
  'Klarspråk for utgående brev': { name: 'services.tplRewrites', io: 'services.tplRewritesIo' },
  'Sorter innkommende post': { name: 'services.tplSorts', io: 'services.tplSortsIo' },
  'Oppsummer høringssvar': { name: 'services.tplSummarises', io: 'services.tplSummarisesIo' },
  'Møtereferat fra lydopptak': { name: 'services.tplTranscribes', io: 'services.tplTranscribesIo' },
};

export const statusKeys: Record<ServiceStatus, PlainKey> = {
  Utkast: 'services.statusDraft',
  'I test': 'services.statusTest',
  'I bruk': 'services.statusLive',
  'Satt på pause': 'services.statusPaused',
  Arkivert: 'services.statusArchived',
};
