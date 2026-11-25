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
import { ApiError, type ApiClient } from '../../api';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import type { HostnameState, HostnameView } from '../../types';
import { problemText } from './ServiceKeys';
import { servicePath } from './sections';
import './service-address.css';

type Visible = Exclude<HostnameState, 'removed'>;

const stateText: Record<Visible, PlainKey> = {
  'pending-dns': 'serviceAddress.stateWaiting',
  binding: 'serviceAddress.stateBinding',
  active: 'serviceAddress.stateActive',
  failed: 'serviceAddress.stateFailed',
  lapsed: 'serviceAddress.stateLapsed',
  removing: 'serviceAddress.stateRemoving',
};

const stateColor: Record<Visible, string> = {
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

export const mainHostname = (hostnames: readonly HostnameView[]) => {
  const main = hostnames.filter(
    (h) => h.state !== 'removed' && !h.redirectTo && (h.environment ?? 'prod') === 'prod',
  );
  return (
    main.find((h) => h.state === 'active' && !h.assigned) ??
    main.find((h) => h.state === 'active') ??
    main.find((h) => h.assigned) ??
    main[0]
  );
};

const refusals: [RegExp, PlainKey][] = [
  [/^no_zone/, 'serviceAddress.noZone'],
  [/^(not_published|no_interface)/, 'serviceAddress.needsApp'],
  [/^has_address/, 'serviceAddress.hasAddress'],
  [/^hostname_limit/, 'serviceAddress.limit'],
];

export const refusalText = (error: unknown, t: T) => {
  const found = error instanceof ApiError ? error.problem?.errors?.[0] : undefined;
  if (found?.path === 'principal' && /lockdown/.test(found.message))
    return t('serviceAddress.operatorsOnly');
  const known = refusals.find(([code]) => code.test(found?.message ?? ''));
  return known ? t(known[1]) : problemText(error, t);
};

const useHostnames = (api: ApiClient, tenant: string, service: string, published = true) => {
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) =>
      published ? api.serviceHostnames(tenant, service, signal).catch(() => undefined) : undefined,
    [api, tenant, service, published],
    { keepPreviousFor: service },
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<unknown>, explain = problemText) => {
    setBusy(true);
    setError('');
    try {
      await work();
      retry();
      return true;
    } catch (e) {
      setError(explain(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const give = () =>
    !busy &&
    void act(() => api.assignAddress(tenant, service, t('serviceAddress.reasonGive')), refusalText);
  return { state, error, busy, act, give };
};

const NoAddress = ({
  service,
  hasApp,
  assigns,
  canManage,
  busy,
  onGive,
}: {
  service: string;
  hasApp: boolean;
  assigns: boolean;
  canManage: boolean;
  busy: boolean;
  onGive: () => void;
}) => {
  const t = useT();
  if (!hasApp)
    return (
      <Paragraph data-size="sm" className="meta">
        {t('serviceAddress.needsApp')}{' '}
        <Link href={`#${servicePath(service, 'interface')}`}>{t('serviceAddress.toDesign')}</Link>
      </Paragraph>
    );
  if (!assigns)
    return (
      <Paragraph data-size="sm" className="meta">
        {t('serviceAddress.noZone')}
      </Paragraph>
    );
  if (!canManage)
    return (
      <Paragraph data-size="sm" className="meta">
        {t('serviceAddress.none')}
      </Paragraph>
    );
  return (
    <div>
      <Button variant="secondary" data-size="sm" aria-disabled={busy || undefined} onClick={onGive}>
        {t('serviceAddress.give')}
      </Button>
    </div>
  );
};

export const ServiceWebPage = ({
  api,
  tenant,
  service,
  published,
  hasApp,
  canManage,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  published: boolean;
  hasApp: boolean;
  canManage: boolean;
}) => {
  const t = useT();
  const { state, error, busy, give } = useHostnames(api, tenant, service, published);
  const data = state.status === 'ready' ? state.data : undefined;
  if (published && !data) return null;
  const main = mainHostname(data?.hostnames ?? []);
  const failure = main ? failureText(main.failure) : undefined;
  return (
    <div className="stack-xs fe-webpage">
      {error ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {error}
        </Alert>
      ) : null}
      {main?.state === 'active' ? (
        <Link href={`https://${main.hostname}/`} target="_blank" rel="noopener noreferrer">
          {main.hostname}
          <Icon icon={ExternalLinkIcon} />
          <span className="visually-hidden"> {t('serviceAddress.opensInNewTab')}</span>
        </Link>
      ) : main ? (
        <>
          <span>
            <strong>{main.hostname}</strong>{' '}
            <Tag data-size="sm" data-color={stateColor[main.state as Visible]}>
              {t(stateText[main.state as Visible])}
            </Tag>
          </span>
          {main.state === 'binding' ? (
            <span className="meta">{t('serviceAddress.takesMinutes')}</span>
          ) : null}
          {failure ? <span className="meta">{t(failure)}</span> : null}
        </>
      ) : null}
      {!main || (!main.assigned && main.state !== 'active' && hasApp && canManage) ? (
        <NoAddress
          service={service}
          hasApp={hasApp && published}
          assigns={data?.assigns ?? false}
          canManage={canManage}
          busy={busy}
          onGive={give}
        />
      ) : null}
    </div>
  );
};

export const ServiceWebPageSection = (props: Parameters<typeof ServiceWebPage>[0]) => {
  const t = useT();
  return (
    <section aria-labelledby="webpage-h" className="stack-sm">
      <Heading level={3} data-size="2xs" id="webpage-h">
        {t('serviceAddress.webPage')}
      </Heading>
      <ServiceWebPage {...props} />
    </section>
  );
};

export const ServiceAddress = ({
  api,
  tenant,
  service,
  hasApp,
  canManage,
}: {
  api: ApiClient;
  tenant: string;
  service: string;
  hasApp: boolean;
  canManage: boolean;
}) => {
  const t = useT();
  const { state, error, busy, act, give } = useHostnames(api, tenant, service);
  const [domain, setDomain] = useState('');

  if (state.status !== 'ready' || !state.data) return null;
  const { client, hostnames = [], assigns } = state.data;
  const shown = hostnames.filter((h) => h.state !== 'removed');
  const open = activeAddress(shown);
  const hasAssigned = shown.some((h) => h.assigned || h.managed);

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
      {shown.length === 0 ? null : (
        <ul className="fe-address-list">
          {shown.map((h) => {
            const visible = h.state as Visible;
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
      {shown.length === 0 || (canManage && assigns && hasApp && !hasAssigned) ? (
        <NoAddress
          service={service}
          hasApp={hasApp}
          assigns={assigns}
          canManage={canManage}
          busy={busy}
          onGive={give}
        />
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
