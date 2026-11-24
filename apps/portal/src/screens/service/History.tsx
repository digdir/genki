import { Alert, Button, Dialog, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { PadlockLockedIcon } from '@navikt/aksel-icons';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiError } from '../../api/error';
import { productionEnvironment } from '../../api/environments';
import { BusyButton } from '../../components/BusyButton';
import { Icon } from '../../components/Icon';
import { asServiceDefinition, keepSharing } from '../../data/service-definition';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { useRights } from '../../Shell';
import { EmptyState, ErrorState, Loading } from '../../states';
import type { PublishedDefinition, VersionSummary } from '../../types';
import { problemErrors, withoutVersion } from './definition';
import { shortWhen } from './dev-format';
import { VersionDiff } from './VersionDiff';
import './sections.css';

type Asking = { kind: 'undo' | 'restore'; target: VersionSummary };

const ChangeDialog = ({
  asking,
  staged,
  onCancel,
  onConfirm,
}: {
  asking: Asking;
  staged: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) => {
  const { t, f } = usePortalFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const date = f.date(asking.target.publishedAt, 'medium');
  const action = asking.kind === 'undo' ? t('edition.undo') : t('edition.restore');
  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
    } catch (e) {
      setError(
        problemErrors(e, t)
          .map((p) => p.message)
          .join(' '),
      );
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modal
      closeButton={false}
      onClose={() => !busy && onCancel()}
      aria-labelledby="edition-change-h"
      aria-describedby="edition-change-d"
    >
      <div className="stack">
        <Heading level={2} data-size="sm" id="edition-change-h">
          {asking.kind === 'undo' ? t('edition.undoTitle') : t('edition.restoreTitle', { date })}
        </Heading>
        <Paragraph id="edition-change-d">
          {t('edition.undoBody', { date })}
          {staged ? ` ${t('edition.keepsTest')}` : ''}
        </Paragraph>
        {error ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="actions">
          <BusyButton
            variant="primary"
            data-size="sm"
            busy={busy}
            busyLabel={t('edition.working')}
            onClick={() => void confirm()}
          >
            {action}
          </BusyButton>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={busy || undefined}
            onClick={() => !busy && onCancel()}
          >
            {t('edition.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

export const History = ({
  api,
  tenant,
  serviceId,
  askUndo = false,
  onAsked,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  askUndo?: boolean;
  onAsked?: (() => void) | undefined;
  onChanged?: (() => void) | undefined;
}) => {
  const { t, f, actor } = usePortalFormat();
  const canManage = useRights().has('manage-services');
  const [round, setRound] = useState(0);
  const [state, retry] = useAsync(
    async (signal) => {
      const [history, pointers] = await Promise.all([
        api.getDefinition(tenant, 'Service', serviceId, signal),
        api.environments.list(tenant, serviceId, signal).catch(() => undefined),
      ]);
      return { history, environments: pointers?.environments };
    },
    [api, tenant, serviceId, round],
    { keepPreviousFor: `${tenant}/${serviceId}` },
  );
  const [open, setOpen] = useState<number>();
  const [asking, setAsking] = useState<Asking | 'fromLink' | undefined>(
    askUndo ? 'fromLink' : undefined,
  );

  const head = (
    <div className="stack-xs">
      <Heading level={2} data-size="sm">
        {t('edition.historyHeading')}
      </Heading>
      <Paragraph className="meta">{t('edition.historyLead')}</Paragraph>
    </div>
  );
  if (state.status === 'loading')
    return (
      <div className="stack">
        {head}
        <Loading label={t('edition.historyLoading')} shape="list" onRetry={retry} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="stack">
        {head}
        {state.error instanceof ApiError && state.error.status === 404 ? (
          <EmptyState title={t('serviceDev.versionsEmptyTitle')}>
            <p className="body-sm">{t('serviceDev.versionsEmptyBody')}</p>
          </EmptyState>
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );

  const { history, environments } = state.data;
  const staged = (environments?.length ?? 0) > 1;
  const canChange = canManage && environments !== undefined;
  const inUse =
    environments?.find((e) => e.name === productionEnvironment)?.version ?? history.latest.version;
  const rows = [...history.versions].filter((v) => v.version <= inUse).reverse();
  const before = rows.find((v) => v.version < inUse);
  const pending =
    asking === 'fromLink'
      ? before
        ? { kind: 'undo' as const, target: before }
        : undefined
      : asking;

  const close = () => {
    setAsking(undefined);
    if (asking === 'fromLink') onAsked?.();
  };

  const giveUsers = async ({ kind, target }: Asking) => {
    const date = f.date(target.publishedAt, 'medium');
    const reason =
      kind === 'undo' ? t('edition.undoReason', { date }) : t('edition.restoreReason', { date });
    if (staged) {
      await api.environments.rollback(
        tenant,
        serviceId,
        productionEnvironment,
        target.version,
        reason,
      );
    } else {
      const old: PublishedDefinition = await api.getVersion(
        tenant,
        'Service',
        serviceId,
        target.version,
      );
      await api.publishDefinition(
        withoutVersion({
          ...keepSharing(
            asServiceDefinition(old.definition),
            asServiceDefinition(history.latest.definition),
          ),
        }),
        old.files ?? {},
        reason,
      );
    }
    close();
    setOpen(undefined);
    setRound((r) => r + 1);
    onChanged?.();
  };

  return (
    <div className="stack">
      {head}
      <table className="edition-history" aria-label={t('edition.historyLabel')}>
        <tbody>
          {rows.map((v) => {
            const current = v.version === inUse;
            return (
              <tr key={v.version}>
                <td className="edition-history-when">{shortWhen(v.publishedAt, f)}</td>
                <td>
                  <div className="tag-row">
                    {v.reason ? <span>{v.reason}</span> : null}
                    {current ? (
                      <span className="edition-chip">
                        <Icon icon={PadlockLockedIcon} size={14} />
                        {t('edition.inUse')}
                      </span>
                    ) : null}
                  </div>
                  <div className="meta">
                    {actor(v.publishedBy, v.publishedByName)} ·{' '}
                    <Link asChild>
                      <button
                        type="button"
                        className="link-button"
                        aria-expanded={open === v.version}
                        onClick={() => setOpen((o) => (o === v.version ? undefined : v.version))}
                      >
                        {t('edition.showChanges')}
                      </button>
                    </Link>
                  </div>
                  {open === v.version ? (
                    <VersionDiff
                      api={api}
                      tenant={tenant}
                      serviceId={serviceId}
                      selected={v.version}
                      previous={history.versions
                        .map((x) => x.version)
                        .filter((n) => n < v.version)
                        .at(-1)}
                      full={false}
                      latest={history.latest}
                    />
                  ) : null}
                </td>
                <td className="edition-history-action">
                  {!canChange ? null : current ? (
                    before ? (
                      <Button
                        variant="secondary"
                        data-size="sm"
                        onClick={() => setAsking({ kind: 'undo', target: before })}
                      >
                        {t('edition.undo')}
                      </Button>
                    ) : null
                  ) : (
                    <Link asChild>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setAsking({ kind: 'restore', target: v })}
                      >
                        {t('edition.restore')}
                      </button>
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pending && canChange ? (
        <ChangeDialog
          asking={pending}
          staged={staged}
          onCancel={close}
          onConfirm={() => giveUsers(pending)}
        />
      ) : null}
    </div>
  );
};
