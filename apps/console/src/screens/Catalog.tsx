import { Paragraph, Tabs, TabsList, TabsPanel, TabsTab } from '@digdir/designsystemet-react';
import type { ApiClient } from '../api';
import { useT } from '../i18n';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type { ConfigEntry } from '../types';
import { PageHeader } from '../ui';
import { Pipelines } from './config/Pipelines';
import {
  localId,
  refusedWithoutSupport,
  Registry,
  ScopeBar,
  scopeEyebrow,
  SupportNeeded,
  useConfigScope,
  type TenantView,
} from './config/Registry';

export const catalogTabs = [
  {
    kind: 'model-endpoint',
    label: 'catalog.tabModelEndpoint',
    template: {
      adapter: 'openai-chat',
      baseURL: 'https://',
      residency: 'eu',
      auth: { kind: 'api-key', secret: 'env:' },
    },
  },
  {
    kind: 'model',
    label: 'catalog.tabModel',
    template: { endpoint: '', residency: 'eu', capabilities: [] },
  },
  {
    kind: 'knowledge-endpoint',
    label: 'catalog.tabKnowledgeEndpoint',
    template: {
      engine: 'typesense',
      baseURL: 'https://',
      auth: { kind: 'api-key', secret: 'env:' },
    },
  },
  {
    kind: 'dataset',
    label: 'catalog.tabDataset',
    template: { name: '', endpoint: '', residency: 'norway', options: {} },
  },
  {
    kind: 'rerank-endpoint',
    label: 'catalog.tabRerankEndpoint',
    template: {
      adapter: 'colbert',
      baseURL: 'https://',
      auth: { kind: 'api-key', secret: 'env:' },
    },
  },
  { kind: 'reranker', label: 'catalog.tabReranker', template: { endpoint: '' } },
  {
    kind: 'price',
    label: 'catalog.tabPrice',
    template: { inputPerThousand: 0, outputPerThousand: 0 },
  },
] as const;

const platformOnly = (e: ConfigEntry) => !e.scope || e.scope === 'platform';

const describe = (e: ConfigEntry) => {
  const spec = e.spec as { name?: string; baseURL?: string; endpoint?: string; residency?: string };
  return [spec.name, spec.baseURL, spec.endpoint, spec.residency].filter(Boolean).join(' · ');
};

type CatalogTab = (typeof catalogTabs)[number];

const PlatformRegistry = ({ api, tab }: { api: ApiClient; tab: CatalogTab }) => {
  const t = useT();
  return (
    <Registry
      api={api}
      label={t(tab.label)}
      paths={{
        list: `/operator/catalog/entries?kind=${tab.kind}`,
        item: (id) => `/operator/catalog/${tab.kind}/${encodeURIComponent(id)}`,
        history: (id) => `/operator/catalog/${tab.kind}/${encodeURIComponent(id)}/versions`,
      }}
      template={tab.template}
      filter={platformOnly}
      describe={describe}
      {...(tab.kind === 'dataset'
        ? {
            detail: (e: ConfigEntry) => (
              <Pipelines
                api={api}
                base={`/operator/datasets/${encodeURIComponent(e.id)}/pipelines`}
              />
            ),
          }
        : {})}
    />
  );
};

const TenantRegistry = ({
  api,
  tab,
  tenant,
}: {
  api: ApiClient;
  tab: CatalogTab;
  tenant: TenantView;
}) => {
  const t = useT();
  const base = `/tenants/${encodeURIComponent(tenant.id)}`;
  const [kinds, retry] = useAsync(
    async (signal) => (await api.configList(`${base}/catalog`, signal)).tenantKinds ?? [],
    [api, base],
  );
  if (kinds.status === 'loading') return <Loading label={t('catalog.loadingKinds')} />;
  if (kinds.status === 'error')
    return refusedWithoutSupport(api, tenant, kinds.error) ? (
      <SupportNeeded tenant={tenant} />
    ) : (
      <ErrorState error={kinds.error} onRetry={retry} />
    );
  if (!kinds.data.includes(tab.kind))
    return (
      <Paragraph data-size="sm">
        {t('catalog.platformOnly', { kind: t(tab.label).toLowerCase() })}
      </Paragraph>
    );
  return (
    <Registry
      api={api}
      label={t(tab.label)}
      tenant={tenant}
      paths={{
        list: `${base}/catalog?kind=${tab.kind}`,
        item: (id) => `${base}/catalog/${tab.kind}/${encodeURIComponent(id)}`,
        history: (id) => `${base}/catalog/${tab.kind}/${encodeURIComponent(id)}/versions`,
      }}
      template={tab.template}
      describe={describe}
      {...(tab.kind === 'dataset'
        ? {
            detail: (e: ConfigEntry) => (
              <Pipelines
                api={api}
                base={`${base}/datasets/${encodeURIComponent(localId(e))}/pipelines`}
              />
            ),
          }
        : {})}
    />
  );
};

export const Catalog = ({ api, tab }: { api: ApiClient; tab: string | undefined }) => {
  const t = useT();
  const current = catalogTabs.find((t) => t.kind === tab)?.kind ?? 'model-endpoint';
  const scope = useConfigScope(api, '/catalog', current);
  const eyebrow = scopeEyebrow(scope);
  return (
    <>
      <PageHeader
        title={t('catalog.title')}
        {...(eyebrow ? { eyebrow } : {})}
        intro={scope.view ? t('catalog.introTenant') : t('catalog.introPlatform')}
      />
      <ScopeBar scope={scope} />
      <Paragraph data-size="sm" className="meta">
        {t('catalog.secretsNote')}
      </Paragraph>
      <Tabs value={current} onChange={(v) => scope.go(scope.tenant, v)}>
        <TabsList aria-label={t('catalog.title')}>
          {catalogTabs.map((c) => (
            <TabsTab key={c.kind} value={c.kind}>
              {t(c.label)}
            </TabsTab>
          ))}
        </TabsList>
        {catalogTabs.map((c) => (
          <TabsPanel key={c.kind} value={c.kind}>
            {current !== c.kind ? null : scope.view ? (
              <TenantRegistry api={api} tab={c} tenant={scope.view} />
            ) : scope.tenant === undefined ? (
              <PlatformRegistry api={api} tab={c} />
            ) : (
              <EmptyState title={t('catalog.chooseTenant')} />
            )}
          </TabsPanel>
        ))}
      </Tabs>
    </>
  );
};
