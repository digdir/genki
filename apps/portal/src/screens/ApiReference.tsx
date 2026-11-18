import { Alert, Heading, Tabs } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { endpoints, missingAreas } from '../data/api-reference';
import { navigate } from '../hooks';
import { publicApiBase } from '../public-api';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { Actions } from './apiref/Actions';
import { EndpointDetail } from './apiref/EndpointDetail';
import { EndpointNav } from './apiref/EndpointNav';
import { ServiceAsApi } from './apiref/ServiceAsApi';
import './apiref.css';

type View = 'ref' | 'service' | 'actions';

const viewFrom = (v: string | null): View => (v === 'service' || v === 'actions' ? v : 'ref');

const titleKeys = {
  ref: 'apiref.titleRef',
  service: 'apiref.titleService',
  actions: 'apiref.titleActions',
} as const satisfies Record<View, PlainKey>;

export const apiReferenceHash = '#/developer/api/reference';

export const ApiReference = ({ api, tenant, tenantName, route }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const view = viewFrom(route.query.get('view'));
  const wanted = route.query.get('endpoint');
  const ep = endpoints.find((e) => e.id === wanted) ?? endpoints.find((e) => e.id === 'tj-pub');

  const go = (next: View, endpoint?: string) =>
    navigate(`${apiReferenceHash}?view=${next}${endpoint ? `&endpoint=${endpoint}` : ''}`);

  return (
    <div className="stack ar">
      <div className="stack-xs ar-measure">
        <Heading level={3} data-size="xs">
          {t(titleKeys[view])}
        </Heading>
        <p className="lead">{t('apiref.lead')}</p>
        <p>
          <a href={`${publicApiBase}/reference`} target="_blank" rel="noreferrer">
            {t('apiref.platformReference')}
          </a>
        </p>
      </div>
      <Tabs value={view} onChange={(v) => go(viewFrom(v))}>
        <Tabs.List aria-label={t('apiref.tabList')}>
          <Tabs.Tab value="ref">{t('apiref.tabRef')}</Tabs.Tab>
          <Tabs.Tab value="service">{t('apiref.tabService')}</Tabs.Tab>
          <Tabs.Tab value="actions">{t('apiref.tabActions')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ref">
          {view === 'ref' && ep ? (
            <div className="stack">
              {wanted && wanted !== ep.id ? (
                <Alert data-color="info" data-size="sm">
                  {t('apiref.unknownEndpoint', {
                    endpoint: wanted,
                    areas: f.list(missingAreas.map((key) => t(key))),
                  })}
                </Alert>
              ) : null}
              <div className="ar-ref">
                <EndpointNav selected={ep.id} onPick={(id) => go('ref', id)} />
                <EndpointDetail ep={ep} api={api} tenant={tenant} tenantName={tenantName} />
              </div>
            </div>
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="service">
          {view === 'service' ? <ServiceAsApi api={api} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="actions">
          {view === 'actions' ? <Actions tenant={tenant} /> : null}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
};
