import { Textfield } from '@digdir/designsystemet-react';
import { BusyButton } from '../../components/BusyButton';
import { useState } from 'react';
import { reasonProblem } from '../../components/ReasonField';
import { useT } from '../../i18n';
import { Problems } from './Problems';

/** «Hva er endret?» and «Lagre ny utgave»: every save is a new edition with its reason. */
export const SaveBar = ({
  disabled = false,
  onSave,
}: {
  disabled?: boolean;
  onSave: (reason: string) => Promise<void>;
}) => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const problem = tried ? reasonProblem(reason, t) : undefined;
  const save = async () => {
    setTried(true);
    if (reasonProblem(reason, t)) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(reason.trim());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-xs">
      <div className="design-savebar">
        <Textfield
          className="design-reason"
          label={t('design.whatChanged')}
          value={reason}
          error={problem}
          onChange={(e) => setReason(e.target.value)}
        />
        <BusyButton
          busy={busy}
          busyLabel={t('design.saving')}
          aria-disabled={disabled || undefined}
          onClick={() => !disabled && void save()}
        >
          {t('design.saveEdition')}
        </BusyButton>
      </div>
      {error ? <Problems error={error} /> : null}
    </div>
  );
};
