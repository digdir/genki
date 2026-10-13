import {
  Heading,
  Paragraph,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient, ConfigEntry } from '../../api';
import { useT, type PlainKey } from '../../i18n';
import { useRights } from '../../Shell';
import { Pipelines } from './Pipelines';
import { Registry } from './Registry';

const kinds = [
  {
    kind: 'dataset',
    label: 'config.kindDataset',
    template: {
      name: '',
      endpoint: '',
      residency: 'norway',
      options: { collections: { chunks: '' } },
    },
  },
  {
    kind: 'knowledge-endpoint',
    label: 'config.kindKnowledgeEndpoint',
    template: { engine: 'typesense', baseURL: 'https://', auth: { kind: 'api-key', secret: '' } },
  },
  {
    kind: 'model-endpoint',
    label: 'config.kindModelEndpoint',
    template: {
      adapter: 'openai-chat',
      baseURL: 'https://',
      residency: 'norway',
      auth: { kind: 'api-key', secret: '' },
    },
  },
  {
    kind: 'model',
    label: 'config.kindModel',
    template: { endpoint: '', residency: 'norway', capabilities: [] },
  },
] as const satisfies readonly { kind: string; label: PlainKey; template: object }[];

const describe = (e: ConfigEntry) => {
  const spec = e.spec as { name?: string; baseURL?: string; endpoint?: string; residency?: string };
  return [spec.name, spec.baseURL, spec.endpoint, spec.residency].filter(Boolean).join(' · ');
};

export const TenantCatalog = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const [tab, setTab] = useState<(typeof kinds)[number]['kind']>('dataset');
  const t = useT();
  const rights = useRights();
  const base = `/tenants/${encodeURIComponent(tenant)}`;
  return (
    <section className="stack" aria-labelledby="egne-kilder-h">
      <div className="stack-xs">
        <Heading level={2} data-size="sm" id="egne-kilder-h">
          {t('config.catalogTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('config.catalogIntro')}</Paragraph>
      </div>
      <Tabs value={tab} onChange={(v) => setTab(v as typeof tab)}>
        <TabsList aria-label={t('config.catalogTitle')}>
          {kinds.map((k) => (
            <TabsTab key={k.kind} value={k.kind}>
              {t(k.label)}
            </TabsTab>
          ))}
        </TabsList>
        {kinds.map((k) => (
          <TabsPanel key={k.kind} value={k.kind}>
            {tab === k.kind ? (
              <Registry
                api={api}
                scope={tenant}
                label={t(k.label)}
                paths={{
                  list: `${base}/catalog?kind=${k.kind}`,
                  item: (id) => `${base}/catalog/${k.kind}/${encodeURIComponent(id)}`,
                  history: (id) => `${base}/catalog/${k.kind}/${encodeURIComponent(id)}/versions`,
                }}
                template={k.template}
                describe={describe}
                canCreate={rights.has(
                  k.kind === 'dataset' || k.kind === 'knowledge-endpoint'
                    ? 'manage-datasets'
                    : 'manage-services',
                )}
                {...(k.kind === 'dataset'
                  ? {
                      detail: (e: ConfigEntry) =>
                        e.scope === tenant ? (
                          <Pipelines
                            api={api}
                            scope={tenant}
                            base={`${base}/datasets/${encodeURIComponent(e.id.replace(`${tenant}/`, ''))}/pipelines`}
                          />
                        ) : null,
                    }
                  : {})}
              />
            ) : null}
          </TabsPanel>
        ))}
      </Tabs>
    </section>
  );
};
