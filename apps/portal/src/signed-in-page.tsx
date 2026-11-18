import { Heading, Paragraph } from '@digdir/designsystemet-react';
import { lazy, useEffect } from 'react';
import { translator, useT } from './i18n';
import { withTexts } from './i18n/areas';
import './i18n/page-texts';
import type { ScreenProps } from './screen';
import { priceSegment } from './screens/about/public-pages';
import { apiReferenceHashFor, developerHashFor } from './screens/developer-routes';
import { Overview } from './screens/Overview';
import { navigation } from './Shell';
import { StrategyCatalogue } from './strategy-catalogue';
import './not-found.css';

const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length] ?? 0;
};

const names = (item: (typeof navigation)[number]) => [
  item.path.slice(1),
  ...(['nb', 'en'] as const).map((l) => translator(l)(item.label).toLowerCase()),
];

/** The menu item an unknown address most likely meant, by prefix or a near spelling. */
export const guessArea = (area: string) => {
  const wanted = area.toLowerCase();
  if (wanted.length < 3) return undefined;
  return navigation.find((item) =>
    names(item).some(
      (name) =>
        name.startsWith(wanted) ||
        wanted.startsWith(name) ||
        distance(wanted, name) <= Math.min(2, Math.floor(name.length / 3)),
    ),
  );
};

const Access = lazy(
  withTexts('access', () => import('./screens/Access').then((m) => ({ default: m.Access }))),
);
const BuildingBlocks = lazy(
  withTexts('buildingBlocks', () =>
    import('./screens/BuildingBlocks').then((m) => ({ default: m.BuildingBlocks })),
  ),
);
const DataHandling = lazy(
  withTexts('dataHandling', () =>
    import('./screens/DataHandling').then((m) => ({ default: m.DataHandling })),
  ),
);
const PricePage = lazy(
  withTexts('pricePage', () =>
    import('./screens/about/PricePage').then((m) => ({ default: m.PricePage })),
  ),
);
const Contact = lazy(
  withTexts('contact', () => import('./screens/FooterPages').then((m) => ({ default: m.Contact }))),
);
const Datasets = lazy(
  withTexts('datasets', () => import('./screens/Datasets').then((m) => ({ default: m.Datasets }))),
);
const DeveloperTools = lazy(
  withTexts('developerTools', () =>
    import('./screens/DeveloperTools').then((m) => ({ default: m.DeveloperTools })),
  ),
);
const Integrations = lazy(
  withTexts('integrations', () =>
    import('./screens/Integrations').then((m) => ({ default: m.Integrations })),
  ),
);
const Log = lazy(withTexts('log', () => import('./screens/Log').then((m) => ({ default: m.Log }))));
const Profile = lazy(
  withTexts('profile', () => import('./screens/Profile').then((m) => ({ default: m.Profile }))),
);
const Onboarding = lazy(
  withTexts('onboarding', () =>
    import('./screens/Onboarding').then((m) => ({ default: m.Onboarding })),
  ),
);
const Playground = lazy(
  withTexts('playground', () =>
    import('./screens/Playground').then((m) => ({ default: m.Playground })),
  ),
);
const Services = lazy(
  withTexts('services', () => import('./screens/Services').then((m) => ({ default: m.Services }))),
);
const Settings = lazy(
  withTexts('settings', () => import('./screens/Settings').then((m) => ({ default: m.Settings }))),
);
const SharedServices = lazy(
  withTexts('sharedServices', () =>
    import('./screens/SharedServices').then((m) => ({ default: m.SharedServices })),
  ),
);
const Skills = lazy(
  withTexts('skills', () => import('./screens/Skills').then((m) => ({ default: m.Skills }))),
);
const StepFlows = lazy(
  withTexts('stepFlows', () =>
    import('./screens/StepFlows').then((m) => ({ default: m.StepFlows })),
  ),
);
const Usage = lazy(
  withTexts('usage', () => import('./screens/Usage').then((m) => ({ default: m.Usage }))),
);

/** Sends an old address on to where the page lives now, keeping the rest of the route. */
const MovedTo = ({ hash }: { hash: string }) => {
  useEffect(() => {
    window.location.replace(hash);
  }, [hash]);
  return null;
};

const footerPages = {
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
  if (area === 'developer' && id === 'api' && sub === 'code')
    return <MovedTo hash="#/developer/api" />;
  if (area === 'developer' && id === 'settings') return <MovedTo hash="#/settings/all" />;
  if (area === 'developer' && id === 'step-flows')
    return (
      <MovedTo hash={window.location.hash.replace(/^#\/developer\/step-flows/, '#/step-flows')} />
    );
  if (area === 'developer')
    return id === 'hooks' && sub ? (
      <Integrations {...props} />
    ) : (
      <DeveloperTools {...props} integrations={(p) => <Integrations {...p} />} />
    );
  if (area === 'integrations') return <MovedTo hash={developerHashFor(props.route)} />;
  if (area === 'profile')
    return <Profile api={props.api} tenant={props.tenant} tenantName={props.tenantName} />;
  if (area === 'help') return <MovedTo hash="#/onboarding" />;
  if (area === 'onboarding') return <Onboarding {...props} />;
  if (area === 'api-reference') return <MovedTo hash={apiReferenceHashFor(props.route)} />;
  if (area === 'log' && !id && props.route.query.get('tab') === 'changes')
    return <MovedTo hash="#/log/changes" />;
  if (area === 'log') return <Log {...props} />;
  if (area === 'status') return <MovedTo hash="#/developer/status" />;
  if (area === 'settings' && props.route.query.get('tab') === 'transfer')
    return <MovedTo hash="#/settings/all" />;
  if (area === 'settings') return <Settings {...props} context={{ kind: 'tenant' }} />;
  if (area === 'data-handling') return <DataHandling api={props.api} />;
  if (area === 'about' && id === priceSegment) return <PricePage />;
  const item = guessArea(area);
  if (Object.hasOwn(footerPages, area))
    return (
      <>
        <Heading level={1} data-size="lg">
          {t(footerPages[area as keyof typeof footerPages])}
        </Heading>
        <Contact />
      </>
    );
  return (
    <>
      <Heading level={1} data-size="lg">
        {t('notFound.title')}
      </Heading>
      <Paragraph>{t('notFound.text', { path: window.location.hash })}</Paragraph>
      <ul className="not-found-links">
        {item ? (
          <li>
            <a className="ds-button" data-variant="primary" href={`#${item.path}`}>
              {t('notFound.goTo', { area: t(item.label) })}
            </a>
          </li>
        ) : null}
        <li>
          <a href="#/overview">{t('notFound.goToOverview')}</a>
        </li>
      </ul>
    </>
  );
};
