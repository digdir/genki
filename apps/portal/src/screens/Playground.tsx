import {
  Button,
  Heading,
  Paragraph,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { PlaygroundPanel } from '../components/playground/PlaygroundPanel';
import { navigate, useNarrow } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { BlocksFullscreen, BlocksStep, useBlocksState } from './services/blocks/BlocksStep';
import { handOver } from './services/blocks/handoff';
import './playground.css';

type View = 'backend' | 'frontend';

const hrefs: Record<View, string> = {
  frontend: '/playground',
  backend: '/playground/backend',
};

/**
 * Frontend tries the interface of a service with the same building blocks as the builder. Backend
 * tries its content: a model, a dataset, a skill or a draft. Either can go on to a new service.
 */
export const Playground = ({ api, tenant, tenantName, route }: ScreenProps) => {
  const t = useT();
  const narrow = useNarrow();
  const blocks = useBlocksState();
  const view: View = route.segments[1] === 'backend' ? 'backend' : 'frontend';
  const fullscreen = route.segments[1] === 'preview';
  const chat = (
    <PlaygroundPanel
      key={blocks.conversation}
      layout="full"
      bare
      api={api}
      tenant={tenant}
      tenantName={tenantName}
    />
  );
  const address = t('playground.frontendAddress');
  const makeService = () => {
    handOver({
      layout: blocks.layout,
      ...(blocks.template ? { template: blocks.template } : {}),
    });
    navigate('/services/new');
  };

  if (fullscreen)
    return (
      <BlocksFullscreen
        state={blocks}
        chat={chat}
        address={address}
        backHref="#/playground"
        onExit={() => navigate('/playground')}
      />
    );

  return (
    <div className="playground-page">
      <header className="playground-head">
        <div className="playground-intro">
          <Heading level={1} data-size="lg">
            {t('playground.pageTitle')}
          </Heading>
          <Paragraph className="lead">{t('playground.pageLead')}</Paragraph>
        </div>
        <Button data-size="sm" onClick={makeService}>
          {t('playground.makeService')}
        </Button>
      </header>
      <Tabs data-size="md" value={view} onChange={(v) => navigate(hrefs[v as View])}>
        <TabsList aria-label={t('playground.viewsLabel')}>
          <TabsTab value="frontend">{t('playground.tabFrontend')}</TabsTab>
          <TabsTab value="backend">{t('playground.tabBackend')}</TabsTab>
        </TabsList>
        <TabsPanel value="frontend" className="playground-view">
          <BlocksStep
            state={blocks}
            narrow={narrow}
            chat={chat}
            address={address}
            onFullscreen={() => navigate('/playground/preview')}
          />
        </TabsPanel>
        <TabsPanel value="backend" className="playground-view">
          <PlaygroundPanel layout="full" api={api} tenant={tenant} tenantName={tenantName} />
        </TabsPanel>
      </Tabs>
    </div>
  );
};
