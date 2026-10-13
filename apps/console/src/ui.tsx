import {
  Alert,
  Button,
  Dialog,
  Heading,
  Paragraph,
  Textarea,
  Label,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { intlLocale, type Format } from '@genai/i18n';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { useT, type T } from './i18n';
import { minimumReasonLength } from './reason';

export const PageHeader = ({
  title,
  intro,
  eyebrow,
}: {
  title: string;
  intro?: ReactNode;
  eyebrow?: string;
}) => {
  const t = useT();
  return (
    <div className="page-header">
      <span className="eyebrow">{eyebrow ?? t('common.allTenants')}</span>
      <Heading level={1} data-size="lg">
        {title}
      </Heading>
      {intro ? <p className="intro">{intro}</p> : null}
    </div>
  );
};

export type FlashMessage = { text: string; color?: 'success' | 'info' | 'danger' | 'warning' };

export const Flash = ({ message }: { message: FlashMessage | undefined }) => (
  <div aria-live="polite" className="flash">
    {message ? (
      <Alert data-color={message.color ?? 'success'} data-size="sm">
        {message.text}
      </Alert>
    ) : null}
  </div>
);

export const useFlash = () => {
  const [message, setMessage] = useState<FlashMessage | undefined>();
  const show = useCallback(
    (text: string, color: FlashMessage['color'] = 'success') => setMessage({ text, color }),
    [],
  );
  const clear = useCallback(() => setMessage(undefined), []);
  return { message, show, clear };
};

export const Kpis = ({
  items,
  label,
}: {
  items: { label: string; value: string }[];
  label?: string;
}) => (
  <dl className="kpis" {...(label ? { 'aria-label': label } : {})}>
    {items.map((k) => (
      <div key={k.label}>
        <dt>{k.label}</dt>
        <dd>{k.value}</dd>
      </div>
    ))}
  </dl>
);

export const TableRegion = ({
  label,
  labelledBy,
  children,
}: {
  label?: string;
  labelledBy?: string;
  children: ReactNode;
}) => (
  <div
    className="table-region"
    tabIndex={0}
    role="region"
    {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': label })}
  >
    {children}
  </div>
);

export const Meter = ({ percent, warn }: { percent: number; warn?: boolean }) => (
  <span className="meter" aria-hidden="true">
    <span
      className={warn ? 'meter-fill warn' : 'meter-fill'}
      style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
    />
  </span>
);

export const VisuallyHidden = ({ children }: { children: ReactNode }) => (
  <span className="visually-hidden">{children}</span>
);

export const isMissing = (error: unknown) =>
  error instanceof ApiError &&
  (error.status === 404 || error.status === 405 || error.status === 501);

export const Unavailable = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="state empty">
    <Heading level={2} data-size="xs">
      {title}
    </Heading>
    <Paragraph>{children}</Paragraph>
  </div>
);

const dayFormat = (f: Format) =>
  new Intl.DateTimeFormat(intlLocale(f.locale), {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Oslo',
  });

export const formatWhen = (iso: string, f: Format, t: T, now = new Date()) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = f.time(d);
  return f.date(d, 'short') === f.date(now, 'short')
    ? t('common.todayAt', { time })
    : t('common.dayAt', { date: dayFormat(f).format(d), time });
};

export const formatDay = (iso: string, f: Format) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dayFormat(f).format(d);
};

export const minutesLeft = (iso: string, now = Date.now()) =>
  Math.max(1, Math.ceil((new Date(iso).getTime() - now) / 60000));

export const NotDecided = () => {
  const t = useT();
  return (
    <span className="ds-tag" data-size="sm" data-color="warning">
      {t('common.notDecided')}
    </span>
  );
};

export class DialogError extends Error {}

export const ReasonDialog = ({
  open,
  title,
  text,
  confirmLabel,
  minLength = minimumReasonLength,
  onConfirm,
  onClose,
  children,
  info = false,
}: {
  open: boolean;
  title: string;
  text?: ReactNode;
  confirmLabel: string;
  minLength?: number;
  onConfirm?: (reason: string) => Promise<void> | void;
  onClose: () => void;
  children?: ReactNode;
  info?: boolean;
}) => {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(undefined);
    }
  }, [open]);
  const confirm = async () => {
    if (info || !onConfirm) return onClose();
    if (reason.trim().length < minLength) {
      setError(t('common.reasonTooShortAudited', { min: minLength }));
      return;
    }
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(e instanceof DialogError ? e.message : t('common.saveFailed'));
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
          {text ? <Paragraph>{text}</Paragraph> : null}
          {children}
          {info ? null : (
            <div className="field">
              <Label htmlFor={`${id}-reason`}>{t('common.reason')}</Label>
              <Textarea
                id={`${id}-reason`}
                rows={2}
                value={reason}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(undefined);
                }}
              />
              {error ? <ValidationMessage>{error}</ValidationMessage> : null}
            </div>
          )}
          <div className="actions-row">
            <Button onClick={() => void confirm()} loading={busy}>
              {info ? t('common.close') : confirmLabel}
            </Button>
            {info ? null : (
              <Button variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
};

export const SidePanel = ({
  labelledBy,
  onClose,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) => {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const [modal, setModal] = useState(() => window.innerWidth < 760);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onResize = () => setModal(window.innerWidth < 760);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    ref.current?.querySelector<HTMLElement>('h2')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);
  return (
    <aside
      ref={ref}
      className="side-panel"
      role="dialog"
      aria-modal={modal}
      aria-labelledby={labelledBy}
    >
      <Button
        variant="tertiary"
        data-size="sm"
        className="panel-close"
        onClick={onClose}
        aria-label={t('common.close')}
        icon
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </Button>
      {children}
    </aside>
  );
};

export const pseudonym = (seed: string) => {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  let v = h >>> 0;
  for (let i = 0; i < 4; i++) {
    out += alphabet[v % alphabet.length];
    v = Math.floor(v / alphabet.length);
  }
  return `A-${out}`;
};

export interface InUse {
  name: string;
  tenant?: string;
}

const text = (...values: unknown[]) => values.find((v) => typeof v === 'string' && v) as string;

export const inUseOf = (error: unknown, key: 'services' | 'datasets'): InUse[] | undefined => {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const listed = (error.problem?.[key] ?? []).flatMap((x): InUse[] => {
    if (typeof x === 'string') return [{ name: x }];
    if (!x || typeof x !== 'object') return [];
    const r = x as Record<string, unknown>;
    const tenant = text(r.tenantName, r.tenant);
    return [
      {
        name: text(r.name, r.title, r.service, r.dataset, r.id) ?? '',
        ...(tenant ? { tenant } : {}),
      },
    ];
  });
  return listed.length ? listed : (error.problem?.errors ?? []).map((e) => ({ name: e.message }));
};

export const InUseList = ({
  items,
  tenantName,
}: {
  items: InUse[];
  tenantName: (tenant: string) => string;
}) => (
  <ul className="service-list">
    {items.map((u) => (
      <li key={`${u.tenant ?? ''}/${u.name}`}>
        <span>
          <strong>{u.name}</strong>
          {u.tenant ? ` · ${tenantName(u.tenant)}` : ''}
        </span>
      </li>
    ))}
  </ul>
);
