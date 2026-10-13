import { Button } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { Icon, icons } from './Icon';

export const CopyButton = ({
  text,
  label,
  ariaLabel,
}: {
  text: string;
  label?: string;
  ariaLabel?: string;
}) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="copy">
      <Button
        variant="tertiary"
        data-size="sm"
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        onClick={() => {
          void navigator.clipboard?.writeText(text).catch(() => undefined);
          setCopied(true);
        }}
      >
        <Icon d={icons.copy} size={16} />
        {label ?? t('common.copy')}
      </Button>
      <span role="status" className="copy-status">
        {copied ? t('common.copied') : ''}
      </span>
    </span>
  );
};
