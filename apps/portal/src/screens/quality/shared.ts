import { ApiError } from '../../api';
import type { CaseSplit, CaseType } from '../../api/quality';
import type { CaseDetail } from '../../data/quality';
import { translator, type PlainKey, type T } from '../../i18n';
import { uniqueId } from '../datasets/live-model';

export type Flash = { text: string; color: 'success' | 'info' | 'warning' | 'danger' } | undefined;

export type SetFlash = (flash: Flash) => void;

export const kindKeys: Record<CaseDetail['kind'], PlainKey> = {
  kilder: 'quality.kindSources',
  kriterier: 'quality.kindCriteria',
  felter: 'quality.kindFields',
  avvis: 'quality.kindReject',
};

const nynorsk =
  /\b(Kva|kva|seier|evalueringane|Evalueringane|ventetida|Ventetida|minutt i snitt)\b/;

export const langOf = (text: string) => (nynorsk.test(text) ? 'nn' : undefined);

export interface Decision {
  state: 'pending' | 'approved' | 'rejected' | 'testing';
  approvers: string[];
  comment?: string;
}

export type NewCase = Omit<CaseDetail, 'id' | 'last'>;

const nbT = translator('nb');

export const problemTitle = (error: unknown, t: T = nbT) => {
  if (!(error instanceof ApiError)) return t('quality.noAnswer');
  const details = (error.problem?.errors ?? []).map((e) => e.message).filter(Boolean);
  if (error.status === 400 && details.length)
    return t('quality.rejected', { details: details.join('; ') });
  return error.problem?.title || t('quality.noAnswer');
};

export const testSetId = (serviceId: string, name: string, taken: string[]) =>
  uniqueId(`${serviceId} ${name}`, taken);

export const caseTypeKeys: Record<CaseType, PlainKey> = {
  criteria: 'quality.kindCriteria',
  exact: 'quality.typeExact',
  must_reject: 'quality.kindReject',
};

export const splitKeys: Record<CaseSplit, PlainKey> = {
  locked: 'quality.splitLockedLong',
  open: 'quality.splitOpenLong',
};
