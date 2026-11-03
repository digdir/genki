import { Button, Dropdown, Paragraph } from '@digdir/designsystemet-react';
import {
  MagnifyingGlassIcon,
  MenuElipsisHorizontalIcon,
  MoonIcon,
  SunIcon,
} from '@navikt/aksel-icons';
import { useEffect, useState } from 'react';
import { links } from './data/blocks';
import { BlockDetail } from './pages/BlockDetail';
import { Blocks } from './pages/Blocks';
import { ComponentDetail } from './pages/ComponentDetail';
import { CaseFlow } from './pages/CaseFlow';
import { Services } from './pages/Services';
import { ServiceTypeDetail } from './pages/ServiceTypeDetail';
import { ServiceTypes } from './pages/ServiceTypes';
import { SearchPage } from './pages/SearchPage';
import { StatusPage } from './pages/StatusPage';
import { SearchDialog } from './components/SearchDialog';
import { GetStarted } from './pages/GetStarted';
import { Overview } from './pages/Overview';
import { Malbilde } from './pages/Malbilde';
import { href, useRoute, type Route } from './router';

type Scheme = 'light' | 'dark';

function useColorScheme(): [Scheme, () => void] {
  const [scheme, setScheme] = useState<Scheme>(() => {
    const stored = localStorage.getItem('genki-scheme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-color-scheme', scheme);
    localStorage.setItem('genki-scheme', scheme);
  }, [scheme]);
  return [scheme, () => setScheme((s) => (s === 'dark' ? 'light' : 'dark'))];
}

const navItems: { label: string; route: Route }[] = [
  { label: 'Oversikt', route: { page: 'oversikt' } },
  { label: 'Målbilde', route: { page: 'malbilde' } },
  { label: 'Byggeklosser', route: { page: 'byggeklosser' } },
  { label: 'Flyt', route: { page: 'tjenester' } },
  { label: 'Kom i gang', route: { page: 'kom-i-gang' } },
];

/** Digdirs D-merke, i Digdir-blått. */
function Logo() {
  return (
    <svg viewBox="11 11 26 26" aria-hidden>
      <path
        d="M24.3422 11H11.5265C11.3869 11 11.253 11.0554 11.1542 11.1539C11.0555 11.2524 11 11.3861 11 11.5255V36.4746C11 36.6138 11.0555 36.7476 11.1542 36.8461C11.253 36.9447 11.3869 37 11.5265 37H24.3422C27.7315 36.9038 30.9497 35.4925 33.313 33.0661C35.6761 30.6395 36.9983 27.389 36.9983 24.0052C36.9983 20.6214 35.6761 17.371 33.313 14.9445C30.9497 12.518 27.7315 11.1067 24.3422 11.0105V11ZM25.5954 33.0801C23.6563 33.4131 21.6614 33.1215 19.8995 32.2477C18.1375 31.3737 16.7 29.9629 15.7951 28.2193C14.8901 26.4757 14.5648 24.49 14.8661 22.5496C15.1674 20.6092 16.0797 18.8148 17.471 17.4264C18.8623 16.0379 20.6602 15.1274 22.6046 14.8267C24.5489 14.526 26.5387 14.8507 28.2858 15.7539C30.0329 16.6569 31.4467 18.0916 32.3222 19.8499C33.198 21.6083 33.49 23.5992 33.1564 25.5344C32.8316 27.4175 31.9303 29.1541 30.5764 30.5053C29.2224 31.8565 27.4824 32.7559 25.5954 33.0801Z"
        fill="var(--ds-color-accent-base-default, #0062ba)"
      />
    </svg>
  );
}

