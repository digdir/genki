import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { Fragment, useId, useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import type { TenantHostname, TenantPerson } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import type { TenantKey } from '../../types';
import { Chip, shortDay, type Tone } from './parts';
import { ReasonRow } from './ReasonRow';

const keyStatus = (k: TenantKey, now: Date): [PlainKey, Tone] =>
  k.revokedAt
    ? ['org.keyRevoked', 'neutral']
    : k.expiresAt && new Date(k.expiresAt).getTime() < now.getTime()
      ? ['org.keyExpired', 'neutral']
      : ['org.keyActive', 'success'];

const roleOf = (p: TenantPerson): PlainKey =>
  p.rights.includes('manage-services')
    ? 'org.roleAdmin'
    : p.rights.some((r) => r === 'manage-datasets' || r === 'register-building-blocks')
      ? 'org.roleDeveloper'
      : 'org.roleReader';

const hostStates: Record<TenantHostname['state'], [PlainKey, Tone]> = {
  active: ['org.hostActive', 'success'],
  'pending-dns': ['org.hostPending', 'warning'],
  binding: ['org.hostBinding', 'info'],
  failed: ['org.hostFailed', 'danger'],
  lapsed: ['org.hostLapsed', 'neutral'],
  removing: ['org.hostRemoving', 'neutral'],
  removed: ['org.hostRemoving', 'neutral'],
};

const lastLogin = (iso: string | null | undefined, f: Format, t: T, now: Date) => {
  if (!iso) return '';
  return new Date(iso).toDateString() === now.toDateString() ? t('org.today') : shortDay(iso, f);
};

const Keys = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const now = new Date();
  const [state, retry] = useAsync((signal) => api.tenantKeys(tenant, signal), [api, tenant]);
  const [changed, setChanged] = useState<TenantKey[]>();
  const [asking, setAsking] = useState<TenantKey>();
  const [done, setDone] = useState<string>();
  const keys = changed ?? (state.status === 'ready' ? state.data : []);
  const setKeys = (next: (all: TenantKey[]) => TenantKey[]) => setChanged(next(keys));
  const nameOf = (k: TenantKey) => k.name || k.prefix || k.id;
  return (
    <section aria-labelledby={`${id}-h`} className="org-section">
      <h2 id={`${id}-h`}>{t('org.keysTitle')}</h2>
      {state.status === 'loading' ? (
        <Loading label={t('org.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : keys.length === 0 ? (
        <p className="org-subtle">{t('org.noKeys')}</p>
      ) : (
        <div tabIndex={0} role="region" aria-label={t('org.keysTitle')} className="org-table-wrap">
          <table className="org-table">
            <thead>
              <tr>
                <th scope="col">{t('org.colName')}</th>
                <th scope="col">{t('org.colCreated')}</th>
                <th scope="col">{t('org.colExpires')}</th>
                <th scope="col">{t('org.colStatus')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('org.colAction')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const [label, tone] = keyStatus(k, now);
                const name = nameOf(k);
                const active = label === 'org.keyActive';
                const open = asking?.id === k.id;
                return (
                  <Fragment key={k.id}>
                    <tr>
                      <td>{name}</td>
                      <td>{k.createdAt ? shortDay(k.createdAt, f) : ''}</td>
                      <td>{k.expiresAt ? shortDay(k.expiresAt, f) : t('org.never')}</td>
                      <td>
                        <Chip tone={tone}>{t(label)}</Chip>
                      </td>
                      <td className="end">
                        {active ? (
                          <button
                            type="button"
                            className="org-link-btn"
                            aria-label={t('org.revokeLabel', { name })}
                            onClick={() => {
                              setDone(undefined);
                              setAsking(k);
                            }}
                          >
                            {t('org.revoke')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {open ? (
                      <ReasonRow
                        colSpan={5}
                        danger
                        warning={t('org.revokeWarning')}
                        confirm={t('org.revoke')}
                        onCancel={() => setAsking(undefined)}
                        onConfirm={async (reason) => {
                          const revoked = await api.revokeTenantKey(tenant, k.id, reason);
                          const at = revoked?.revokedAt ?? new Date().toISOString();
                          setKeys((all) =>
                            all.map((x) => (x.id === k.id ? { ...x, revokedAt: at } : x)),
                          );
                          setDone(t('org.revoked', { name }));
                          setAsking(undefined);
                        }}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div aria-live="polite">
        {done ? (
          <p role="status" className="org-status bare">
            {done}
          </p>
        ) : null}
      </div>
    </section>
  );
};

const People = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby={`${id}-h`} className="org-section">
      <div className="org-section-head">
        <h2 id={`${id}-h`}>{t('org.peopleTitle')}</h2>
        {open ? null : (
          <button type="button" className="org-link-btn" onClick={() => setOpen(true)}>
            {t('org.showPeople')}
          </button>
        )}
      </div>
      {open ? <PeopleList api={api} tenant={tenant} /> : null}
    </section>
  );
};

const PeopleList = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const f = useFormat();
  const now = new Date();
  const [state, retry] = useAsync((signal) => api.tenantPeople(tenant, signal), [api, tenant]);
  return (
    <>
      {state.status === 'loading' ? (
        <Loading label={t('org.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <p className="org-subtle">{t('org.noPeople')}</p>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={t('org.peopleTitle')}
          className="org-table-wrap"
        >
          <table className="org-table">
            <thead>
              <tr>
                <th scope="col">{t('org.colName')}</th>
                <th scope="col">{t('org.colRole')}</th>
                <th scope="col">{t('org.colLastLogin')}</th>
              </tr>
            </thead>
            <tbody>
              {state.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{t(roleOf(p))}</td>
                  <td>{lastLogin(p.lastLogin, f, t, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

const Addresses = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const id = useId();
  const [state, retry] = useAsync(
    async (signal) => {
      const [hosts, networks] = await Promise.all([
        api.tenantHostnames(tenant, signal),
        api.tenantPrivateNetworks(tenant, signal).catch(() => undefined),
      ]);
      return {
        hosts: hosts.filter((h) => h.state !== 'removed'),
        networks: networks?.entries ?? [],
      };
    },
    [api, tenant],
  );
  return (
    <section aria-labelledby={`${id}-h`} className="org-section">
      <h2 id={`${id}-h`}>{t('org.networkTitle')}</h2>
      {state.status === 'loading' ? (
        <Loading label={t('org.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.hosts.length + state.data.networks.length === 0 ? (
        <p className="org-subtle">{t('org.noAddresses')}</p>
      ) : (
        <ul className="org-rows">
          {state.data.hosts.map((h) => {
            const [label, tone] = hostStates[h.state];
            return (
              <li key={h.hostname}>
                <span className="grow">{h.hostname}</span>
                <Chip tone={tone}>{t(label)}</Chip>
              </li>
            );
          })}
          {state.data.networks.map((entry) => (
            <li key={entry}>
              <span className="grow">{entry}</span>
              <Chip tone="success">{t('org.networkOpen')}</Chip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export const AccessTab = ({ api, tenant }: { api: ApiClient; tenant: string; name: string }) => (
  <>
    <Keys api={api} tenant={tenant} />
    <People api={api} tenant={tenant} />
    <Addresses api={api} tenant={tenant} />
  </>
);
