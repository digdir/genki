import {
  Alert,
  Link,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import type { ApiClient, StateRegisterView } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import { PageHeader, TableRegion } from '../ui';
import { formatOrgNumber } from './Tenants';

type Kind = StateRegisterView['differences'][number]['kind'];
const kindColor: Record<Kind, 'warning' | 'neutral' | 'info'> = {
  mismatch: 'warning',
  'budget-booking': 'neutral',
  'not-in-register': 'info',
};
const registerUrl = 'https://data.brreg.no/enhetsregisteret/oppslag/enheter';
const accountsUrl = 'https://statsregnskapet.dfo.no/';

const kindLabel = {
  mismatch: 'stateRegister.kindMismatch',
  'budget-booking': 'stateRegister.kindBudgetBooking',
  'not-in-register': 'stateRegister.kindNotInRegister',
} as const;

/** The state's organisation from Enhetsregisteret, and how the state accounts differ (ADR 0058). */
export const StateRegister = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.stateRegister(signal), [api]);
  const day = (iso: string | null) =>
    iso ? f.date(new Date(iso), 'short') : t('stateRegister.never');

  return (
    <>
      <PageHeader
        eyebrow={t('shell.groupPlatform')}
        title={t('stateRegister.title')}
        intro={t('stateRegister.intro')}
      />
      {state.status === 'loading' ? (
        <Loading label={t('stateRegister.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <>
          {state.data.failedNights >= 2 ? (
            <Alert data-color="warning" role="alert">
              {t('stateRegister.stale', {
                nights: state.data.failedNights,
                date: day(state.data.lastGood),
              })}
            </Alert>
          ) : null}
          <Paragraph>
            {t('stateRegister.summary', {
              date: day(state.data.lastGood),
              units: state.data.units,
              changed: day(state.data.syncedAt),
            })}
          </Paragraph>
          <Paragraph data-size="sm">
            {state.data.accountsPeriod
              ? t('stateRegister.accounts', {
                  period: `${state.data.accountsPeriod.slice(4)}.${state.data.accountsPeriod.slice(0, 4)}`,
                  same: state.data.same,
                })
              : t('stateRegister.noAccounts')}
          </Paragraph>
          <Paragraph data-size="sm">
            {t('stateRegister.creditBefore')}
            <Link href={t('stateRegister.creditLicenceUrl')}>
              {t('stateRegister.creditLicence')}
            </Link>
            {t('stateRegister.creditBy')}
            <Link href={registerUrl}>{t('stateRegister.creditRegister')}</Link>
            {t('stateRegister.creditAnd')}
            <Link href={accountsUrl}>{t('stateRegister.creditAccounts')}</Link>
            {t('stateRegister.creditAfter')}
          </Paragraph>
          {state.data.differences.length === 0 ? (
            <EmptyState title={t('stateRegister.noneTitle')}>
              <Paragraph>{t('stateRegister.noneText')}</Paragraph>
            </EmptyState>
          ) : (
            <TableRegion label={t('stateRegister.tableLabel')}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t('stateRegister.colAgency')}</TableHeaderCell>
                    <TableHeaderCell>{t('stateRegister.colRegister')}</TableHeaderCell>
                    <TableHeaderCell>{t('stateRegister.colAccounts')}</TableHeaderCell>
                    <TableHeaderCell>{t('stateRegister.colKind')}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {state.data.differences.map((d) => (
                    <TableRow key={d.orgnr}>
                      <TableCell>
                        {d.name}
                        <div className="muted">{formatOrgNumber(d.orgnr)}</div>
                      </TableCell>
                      <TableCell>{d.registerMinistryName ?? d.registerMinistry ?? '–'}</TableCell>
                      <TableCell>{d.accountsMinistryName ?? d.accountsMinistry ?? '–'}</TableCell>
                      <TableCell>
                        <Tag data-color={kindColor[d.kind]}>{t(kindLabel[d.kind])}</Tag>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableRegion>
          )}
        </>
      )}
    </>
  );
};
