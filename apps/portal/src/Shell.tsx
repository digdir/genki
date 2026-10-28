import {
  Alert,
  Avatar,
  Button,
  Divider,
  Heading,
  SkipLink,
  Tag,
} from '@digdir/designsystemet-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { ApiClient } from './api';
import { Icon, icons } from './components/Icon';
import { formatOrgNumber, profileFor } from './data/organisations';
import { isEntraLogin } from './oidc';
import { useEscape, useNarrow } from './hooks';
import { translator, useT, type PlainKey, type T } from './i18n';
import { Unregistered } from './screens/Unregistered';
import type { Organisation, PortalRight, Session } from './types';

type NavItem = { path: string; label: PlainKey; also?: readonly string[] };

export const navigationGroups = [
  { items: [{ path: '/overview', label: 'shell.navOverview' }] },
  {
    heading: 'shell.groupBuild',
    items: [
      { path: '/services', label: 'shell.navServices', also: ['/step-flows'] },
      { path: '/shared-services', label: 'shell.navSharedServices' },
      { path: '/datasets', label: 'shell.navDatasets' },
      { path: '/building-blocks', label: 'shell.navBuildingBlocks', also: ['/skills'] },
      { path: '/playground', label: 'shell.navPlayground' },
    ],
  },
  {
    heading: 'shell.groupAnalyse',
    items: [
      { path: '/statistics', label: 'shell.navStatistics' },
      { path: '/log', label: 'shell.navLog' },
      { path: '/feedback', label: 'shell.navFeedback' },
    ],
  },
  {
    heading: 'shell.groupAdmin',
    items: [
      { path: '/access', label: 'shell.navAccess' },
      { path: '/organisation', label: 'shell.navSettings' },
    ],
  },
] as const satisfies readonly { heading?: PlainKey; items: readonly NavItem[] }[];

export const navigation: readonly NavItem[] = navigationGroups.flatMap(
  (g): readonly NavItem[] => g.items,
);

const collapsedKey = 'genki.sidebarCollapsed';

const readCollapsed = () => {
  try {
    return localStorage.getItem(collapsedKey) === 'true';
  } catch {
    return false;
  }
};

const storeCollapsed = (collapsed: boolean) => {
  try {
    localStorage.setItem(collapsedKey, String(collapsed));
  } catch {
    // Remembering is a convenience; the panel still works without storage.
  }
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const rightKeys = {
  'use-services': 'rights.useServices',
  'manage-services': 'rights.manageServices',
  'manage-datasets': 'rights.manageDatasets',
  'register-building-blocks': 'rights.registerBuildingBlocks',
  'view-usage': 'rights.viewUsage',
} as const satisfies Record<PortalRight, PlainKey>;

const nbT = translator('nb');
const enT = translator('en');

export const rightLabel = (t: T, right: PortalRight) => t(rightKeys[right]);

export const rightLabels = Object.fromEntries(
  Object.entries(rightKeys).map(([right, key]) => [right, nbT(key)]),
) as Record<PortalRight, string>;

const legacyKeys = { read: 'rights.read', write: 'rights.write' } as const;
const allRights = Object.keys(rightKeys) as PortalRight[];

const legacyRights: Record<string, readonly PortalRight[]> = {
  read: ['use-services', 'view-usage'],
  write: ['manage-services', 'manage-datasets', 'register-building-blocks', 'view-usage'],
};

const toRight = (action: string) =>
  allRights.find(
    (r) => r === action || rightLabel(nbT, r) === action || rightLabel(enT, r) === action,
  );

export const rightsFor = (actions: readonly string[], t: T = nbT) => {
  const granted = allRights.filter((r) => actions.some((a) => toRight(a) === r));
  const legacy = new Set(actions.flatMap((a) => legacyRights[a] ?? []));
  const rights = granted.length > 0 ? granted : allRights.filter((r) => legacy.has(r));
  const labels = [
    ...granted.map((r) => rightLabel(t, r)),
    ...actions
      .filter((a) => !toRight(a) && !(granted.length > 0 && a in legacyKeys))
      .map((a) => (a in legacyKeys ? t(legacyKeys[a as keyof typeof legacyKeys]) : a)),
  ];
  return { rights, labels };
};

const RightsContext = createContext<readonly PortalRight[]>([]);

export const RightsProvider = RightsContext.Provider;

export const useRights = () => {
  const rights = useContext(RightsContext);
  return { rights, has: (right: PortalRight) => rights.includes(right) };
};

export const needsRight = (right: PortalRight, t: T = nbT) =>
  t('common.needsRight', { right: rightLabel(t, right) });

const UserNameContext = createContext('');

export const useUserName = () => useContext(UserNameContext);

const RightLabelsContext = createContext<readonly string[]>([]);

/** The rights as Altinn names them for this person, including the older read and write. */
export const useRightLabels = () => useContext(RightLabelsContext);

const isActive = (path: string, item: NavItem) => {
  const roots: readonly string[] = [item.path, ...(item.also ?? [])];
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
};

const userMenuLinks: readonly (readonly [string, PlainKey, boolean?])[] = [
  ['#/onboarding', 'shell.menuOnboarding'],
  ['#/changelog', 'shell.menuChangelog', true],
  ['#/profile', 'shell.menuProfile'],
  ['#/developer', 'shell.menuDeveloper'],
  ['#/contact', 'shell.contact'],
];

const readableUnregistered = ['api-reference', 'shared-services', 'data-handling'];

interface ShellProps {
  session: Session;
  organisation: Organisation;
  onSwitch: (organisation: Organisation) => void;
  onLogout: () => void;
  path: string;
  badges?: Partial<Record<string, { count: number; label: string }>>;
  unregistered?: boolean;
  registeredElsewhere?: string[];
  api: ApiClient;
  children: ReactNode;
}

export const LockdownBanner = ({
  api,
  entra,
}: {
  api: Pick<ApiClient, 'getHealth'>;
  entra: boolean;
}) => {
  const t = useT();
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api.getHealth(controller.signal).then(
      (health) => setLocked(health.lockdown === true),
      () => undefined,
    );
    return () => controller.abort();
  }, [api]);
  return locked ? (
    <Alert data-color="warning" data-size="sm" className="lockdown-banner">
      {t(entra ? 'shell.lockdown' : 'shell.lockdownReadOnly')}
    </Alert>
  ) : null;
};

