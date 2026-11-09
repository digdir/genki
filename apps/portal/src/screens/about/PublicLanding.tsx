import { Switch } from '@digdir/designsystemet-react';
import { lazy, Suspense } from 'react';
import { navigate, type Route } from '../../hooks';
import { useT } from '../../i18n';
import { Startside } from '../Startside';
import { useLanding } from './landing';
import { PublicErrorBoundary } from './PublicErrorBoundary';

const publicAreas = ['about', 'data-handling', 'contact'];

const PublicSite = lazy(() => import('./PublicSite').then((m) => ({ default: m.PublicSite })));

const LandingSwitch = ({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const t = useT();
  return (
    <div className="start-preview">
      <div className="start-preview-bar">
        <Switch
          data-size="sm"
          data-color="accent"
          label={t('about.previewSwitch')}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      </div>
    </div>
  );
};

export const PublicLanding = ({
  route,
  onLogin,
  busy,
  failed,
}: {
  route: Route;
  onLogin: () => void;
  busy: boolean;
  failed: boolean;
}) => {
  const [landing, choose] = useLanding(route.query);
  const onPublicPage = publicAreas.includes(route.segments[0] ?? '');
  const preview = (
    <LandingSwitch
      checked={landing === 'new' || onPublicPage}
      onChange={(on) => {
        choose(on ? 'new' : 'old');
        if (!on && onPublicPage) navigate('/');
      }}
    />
  );
  if (!onPublicPage && landing === 'old')
    return <Startside onLogin={onLogin} busy={busy} failed={failed} preview={preview} />;
  return (
    <PublicErrorBoundary>
      <Suspense fallback={null}>
        <PublicSite
          route={route}
          preview={preview}
          busy={busy}
          failed={failed}
          onLogin={() => {
            if (onPublicPage) navigate('/');
            onLogin();
          }}
        />
      </Suspense>
    </PublicErrorBoundary>
  );
};
