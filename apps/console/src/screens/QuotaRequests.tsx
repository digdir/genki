import {
  Button,
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
import { useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type Format, type PlainKey, type T } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { QuotaRequestRow, QuotaRequestState } from '../types';
import {
  DialogError,
  Flash,
  formatWhen,
  Meter,
  PageHeader,
  ReasonDialog,
  TableRegion,
  useFlash,
  VisuallyHidden,
} from '../ui';
import { formatOrgNumber, quotaRequestsHref } from './Tenants';

type Decision = Exclude<QuotaRequestState, 'pending'>;

const stateTag: Record<QuotaRequestState, [PlainKey, 'warning' | 'success' | 'neutral']> = {
  pending: ['quotaRequests.statePending', 'warning'],
  approved: ['quotaRequests.stateApproved', 'success'],
  rejected: ['quotaRequests.stateRejected', 'neutral'],
};

const millions = (tokens: number, f: Format) =>
  f.number(tokens / 1_000_000, { maximumFractionDigits: 1 });

export const pendingFirst = (rows: readonly QuotaRequestRow[]) =>
  [...rows].sort(
    (a, b) =>
      Number(b.state === 'pending') - Number(a.state === 'pending') ||
      (b.decision?.at ?? b.requestedAt).localeCompare(a.decision?.at ?? a.requestedAt),
  );

const problemText = (error: unknown, fallback: string) => {
  if (!(error instanceof ApiError)) return fallback;
  const details = (error.problem?.errors ?? []).map((e) => e.message).join('. ');
  return [error.problem?.title, details].filter(Boolean).join(': ') || fallback;
};

const Usage = ({ row, t, f }: { row: QuotaRequestRow; t: T; f: Format }) => {
  if (!row.quota) return <>{t('quotaRequests.notAvailable')}</>;
  const percent = Math.round((row.quota.usedTokens / row.quota.monthlyTokens) * 100);
  return (
    <span className="usage">
      <span className="usage-text">
        {t('quotaRequests.usedOfQuota', {
          used: millions(row.quota.usedTokens, f),
          quota: millions(row.quota.monthlyTokens, f),
          percent,
        })}
      </span>
      <Meter percent={percent} warn={percent >= 85} />
    </span>
  );
};

export const QuotaRequests = ({
  api,
  tenant,
  onDecided,
}: {
  api: ApiClient;
  tenant?: string | undefined;
  onDecided?: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.quotaRequests(signal), [api]);
  const flash = useFlash();
  const [deciding, setDeciding] = useState<{ row: QuotaRequestRow; decision: Decision }>();

  const decide = async (reason: string) => {
    if (!deciding) return;
    const { row, decision } = deciding;
    try {
      await api.decideQuotaRequest(row.tenant, row.id, decision, reason);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        retry();
        onDecided?.();
      }
      throw new DialogError(problemText(error, t('quotaRequests.decideFailed')));
    }
    flash.show(
      decision === 'approved'
        ? t('quotaRequests.approvedFlash', {
            name: row.tenantName,
            amount: millions(row.monthlyTokens, f),
          })
        : t('quotaRequests.rejectedFlash', { name: row.tenantName }),
    );
    retry();
    onDecided?.();
  };

  const header = <PageHeader title={t('quotaRequests.title')} />;
  if (state.status === 'loading')
    return (
      <>
        {header}
        <Loading label={t('quotaRequests.loading')} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        {header}
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const rows = pendingFirst(state.data.filter((r) => !tenant || r.tenant === tenant));
  const target = deciding?.row;
  return (
    <>
      {header}
      <Flash message={flash.message} />
      {tenant ? (
        <Paragraph data-size="sm">
          <Link href={quotaRequestsHref()}>{t('quotaRequests.showAll')}</Link>
        </Paragraph>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t('quotaRequests.noneTitle')} />
      ) : (
        <TableRegion label={t('quotaRequests.title')}>
          <Table data-size="sm" className="wide-900">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('quotaRequests.colTenant')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('quotaRequests.colRequested')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('quotaRequests.colUsage')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('quotaRequests.colAskedBy')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('quotaRequests.colReason')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('quotaRequests.colStatus')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <VisuallyHidden>{t('quotaRequests.colActions')}</VisuallyHidden>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const [label, color] = stateTag[row.state];
                return (
                  <TableRow key={`${row.tenant}/${row.id}`}>
                    <TableHeaderCell scope="row" className="row-head">
                      <span className="two-line">
                        <span>{row.tenantName}</span>
                        <span className="meta">{formatOrgNumber(row.tenant)}</span>
                      </span>
                    </TableHeaderCell>
                    <TableCell>
                      {t('quotaRequests.perMonth', { amount: millions(row.monthlyTokens, f) })}
                    </TableCell>
                    <TableCell>
                      <Usage row={row} t={t} f={f} />
                    </TableCell>
                    <TableCell>
                      <span className="two-line">
                        <span>{row.requestedByName ?? row.requestedBy}</span>
                        <span className="meta">{formatWhen(row.requestedAt, f, t)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="sm">{row.reason}</TableCell>
                    <TableCell>
                      <span className="two-line">
                        <Tag data-size="sm" data-color={color}>
                          {t(label)}
                        </Tag>
                        {row.decision ? (
                          <span className="meta">
                            {t('quotaRequests.decidedBy', {
                              name: row.decision.byName ?? row.decision.by,
                              when: formatWhen(row.decision.at, f, t),
                              reason: row.decision.reason,
                            })}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.state === 'pending' ? (
                        <span className="row-actions">
                          <Button
                            data-size="sm"
                            aria-label={t('quotaRequests.approveFor', { name: row.tenantName })}
                            onClick={() => {
                              flash.clear();
                              setDeciding({ row, decision: 'approved' });
                            }}
                          >
                            {t('quotaRequests.approve')}
                          </Button>
                          <Button
                            data-size="sm"
                            variant="secondary"
                            aria-label={t('quotaRequests.rejectFor', { name: row.tenantName })}
                            onClick={() => {
                              flash.clear();
                              setDeciding({ row, decision: 'rejected' });
                            }}
                          >
                            {t('quotaRequests.reject')}
                          </Button>
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      <ReasonDialog
        open={deciding !== undefined}
        title={
          target
            ? deciding?.decision === 'approved'
              ? t('quotaRequests.approveTitle', {
                  name: target.tenantName,
                  amount: millions(target.monthlyTokens, f),
                })
              : t('quotaRequests.rejectTitle', { name: target.tenantName })
            : ''
        }
        text={
          deciding?.decision === 'approved'
            ? t('quotaRequests.approveText')
            : t('quotaRequests.rejectText')
        }
        confirmLabel={
          deciding?.decision === 'approved' ? t('quotaRequests.approve') : t('quotaRequests.reject')
        }
        onClose={() => setDeciding(undefined)}
        onConfirm={decide}
      />
    </>
  );
};
