import {
  Alert,
  Button,
  Dialog,
  Dropdown,
  Heading,
  Paragraph,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { reasonProblem } from '../../components/ReasonField';
import { navigate, useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { ServiceLifecycleView } from '../../types';
import { lifecycleChanged, useServiceLifecycle, type LifecycleView } from './lifecycle';
import { actorLabel } from '../../format';
import { BatchDialog } from '../batch/BatchDialog';

export type Change = 'pause' | 'resume' | 'archive' | 'restore';

const target: Record<Change, ServiceLifecycleView['state']> = {
  pause: 'paused',
  resume: 'active',
  archive: 'archived',
  restore: 'active',
};

const infoKey: Record<Change, PlainKey> = {
  pause: 'serviceLifecycle.pauseInfo',
  resume: 'serviceLifecycle.resumeInfo',
  archive: 'serviceLifecycle.archiveInfo',
  restore: 'serviceLifecycle.restoreInfo',
};

const actionKey: Record<Change, PlainKey> = {
  pause: 'serviceLifecycle.pause',
  resume: 'serviceLifecycle.resume',
  archive: 'serviceLifecycle.archive',
  restore: 'serviceLifecycle.restore',
};

const dayMs = 86_400_000;

const PauseImpact = ({
  api,
  tenant,
  id,
  now,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  now: () => Date;
}) => {
  const t = useT();
  const [state] = useAsync(
    async (signal) =>
      (
        await api.tasks(
          tenant,
          { service: id, from: new Date(now().getTime() - 7 * dayMs).toISOString(), limit: 1 },
          signal,
        )
      ).total,
    [api, tenant, id],
  );
  return (
    <Paragraph>
      {state.status === 'ready'
        ? t('serviceLifecycle.pauseImpact', { count: state.data })
        : t('serviceLifecycle.pauseInfo')}
    </Paragraph>
  );
};

export const LifecycleDialog = ({
  api,
  tenant,
  id,
  name,
  change,
  onClose,
  onChanged,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  change: Change;
  onClose: () => void;
  onChanged?: () => void;
  now?: () => Date;
}) => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [showError, setShowError] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const pause = change === 'pause';
  const error = showError ? reasonProblem(reason, t) : undefined;

  const requestClose = () => {
    if (reason.trim()) setAsking(true);
    else onClose();
  };

  const title =
    change === 'pause'
      ? t('serviceLifecycle.pauseTitle', { name })
      : change === 'resume'
        ? t('serviceLifecycle.resumeTitle', { name })
        : change === 'archive'
          ? t('serviceLifecycle.archiveTitle', { name })
          : t('serviceLifecycle.restoreTitle', { name });

  const confirm = async () => {
    if (busy) return;
    if (reasonProblem(reason, t)) {
      setShowError(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      await api.setServiceLifecycle(tenant, id, target[change], reason.trim());
      onClose();
      lifecycleChanged(tenant, id);
      onChanged?.();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      modal
      closeButton={false}
      closedby="none"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      aria-labelledby="lifecycle-h"
    >
      <div className="stack">
        <div className="row-wrap spread">
          <Heading level={2} data-size="sm" id="lifecycle-h">
            {title}
          </Heading>
          <Button variant="tertiary" data-size="sm" onClick={requestClose}>
            {t('serviceLifecycle.close')}
          </Button>
        </div>
        {pause ? (
          <PauseImpact api={api} tenant={tenant} id={id} now={now} />
        ) : (
          <Paragraph>{t(infoKey[change])}</Paragraph>
        )}
        <Textfield
          multiline
          rows={3}
          label={pause ? t('serviceLifecycle.pauseReason') : t('common.reason')}
          description={pause ? t('serviceLifecycle.pauseReasonHelp') : undefined}
          value={reason}
          error={error}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setReason(e.target.value);
            setAsking(false);
          }}
        />
        {asking ? (
          <Alert data-color="warning" data-size="sm" role="alert">
            <Paragraph data-size="sm">{t('serviceLifecycle.discardAsk')}</Paragraph>
            <div className="actions">
              <Button data-size="sm" data-color="danger" onClick={onClose}>
                {t('serviceLifecycle.discard')}
              </Button>
              <Button data-size="sm" variant="secondary" onClick={() => setAsking(false)}>
                {t('serviceLifecycle.keepWriting')}
              </Button>
            </div>
          </Alert>
        ) : null}
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('serviceLifecycle.failed')}
          </Alert>
        ) : null}
        <div className="actions">
          <Button
            variant="primary"
            data-size="sm"
            aria-disabled={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy && pause ? t('serviceLifecycle.pausing') : t(actionKey[change])}
          </Button>
          <Button variant="secondary" data-size="sm" onClick={requestClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

type Refusal = { message: string; href?: string };

const placeOf = ({ path, id }: { path: string; id?: string }) =>
  path === 'frontends'
    ? '#/developer/frontends'
    : path === 'apiKeys'
      ? '#/developer/keys'
      : path === 'services' && id
        ? `#/services/${encodeURIComponent(id)}`
        : undefined;

export const DeleteServiceDialog = ({
  api,
  tenant,
  id,
  name,
  onClose,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  onClose: () => void;
}) => {
  const t = useT();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [refusals, setRefusals] = useState<Refusal[]>();
  const [busy, setBusy] = useState(false);
  const mismatch =
    showErrors && typed.trim() !== id ? t('serviceLifecycle.deleteMismatch') : undefined;
  const reasonError = showErrors ? reasonProblem(reason, t) : undefined;

  const confirm = async () => {
    if (busy) return;
    if (typed.trim() !== id || reasonProblem(reason, t)) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    setRefusals(undefined);
    try {
      await api.deleteService(tenant, id, reason.trim());
      onClose();
      navigate('/services');
    } catch (error) {
      const found: Refusal[] =
        error instanceof ApiError
          ? (error.problem?.errors ?? []).map((e) => {
              const href = placeOf(e);
              return href ? { message: e.message, href } : { message: e.message };
            })
          : [];
      setRefusals(found.length > 0 ? found : [{ message: t('serviceLifecycle.deleteFailed') }]);
      setBusy(false);
    }
  };

  return (
    <Dialog open modal closedby="any" onClose={onClose} aria-labelledby="delete-service-h">
      <div className="stack">
        <Heading level={2} data-size="sm" id="delete-service-h">
          {t('serviceLifecycle.deleteTitle', { name })}
        </Heading>
        <Paragraph>{t('serviceLifecycle.deleteInfo')}</Paragraph>
        <Textfield
          label={t('serviceLifecycle.deleteConfirm', { id })}
          value={typed}
          autoComplete="off"
          error={mismatch}
          aria-invalid={mismatch ? true : undefined}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Textfield
          multiline
          rows={3}
          label={t('common.reason')}
          value={reason}
          error={reasonError}
          aria-invalid={reasonError ? true : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        {refusals ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {refusals.map(({ message, href }) => (
              <Paragraph key={message} data-size="sm">
                {href ? <a href={href}>{message}</a> : message}
              </Paragraph>
            ))}
          </Alert>
        ) : null}
        <div className="actions">
          <Button
            variant="primary"
            data-color="danger"
            data-size="sm"
            aria-disabled={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy ? t('serviceLifecycle.deleting') : t('serviceLifecycle.delete')}
          </Button>
          <Button variant="secondary" data-size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export const ServiceLifecycle = ({
  api,
  tenant,
  id,
  name,
  onChanged,
  onCopy,
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  onChanged?: () => void;
  onCopy?: () => void;
}) => {
  const t = useT();
  const view = useServiceLifecycle(api, tenant, id);
  const [change, setChange] = useState<Change>();
  const [batchOpen, setBatchOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!view) return null;
  const current = view.state;
  const dialog = change ? (
    <LifecycleDialog
      api={api}
      tenant={tenant}
      id={id}
      name={name}
      change={change}
      onClose={() => setChange(undefined)}
      {...(onChanged ? { onChanged } : {})}
    />
  ) : null;

  if (current === 'archived')
    return (
      <>
        <Button variant="secondary" data-size="sm" onClick={() => setChange('restore')}>
          {t(actionKey.restore)}
        </Button>
        <Button
          variant="secondary"
          data-color="danger"
          data-size="sm"
          onClick={() => setDeleting(true)}
        >
          {t('serviceLifecycle.delete')}
        </Button>
        {dialog}
        {deleting ? (
          <DeleteServiceDialog
            api={api}
            tenant={tenant}
            id={id}
            name={name}
            onClose={() => setDeleting(false)}
          />
        ) : null}
      </>
    );

  return (
    <>
      <Dropdown.TriggerContext>
        <Dropdown.Trigger variant="secondary" data-size="sm">
          {t('serviceLifecycle.more')}
        </Dropdown.Trigger>
        <Dropdown
          placement="bottom-start"
          data-size="sm"
          aria-label={t('serviceLifecycle.moreFor', { name })}
        >
          <Dropdown.List>
            <Dropdown.Item>
              <Dropdown.Button onClick={() => setBatchOpen(true)}>
                {t('serviceLifecycle.batch')}
              </Dropdown.Button>
            </Dropdown.Item>
            {onCopy ? (
              <Dropdown.Item>
                <Dropdown.Button onClick={onCopy}>{t('serviceLifecycle.copy')}</Dropdown.Button>
              </Dropdown.Item>
            ) : null}
            {(current === 'paused'
              ? (['resume', 'archive'] as const)
              : (['pause', 'archive'] as const)
            ).map((c) => (
              <Dropdown.Item key={c}>
                <Dropdown.Button onClick={() => setChange(c)}>{t(actionKey[c])}</Dropdown.Button>
              </Dropdown.Item>
            ))}
          </Dropdown.List>
        </Dropdown>
      </Dropdown.TriggerContext>
      {dialog}
      {batchOpen ? (
        <BatchDialog api={api} tenant={tenant} id={id} onClose={() => setBatchOpen(false)} />
      ) : null}
    </>
  );
};

export const ArchivedBanner = ({
  canRestore,
  lifecycle,
  ...props
}: {
  api: ApiClient;
  tenant: string;
  id: string;
  name: string;
  lifecycle: LifecycleView;
  canRestore: boolean;
  onChanged?: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const { at, reason, by, byName } = lifecycle;
  const who = by ? actorLabel(by, t, byName) : undefined;
  const when = at ? f.date(at, 'long') : undefined;
  const why = reason?.trim();
  return (
    <div role="status" className="archived-banner">
      <div className="archived-banner-text">
        <strong>{t('serviceLifecycle.archivedTitle')}</strong>
        <span>
          {who && when
            ? `${t(why ? 'serviceLifecycle.archivedByWhy' : 'serviceLifecycle.archivedBy', { who, when, why: why ?? '' })} `
            : `${when ? `${t('serviceLifecycle.archivedAt', { date: when })} ` : ''}${why ? `«${why}». ` : ''}`}
          {t('serviceLifecycle.archivedText')}
        </span>
      </div>
      {canRestore ? <ServiceLifecycle {...props} /> : null}
    </div>
  );
};
