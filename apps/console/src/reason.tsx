import { Textfield } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT, type T } from './i18n';

export const minimumReasonLength = 10;

export const reasonTooShort = (reason: string, minLength = minimumReasonLength) =>
  reason.trim().length < minLength;

export const reasonProblem = (t: T, reason: string, minLength = minimumReasonLength) =>
  reasonTooShort(reason, minLength) ? t('common.reasonTooShort', { min: minLength }) : undefined;

export const useReason = () => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const require = () => {
    const ok = !reasonTooShort(reason);
    setMissing(!ok);
    return ok ? reason.trim() : undefined;
  };
  const field = (description: string) => (
    <Textfield
      className="reason"
      label={t('common.reason')}
      description={description}
      value={reason}
      onChange={(e) => {
        setReason(e.target.value);
        if (!reasonTooShort(e.target.value)) setMissing(false);
      }}
      error={missing ? reasonProblem(t, reason) : undefined}
    />
  );
  return { require, field };
};
