import { useFormat } from '@genai/i18n/react';
import { useT } from '../../i18n';
import type { TenantOverview } from '../../operator-types';
import { auditLine } from './audit-line';
import { kroner, millions, orgHref, shortDay } from './parts';

export const OverviewTab = ({ overview }: { overview: TenantOverview }) => {
  const t = useT();
  const f = useFormat();
  const month = f.month(new Date());
  const tokens = overview.tokens;
  const percent = tokens ? Math.round(tokens.usedPercent) : 0;
  return (
    <>
      <dl className="org-kpis">
        <div className="org-kpi">
          <dt>{t('org.kpiTokens', { month })}</dt>
          <dd>
            {tokens ? millions(tokens.usedTokens, f) : t('org.none')}{' '}
            {tokens ? (
              <span className="of">
                {t('org.kpiTokensOf', { quota: millions(tokens.monthlyTokens, f) })}
              </span>
            ) : null}
          </dd>
          {tokens ? (
            <div className="org-meter" role="img" aria-label={t('org.kpiTokensMeter', { percent })}>
              <div
                className={percent >= 90 ? 'warn' : undefined}
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
          ) : null}
        </div>
        <div className="org-kpi">
          <dt>{t('org.kpiCost', { month })}</dt>
          <dd>{kroner(overview.cost.costMicroNok, f, t)}</dd>
          <a href={orgHref(overview.orgNumber, 'usage')} className="sub">
            {t('org.seeUsage')}
          </a>
        </div>
        <div className="org-kpi">
          <dt>{t('org.kpiServices')}</dt>
          <dd>
            {overview.services.inUse}{' '}
            <span className="of">{t('org.kpiServicesOf', { total: overview.services.total })}</span>
          </dd>
        </div>
        <div className="org-kpi">
          <dt>{t('org.kpiErrors')}</dt>
          <dd>{overview.failedRunsLast7Days}</dd>
          <a href="#/operations" className="sub">
            {t('org.seeRuns')}
          </a>
        </div>
      </dl>
      <section aria-labelledby="org-latest" className="org-section">
        <div className="org-section-head">
          <h2 id="org-latest">{t('org.latestTitle')}</h2>
          <a href={orgHref(overview.orgNumber, 'log')}>{t('org.wholeLog')}</a>
        </div>
        {overview.latestAudit.length === 0 ? (
          <p className="org-subtle">{t('org.noChanges')}</p>
        ) : (
          <ol className="org-rows">
            {overview.latestAudit.slice(0, 3).map((e) => {
              const line = auditLine(e, t);
              return (
                <li key={e.task}>
                  <span className="when">{shortDay(e.at, f)}</span>
                  <span className="grow">
                    {line.sentence}
                    {line.who && line.reason ? `: «${line.reason}»` : ''}
                    {line.who ? <span className="org-subtle"> · {line.who}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
};
