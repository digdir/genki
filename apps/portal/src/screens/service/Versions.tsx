import { Alert, Button, Paragraph, Tag, Textfield } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { productionEnvironment } from '../../api/environments';
import { asServiceDefinition, keepSharing } from '../../data/service-definition';
import { actorLabel } from '../../format';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { useFormat } from '@genai/i18n/react';
import { ErrorState, Loading } from '../../states';
import type { PublishedDefinition } from '../../types';
import { definitionYaml, problemErrors, withoutVersion } from './definition';
import './sections.css';
import { reasonProblem } from '../../components/ReasonField';
import { useRights } from '../../Shell';
import { Environments } from './Environments';

interface Props {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  onPublished?: (published: PublishedDefinition) => void;
}

const VersionYaml = ({
  api,
  tenant,
  serviceId,
  version,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  version: number;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    (signal) => api.getVersion(tenant, 'Service', serviceId, version, signal),
    [api, tenant, serviceId, version],
  );
  if (state.status === 'loading')
    return (
      <Loading
        label={t('serviceVersions.loadingVersion', { version })}
        shape="detail"
        onRetry={retry}
      />
    );
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return (
    <pre
      tabIndex={0}
      className="version-yaml"
      aria-label={t('serviceVersions.yamlLabel', { version })}
    >
      <code>{definitionYaml(state.data.definition)}</code>
    </pre>
  );
};

