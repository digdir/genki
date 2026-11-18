import { Tabs, TabsList, TabsPanel, TabsTab } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api';
import { navigate, useAsync } from '../hooks';
import { useT } from '../i18n';
import { ErrorState, Loading } from '../states';
import { Flash, PageHeader, useFlash } from '../ui';
import { ApiGuide } from './models/ApiGuide';
import { ApiList } from './models/ApiList';
import { tabOf, type AreaData, type AreaProps, type ModelsTab } from './models/area-data';
import { ConnectionDetail } from './models/ConnectionDetail';
import { ConnectionList } from './models/ConnectionList';
import { ModelDetail } from './models/ModelDetail';
import { ModelList } from './models/ModelList';

const settled = <T,>(promise: Promise<T>) => promise.catch(() => undefined);

const useAreaData = (api: ApiClient, version: number) =>
  useAsync(
    async (signal): Promise<AreaData> => {
      const [models, connections, apis, kinds, descriptors, records] = await Promise.all([
        api.listModels(signal),
        settled(api.modelEndpoints(signal)),
        settled(api.modelApis(signal)),
        settled(api.operationKindsOverview(signal)),
        settled(api.operationDescriptors(signal)),
        settled(api.processorRecords(signal)),
      ]);
      return { models, connections, apis, kinds, descriptors, records };
    },
    [api, version],
  );

export const Forward = ({ to, params }: { to: string; params?: Record<string, string> }) => {
  useEffect(() => navigate(to, params), [to, params]);
  return null;
};

export const Models = ({ api, params }: { api: ApiClient; params: URLSearchParams }) => {
  const t = useT();
  const [version, setVersion] = useState(0);
  const [state, retry] = useAreaData(api, version);
  const [data, setData] = useState<AreaData | undefined>();
  const flash = useFlash();
  useEffect(() => {
    if (state.status === 'ready') setData(state.data);
  }, [state]);
  const connection = params.get('connection');
  const model = params.get('model');
  const apiId = params.get('api');
  const tab = tabOf(params.get('tab'));
  const done = (message: string) => {
    flash.show(message);
    setVersion((v) => v + 1);
  };

  if (!data)
    return (
      <>
        <PageHeader eyebrow={t('shell.groupPlatform')} title={t('models.title')} />
        {state.status === 'error' ? (
          <ErrorState error={state.error} onRetry={retry} />
        ) : (
          <Loading label={t('models.loading')} />
        )}
      </>
    );

  const props: AreaProps = { api, data, done };
  const detail = connection ? (
    <ConnectionDetail {...props} id={connection} />
  ) : model ? (
    <ModelDetail {...props} id={model} />
  ) : apiId ? (
    <ApiGuide {...props} id={apiId} step={params.get('step')} />
  ) : undefined;

  return (
    <>
      <Flash message={flash.message} />
      {detail ?? (
        <>
          <PageHeader
            eyebrow={t('shell.groupPlatform')}
            title={t('models.title')}
            intro={t('models.intro')}
          />
          <Tabs
            value={tab}
            onChange={(v) => {
              flash.clear();
              navigate('/models', { tab: v as ModelsTab });
            }}
          >
            <TabsList aria-label={t('models.title')}>
              <TabsTab value="connections">{t('models.tabConnections')}</TabsTab>
              <TabsTab value="models">{t('models.tabModels')}</TabsTab>
              <TabsTab value="apis">{t('models.tabApis')}</TabsTab>
            </TabsList>
            <TabsPanel value="connections">
              {tab === 'connections' ? <ConnectionList {...props} /> : null}
            </TabsPanel>
            <TabsPanel value="models">
              {tab === 'models' ? <ModelList {...props} /> : null}
            </TabsPanel>
            <TabsPanel value="apis">{tab === 'apis' ? <ApiList {...props} /> : null}</TabsPanel>
          </Tabs>
        </>
      )}
    </>
  );
};