const NavLinks = ({
  path,
  badges,
  onNavigate,
}: {
  path: string;
  badges: ShellProps['badges'];
  onNavigate: () => void;
}) => {
  const t = useT();
  return (
    <div className="nav-groups">
      {navigationGroups.map((group, i) => {
        const headingId = 'heading' in group ? `nav-group-${i}` : undefined;
        return (
          <div key={i} className="nav-group">
            {i > 0 ? <Divider /> : null}
            {'heading' in group ? (
              <Heading level={2} data-size="2xs" id={headingId} className="nav-group-heading">
                {t(group.heading)}
              </Heading>
            ) : null}
            <ul className="nav-list" aria-labelledby={headingId}>
              {group.items.map((item: NavItem) => {
                const active = isActive(path, item);
                const badge = badges?.[item.path];
                return (
                  <li key={item.path}>
                    <a
                      href={`#${item.path}`}
                      aria-current={active ? 'page' : undefined}
                      className={active ? 'active' : undefined}
                      onClick={onNavigate}
                    >
                      {t(item.label)}
                      {badge && badge.count > 0 ? (
                        <Tag data-color="danger" data-size="sm" aria-label={badge.label}>
                          {badge.count}
                        </Tag>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
};

export const Shell = ({
  session,
  organisation,
  onSwitch,
  onLogout,
  path,
  badges,
  unregistered = false,
  registeredElsewhere = [],
  api,
  children,
}: ShellProps) => {
  const t = useT();
  const narrow = useNarrow();
  const [open, setOpen] = useState<'org' | 'user' | 'menu' | undefined>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const closeAll = useCallback(() => setOpen(undefined), []);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      storeCollapsed(!c);
      return !c;
    });
  useEscape(open !== undefined, closeAll);
  useEffect(() => {
    if (!narrow) setOpen((o) => (o === 'menu' ? undefined : o));
  }, [narrow]);
  useEffect(closeAll, [path, closeAll]);
  const area = path.split('/')[1] ?? '';
  const shownArea = useRef(area);
  useEffect(() => {
    if (shownArea.current === area) return;
    shownArea.current = area;
    document.getElementById('hovedinnhold')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [area]);
  useEffect(() => {
    if (open !== 'org' && open !== 'user') return;
    const onPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.popover-anchor'))
        closeAll();
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open, closeAll]);

  const profile = profileFor(organisation.orgNumber, organisation.name);
  const orgNr = formatOrgNumber(organisation.orgNumber);
  const multi = session.organisations.length > 1;
  const { rights, labels } = rightsFor(organisation.actions ?? profile.rights, t);
  const gated = unregistered && !readableUnregistered.includes(area);
  const orgMeta = t(unregistered ? 'shell.orgMetaUnregistered' : 'shell.orgMeta', { orgNr });
  const [above, setAbove] = useState<CSSProperties>();
  // In the sidebar a menu opens above its button, placed from where the button is now.
  const toggle = (which: 'org' | 'user' | 'menu', from?: HTMLElement) => {
    if (from) {
      const box = from.getBoundingClientRect();
      setAbove({ left: box.left, bottom: window.innerHeight - box.top + 8 });
    }
    setOpen((o) => (o === which ? undefined : which));
  };
  // The sidebar holds the brand and the user menu; without one (narrow, unregistered) they stay in the header.
  const userInSidebar = !narrow && !unregistered;
  const brand = (
    <a className="brand" href="#/overview">
      <img src="/emblem-felleslosning.svg" alt="" width={32} height={32} />
      {userInSidebar && collapsed ? (
        <span className="visually-hidden">{t('shell.brandFull')}</span>
      ) : (
        <span className="brand-text">
          <span className="brand-owner">{t('shell.owner')}</span>
          <span className="brand-name">
            {narrow ? t('shell.brandShort') : t('shell.brandFull')}
          </span>
        </span>
      )}
    </a>
  );
  const userMenu = (
    <div className={userInSidebar ? 'popover-anchor sidebar-user' : 'popover-anchor'}>
      <Button
        variant="tertiary"
        data-size="sm"
        aria-expanded={open === 'user'}
        aria-haspopup="true"
        aria-label={t('shell.userMenuButton', { name: session.name })}
        onClick={(e) => toggle('user', e.currentTarget)}
      >
        <Avatar data-size="sm" aria-hidden="true">
          {initials(session.name)}
        </Avatar>
        {narrow || (userInSidebar && collapsed) ? null : <span>{session.name}</span>}
      </Button>
      {open === 'user' ? (
        <div
          role="dialog"
          aria-label={t('shell.userMenu')}
          className="popover user-menu"
          style={userInSidebar ? above : undefined}
        >
          <div className="popover-head">
            <span className="popover-title">{session.name}</span>
            <span className="meta">{t('shell.actingFor', { name: organisation.name, orgNr })}</span>
          </div>
          <ul className="user-menu-list">
            {userMenuLinks.map(([href, label, isNew]) => (
              <li key={href}>
                <a href={href} onClick={closeAll}>
                  {t(label)}
                  {isNew ? (
                    <span className="new-dot">
                      <span className="visually-hidden">{t('shell.menuNew')}</span>
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="user-menu-sub"
                aria-expanded={aboutOpen}
                onClick={() => setAboutOpen((o) => !o)}
              >
                {t('shell.menuAbout')}
                <Icon d={aboutOpen ? icons.chevronDown : icons.chevronRight} size={16} />
              </button>
              {aboutOpen ? (
                <ul className="user-menu-list nested">
                  <li>
                    <a href="#/help" onClick={closeAll}>
                      {t('shell.guide')}
                    </a>
                  </li>
                  <li>
                    <a href="#/data-handling" onClick={closeAll}>
                      {t('shell.menuDataHandling')}
                    </a>
                  </li>
                </ul>
              ) : null}
            </li>
          </ul>
          <Divider />
          <Button variant="secondary" data-size="sm" onClick={onLogout}>
            {t('shell.logout')}
          </Button>
        </div>
      ) : null}
    </div>
  );

  const orgChooser = (
    <div className={userInSidebar ? 'popover-anchor sidebar-org' : 'popover-anchor'}>
      {multi ? (
        <Button
          variant="secondary"
          data-size="sm"
          aria-expanded={open === 'org'}
          aria-haspopup="true"
          aria-label={t(unregistered ? 'shell.orgButtonUnregistered' : 'shell.orgButton', {
            name: organisation.name,
            orgNr,
          })}
          onClick={(e) => toggle('org', e.currentTarget)}
        >
          <span className="org-button">
            <span className="org-name">{organisation.name}</span>
            {narrow ? null : <span className="meta">{orgMeta}</span>}
          </span>
          <Icon d={icons.chevronDown} size={16} />
        </Button>
      ) : (
        <div className="org-static">
          <span className="visually-hidden">{t('shell.actingForLabel')} </span>
          <span className="org-button">
            <span className="org-name">{organisation.name}</span>
            {narrow ? null : <span className="meta">{orgMeta}</span>}
          </span>
        </div>
      )}
      {open === 'org' && multi ? (
        <div
          role="dialog"
          aria-label={t('shell.chooseOrg')}
          className="popover"
          style={userInSidebar ? above : undefined}
        >
          <div className="popover-head">
            <span className="popover-title">{t('shell.chooseOrg')}</span>
            <span className="meta">{t('shell.chooseOrgHelp')}</span>
          </div>
          <fieldset className="org-options">
            <legend className="visually-hidden">{t('shell.organisations')}</legend>
            {session.organisations.map((org) => {
              const p = profileFor(org.orgNumber, org.name);
              const checked = org.orgNumber === organisation.orgNumber;
              return (
                <label
                  key={org.orgNumber}
                  className={checked ? 'org-option checked' : 'org-option'}
                >
                  <input
                    className="ds-input"
                    type="radio"
                    name="org"
                    checked={checked}
                    onChange={() => {
                      onSwitch(org);
                      closeAll();
                    }}
                  />
                  <span className="org-option-text">
                    <span className="org-option-name">{org.name}</span>
                    <span className="meta">
                      {checked && unregistered
                        ? t('shell.orgOptionUnregistered', {
                            orgNr: formatOrgNumber(org.orgNumber),
                          })
                        : p.role
                          ? t('shell.orgOptionRole', {
                              orgNr: formatOrgNumber(org.orgNumber),
                              role: p.role,
                            })
                          : t('shell.orgOptionMeta', {
                              orgNr: formatOrgNumber(org.orgNumber),
                            })}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={userInSidebar ? 'shell no-header' : 'shell'}>
      <SkipLink href="#hovedinnhold">{t('shell.skipToContent')}</SkipLink>
      {userInSidebar ? null : (
        <header className="header">
          <div className="header-bar">
            {narrow && !unregistered ? (
              <Button
                variant="tertiary"
                data-size="sm"
                aria-expanded={open === 'menu'}
                aria-controls="hovedmeny"
                onClick={() => toggle('menu')}
              >
                <Icon d={icons.menu} />
                <span>{t('shell.menu')}</span>
              </Button>
            ) : null}
            {brand}
            <div className="header-spacer" />
            {orgChooser}
            {userMenu}
          </div>
          {narrow && open === 'menu' && !unregistered ? (
            <nav id="hovedmeny" aria-label={t('shell.mainMenu')} className="narrow-nav">
              <NavLinks path={path} badges={badges} onNavigate={closeAll} />
            </nav>
          ) : null}
        </header>
      )}
      <div className="body">
        {narrow || unregistered ? null : (
          <nav
            aria-label={t('shell.mainMenu')}
            className={collapsed ? 'sidebar collapsed' : 'sidebar'}
          >
            <div className="sidebar-top">
              {brand}
              <Button
                variant="tertiary"
                data-size="sm"
                icon
                aria-expanded={!collapsed}
                aria-label={t(collapsed ? 'shell.showSidebar' : 'shell.hideSidebar')}
                onClick={toggleCollapsed}
              >
                <Icon d={icons.sidebar} />
              </Button>
            </div>
            {collapsed ? null : <NavLinks path={path} badges={badges} onNavigate={closeAll} />}
            <div className="sidebar-spacer" />
            <div className="sidebar-account">
              {userMenu}
              {collapsed ? null : orgChooser}
            </div>
          </nav>
        )}
        <main id="hovedinnhold" className="main" tabIndex={-1}>
          <div className="main-inner">
            <LockdownBanner api={api} entra={isEntraLogin(session.token)} />
            {gated ? (
              <Unregistered
                api={api}
                organisation={organisation}
                contactName={session.name}
                onLogout={onLogout}
                registeredElsewhere={registeredElsewhere}
                {...(multi ? { onSwitch: () => setOpen('org') } : {})}
              />
            ) : (
              <UserNameContext.Provider value={session.name}>
                <RightsContext.Provider value={rights}>
                  <RightLabelsContext.Provider value={labels}>
                    {children}
                  </RightLabelsContext.Provider>
                </RightsContext.Provider>
              </UserNameContext.Provider>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
