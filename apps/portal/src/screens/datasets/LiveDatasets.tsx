import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { needsRight, useRights } from '../../Shell';
import { EmptyState, ErrorState, Loading } from '../../states';
import { TenantCatalog } from '../config/TenantCatalog';
import type { DetailTab } from './DatasetDetail';
import { DatasetList } from './DatasetList';
import { listItemOf } from './live-model';
import { LiveDatasetDetail } from './LiveDatasetDetail';
import { LiveNewDataset } from './LiveNewDataset';
import { datasetHref } from './model';

const tabs: Record<string, DetailTab> = {
  ingestions: 'ingestions',
  filters: 'filters',
  source: 'source',
};

const List = ({ api, tenant }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.datasets.list(tenant, signal), [api, tenant]);
  const canCreate = useRights().has('manage-datasets');
  if (state.status === 'loading') return <Loading label={t('datasets.loading')} />;
  if (state.status === 'error')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('datasets.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  if (state.data.length === 0)
    return (
      <div className="stack">
        <Heading level={1} data-size="lg">
          {t('datasets.title')}
        </Heading>
        <EmptyState title={t('datasets.emptyTitle')}>
          <Paragraph>{t('datasets.emptyTextLive')}</Paragraph>
          {canCreate ? (
            <Button variant="primary" data-size="sm" onClick={() => navigate('/datasets/new')}>
              {t('datasets.new')}
            </Button>
          ) : null}
        </EmptyState>
        <TenantCatalog api={api} tenant={tenant} />
      </div>
    );
  return (
    <div className="stack">
      <DatasetList datasets={state.data.map((d) => listItemOf(t, f, d))} canCreate={canCreate} />
      <TenantCatalog api={api} tenant={tenant} />
    </div>
  );
};

export const LiveDatasets = (props: ScreenProps) => {
  const t = useT();
  const { api, tenant, tenantName, route } = props;
  const id = route.segments[1];
  const canCreate = useRights().has('manage-datasets');
  if (id === 'new')
    return canCreate ? (
      <LiveNewDataset
        api={api}
        tenant={tenant}
        onCreated={(fullId) => {
          window.location.hash = datasetHref(fullId);
        }}
        onCancel={() => navigate('/datasets')}
      />
    ) : (
      <div className="stack">
        <Heading level={1} data-size="lg">
          {t('datasets.newTitle')}
        </Heading>
        <Paragraph>
          {needsRight('manage-datasets', t)} <a href="#/datasets">{t('datasets.goToDatasets')}</a>
        </Paragraph>
      </div>
    );
  if (id)
    return (
      <LiveDatasetDetail
        key={id}
        api={api}
        tenant={tenant}
        tenantName={tenantName}
        id={id}
        initialTab={tabs[route.query.get('tab') ?? ''] ?? 'ingestions'}
      />
    );
  return <List {...props} />;
};
