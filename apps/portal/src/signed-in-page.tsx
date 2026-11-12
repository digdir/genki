import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { lazy, useEffect } from 'react';
import { useT } from './i18n';
import type { ScreenProps } from './screen';
import { developerHashFor } from './screens/developer-routes';
import { Overview } from './screens/Overview';
import { navigation } from './Shell';
import { StrategyCatalogue } from './strategy-catalogue';

const Access = lazy(() => import('./screens/Access').then((m) => ({ default: m.Access })));
const ApiReference = lazy(() =>
  import('./screens/ApiReference').then((m) => ({ default: m.ApiReference })),
);
const BuildingBlocks = lazy(() =>
  import('./screens/BuildingBlocks').then((m) => ({ default: m.BuildingBlocks })),
);
const DataHandling = lazy(() =>
  import('./screens/DataHandling').then((m) => ({ default: m.DataHandling })),
);
const Contact = lazy(() => import('./screens/FooterPages').then((m) => ({ default: m.Contact })));
const Guide = lazy(() => import('./screens/FooterPages').then((m) => ({ default: m.Guide })));
const Status = lazy(() => import('./screens/FooterPages').then((m) => ({ default: m.Status })));
const Datasets = lazy(() => import('./screens/Datasets').then((m) => ({ default: m.Datasets })));
const DeveloperTools = lazy(() =>
  import('./screens/DeveloperTools').then((m) => ({ default: m.DeveloperTools })),
);
const Integrations = lazy(() =>
  import('./screens/Integrations').then((m) => ({ default: m.Integrations })),
);
const Log = lazy(() => import('./screens/Log').then((m) => ({ default: m.Log })));
const Profile = lazy(() => import('./screens/Profile').then((m) => ({ default: m.Profile })));
const Playground = lazy(() =>
  import('./screens/Playground').then((m) => ({ default: m.Playground })),
);
const Services = lazy(() => import('./screens/Services').then((m) => ({ default: m.Services })));
const Settings = lazy(() => import('./screens/Settings').then((m) => ({ default: m.Settings })));
const SharedServices = lazy(() =>
  import('./screens/SharedServices').then((m) => ({ default: m.SharedServices })),
);
const Skills = lazy(() => import('./screens/Skills').then((m) => ({ default: m.Skills })));
const StepFlows = lazy(() => import('./screens/StepFlows').then((m) => ({ default: m.StepFlows })));
const Usage = lazy(() => import('./screens/Usage').then((m) => ({ default: m.Usage })));

/** Sends an old address on to where the page lives now, keeping the rest of the route. */
const MovedTo = ({ hash }: { hash: string }) => {
  useEffect(() => {
    window.location.replace(hash);
  }, [hash]);
  return null;
};

const footerPages = {
  status: 'shell.status',
  contact: 'shell.contact',
} as const;

export const Page = ({
  onFailingIngests,
  ...props
}: ScreenProps & { onFailingIngests: (count: number) => void }) => {
  const t = useT();
  const [area = 'overview', id, sub] = props.route.segments;
  if (area === 'overview') return <Overview {...props} onFailingIngests={onFailingIngests} />;
  if (area === 'services')
    return (
      <StrategyCatalogue api={props.api} tenant={props.tenant}>
        <Services {...props} />
      </StrategyCatalogue>
    );
  if (area === 'step-flows') return <StepFlows {...props} />;
  if (area === 'shared-services') return <SharedServices {...props} />;
  if (area === 'datasets' && id && id !== 'new' && sub === 'settings')
    return <Settings {...props} context={{ kind: 'dataset', id }} />;
  if (area === 'datasets') return <Datasets {...props} />;
  if (area === 'building-blocks') return <BuildingBlocks {...props} />;
  if (area === 'skills') return <Skills {...props} />;
  if (area === 'playground') return <Playground {...props} />;
  if (area === 'access') return <Access {...props} />;
  if (area === 'usage')
    return <MovedTo hash={window.location.hash.replace(/^#\/usage/, '#/statistics')} />;
  if (area === 'statistics') return <Usage {...props} />;
  if (area === 'developer')
    return (id === 'api' && sub === 'code') || (id === 'hooks' && sub) ? (
      <Integrations {...props} />
    ) : (
      <DeveloperTools {...props} integrations={(p) => <Integrations {...p} />} />
    );
  if (area === 'integrations') return <MovedTo hash={developerHashFor(props.route)} />;
  if (area === 'profile') return <Profile />;
  if (area === 'help') return <MovedTo hash="#/onboarding" />;
  if (area === 'onboarding')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('shell.menuOnboarding')}
        </Heading>
        <Guide />
      </>
    );
  if (area === 'api-reference') return <ApiReference {...props} />;
  if (area === 'log') return <Log {...props} />;
  if (area === 'settings') return <Settings {...props} context={{ kind: 'tenant' }} />;
  if (area === 'data-handling') return <DataHandling api={props.api} />;
  const item = navigation.find((n) => n.path === `/${area}`);
  if (Object.hasOwn(footerPages, area))
    return (
      <>
        <Heading level={1} data-size="lg">
          {t(footerPages[area as keyof typeof footerPages])}
        </Heading>
        {area === 'status' ? <Status api={props.api} /> : <Contact />}
      </>
    );
  return (
    <>
      <Heading level={1} data-size="lg">
        {item
          ? t(item.label)
          : Object.hasOwn(footerPages, area)
            ? t(footerPages[area as keyof typeof footerPages])
            : t('app.notFound')}
      </Heading>
      <Paragraph>{t.rich('app.notDrawn', { link: (c) => <a href="#/overview">{c}</a> })}</Paragraph>
    </>
  );
};
