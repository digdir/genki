import { Textfield } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';

export const ReasonField = ({
  value,
  onChange,
  error,
  description,
  rows = 2,
  single = false,
  disabled = false,
}: {
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
    label: t('common.reason'),
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
