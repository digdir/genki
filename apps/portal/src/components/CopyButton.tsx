import { FilesIcon } from '@navikt/aksel-icons';
import { Button } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';

export const CopyButton = ({
  text,
  label,
  ariaLabel,
  onCopied,
}: {
  text: string;
  label?: string;
  ariaLabel?: string;
  onCopied?: () => void;
}) => {
  const t = useT();
  const [result, setResult] = useState<'copied' | 'failed'>();
  useEffect(() => {
    if (result !== 'copied') return;
    const timer = setTimeout(() => setResult(undefined), 2500);
    return () => clearTimeout(timer);
  }, [result]);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setResult('copied');
      onCopied?.();
    } catch {
      setResult('failed');
    }
  };
  return (
    <span className="copy">
      <Button
        variant="tertiary"
        data-size="sm"
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        onClick={() => void copy()}
      >
        <Icon icon={FilesIcon} size={16} />
        {label ?? t('common.copy')}
      </Button>
      <span role="status" className="copy-status">
        {result === 'copied'
          ? t('common.copied')
          : result === 'failed'
            ? t('common.copyFailed')
            : ''}
      </span>
    </span>
  );
};
