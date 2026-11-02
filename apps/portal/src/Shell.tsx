import { Alert, Avatar, Button, Divider, SkipLink, Tag } from '@digdir/designsystemet-react';
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

type NavItem = { path: string; label: PlainKey; icon: string; also?: readonly string[] };

export const navigationGroups = [
  {
    items: [
      { path: '/overview', label: 'shell.navOverview', icon: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z' },
    ],
  },
  {
    heading: 'shell.groupBuild',
    items: [
      {
        path: '/services',
        label: 'shell.navServices',
        icon: 'M4 5h16v14H4zM4 9h16M8 13h8',
        also: ['/step-flows'],
      },
      {
        path: '/shared-services',
        label: 'shell.navSharedServices',
        icon: 'M8 7a3 3 0 1 0 0 .01M16 7a3 3 0 1 0 0 .01M3 19c0-3 2-5 5-5s5 2 5 5M13 15c1-1 2-1 3-1 3 0 5 2 5 5',
      },
      {
        path: '/datasets',
        label: 'shell.navDatasets',
        icon: 'M5 6c0-1.7 3-3 7-3s7 1.3 7 3-3 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3 3 7 3s7-1.3 7-3',
      },
      {
        path: '/building-blocks',
        label: 'shell.navBuildingBlocks',
        icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
        also: ['/skills'],
      },
      { path: '/playground', label: 'shell.navPlayground', icon: 'M7 4v16l13-8z' },
      {
        path: '/developer',
        label: 'shell.menuDeveloper',
        icon: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
        also: ['/api-reference'],
      },
    ],
  },
  {
    heading: 'shell.groupAnalyse',
    items: [
      {
        path: '/statistics',
        label: 'shell.navStatistics',
        icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
      },
      { path: '/log', label: 'shell.navLog', icon: 'M4 6h16M4 12h10M4 18h6' },
    ],
  },
  {
    heading: 'shell.groupAdmin',
    items: [
      {
        path: '/access',
        label: 'shell.navAccess',
        icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
      },
      {
        path: '/settings',
        label: 'shell.navSettings',
        icon: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.9 4.9L7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
      },
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

const userMenuLinks: readonly (readonly [string, PlainKey])[] = [
  ['#/onboarding', 'shell.menuOnboarding'],
  ['#/profile', 'shell.menuProfile'],
  ['#/contact', 'shell.contact'],
  ['#/data-handling', 'shell.menuDataHandling'],
];

const readableUnregistered = ['api-reference', 'shared-services', 'data-handling', 'profile'];

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
  compact = false,
}: {
  path: string;
  badges: ShellProps['badges'];
  onNavigate: () => void;
  compact?: boolean;
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
              <span id={headingId} className={compact ? 'visually-hidden' : 'nav-group-heading'}>
                {t(group.heading)}
              </span>
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
                      title={compact ? t(item.label) : undefined}
                    >
                      <span className="nav-item">
                        <Icon d={item.icon} />
                        <span className={compact ? 'visually-hidden' : undefined}>
                          {t(item.label)}
                        </span>
                      </span>
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
    window.addEventListener('resize', closeAll);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', closeAll);
    };
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
            {userMenuLinks.map(([href, label]) => (
              <li key={href}>
                <a href={href} onClick={closeAll}>
                  {t(label)}
                </a>
              </li>
            ))}
          </ul>
          <Divider />
          <Button variant="secondary" data-size="sm" onClick={onLogout}>
            {t('shell.logout')}
          </Button>
        </div>
      ) : null}
    </div>
  );

  const orgCompact = userInSidebar && collapsed;
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
          title={orgCompact ? organisation.name : undefined}
        >
          {orgCompact ? (
            <Icon d={icons.organisation} />
          ) : (
            <>
              <span className="org-button">
                <span className="org-name">{organisation.name}</span>
                {narrow ? null : <span className="meta">{orgMeta}</span>}
              </span>
              <Icon d={icons.chevronDown} size={16} />
            </>
          )}
        </Button>
      ) : (
        <div className="org-static" title={orgCompact ? organisation.name : undefined}>
          <span className="visually-hidden">{t('shell.actingForLabel')} </span>
          {orgCompact ? <Icon d={icons.organisation} /> : null}
          <span className={orgCompact ? 'visually-hidden' : 'org-button'}>
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
                aria-label={t(collapsed ? 'shell.showSidebar' : 'shell.hideSidebar')}
                onClick={toggleCollapsed}
              >
                <Icon d={icons.sidebar} />
              </Button>
            </div>
            <NavLinks path={path} badges={badges} onNavigate={closeAll} compact={collapsed} />
            <div className="sidebar-account">
              {userMenu}
              {orgChooser}
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
