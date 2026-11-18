import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { needsRight, useRights } from '../../Shell';
import { EmptyState, ErrorState, Loading } from '../../states';
import { DatasetList } from './DatasetList';
import { failureText, listItemOf } from './live-model';
import { ApiError } from '../../api/error';
import { LiveDatasetDetail } from './LiveDatasetDetail';
import { LiveNewDataset } from './LiveNewDataset';
import { datasetHref, detailTabOf } from './model';

const List = ({ api, tenant }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const [state, retry, pending] = useAsync(
    (signal) => api.datasets.list(tenant, signal),
    [api, tenant],
    {
      keepPreviousFor: tenant,
    },
  );
  const canCreate = useRights().has('manage-datasets');
  const onRetry = async (fullId: string) => {
    const view = state.status === 'ready' ? state.data.find((d) => d.fullId === fullId) : undefined;
    if (!view) return;
    try {
      const [pipeline] = await api.datasets.pipelines(tenant, view.id);
      if (!pipeline) throw new Error(t('datasets.sourceNone'));
      await api.datasets.execute(tenant, view.id, pipeline.id, t('datasets.runReason'));
    } catch (error) {
      throw new Error(
        error instanceof ApiError ? failureText(t, error) : t('datasets.somethingWrong'),
        {
          cause: error,
        },
      );
    }
    retry();
  };
  if (state.status === 'loading')
    return (
      <div className="stack">
        <DatasetList
          canCreate={canCreate}
          placeholder={
            <Loading
              label={t('datasets.loading')}
              shape="table"
              columns={[
                t('datasets.columnDataset'),
                t('datasets.columnStatus'),
                t('datasets.factDocuments'),
                t('datasets.columnLastStarted'),
              ]}
              onRetry={retry}
            />
          }
        />
      </div>
    );
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
      </div>
    );
  return (
    <div className="stack">
      <DatasetList
        datasets={state.data.map((d) => listItemOf(t, f, d))}
        canCreate={canCreate}
        pending={pending}
        {...(canCreate ? { onRetry } : {})}
      />
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
        tenantName={tenantName}
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
        tab={detailTabOf(route)}
      />
    );
  return <List {...props} />;
};
