import { lazy, Suspense } from 'react';
import { navigate, type Route } from '../../hooks';
import { PublicErrorBoundary } from './PublicErrorBoundary';

const publicAreas = ['about', 'data-handling', 'contact'];

const PublicSite = lazy(() => import('./PublicSite').then((m) => ({ default: m.PublicSite })));

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
  const onPublicPage = publicAreas.includes(route.segments[0] ?? '');
  return (
    <PublicErrorBoundary>
      <Suspense fallback={null}>
        <PublicSite
          route={route}
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
