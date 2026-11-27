import { useFormat } from '@genai/i18n/react';
import { Fragment, useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { FlagRowView, TenantFlag } from '../../operator-types';
import { ErrorState, Loading } from '../../states';
import { personOf } from '../queue/lanes';
import { Chip, flagName, shortDay } from './parts';
import { ReasonRow } from './ReasonRow';

type Asking = { key: string; person?: FlagRowView['person'] };

const same = (a: Asking | undefined, key: string, person?: FlagRowView['person']) =>
  a?.key === key && a.person?.issuer === person?.issuer && a.person?.subject === person?.subject;

export const FlagsTab = ({
  api,
  tenant,
  name,
}: {
  api: ApiClient;
  tenant: string;
  name: string;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.tenantFlags(tenant, signal), [api, tenant]);
  const [asking, setAsking] = useState<Asking | undefined>();
  if (state.status === 'loading') return <Loading label={t('org.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const changed = (row: FlagRowView | null) =>
    row ? t('org.byAt', { name: row.byName ?? personOf(row.by), date: shortDay(row.at, f) }) : '';
  const expiry = (row: FlagRowView | null) =>
    row?.expiresAt ? shortDay(row.expiresAt, f) : t('org.none');
  const confirm = async (
    change: Parameters<ApiClient['setFlag']>[1],
    key: string,
    reason: string,
  ) => {
    await api.setFlag(key, change, reason);
    setAsking(undefined);
    retry();
  };
  const rowsOf = (flag: TenantFlag) => {
    const label = flagName(flag.key, t);
    const verb = flag.on ? t('org.turnOff') : t('org.turnOn');
    return (
      <Fragment key={flag.key}>
        <tr>
          <th scope="row">{label}</th>
          <td>
            <Chip tone={flag.on ? 'success' : 'neutral'}>
              {flag.on ? t('org.on') : t('org.off')}
            </Chip>
          </td>
          <td className="subtle">{t('org.off')}</td>
          <td>{expiry(flag.tenant)}</td>
          <td className="subtle">{changed(flag.tenant)}</td>
          <td className="end">
            <button
              type="button"
              className="org-link-btn"
              aria-label={
                flag.on
                  ? t('org.turnOffLabel', { flag: label })
                  : t('org.turnOnLabel', { flag: label })
              }
              onClick={() => setAsking({ key: flag.key })}
            >
              {verb}
            </button>
          </td>
        </tr>
        {same(asking, flag.key) ? (
          <ReasonRow
            colSpan={6}
            confirm={verb}
            onCancel={() => setAsking(undefined)}
            onConfirm={(reason) => confirm({ tenant, on: !flag.on }, flag.key, reason)}
          />
        ) : null}
        {flag.people.map((p) => {
          const person = p.personName ?? p.person?.subject ?? '';
          return (
            <Fragment key={`${p.person?.issuer}/${p.person?.subject}`}>
              <tr>
                <th scope="row" className="person">
                  {person}
                </th>
                <td>
                  <Chip tone={p.on ? 'success' : 'neutral'}>
                    {p.on ? t('org.on') : t('org.off')}
                  </Chip>
                </td>
                <td className="subtle">{t('org.followsTenant')}</td>
                <td>{expiry(p)}</td>
                <td className="subtle">{changed(p)}</td>
                <td className="end">
                  <button
                    type="button"
                    className="org-link-btn"
                    aria-label={t('org.clearLabel', { person })}
                    onClick={() =>
                      setAsking({ key: flag.key, ...(p.person ? { person: p.person } : {}) })
                    }
                  >
                    {t('org.clear')}
                  </button>
                </td>
              </tr>
              {p.person && same(asking, flag.key, p.person) ? (
                <ReasonRow
                  colSpan={6}
                  confirm={t('org.clear')}
                  onCancel={() => setAsking(undefined)}
                  onConfirm={(reason) =>
                    confirm(
                      { tenant, ...(p.person ? { person: p.person } : {}), on: null },
                      flag.key,
                      reason,
                    )
                  }
                />
              ) : null}
            </Fragment>
          );
        })}
      </Fragment>
    );
  };
  return (
    <>
      <div
        tabIndex={0}
        role="region"
        aria-label={t('org.flagsTable', { tenant: name })}
        className="org-table-wrap"
      >
        <table className="org-table mid">
          <thead>
            <tr>
              <th scope="col">{t('org.colFlag')}</th>
              <th scope="col">{t('org.colHere')}</th>
              <th scope="col">{t('org.colDefault')}</th>
              <th scope="col">{t('org.colExpiry')}</th>
              <th scope="col">{t('org.colChanged')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('org.colAction')}</span>
              </th>
            </tr>
          </thead>
          <tbody>{state.data.map(rowsOf)}</tbody>
        </table>
      </div>
      <a href="#/flags" className="org-align-start">
        {t('org.allFlags')}
      </a>
    </>
  );
};
