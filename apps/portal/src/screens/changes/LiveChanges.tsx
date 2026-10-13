import { Tag } from '@digdir/designsystemet-react';
import type { ApiClient } from '../../api';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { changeText, newestFirst } from './changes';

export const LiveChanges = ({
  api,
  tenant,
  limit = 5,
}: {
  api: ApiClient;
  tenant: string;
  limit?: number;
}) => {
  const p = usePortalFormat();
  const t = p.t;
  const allowed = useRights().has('manage-services');
  const [state, retry] = useAsync(
    async (signal) => (allowed ? api.audit(tenant, signal) : []),
    [api, tenant, allowed],
  );
  if (!allowed)
    return (
      <div className="card-empty">
        <span className="empty-text">{needsRight('manage-services', t)}</span>
      </div>
    );
  if (state.status === 'loading') return <Loading label={t('changes.loading')} />;
  if (state.status === 'error')
    return <ErrorState error={state.error} onRetry={retry} headingLevel={3} />;
  const rows = newestFirst(Array.isArray(state.data) ? state.data : []).slice(0, limit);
  if (rows.length === 0)
    return (
      <div className="card-empty">
        <span className="empty-title">{t('changes.none')}</span>
        <span className="empty-text">{t('changes.noneText')}</span>
      </div>
    );
  return (
    <ol className="plain-list card-rows">
      {rows.map((e) => (
        <li key={e.task} className="change-row">
          <div className="change-text">
            <span>
              <strong>
                {p.actor(e.actor, e.actor.startsWith('operator:') ? undefined : e.actorName)}
              </strong>{' '}
              {changeText(e, t)}
              {e.outcome === 'rejected' ? (
                <>
                  {' '}
                  <Tag data-size="sm" data-color="danger">
                    {t('changes.rejected')}
                  </Tag>
                </>
              ) : null}
            </span>
            <time className="meta" dateTime={e.at}>
              {p.dateTime(e.at)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
};