export const Versions = ({ api, tenant, serviceId, onPublished }: Props) => {
  const t = useT();
  const f = useFormat();
  const [round, setRound] = useState(0);
  const [state, retry, pending] = useAsync(
    (signal) => api.getDefinition(tenant, 'Service', serviceId, signal),
    [api, tenant, serviceId, round],
    { keepPreviousFor: `${tenant}/${serviceId}` },
  );
  const [environments, retryEnvironments] = useAsync(
    (signal) =>
      api.environments
        .list(tenant, serviceId, signal)
        .catch((e: unknown) =>
          e instanceof ApiError && e.status === 404 ? undefined : Promise.reject(e),
        ),
    [api, tenant, serviceId, round],
    { keepPreviousFor: `${tenant}/${serviceId}` },
  );
  const canManage = useRights().has('manage-services');
  const [open, setOpen] = useState<number>();
  const [confirm, setConfirm] = useState<number>();
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  if (state.status === 'loading')
    return <Loading label={t('serviceVersions.loading')} shape="list" onRetry={retry} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const current = state.data.latest.version;
  const versions = [...state.data.versions].reverse();
  const pointers = environments.status === 'ready' ? environments.data?.environments : undefined;
  const staged = pointers !== undefined && pointers.length > 1;
  const runningIn = (version: number) =>
    (pointers ?? []).filter((e) => e.version === version).map((e) => e.name);
  const followers = (pointers ?? []).filter((e) => e.followsPublishes).map((e) => e.name);

  const restore = async (version: number) => {
    const reasonError = reasonProblem(reason);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const old = await api.getVersion(tenant, 'Service', serviceId, version);
      const published = await api.publishDefinition(
        withoutVersion({
          ...keepSharing(
            asServiceDefinition(old.definition),
            asServiceDefinition(state.data.latest.definition),
          ),
        }),
        old.files ?? {},
        reason.trim(),
      );
      setConfirm(undefined);
      setReason('');
      setMessage({
        ok: true,
        text: t('serviceVersions.republished', { version, published: published.version }),
      });
      onPublished?.(published);
      setRound((r) => r + 1);
    } catch (error) {
      setMessage({
        ok: false,
        text: problemErrors(error, t)
          .map((e) => e.message)
          .join(' '),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {environments.status === 'error' ? (
        <ErrorState error={environments.error} onRetry={retryEnvironments} />
      ) : null}
      {environments.status === 'ready' && environments.data ? (
        <Environments
          api={api}
          tenant={tenant}
          serviceId={serviceId}
          data={environments.data}
          versions={versions.map((v) => v.version)}
          canManage={canManage}
          onChanged={() => setRound((r) => r + 1)}
        />
      ) : null}
      <div className="stack-sm">
        <div aria-live="polite">
          {message ? (
            <Alert data-color={message.ok ? 'success' : 'danger'} data-size="sm">
              {message.text}
            </Alert>
          ) : null}
        </div>
        <ol
          className="plain-list version-list"
          aria-label={t('serviceVersions.listLabel')}
          aria-busy={pending || undefined}
        >
          {versions.map((v) => {
            const showing = open === v.version;
            const confirming = confirm === v.version;
            return (
              <li key={v.version}>
                <div className="tag-row">
                  <span className="version-name">
                    {t('serviceVersions.version', { version: v.version })}
                  </span>
                  {staged && runningIn(v.version).length ? (
                    runningIn(v.version).map((name) => (
                      <Tag
                        key={name}
                        data-size="sm"
                        data-color={name === productionEnvironment ? 'success' : 'info'}
                      >
                        {t('serviceVersions.runsIn', { environment: name })}
                      </Tag>
                    ))
                  ) : (
                    <Tag
                      data-size="sm"
                      data-color={v.version === current && !staged ? 'success' : 'neutral'}
                    >
                      {v.version === current && !staged
                        ? t('serviceVersions.inUse')
                        : t('serviceVersions.earlier')}
                    </Tag>
                  )}
                  <span className="meta">
                    {f.dateTime(v.publishedAt, 'medium')} ·{' '}
                    {actorLabel(v.publishedBy, t, v.publishedByName)}
                  </span>
                </div>
                {v.reason ? (
                  <span className="meta">
                    {t('serviceVersions.reasonLine', { reason: v.reason })}
                  </span>
                ) : null}
                <div className="row-wrap">
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    aria-expanded={showing}
                    onClick={() => setOpen(showing ? undefined : v.version)}
                  >
                    {showing ? t('serviceVersions.hideYaml') : t('serviceVersions.showYaml')}
                    <span className="visually-hidden">
                      {t('serviceVersions.hiddenVersion', { version: v.version })}
                    </span>
                  </Button>
                  {v.version === current || confirming ? null : (
                    <Button
                      variant="secondary"
                      data-size="sm"
                      onClick={() => {
                        setConfirm(v.version);
                        setReasonErr('');
                      }}
                    >
                      {t('serviceVersions.restore')}
                      <span className="visually-hidden">
                        {t('serviceVersions.hiddenVersion', { version: v.version })}
                      </span>
                    </Button>
                  )}
                </div>
                {showing ? (
                  <VersionYaml
                    api={api}
                    tenant={tenant}
                    serviceId={serviceId}
                    version={v.version}
                  />
                ) : null}
                {confirming ? (
                  <Alert data-color="warning" data-size="sm">
                    <Paragraph data-size="sm">
                      {!staged
                        ? t('serviceVersions.confirm', { version: v.version, current })
                        : followers.length
                          ? t('serviceVersions.confirmEnvironments', {
                              version: v.version,
                              environments: followers.join(', '),
                            })
                          : t('serviceVersions.confirmPinned', { version: v.version })}
                    </Paragraph>
                    <Textfield
                      label={t('serviceVersions.reason')}
                      value={reason}
                      error={reasonErr || undefined}
                      onChange={(e) => {
                        setReason(e.target.value);
                        setReasonErr('');
                      }}
                    />
                    <div className="row-wrap">
                      <Button
                        variant="primary"
                        data-size="sm"
                        loading={busy}
                        onClick={() => !busy && void restore(v.version)}
                      >
                        {t('serviceVersions.publishAgain', { version: v.version })}
                      </Button>
                      <Button
                        variant="secondary"
                        data-size="sm"
                        onClick={() => setConfirm(undefined)}
                      >
                        {t('serviceVersions.cancel')}
                      </Button>
                    </div>
                  </Alert>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
};
