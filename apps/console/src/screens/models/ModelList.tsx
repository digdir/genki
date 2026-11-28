import { Alert, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { Format, PlainKey, T } from '../../i18n';
import { useT } from '../../i18n';
import { operationName } from '../../model-operations';
import { EmptyState } from '../../states';
import type { OperatorModel, RefreshResult } from '../../types';
import { ReasonDialog } from '../../ui';
import { perMillion } from './prices';
import { boundOf, isUnconfirmed, modelsHref, type AreaProps } from './area-data';
import { residencyLabel } from './Endpoints';
import '../platform.css';
import { PageTabs } from '../../page-tabs';

export const KindTags = ({ model }: { model: OperatorModel }) => {
  const t = useT();
  const bound = Object.entries(boundOf(model));
  if (bound.length === 0 && model.kind)
    return (
      <span className="two-line">
        <Tag data-size="sm" data-color="warning">
          {t('models.kindUnbound', {
            kind: model.kind === 'unknown' ? t('models.kindUnknown') : operationName(model.kind, t),
          })}
        </Tag>
        <span className="meta">{t('models.kindNeedsDescriptor')}</span>
      </span>
    );
  if (bound.length === 0) return <span className="meta">{t('models.noKinds')}</span>;
  return (
    <span className="tag-row">
      {bound.map(([kind, api]) => (
        <Tag key={kind} data-size="sm" data-color="neutral">
          {operationName(kind, t)} · {api}
        </Tag>
      ))}
    </span>
  );
};

export const ModelStatus = ({ model }: { model: OperatorModel }) => {
  const t = useT();
  return (
    <span className="tag-row">
      <Tag data-size="sm" data-color={model.enabled ? 'success' : 'neutral'}>
        {model.enabled ? t('models.enabled') : t('models.disabled')}
      </Tag>
      {isUnconfirmed(model) ? (
        <Tag data-size="sm" data-color="warning">
          {t('models.unconfirmed')}
        </Tag>
      ) : null}
    </span>
  );
};

const money = (value: number, f: Format) => f.number(value, { maximumFractionDigits: 4 });

const listPrice = (model: OperatorModel, f: Format, t: T) => {
  if (!model.price) return t('models.priceNotSet');
  const { input, output } = perMillion(model.price);
  return output === 0
    ? t('models.priceInputOnly', { input: money(input, f) })
    : t('models.priceText', { input: money(input, f), output: money(output, f) });
};

const callTypes = (model: OperatorModel, t: T) => {
  const kinds = Object.keys(boundOf(model));
  const names = kinds.map((k) => (k === 'chat' ? t('models.callText') : operationName(k, t)));
  if (kinds.includes('chat') && model.capabilities.includes('tools'))
    names.push(t('models.callTools'));
  return names.length ? names.join(', ') : t('models.noKinds');
};

const statusOf = (model: OperatorModel): [PlainKey, string] =>
  isUnconfirmed(model)
    ? ['models.statusReview', 'info']
    : model.enabled
      ? ['models.statusAllowed', 'ok']
      : ['models.disabled', 'neutral'];

export const ModelList = ({ api, data, done }: AreaProps) => {
  const t = useT();
  const f = useFormat();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<RefreshResult | undefined>();

  return (
    <>
      <div className="pf-head">
        <h1 className="pf-title">{t('models.title')}</h1>
        <button type="button" className="pf-button" onClick={() => setRefreshing(true)}>
          {t('models.refresh')}
        </button>
      </div>
      <PageTabs />
      {refreshed ? (
        <Alert data-color={refreshed.failed.length > 0 ? 'warning' : 'success'} role="status">
          <Paragraph>{t('models.discovered', { count: refreshed.discovered })}</Paragraph>
          {refreshed.learned && refreshed.learned.calls > 0 ? (
            <Paragraph>{t('models.learnedCalls', { count: refreshed.learned.calls })}</Paragraph>
          ) : null}
          {refreshed.learned && refreshed.learned.deferred > 0 ? (
            <Paragraph>
              {t('models.learnedDeferred', { count: refreshed.learned.deferred })}
            </Paragraph>
          ) : null}
          {refreshed.failed.length > 0 ? (
            <>
              <Paragraph>{t('models.providersFailed')}</Paragraph>
              <ul>
                {refreshed.failed.map((x) => (
                  <li key={x.endpoint}>
                    {x.endpoint}: {x.error}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Alert>
      ) : null}
      {data.models.length === 0 ? (
        <EmptyState title={t('models.noneTitle')}>
          <Paragraph>{t('models.noneText')}</Paragraph>
          <a className="pf-link" href={modelsHref({ tab: 'connections' })}>
            {t('models.tabConnections')}
          </a>
        </EmptyState>
      ) : (
        <div className="pf-region" tabIndex={0} role="region" aria-label={t('models.title')}>
          <table className="pf-table pf-min-900">
            <thead>
              <tr>
                <th scope="col">{t('models.colModel')}</th>
                <th scope="col">{t('models.colResidency')}</th>
                <th scope="col">{t('models.colPrice')}</th>
                <th scope="col">{t('models.kind')}</th>
                <th scope="col">{t('models.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => {
                const [status, tone] = statusOf(m);
                return (
                  <tr key={m.id}>
                    <td>
                      <a className="name" href={modelsHref({ model: m.id })}>
                        {m.deployment}
                      </a>
                      <span className="pf-sub">{m.endpoint}</span>
                    </td>
                    <td>
                      {isUnconfirmed(m) ? (
                        <span className="pf-chip" data-tone="warn">
                          {t('models.residencyUnconfirmed', {
                            residency: t(residencyLabel[m.residency]),
                          })}
                        </span>
                      ) : (
                        t(residencyLabel[m.residency])
                      )}
                    </td>
                    <td>{listPrice(m, f, t)}</td>
                    <td>{callTypes(m, t)}</td>
                    <td>
                      <span className="pf-chip" data-tone={tone}>
                        {t(status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog
        open={refreshing}
        title={t('models.refresh')}
        text={t('models.refreshText')}
        confirmLabel={t('models.refresh')}
        onClose={() => setRefreshing(false)}
        onConfirm={async (reason) => {
          setRefreshed(await api.refreshModels(reason));
          done(t('models.refreshed'));
        }}
      />
    </>
  );
};
