import { Textfield } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';

export const ReasonField = ({
  id,
  className,
  label,
  value,
  onChange,
  error,
  description,
  rows = 2,
  single = false,
  disabled = false,
}: {
  id?: string;
  className?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  description?: ReactNode;
  rows?: number;
  single?: boolean;
  disabled?: boolean;
}) => {
  const t = useT();
  const shared = {
    ...(id ? { id } : {}),
    ...(className ? { className } : {}),
    label: label ?? t('common.reason'),
    description,
    value,
    error,
    'aria-invalid': error ? true : undefined,
    disabled,
  };
  return single ? (
    <Textfield {...shared} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <Textfield {...shared} multiline rows={rows} onChange={(e) => onChange(e.target.value)} />
  );
};
