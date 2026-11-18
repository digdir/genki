import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { blockPath, type BlockKind } from '../api/building-blocks';
import { navigate, useAsync, type Route } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';
import {
  BlockDetail,
  BlockDetailLoading,
  blockTabs,
  type BlockTab,
  type ServiceRuns,
} from './buildingblocks/BlockDetail';
import {
  BlockList,
  ListHeader,
  listKinds,
  type ListFilters,
  type ListTab,
} from './buildingblocks/BlockList';
import { SkillBlockPage } from './skills/SkillBlockPage';
import { StepFlowEditor } from './StepFlows';
import { FlashMessage, settled, type Flash } from './buildingblocks/common';
import { ConnectorsPage } from './buildingblocks/ConnectorsPage';
import { RegisterBlock } from './buildingblocks/RegisterBlock';
import { BackLink } from '../components/BackLink';
import './buildingblocks.css';

const listSegments: Record<string, ListTab> = { 'in-use': 'in-use', catalogue: 'catalog' };
const tabSegment: Record<ListTab, string> = { 'in-use': 'in-use', catalog: 'catalogue' };

const filtersOf = (route: Route): ListFilters => {
  const type = route.query.get('type');
  return {
    tab: listSegments[route.segments[1] ?? ''] ?? 'in-use',
    q: route.query.get('q') ?? '',
    kind: listKinds.find((k) => k === type) ?? 'all',
  };
};

export const kindAliases: Record<string, BlockKind> = {
  'step-flow': 'step_flow',
  'search-engine': 'search_engine',
  'shared-service': 'shared_service',
  'extension-point': 'extension_point',
};

export const listHash = (filters: ListFilters) => {
  const query = new URLSearchParams();
  if (filters.kind !== 'all') query.set('type', filters.kind);
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
  const [state, retry, pending] = useAsync(
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
  if (state.status !== 'ready') {
    const catalogue = filters.tab === 'catalog';
    return (
      <div className="stack">
        <ListHeader tab={filters.tab} tenantName={tenantName} />
        {state.status === 'loading' ? (
          <Loading label={t('blocks.loadingList')} shape="list" onRetry={retry} />
        ) : (
          <Alert data-color="danger" role="alert">
            <Heading level={2} data-size="xs">
              {catalogue ? t('blockPages.errorCatalogueTitle') : t('blockPages.errorInUseTitle')}
            </Heading>
            <Paragraph>
              {catalogue ? t('blockPages.errorCatalogueBody') : t('blockPages.errorInUseBody')}
            </Paragraph>
            <Button variant="secondary" data-size="sm" onClick={retry}>
              {t('common.tryAgain')}
            </Button>
          </Alert>
        )}
      </div>
    );
  }
  const { proposals, connectors } = state.data;
  const failed = !proposals.ok ? proposals.error : !connectors.ok ? connectors.error : undefined;
  return (
    <BlockList
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      items={state.data.data}
      refreshing={pending}
      proposals={proposals.ok ? proposals.data : []}
      connectors={connectors.ok ? connectors.data : []}
      partialError={failed === undefined ? undefined : { error: failed, retry }}
      filters={filters}
      onFilters={onFilters}
      onFlash={onFlash}
      onAdopted={(flash, adopted) =>
        onFlash(
          adopted
            ? {
                ...flash,
                link: { href: '#/building-blocks/in-use', label: t('blockPages.seeInUse') },
              }
            : flash,
        )
      }
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
      const [item, versions] = await Promise.all([
        api.buildingBlocks.get(tenant, block, signal),
        settled(api.buildingBlocks.versions(tenant, block, signal)),
      ]);
      return { item, versions };
    },
    [tenant, kind, id, version],
    { keepPreviousFor: `${tenant}/${kind}/${id}` },
  );
  const [runs] = useAsync(
    (signal) =>
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
    [tenant],
  );
  if (state.status === 'loading')
    return (
      <BlockDetailLoading
        block={{ kind, id }}
        tab={tab}
        label={t('blocks.loadingOne')}
        onRetry={retry}
      />
    );
  if (state.status === 'error')
    return (
      <div className="stack">
        <BackLink label={t('blocks.title')} href="#/building-blocks" />
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
      services={runs.status === 'ready' ? runs.data : []}
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
  const t = useT();
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

  const alias = kind ? kindAliases[kind] : undefined;
  useEffect(() => {
    if (alias)
      window.location.replace(
        `#${path.replace(`/building-blocks/${kind}`, `/building-blocks/${alias}`)}`,
      );
  }, [alias, path]);

  let page;
  if (alias) page = <Loading label={t('blocks.loadingOne')} shape="detail" />;
  else if (kind === 'new')
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
  else if (kind === 'step_flow' && id && view === 'edit')
    page = <StepFlowEditor {...props} id={id} />;
  else if (kind === 'skill' && id) page = <SkillBlockPage {...props} id={id} tab={view} />;
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
