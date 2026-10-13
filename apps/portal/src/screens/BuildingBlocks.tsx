import { Heading } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { blockPath, type BlockKind, type BlockUser } from '../api/building-blocks';
import { Crumbs } from '../components/Crumbs';
import { navigate, useAsync } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { ErrorState, Loading } from '../states';
import { BlockDetail } from './buildingblocks/BlockDetail';
import { BlockList, initialFilters, type ListFilters } from './buildingblocks/BlockList';
import { FlashMessage, type Flash } from './buildingblocks/common';
import { ConnectorsPage } from './buildingblocks/ConnectorsPage';
import { RegisterBlock } from './buildingblocks/RegisterBlock';
import './buildingblocks.css';

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
        api.buildingBlocks.proposals(tenant, signal).catch(() => []),
        api.buildingBlocks.connectors(tenant, signal).catch(() => []),
      ]);
      return { ...list, proposals, connectors };
    },
    [tenant, version],
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
  return (
    <BlockList
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      items={state.data.data}
      proposals={state.data.proposals}
      connectors={state.data.connectors}
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
  onChanged,
}: ScreenProps & { kind: BlockKind; id: string; onChanged: (flash: Flash) => void }) => {
  const t = useT();
  const [version, setVersion] = useState(0);
  const [state, retry] = useAsync(
    async (signal) => {
      const block = { kind, id };
      const [item, versions, services] = await Promise.all([
        api.buildingBlocks.get(tenant, block, signal),
        api.buildingBlocks.versions(tenant, block, signal).catch(() => []),
        api
          .overview(tenant, signal)
          .then((o): BlockUser[] => o.services.map((s) => ({ id: s.id, name: s.name })))
          .catch((): BlockUser[] => []),
      ]);
      return { item, versions, services };
    },
    [tenant, kind, id, version],
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
      onChanged={(flash) => {
        onChanged(flash);
        setVersion((v) => v + 1);
      }}
    />
  );
};

export const BuildingBlocks = (props: ScreenProps) => {
  const [, kind, id] = props.route.segments;
  const [filters, setFilters] = useState<ListFilters>(initialFilters);
  const [flash, setFlash] = useState<{ path: string; flash: Flash } | null>(null);
  const [version, setVersion] = useState(0);
  const path = props.route.path;

  useEffect(() => {
    setFilters(initialFilters);
    setFlash(null);
  }, [props.tenant]);

  const show = (next: Flash, at = path) => {
    setFlash({ path: at, flash: next });
    setVersion((v) => v + 1);
    window.scrollTo?.(0, 0);
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
      <DetailPage {...props} kind={kind as BlockKind} id={id} onChanged={(next) => show(next)} />
    );
  else
    page = (
      <ListPage
        {...props}
        filters={filters}
        onFilters={setFilters}
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
