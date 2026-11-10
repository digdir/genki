import { useEffect, useState, type ReactNode } from 'react';
import { BlockDetail } from './pages/BlockDetail';
import { Blocks } from './pages/Blocks';
import { CaseFlow } from './pages/CaseFlow';
import { ComponentDetail } from './pages/ComponentDetail';
import { GetStarted } from './pages/GetStarted';
import { Malbilde } from './pages/Malbilde';
import { Overview } from './pages/Overview';
import { SearchPage } from './pages/SearchPage';
import { Services } from './pages/Services';
import { ServiceTypeDetail } from './pages/ServiceTypeDetail';
import { ServiceTypes } from './pages/ServiceTypes';
import { StatusPage } from './pages/StatusPage';
import { NotFound } from './components/NotFound';
import { useDocumentTitle } from './document';
import { useT } from './i18n';
import { href, type Route } from './router';

export function DocsPage({ route, overview }: { route: Route; overview?: ReactNode }) {
  switch (route.page) {
    case 'byggeklosser':
      if (!route.id) return <Blocks />;
      return route.sub ? (
        <ComponentDetail blockId={route.id} id={route.sub} />
      ) : (
        <BlockDetail id={route.id} />
      );
    case 'tjenester':
      return route.id ? <CaseFlow id={route.id} del={route.del} steg={route.steg} /> : <Services />;
    case 'typer':
      return route.id ? <ServiceTypeDetail id={route.id} /> : <ServiceTypes />;
    case 'sok':
      return <SearchPage q={route.q} />;
    case 'status':
      return <StatusPage id={route.id} />;
    case 'malbilde':
      return <Malbilde />;
    case 'kom-i-gang':
      return <GetStarted />;
    case 'ikke-funnet':
      return <PageNotFound />;
    default:
      return <Overview>{overview}</Overview>;
  }
}

function PageNotFound() {
  const t = useT();
  useDocumentTitle(t('docsCommon.notFoundTitle'));
  return (
    <NotFound
      title={t('docsCommon.notFoundTitle')}
      message={t('docsCommon.notFoundBody')}
      back={{ href: href({ page: 'oversikt' }), label: t('docsCommon.toStart') }}
    />
  );
}

export function useSearchShortcut() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen] as const;
}