export function App() {
  const route = useRoute();
  const [scheme, toggle] = useColorScheme();
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl+K eller Cmd+K åpner søket fra hvor som helst.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  let page: React.ReactNode;
  switch (route.page) {
    case 'byggeklosser':
      page = route.id ? (
        route.sub ? (
          <ComponentDetail blockId={route.id} id={route.sub} />
        ) : (
          <BlockDetail id={route.id} />
        )
      ) : (
        <Blocks />
      );
      break;
    case 'tjenester':
      page = route.id ? <CaseFlow id={route.id} del={route.del} steg={route.steg} /> : <Services />;
      break;
    case 'typer':
      page = route.id ? <ServiceTypeDetail id={route.id} /> : <ServiceTypes />;
      break;
    case 'sok':
      page = <SearchPage q={route.q} />;
      break;
    case 'status':
      page = <StatusPage id={route.id} />;
      break;
    case 'malbilde':
      page = <Malbilde />;
      break;
    case 'kom-i-gang':
      page = <GetStarted />;
      break;
    default:
      page = <Overview />;
  }

  // Nøkkel per sidetype, ikke per id: forrige/neste innen samme side beholder figuren i stedet for å tegne den på nytt.
  const pageKey = route.page;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand" href="#/">
            <Logo />
            <span>Genki</span>
          </a>
          <nav className="nav" aria-label="Hovedmeny">
            {navItems.map((item) => (
              <a
                key={item.label}
                href={href(item.route)}
                aria-current={item.route.page === route.page ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <Button
            variant="tertiary"
            icon
            onClick={() => setSearchOpen(true)}
            aria-label="Søk (Ctrl+K)"
            title="Søk (Ctrl+K)"
          >
            <MagnifyingGlassIcon aria-hidden />
          </Button>
          <Dropdown.TriggerContext>
            <Dropdown.Trigger variant="tertiary" icon aria-label="Mer" title="Mer">
              <MenuElipsisHorizontalIcon aria-hidden />
            </Dropdown.Trigger>
            <Dropdown placement="bottom-end" data-size="sm">
              <Dropdown.Heading>Utforsk</Dropdown.Heading>
              <Dropdown.List>
                <Dropdown.Item>
                  <Dropdown.Button asChild>
                    <a href={href({ page: 'typer' })}>Typer KI-tjenester</a>
                  </Dropdown.Button>
                </Dropdown.Item>
                <Dropdown.Item>
                  <Dropdown.Button asChild>
                    <a href={href({ page: 'status' })}>Merkelapper</a>
                  </Dropdown.Button>
                </Dropdown.Item>
                <Dropdown.Item>
                  <Dropdown.Button asChild>
                    <a href={href({ page: 'byggeklosser', id: 'sprakmodeller' })}>
                      Språkmodeller og katalog
                    </a>
                  </Dropdown.Button>
                </Dropdown.Item>
              </Dropdown.List>
              <Dropdown.Heading>Genki på GitHub</Dropdown.Heading>
              <Dropdown.List>
                <Dropdown.Item>
                  <Dropdown.Button asChild>
                    <a href={links.repo}>Kildekoden</a>
                  </Dropdown.Button>
                </Dropdown.Item>
                <Dropdown.Item>
                  <Dropdown.Button asChild>
                    <a href={links.adr}>Arkitekturbeslutninger (ADR)</a>
                  </Dropdown.Button>
                </Dropdown.Item>
                <Dropdown.Item>
                  <Dropdown.Button asChild>
                    <a href={links.api}>API-dokumentasjon</a>
                  </Dropdown.Button>
                </Dropdown.Item>
              </Dropdown.List>
            </Dropdown>
          </Dropdown.TriggerContext>
          <Button
            variant="tertiary"
            icon
            onClick={toggle}
            aria-label={scheme === 'dark' ? 'Bytt til lyst tema' : 'Bytt til mørkt tema'}
            title={scheme === 'dark' ? 'Bytt til lyst tema' : 'Bytt til mørkt tema'}
          >
            {scheme === 'dark' ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
          </Button>
        </div>
      </header>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <main>
        <div key={pageKey} className="page-enter">
          {page}
        </div>
      </main>
      <footer className="app-footer">
        <div className="app-footer-inner">
          <Paragraph data-size="sm" style={{ margin: 0 }}>
            Genki er en åpen fellesløsning fra Digdir (MIT-lisens), under utvikling. Innholdet her
            er hentet fra <a href={links.repo}>repoet</a> og dets ADR-er per oktober 2026.
          </Paragraph>
          <Paragraph data-size="sm" style={{ margin: 0 }}>
            Bygd med <a href={links.designsystemet}>Designsystemet</a>.
          </Paragraph>
        </div>
      </footer>
    </div>
  );
}
