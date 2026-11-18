import { Button, Heading } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { CatalogItem } from '../api/building-blocks';
import { BackLink } from '../components/BackLink';
import { HeadingSkeleton } from '../components/Skeleton';
import { LinkTabs } from '../components/LinkTabs';
import { NotAvailable } from '../components/NotAvailable';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { useRights } from '../Shell';
import { Loading } from '../states';
import { stepFlowHref } from './buildingblocks/block-types';
import { StepFlowView } from './buildingblocks/StepFlowView';
import { LiveWorkspace } from './stepflows/LiveWorkspace';
import { UseInService } from './stepflows/UseInService';

type Service = { id: string; name: string };

const BackTo = ({ service }: { service: Service | undefined }) => {
  const t = useT();
  return service ? (
    <BackLink
      label={t('stepFlowHome.backToService', { service: service.name })}
      href={`#/services/${encodeURIComponent(service.id)}`}
    />
  ) : (
    <BackLink label={t('stepFlowHome.back')} href="#/developer/step-flows" />
  );
};

const PublishedFlow = ({
  api,
  tenant,
  item,
  service,
  view,
}: Pick<ScreenProps, 'api' | 'tenant'> & {
  item: CatalogItem;
  service: Service | undefined;
  view: 'diagram' | 'yaml';
}) => {
  const t = useT();
  const canUse = useRights().has('manage-services');
  const [missing, setMissing] = useState(false);
  const [using, setUsing] = useState(false);
  const version = Number(item.latestVersion ?? item.version);
  const suffix = service ? `?service=${encodeURIComponent(service.id)}` : '';
  return (
    <div className="stack">
      <div className="stack-sm">
        <BackTo service={service} />
        <span className="meta">
          {t('stepFlowHome.flowLine', { publisher: item.publisher.name })}
        </span>
        <div className="sf-home-head">
          <Heading level={1} data-size="lg">
            {item.name}
          </Heading>
          {canUse ? (
            <Button onClick={() => setUsing(true)}>
              {service ? t('stepFlowHome.pinHere') : t('stepFlowHome.useInService')}
            </Button>
          ) : null}
        </div>
        {item.description ? <p className="lead">{item.description}</p> : null}
      </div>
      {missing ? (
        <NotAvailable>{t('stepFlowHome.notShown')}</NotAvailable>
      ) : (
        <>
          <LinkTabs
            label={t('stepFlowHome.tabsLabel', { name: item.name })}
            tabs={[
              {
                key: 'diagram',
                label: t('stepFlowHome.tabDiagram'),
                href: `${stepFlowHref(item.id)}${suffix}`,
              },
              {
                key: 'yaml',
                label: t('stepFlowHome.tabYaml'),
                href: `${stepFlowHref(item.id, '/yaml')}${suffix}`,
              },
            ]}
            current={view}
          />
          <StepFlowView
            api={api}
            tenant={tenant}
            id={item.id}
            own={false}
            view={view}
            onMissing={() => setMissing(true)}
          />
        </>
      )}
      {using ? (
        <UseInService
          api={api}
          tenant={tenant}
          flow={{ id: item.id, version, name: item.name }}
          {...(service ? { service: service.id } : {})}
          onClose={() => setUsing(false)}
        />
      ) : null}
    </div>
  );
};

export const StepFlows = ({ api, tenant, route, live }: ScreenProps) => {
  const t = useT();
  const id = route.segments[2] ?? 'new';
  const serviceId = route.query.get('service') ?? '';
  const [state, retry] = useAsync(
    async (signal) => {
      const [item, services] = await Promise.all([
        id === 'new'
          ? undefined
          : api.buildingBlocks
              .get(tenant, { kind: 'step_flow', id }, signal)
              .catch(() => undefined),
        serviceId
          ? api
              .services(tenant, signal)
              .then((list) => list.data)
              .catch(() => [])
          : [],
      ]);
      const found = services.find((s) => s.id === serviceId);
      return {
        item,
        service: serviceId ? { id: serviceId, name: found?.name || serviceId } : undefined,
      };
    },
    [api, tenant, id, serviceId],
  );
  if (state.status !== 'ready')
    return (
      <div className="stack">
        <div className="stack-sm">
          <BackLink label={t('stepFlowHome.back')} href="#/developer/step-flows" />
          <HeadingSkeleton label={t('blocks.flowLoading')} />
        </div>
        <Loading label={t('blocks.flowLoading')} shape="detail" onRetry={retry} />
      </div>
    );
  const { item, service } = state.data;
  if (item && item.publisher.type !== 'own')
    return (
      <PublishedFlow
        api={api}
        tenant={tenant}
        item={item}
        service={service}
        view={route.segments[3] === 'yaml' ? 'yaml' : 'diagram'}
      />
    );
  return (
    <LiveWorkspace
      key={id}
      api={api}
      tenant={tenant}
      query={route.query}
      flowId={id}
      service={service}
      live={live}
    />
  );
};
