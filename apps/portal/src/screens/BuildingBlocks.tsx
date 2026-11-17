import { Heading } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { blockPath, type BlockKind } from '../api/building-blocks';
import { Crumbs } from '../components/Crumbs';
import { publisherOptions } from '../data/building-blocks';
import { navigate, useAsync, type Route } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';
import {
  BlockDetail,
  blockTabs,
  type BlockTab,
  type ServiceRuns,
} from './buildingblocks/BlockDetail';
import { BlockList, listKinds, type ListFilters, type ListTab } from './buildingblocks/BlockList';
import { FlashMessage, settled, type Flash } from './buildingblocks/common';
import { ConnectorsPage } from './buildingblocks/ConnectorsPage';
import { RegisterBlock } from './buildingblocks/RegisterBlock';
import './buildingblocks.css';

const listSegments: Record<string, ListTab> = { 'in-use': 'in-use', catalogue: 'catalog' };
const tabSegment: Record<ListTab, string> = { 'in-use': 'in-use', catalog: 'catalogue' };

const filtersOf = (route: Route): ListFilters => {
  const type = route.query.get('type');
  const publisher = route.query.get('publisher');
  return {
    tab: listSegments[route.segments[1] ?? ''] ?? 'in-use',
    q: route.query.get('q') ?? '',
    kind: listKinds.find((k) => k === type) ?? 'all',
    publisher: publisherOptions.find((o) => o.value === publisher)?.value ?? 'all',
  };
};

export const listHash = (filters: ListFilters) => {
  const query = new URLSearchParams();
  if (filters.kind !== 'all') query.set('type', filters.kind);
  if (filters.publisher !== 'all') query.set('publisher', filters.publisher);
  if (filters.q) query.set('q', filters.q);
  const search = query.toString();
  return `/building-blocks/${tabSegment[filters.tab]}${search ? `?${search}` : ''}`;
};

const ListPage = ({
  api,
  tenant,
  tenantName,
  filters,
  onFilters,
  onFlash,
  version,
}: ScreenProps & {
  filters: ListFilters;
  onFilters: (f: ListFilters) => void;
  onFlash: (flash: Flash) => void;
  version: number;
}) => {
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [list, proposals, connectors] = await Promise.all([
        api.buildingBlocks.list(tenant, {}, signal),
        settled(api.buildingBlocks.proposals(tenant, signal)),
        settled(api.buildingBlocks.connectors(tenant, signal)),
      ]);
      return { ...list, proposals, connectors };
    },
    [tenant, version],
    { keepPreviousFor: tenant },
  );
  if (state.status !== 'ready')
    return (
      <div className="stack">
        <Heading level={1} data-size="lg">
          {t('blocks.title')}
        </Heading>
        {state.status === 'loading' ? (
          <Loading label={t('blocks.loadingList')} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );
  const { proposals, connectors } = state.data;
  const failed = !proposals.ok ? proposals.error : !connectors.ok ? connectors.error : undefined;
  return (
    <BlockList
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      items={state.data.data}
      proposals={proposals.ok ? proposals.data : []}
      connectors={connectors.ok ? connectors.data : []}
      partialError={failed === undefined ? undefined : { error: failed, retry }}
      filters={filters}
      onFilters={onFilters}
      onFlash={onFlash}
    />
  );
};

const DetailPage = ({
  api,
  tenant,
  tenantName,
  kind,
  id,
  tab,
  onChanged,
}: ScreenProps & {
  kind: BlockKind;
  id: string;
  tab: BlockTab;
  onChanged: (flash: Flash) => void;
}) => {
  const t = useT();
  const [version, setVersion] = useState(0);
  const [state, retry] = useAsync(
    async (signal) => {
      const block = { kind, id };
      const [item, versions, services] = await Promise.all([
        api.buildingBlocks.get(tenant, block, signal),
        settled(api.buildingBlocks.versions(tenant, block, signal)),
        api
          .overview(tenant, signal)
          .then((o): ServiceRuns[] =>
            o.services.map((s) => ({
              id: s.id,
              name: s.name,
              ...(s.runsThisWeek === undefined ? {} : { runsThisWeek: s.runsThisWeek }),
            })),
          )
          .catch((): ServiceRuns[] => []),
      ]);
      return { item, versions, services };
    },
    [tenant, kind, id, version],
    { keepPreviousFor: `${tenant}/${kind}/${id}` },
  );
  if (state.status === 'loading') return <Loading label={t('blocks.loadingOne')} />;
  if (state.status === 'error')
    return (
      <div className="stack">
        <Crumbs items={[{ label: t('blocks.title'), href: '#/building-blocks' }, { label: id }]} />
        <Heading level={1} data-size="md">
          {t('blocks.blockOne')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  return (
    <BlockDetail
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      item={state.data.item}
      services={state.data.services}
      versions={state.data.versions}
      tab={tab}
      onRetry={retry}
      onChanged={(flash) => {
        onChanged(flash);
        setVersion((v) => v + 1);
      }}
    />
  );
};

export const BuildingBlocks = (props: ScreenProps) => {
  const { route } = props;
  const [, kind, id, view] = route.segments;
  const fromRoute = filtersOf(route);
  const [typed, setTyped] = useState(fromRoute);
  const filters = { ...typed, tab: fromRoute.tab };
  const [flash, setFlash] = useState<{ path: string; flash: Flash } | null>(null);
  const [version, setVersion] = useState(0);
  const path = route.path;

  const search = route.query.toString();
  useEffect(() => {
    setTyped(filtersOf(route));
  }, [search, kind]);

  useEffect(() => {
    setFlash(null);
  }, [props.tenant]);

  const show = (next: Flash, at = path) => {
    setFlash({ path: at, flash: next });
    setVersion((v) => v + 1);
    window.scrollTo?.(0, 0);
  };

  const changeFilters = (next: ListFilters) => {
    setTyped(next);
    if (next.tab !== filters.tab) navigate(listHash(next));
    else window.location.replace(`#${listHash(next)}`);
  };

  let page;
  if (kind === 'new')
    page = (
      <RegisterBlock
        api={props.api}
        tenant={props.tenant}
        tenantName={props.tenantName}
        onRegistered={(block, next) => {
          show(next, `/building-blocks/${block.kind}/${block.id}`);
          navigate(`/building-blocks${blockPath(block)}`);
        }}
      />
    );
  else if (kind === 'connectors' && !id)
    page = <ConnectorsPage {...props} version={version} onFlash={(next) => show(next)} />;
  else if (kind && id)
    page = (
      <DetailPage
        {...props}
        kind={kind as BlockKind}
        id={id}
        tab={blockTabs[view ?? ''] ?? 'about'}
        onChanged={(next) => show(next)}
      />
    );
  else
    page = (
      <ListPage
        {...props}
        filters={filters}
        onFilters={changeFilters}
        onFlash={(next) => show(next)}
        version={version}
      />
    );

  return (
    <div className="stack">
      <FlashMessage flash={flash?.path === path ? flash.flash : null} />
      {page}
    </div>
  );
};
