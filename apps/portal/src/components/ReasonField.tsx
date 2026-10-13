import { Textfield } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { translator, useT, type T } from '../i18n';

const nbT = translator('nb');

export const minimumReasonLength = 10;

export const reasonProblem = (reason: string, t: T = nbT, minLength = minimumReasonLength) =>
  reason.trim().length < minLength ? t('common.reasonTooShort', { min: minLength }) : undefined;

export const ReasonField = ({
  value,
  onChange,
  minLength = minimumReasonLength,
  showError = false,
  description,
  rows = 2,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  showError?: boolean;
  description?: ReactNode;
  rows?: number;
  disabled?: boolean;
}) => {
  const t = useT();
  const error = showError ? reasonProblem(value, t, minLength) : undefined;
  return (
    <Textfield
      multiline
      rows={rows}
      label={t('common.reason')}
      description={description}
      value={value}
      error={error}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
