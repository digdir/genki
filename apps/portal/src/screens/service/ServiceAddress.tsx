import { ExternalLinkIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Heading,
  Link,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import type { HostnameState, HostnameView } from '../../types';
import { problemText } from './ServiceKeys';
import './service-address.css';

const stateText: Record<Exclude<HostnameState, 'removed'>, PlainKey> = {
  'pending-dns': 'serviceAddress.stateWaiting',
  binding: 'serviceAddress.stateBinding',
  active: 'serviceAddress.stateActive',
  failed: 'serviceAddress.stateFailed',
  lapsed: 'serviceAddress.stateLapsed',
  removing: 'serviceAddress.stateRemoving',
};

const stateColor: Record<Exclude<HostnameState, 'removed'>, string> = {
  'pending-dns': 'warning',
  binding: 'info',
  active: 'success',
  failed: 'danger',
  lapsed: 'danger',
  removing: 'neutral',
};

const failureText = (failure: string | null): PlainKey | undefined => {
  if (!failure) return undefined;
  if (failure.startsWith('not_verified')) return 'serviceAddress.failedNotVerified';
  if (failure.startsWith('expired')) return 'serviceAddress.failedExpired';
  return 'serviceAddress.failedBind';
};

export const activeAddress = (hostnames: readonly HostnameView[]) => {
  const active = hostnames.filter((h) => h.state === 'active' && !h.redirectTo);
  const name =
    active.find((h) => (h.environment ?? 'prod') === 'prod' && !h.assigned) ??
    active.find((h) => (h.environment ?? 'prod') === 'prod') ??
    active[0];
  return name ? `https://${name.hostname}/` : undefined;
};

export const ServiceAddress = ({
  api,
  tenant,
  service,
  canManage,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  canManage: boolean;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    (signal) => api.serviceHostnames(tenant, service, signal).catch(() => undefined),
    [api, tenant, service],
    { keepPreviousFor: service },
  );
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.status !== 'ready' || !state.data) return null;
  const { client, hostnames = [], assigns } = state.data;
  const shown = hostnames.filter((h) => h.state !== 'removed');
  const open = activeAddress(shown);
  const hasAssigned = shown.some((h) => h.assigned || h.managed);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      retry();
      return true;
    } catch (e) {
      setError(problemText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const hostname = domain.trim().toLowerCase();
    if (!client || !hostname || busy) return;
    const done = await act(() =>
      api.addHostname(
        tenant,
        client,
        { hostname, environment: 'prod' },
        t('serviceAddress.reasonAdd', { hostname }),
      ),
    );
    if (done) setDomain('');
  };

  return (
    <section aria-labelledby="fe-address-h" className="stack-sm dv-panel fe-address">
      <div className="row-between">
        <Heading level={3} data-size="2xs" id="fe-address-h">
          {t('serviceAddress.heading')}
        </Heading>
        {open ? (
          <Button asChild variant="secondary" data-size="sm">
            <a href={open} target="_blank" rel="noopener noreferrer">
              {t('serviceAddress.open')}
              <Icon icon={ExternalLinkIcon} />
              <span className="visually-hidden"> {t('serviceAddress.opensInNewTab')}</span>
            </a>
          </Button>
        ) : null}
      </div>
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      {shown.length === 0 ? (
        <Paragraph data-size="sm" className="meta">
          {t('serviceAddress.none')}
        </Paragraph>
      ) : (
        <ul className="fe-address-list">
          {shown.map((h) => {
            const visible = h.state as Exclude<HostnameState, 'removed'>;
            const failure = failureText(h.failure);
            return (
              <li key={h.id ?? h.hostname} className="stack-xs">
                <div className="row-between">
                  <span>
                    {h.state === 'active' && !h.redirectTo ? (
                      <Link
                        href={`https://${h.hostname}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {h.hostname}
                      </Link>
                    ) : (
                      <strong>{h.hostname}</strong>
                    )}{' '}
                    <Tag data-size="sm" data-color={stateColor[visible]}>
                      {t(stateText[visible])}
                    </Tag>
                  </span>
                  {canManage && !h.managed && h.state !== 'removing' ? (
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-disabled={busy || undefined}
                      onClick={() =>
                        !busy &&
                        void act(() =>
                          api.removeHostname(
                            tenant,
                            h.client,
                            h.hostname,
                            t('serviceAddress.reasonRemove', { hostname: h.hostname }),
                          ),
                        )
                      }
                    >
                      {t('serviceAddress.remove', { hostname: h.hostname })}
                    </Button>
                  ) : null}
                </div>
                {h.redirectTo ? (
                  <Paragraph data-size="sm" className="meta">
                    {t('serviceAddress.redirectsTo', { hostname: h.redirectTo })}
                  </Paragraph>
                ) : null}
                {failure ? (
                  <Paragraph data-size="sm" className="meta">
                    {t(failure)}
                  </Paragraph>
                ) : null}
                {h.state === 'pending-dns' && h.records.length > 0 ? (
                  <table className="fe-address-records">
                    <caption>{t('serviceAddress.records')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('serviceAddress.recordType')}</th>
                        <th scope="col">{t('serviceAddress.recordName')}</th>
                        <th scope="col">{t('serviceAddress.recordValue')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h.records.map((r) => (
                        <tr key={`${r.type} ${r.name}`}>
                          <td>{r.type}</td>
                          <td>
                            <code>{r.name}</code>
                          </td>
                          <td>
                            <code>{r.value}</code> <CopyButton text={r.value} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && assigns && !hasAssigned ? (
        <div>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={busy || undefined}
            onClick={() =>
              !busy &&
              void act(() => api.assignAddress(tenant, service, t('serviceAddress.reasonGive')))
            }
          >
            {t('serviceAddress.give')}
          </Button>
        </div>
      ) : null}
      {canManage && client ? (
        <form
          className="fe-address-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Textfield
            label={t('serviceAddress.customDomain')}
            data-size="sm"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="secondary"
            data-size="sm"
            aria-disabled={busy || !domain.trim() || undefined}
          >
            {t('serviceAddress.add')}
          </Button>
        </form>
      ) : null}
    </section>
  );
};
