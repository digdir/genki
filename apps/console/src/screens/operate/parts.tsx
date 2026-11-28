import { Dialog } from '@digdir/designsystemet-react';
import { intlLocale, type Format } from '@genai/i18n';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import type { AsyncState } from '../../hooks';
import { ReasonField } from '../../components/ReasonField';
import { useT, type PlainKey } from '../../i18n';
import { reasonProblem } from '../../reason';

export const useKept = <D,>(state: AsyncState<D>) => {
  const [kept, setKept] = useState<D | undefined>();
  useEffect(() => {
    if (state.status === 'ready') setKept(state.data);
  }, [state]);
  return state.status === 'ready' ? state.data : kept;
};

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export const Chip = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span className="op-chip" data-tone={tone}>
    {children}
  </span>
);

const osloDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

export const sameDay = (a: Date, b: Date) => osloDay(a) === osloDay(b);

export const clock = (iso: string, f: Format) => {
  const time = f.time(iso);
  return f.locale === 'en' ? time : time.replace(':', '.');
};

export const dayMonth = (iso: string, f: Format) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Oslo',
  }).format(new Date(iso));

export const shortMonth = (date: Date, f: Format) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Oslo',
  })
    .formatToParts(date)
    .find((p) => p.type === 'month')?.value ?? '';

export const inboxTypeLabel: Record<string, PlainKey> = {
  quota: 'orgList.typeQuota',
  access: 'orgList.typeAccess',
  catalogue: 'orgList.typeCatalogue',
  'work-instruction': 'orgList.typeWorkInstruction',
  suggestion: 'orgList.typeSuggestion',
  incident: 'orgList.typeIncident',
  expiring: 'orgList.typeExpiring',
};

export const orgHref = (tenant: string, tab?: string) =>
  `#/support-access?${new URLSearchParams(tab ? { tenant, tab } : { tenant }).toString()}`;

export const runHref = (tenant: string, task: string) =>
  `#/diagnostics?${new URLSearchParams({ tenant, task }).toString()}`;

export const OperateDialog = ({
  open,
  title,
  lead,
  hint,
  cta,
  initialReason = '',
  children,
  validate,
  onConfirm,
  onClose,
  failedText,
}: {
  open: boolean;
  title: string;
  lead?: ReactNode;
  hint?: ReactNode;
  cta: string;
  initialReason?: string;
  children?: ReactNode;
  validate?: () => boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
  failedText?: string;
}) => {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState(initialReason);
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) onClose();
  };
  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setReason(initialReason);
    setError(undefined);
    setFailed(undefined);
  }, [open, initialReason]);
  const confirm = async () => {
    if (busy) return;
    const fieldsOk = validate ? validate() : true;
    const problem = reasonProblem(t, reason);
    setError(problem);
    if (problem || !fieldsOk) return;
    setBusy(true);
    setFailed(undefined);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.problem?.title
          ? e.problem.title
          : (failedText ?? t('common.saveFailed')),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      closeButton={false}
      aria-labelledby={`${id}-h`}
      {...(lead ? { 'aria-describedby': `${id}-lead` } : {})}
      className="op-dialog"
    >
      {open ? (
        <form
          className="op-dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <h2 id={`${id}-h`}>{title}</h2>
          {lead ? (
            <p id={`${id}-lead`} className="op-subtle">
              {lead}
            </p>
          ) : null}
          {children}
          <ReasonField
            value={reason}
            onChange={(v) => {
              setReason(v);
              setError(undefined);
            }}
            error={error}
            description={hint}
            rows={3}
          />
          {failed ? (
            <p className="op-error" role="alert">
              {failed}
            </p>
          ) : null}
          <div className="op-dialog-actions">
            <button type="submit" className="op-btn primary wide" aria-disabled={busy || undefined}>
              {cta}
            </button>
            <button
              type="button"
              className="op-btn wide"
              aria-disabled={busy || undefined}
              onClick={close}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
};
