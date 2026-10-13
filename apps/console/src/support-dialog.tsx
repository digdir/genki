import {
  Alert,
  Button,
  Dialog,
  Heading,
  Label,
  Paragraph,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { ApiCall } from './api-call';
import { useT, type T } from './i18n';
import { minimumReasonLength } from './reason';

export const reasonError = (t: T, text: string, min = minimumReasonLength) => {
  const count = text.trim().length;
  return count < min ? t('support.reasonTooShort', { min, count }) : undefined;
};

export interface SupportDialogProps {
  open: boolean;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
  initialReason?: string;
  hint: string;
  sees: string;
  cta: string;
  danger?: boolean;
  api: { method: string; path: string; body?: (reason: string) => unknown; proposed?: boolean };
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

export const SupportDialog = ({
  open,
  title,
  lead,
  children,
  initialReason = '',
  hint,
  sees,
  cta,
  danger = false,
  api,
  onClose,
  onConfirm,
}: SupportDialogProps) => {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState(initialReason);
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setReason(initialReason);
    setError(undefined);
    setFailed(undefined);
  }, [open, initialReason]);
  const confirm = async () => {
    const problem = reasonError(t, reason);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.problem?.title ? e.problem.title : t('support.saveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeButton={t('common.close')}
      aria-labelledby={`${id}-h`}
      className="reason-dialog"
    >
      {open ? (
        <div className="stack">
          <Heading level={2} data-size="xs" id={`${id}-h`}>
            {title}
          </Heading>
          {children}
          {lead ? <Paragraph>{lead}</Paragraph> : null}
          <div className="field">
            <Label htmlFor={`${id}-reason`}>{t('common.reason')}</Label>
            <Paragraph data-size="sm" className="meta" id={`${id}-hint`}>
              {hint}
            </Paragraph>
            <Textarea
              id={`${id}-reason`}
              rows={2}
              value={reason}
              aria-describedby={`${id}-hint`}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setError(undefined);
              }}
            />
            {error ? <ValidationMessage>{error}</ValidationMessage> : null}
          </div>
          <p className="info-note">{sees}</p>
          <ApiCall
            method={api.method}
            path={api.path}
            body={api.body?.(reason.trim())}
            proposed={api.proposed ?? false}
          />
          {failed ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {failed}
            </Alert>
          ) : null}
          <div className="actions-row">
            <Button
              loading={busy}
              data-color={danger ? 'danger' : 'accent'}
              onClick={() => void confirm()}
            >
              {cta}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
};
