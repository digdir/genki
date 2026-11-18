import { Label, Textarea, ValidationMessage } from '@digdir/designsystemet-react';
import { useId } from 'react';
import { useT, type T } from '../../i18n';
import { minimumReasonLength } from '../../reason';

export const reasonError = (reason: string, t: T) =>
  reason.trim().length < minimumReasonLength
    ? t('endpoints.reasonError', { min: minimumReasonLength })
    : undefined;

export const ReasonField = ({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) => {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id}>{t('common.reason')}</Label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
    </div>
  );
};
