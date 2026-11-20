import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlaygroundPanel, type TriedHere } from '../components/playground/PlaygroundPanel';
import { navigate, useAsync, useNarrow } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { needsRight, useRights } from '../Shell';
import { PageLoading } from '../states';
import { BlocksFullscreen, BlocksStep, useBlocksState } from './services/blocks/BlocksStep';
import { storedLayout } from './services/blocks/layoutStore';
import { handOver, handoverDraftId, serviceFromPlayground } from './services/handover';
import './playground.css';

type View = 'frontend' | 'backend';

const ServicePlayground = ({
  api,
  tenant,
  tenantName,
  service,
  onTried,
}: Omit<ScreenProps, 'route' | 'live'> & {
  service: string;
  onTried: (tried: TriedHere) => void;
}) => {
  const t = useT();
  const [draft, retry] = useAsync(
    (signal) => api.quality.draft(tenant, service, signal).catch(() => undefined),
    [api, tenant, service],
  );
  if (draft.status !== 'ready')
    return <PageLoading label={t('playground.loadingSetup')} shape="detail" onRetry={retry} />;
  return (
    <PlaygroundPanel
      layout="page"
      context="service"
      name={service}
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      onTried={onTried}
      {...(draft.data
        ? { serviceDraft: { definition: draft.data.definition, files: draft.data.files } }
        : {})}
    />
  );
};

/**
 * Frontend tries the interface of a service with the builder's building blocks, without its
 * assistant. Backend tries its content: a model, instructions, datasets or a service's draft. Both
 * can go on to a new service. An old `#/playground?service=<id>` opens that draft in Backend.
 */
export const Playground = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const t = useT();
  const narrow = useNarrow();
  const canCreate = useRights().has('manage-services');
  const service = route.query.get('service');
  const [, sub] = route.segments;
  const fullscreen = sub === 'preview';
  const view: View = sub === 'backend' || (sub === undefined && service) ? 'backend' : 'frontend';
  const query = service ? `?service=${encodeURIComponent(service)}` : '';
  const hrefs: Record<View, string> = {
    frontend: service ? `/playground/frontend${query}` : '/playground',
    backend: `/playground/backend${query}`,
  };

  const blocks = useBlocksState();
  // Without a draft the try view runs the playground's own first setup.
  const run = useMemo(() => ({ api, tenant }), [api, tenant]);
  const address = t('playground.frontendAddress');

  // Backend starts once it is opened and then stays, so what is tried there outlives a tab switch.
  const [backendOpened, setBackendOpened] = useState(view === 'backend');
  useEffect(() => {
    if (view === 'backend') setBackendOpened(true);
  }, [view]);
  // What Backend tried, for the draft it was tried on: another `?service=` starts afresh.
  const tried = useRef<{ service: string | null; tried: TriedHere } | undefined>(undefined);
  const onTried = useCallback(
    (next: TriedHere) => {
      tried.current = { service, tried: next };
    },
    [service],
  );

  const [making, setMaking] = useState<'busy' | 'failed'>();
  const makeService = async () => {
    if (making === 'busy' || !canCreate) return;
    setMaking('busy');
    try {
      const template = await api.definitionTemplate(tenant, 'Service');
      const made = serviceFromPlayground({
        template,
        tenant,
        name: t('playground.newServiceName'),
        layout: storedLayout({
          layout: blocks.layout,
          ...(blocks.state.held ? { held: blocks.state.held } : {}),
        }),
        tried: tried.current?.service === service ? tried.current.tried : undefined,
      });
      const id = handoverDraftId();
      await api.quality.saveDraft(
        tenant,
        id,
        { definition: made.definition, files: made.files, revision: 0 },
        t('playground.newServiceReason'),
      );
      handOver(id, made.handover);
      navigate(`/services/${encodeURIComponent(id)}/setup`);
    } catch {
      setMaking('failed');
    }
  };

  const backend = service ? (
    <ServicePlayground
      key={service}
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      service={service}
      onTried={onTried}
    />
  ) : (
    <PlaygroundPanel
      layout="page"
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      onTried={onTried}
    />
  );

  return (
    <div className="playground-page">
      {fullscreen ? (
        <BlocksFullscreen
          state={blocks}
          run={run}
          address={address}
          backHref="#/playground"
          onExit={() => navigate('/playground')}
        />
      ) : null}
      <Tabs
        hidden={fullscreen || undefined}
        value={view}
        onChange={(v) => v !== view && navigate(hrefs[v as View])}
      >
        <div className="playground-views">
          <TabsList aria-label={t('playground.viewsLabel')}>
            <TabsTab value="frontend">{t('playground.tabFrontend')}</TabsTab>
            <TabsTab value="backend">{t('playground.tabBackend')}</TabsTab>
          </TabsList>
          {live ? (
            <span className="playground-make">
              <Button
                data-size="sm"
                aria-disabled={canCreate && making !== 'busy' ? undefined : true}
                onClick={() => void makeService()}
              >
                {t('playground.makeService')}
              </Button>
              {canCreate ? null : (
                <span className="playground-subtle">{needsRight('manage-services', t)}</span>
              )}
            </span>
          ) : null}
        </div>
        {making === 'failed' ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {t('playground.makeServiceFailed')}
          </Alert>
        ) : null}
        <TabsPanel value="frontend">
          {view === 'frontend' && !fullscreen ? (
            <div className="playground-frontend">
              <div className="page-head">
                <div className="page-head-text">
                  <Heading level={1} data-size="lg">
                    {t('playground.pageHeading')}
                  </Heading>
                  <Paragraph className="lead">{t('playground.frontendLead')}</Paragraph>
                </div>
              </div>
              <BlocksStep
                state={blocks}
                narrow={narrow}
                run={run}
                address={address}
                onFullscreen={() => navigate('/playground/preview')}
              />
            </div>
          ) : null}
        </TabsPanel>
        <TabsPanel value="backend">
          {backendOpened ? <div hidden={view !== 'backend' || undefined}>{backend}</div> : null}
        </TabsPanel>
      </Tabs>
    </div>
  );
};
