import type { T } from '../../i18n';
import { minimumReasonLength } from '../../reason';

export const reasonError = (reason: string, t: T) =>
  reason.trim().length < minimumReasonLength
    ? t('endpoints.reasonError', { min: minimumReasonLength })
    : undefined;

export { ReasonField } from '../../components/ReasonField';
