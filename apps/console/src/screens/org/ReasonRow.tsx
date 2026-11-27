import { useState } from 'react';
import { ApiError } from '../../api';
import { useT } from '../../i18n';
import { reasonError } from '../../support-dialog';
import { ReasonField } from '../../components/ReasonField';

export const ReasonRow = ({
  colSpan,
  danger = false,
  warning,
  confirm,
  onConfirm,
  onCancel,
}: {
  colSpan: number;
  danger?: boolean;
  warning?: string;
  confirm: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}) => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    const problem = reasonError(t, reason);
    setError(problem);
    if (problem) return;
    setBusy(true);
    setFailed(undefined);
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setFailed(e instanceof ApiError && e.problem?.title ? e.problem.title : t('org.saveFailed'));
      setBusy(false);
    }
  };
  return (
    <tr>
      <td colSpan={colSpan} className={danger ? 'org-edit-cell danger' : 'org-edit-cell'}>
        <div className="org-edit" style={{ gap: 12 }}>
          {warning ? <span>{warning}</span> : null}
          <ReasonField
            value={reason}
            error={error}
            single
            onChange={(v) => {
              setReason(v);
              setError(undefined);
            }}
          />
          {failed ? (
            <p role="alert" className="error" style={{ margin: 0 }}>
              {failed}
            </p>
          ) : null}
          <div className="org-actions">
            <button
              type="button"
              className={danger ? 'org-btn danger' : 'org-btn primary'}
              aria-disabled={busy || undefined}
              onClick={() => void go()}
            >
              {confirm}
            </button>
            <button type="button" className="org-btn" onClick={onCancel}>
              {t('org.cancel')}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
};
