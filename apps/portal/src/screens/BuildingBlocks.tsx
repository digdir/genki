import { Alert, Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { blockPath, type BlockKind } from '../api/building-blocks';
import { navigate, parseRoute, useAsync, type Route } from '../hooks';
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
import { TypeHeader, TypeList, type TypeFilters } from './buildingblocks/BlockList';
import { OverviewBody, OverviewHeader, SearchAll } from './buildingblocks/BlocksOverview';
import {
  movedKindHash,
  movedListHash,
  typeFromSegment,
  typeHref,
  type TypeKey,
} from './buildingblocks/block-types';
import { SkillBlockPage } from './skills/SkillBlockPage';
import { FlashMessage, settled, type Flash } from './buildingblocks/common';
import { ConnectorsPage } from './buildingblocks/ConnectorsPage';
import { RegisterBlock } from './buildingblocks/RegisterBlock';
import { ModelCatalog } from './models/ModelCatalog';
import { ModelsInUse } from './models/ModelsInUse';
import { BackLink } from '../components/BackLink';
import './buildingblocks.css';

const filtersOf = (route: Route): TypeFilters => ({
  show: route.query.get('show') === 'catalogue' ? 'catalogue' : 'in-use',
  q: route.query.get('q') ?? '',
});

export const kindAliases: Record<string, BlockKind> = {
  'step-flow': 'step_flow',
  'search-engine': 'search_engine',
  'shared-service': 'shared_service',
  'extension-point': 'extension_point',
};

const useBlockList = (api: ScreenProps['api'], tenant: string, version: number) =>
  useAsync(
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

const ListError = ({ catalogue, onRetry }: { catalogue: boolean; onRetry: () => void }) => {
  const t = useT();
  return (
    <Alert data-color="danger" role="alert">
      <Heading level={2} data-size="xs">
        {catalogue ? t('blockPages.errorCatalogueTitle') : t('blockPages.errorInUseTitle')}
      </Heading>
      <Paragraph>
        {catalogue ? t('blockPages.errorCatalogueBody') : t('blockPages.errorInUseBody')}
      </Paragraph>
      <Button variant="secondary" data-size="sm" onClick={onRetry}>
        {t('common.tryAgain')}
      </Button>
    </Alert>
  );
};

const OverviewPage = ({
  api,
  tenant,
  tenantName,
  q,
  onQuery,
  version,
}: ScreenProps & { q: string; onQuery: (q: string) => void; version: number }) => {
  const t = useT();
  const [state, retry, pending] = useBlockList(api, tenant, version);
  return (
    <div className="stack">
      <OverviewHeader tenantName={tenantName} />
      <SearchAll q={q} onQuery={onQuery} />
      {state.status === 'loading' ? (
        <Loading label={t('blocks.loadingList')} shape="list" onRetry={retry} />
      ) : state.status === 'error' ? (
        <ListError catalogue={false} onRetry={retry} />
      ) : (
        <OverviewBody
          api={api}
          tenant={tenant}
          items={state.data.data}
          required={state.data.counts.required ?? {}}
          refreshing={pending}
          proposals={state.data.proposals.ok ? state.data.proposals.data : []}
          partialError={
            state.data.proposals.ok ? undefined : { error: state.data.proposals.error, retry }
          }
          q={q}
          onQuery={onQuery}
        />
      )}
    </div>
  );
};

const TypePage = ({
  api,
  tenant,
  tenantName,
  type,
  filters,
  onFilters,
  onFlash,
  version,
}: ScreenProps & {
  type: TypeKey;
  filters: TypeFilters;
  onFilters: (f: TypeFilters) => void;
  onFlash: (flash: Flash) => void;
  version: number;
}) => {
  const t = useT();
  const [state, retry, pending] = useBlockList(api, tenant, version);
  if (state.status !== 'ready')
    return (
      <div className="stack">
        <TypeHeader type={type} />
        {state.status === 'loading' ? (
          <Loading label={t('blocks.loadingList')} shape="list" onRetry={retry} />
        ) : (
          <ListError catalogue={filters.show === 'catalogue'} onRetry={retry} />
        )}
      </div>
    );
  const { proposals, connectors } = state.data;
  const failed = !proposals.ok ? proposals.error : !connectors.ok ? connectors.error : undefined;
  return (
    <TypeList
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      type={type}
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
            ? { ...flash, link: { href: typeHref(type), label: t('blockPages.seeInUse') } }
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

const blockKindList: readonly string[] = [
  'model',
  'dataset',
  'search_engine',
  'tool',
  'skill',
  'extension_point',
  'guardrail',
  'judge',
  'step_flow',
  'shared_service',
];

const movedHash = (route: Route) => {
  const [, kind, id] = route.segments;
  if (kind === 'in-use' || kind === 'catalogue') return movedListHash(route);
  if (kind && blockKindList.includes(kind))
    return movedKindHash(kind as BlockKind, id, route.query);
  if (kind && !id && !typeFromSegment(kind) && !['new', 'models', 'connectors'].includes(kind))
    return '#/building-blocks';
  return undefined;
};

export const BuildingBlocks = (props: ScreenProps) => {
  const t = useT();
  const { route } = props;
  const [, kind, id, view] = route.segments;
  const fromRoute = filtersOf(route);
  const [typed, setTyped] = useState(fromRoute);
  const filters = { ...typed, show: fromRoute.show };
  const [flash, setFlash] = useState<{ path: string; flash: Flash } | null>(null);
  const [version, setVersion] = useState(0);
  const path = route.path;
  const type = typeFromSegment(kind);

  const search = route.query.toString();
  useEffect(() => {
    const now = parseRoute(window.location.hash);
    if (now.path === route.path && now.query.toString() === search) setTyped(filtersOf(route));
  }, [search, kind]);

  useEffect(() => {
    setFlash(null);
  }, [props.tenant]);

  const show = (next: Flash, at = path) => {
    setFlash({ path: at, flash: next });
    setVersion((v) => v + 1);
    window.scrollTo?.(0, 0);
  };

  const changeFilters = (next: TypeFilters) => {
    if (!type) return;
    setTyped(next);
    const hash = typeHref(type, next.show, next.q);
    if (next.show !== filters.show) navigate(hash.slice(1));
    else window.location.replace(hash);
  };

  const changeQuery = (q: string) => {
    setTyped({ ...typed, q });
    window.location.replace(
      q ? `#/building-blocks?q=${encodeURIComponent(q)}` : '#/building-blocks',
    );
  };

  const alias = kind ? kindAliases[kind] : undefined;
  const moved = alias ? undefined : movedHash(route);
  useEffect(() => {
    if (alias)
      window.location.replace(
        `#${path.replace(`/building-blocks/${kind}`, `/building-blocks/${alias}`)}`,
      );
    else if (moved) window.location.replace(moved);
  }, [alias, moved, path]);

  let page;
  if (alias || moved) page = <Loading label={t('blocks.loadingOne')} shape="detail" />;
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
  else if (kind === 'models')
    page = id === 'in-use' ? <ModelsInUse {...props} /> : <ModelCatalog {...props} />;
  else if (kind === 'connectors' && !id)
    page = <ConnectorsPage {...props} version={version} onFlash={(next) => show(next)} />;
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
  else if (type)
    page = (
      <TypePage
        {...props}
        type={type}
        filters={filters}
        onFilters={changeFilters}
        onFlash={(next) => show(next)}
        version={version}
      />
    );
  else page = <OverviewPage {...props} q={typed.q} onQuery={changeQuery} version={version} />;

  return (
    <div className="stack">
      <FlashMessage flash={flash?.path === path ? flash.flash : null} />
      {page}
    </div>
  );
};
