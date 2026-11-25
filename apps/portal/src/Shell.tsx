import {
  BarChartIcon,
  BulletListIcon,
  CodeIcon,
  CogIcon,
  ComponentIcon,
  DatabaseIcon,
  HouseIcon,
  MenuHamburgerIcon,
  PaletteIcon,
  PersonGroupIcon,
  RectangleSectionsIcon,
  SandboxIcon,
  ShieldLockIcon,
  SidebarLeftIcon,
} from '@navikt/aksel-icons';
import { Alert, Avatar, Button, Divider, SkipLink } from '@digdir/designsystemet-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { ApiClient } from './api';
import { Icon, type IconComponent } from './components/Icon';
import { useFlag } from './flags';
import { formatOrgNumber, hasOwnName, organisationName, profileFor } from './data/organisations';
import { restoringScroll, useEscape, useNarrow } from './hooks';
import { translator, useT, type PlainKey, type T } from './i18n';
import { Unregistered } from './screens/Unregistered';
import type { Organisation, PortalRight, Session } from './types';

type NavItem = { path: string; label: PlainKey; icon: IconComponent; also?: readonly string[] };

type NavGroup = { heading?: PlainKey; items: readonly NavItem[] };

export const navigationGroups: readonly NavGroup[] = [
  {
    items: [{ path: '/overview', label: 'shell.navOverview', icon: HouseIcon }],
  },
  {
    heading: 'shell.groupBuild',
    items: [
      {
        path: '/services',
        label: 'shell.navServices',
        icon: RectangleSectionsIcon,
      },
      {
        path: '/shared-services',
        label: 'shell.navSharedServices',
        icon: PersonGroupIcon,
      },
      {
        path: '/datasets',
        label: 'shell.navDatasets',
        icon: DatabaseIcon,
      },
      {
        path: '/building-blocks',
        label: 'shell.navBuildingBlocks',
        icon: ComponentIcon,
        also: ['/skills'],
      },
      { path: '/playground', label: 'shell.navPlayground', icon: SandboxIcon },
      {
        path: '/developer',
        label: 'shell.menuDeveloper',
        icon: CodeIcon,
        also: ['/api-reference', '/step-flows'],
      },
    ],
  },
  {
    heading: 'shell.groupAnalyse',
    items: [
      {
        path: '/statistics',
        label: 'shell.navStatistics',
        icon: BarChartIcon,
      },
      { path: '/log', label: 'shell.navLog', icon: BulletListIcon },
    ],
  },
  {
    heading: 'shell.groupAdmin',
    items: [
      {
        path: '/access',
        label: 'shell.navAccess',
        icon: ShieldLockIcon,
      },
      {
        path: '/settings',
        label: 'shell.navSettings',
        icon: CogIcon,
      },
    ],
  },
];

export const designNavItem: NavItem = {
  path: '/design',
  label: 'shell.navDesign',
  icon: PaletteIcon,
};

const withDesign = (items: readonly NavItem[]) =>
  items.flatMap((item) => (item.path === '/services' ? [item, designNavItem] : [item]));

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

// The action names in the Altinn resource; the portal's own labels may differ.
const altinnActionNames: Record<PortalRight, string> = {
  'use-services': 'Bruke tjenester',
  'manage-services': 'Administrere tjenester',
  'manage-datasets': 'Administrere datasett',
  'register-building-blocks': 'Registrere byggeklosser',
  'view-usage': 'Se forbruk og kostnad',
};

const toRight = (action: string) =>
  allRights.find(
    (r) =>
      r === action ||
      altinnActionNames[r] === action ||
      rightLabel(nbT, r) === action ||
      rightLabel(enT, r) === action,
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
  ['#/profile', 'shell.menuProfile'],
  ['#/onboarding', 'shell.menuOnboarding'],
  ['#/data-handling', 'shell.menuDataHandling'],
];

const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"]',
    ),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const target =
    event.key === 'ArrowDown'
      ? items[(at + 1) % items.length]
      : event.key === 'ArrowUp'
        ? items[(at - 1 + items.length) % items.length]
        : event.key === 'Home'
          ? items[0]
          : event.key === 'End'
            ? items[items.length - 1]
            : undefined;
  if (!target) return;
  event.preventDefault();
  target.focus();
};

const readableUnregistered = [
  '/api-reference',
  '/developer/api/reference',
  '/shared-services',
  '/data-handling',
  '/profile',
];

interface ShellProps {
  session: Session;
  organisation: Organisation;
  onSwitch: (organisation: Organisation) => void;
  onLogout: () => void;
  path: string;
  unregistered?: boolean;
  registeredElsewhere?: string[];
  api: ApiClient;
  onRights?: (rights: readonly PortalRight[]) => void;
  children: ReactNode;
}

export const LockdownBanner = ({
  api,
}: {
  api: Pick<ApiClient, 'getHealth' | 'isReadOnlyInLockdown'>;
}) => {
  const t = useT();
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api
      .getHealth(controller.signal)
      .then(async (health) => {
        if (health.lockdown !== true) return;
        if (await api.isReadOnlyInLockdown(controller.signal)) setReadOnly(true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [api]);
  return readOnly ? (
    <Alert data-color="warning" data-size="sm" className="lockdown-banner">
      {t('shell.lockdownReadOnly')}
    </Alert>
  ) : null;
};

const NavLinks = ({
  path,
  onNavigate,
  compact = false,
}: {
  path: string;
  onNavigate: () => void;
  compact?: boolean;
}) => {
  const t = useT();
  const studio = useFlag('blockStudio');
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
              {(studio ? withDesign(group.items) : group.items).map((item: NavItem) => {
                const active = isActive(path, item);
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
                        <Icon icon={item.icon} />
                        <span className={compact ? 'visually-hidden' : undefined}>
                          {t(item.label)}
                        </span>
                      </span>
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
  unregistered = false,
  registeredElsewhere = [],
  api,
  onRights,
  children,
}: ShellProps) => {
  const t = useT();
  const narrow = useNarrow();
  const [open, setOpen] = useState<'user' | undefined>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const closeAll = useCallback(() => {
    setOpen(undefined);
    setMenuOpen(false);
  }, []);
  const userButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const openNow = useRef(open);
  openNow.current = open;
  const closeToButton = useCallback(() => {
    if (openNow.current === 'user') {
      setOpen(undefined);
      userButton.current?.focus();
      return;
    }
    setMenuOpen(false);
    menuButton.current?.focus();
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      storeCollapsed(!c);
      return !c;
    });
  useEscape(open !== undefined || menuOpen, closeToButton);
  useEffect(() => {
    if (open === 'user')
      userMenuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);
  const shownPath = useRef(path);
  useEffect(() => {
    if (shownPath.current === path) return;
    shownPath.current = path;
    closeAll();
  }, [path, closeAll]);
  const area = path.split('/')[1] ?? '';
  const shownArea = useRef(area);
  useEffect(() => {
    if (shownArea.current === area) return;
    shownArea.current = area;
    document.getElementById('hovedinnhold')?.focus({ preventScroll: true });
    if (!restoringScroll()) window.scrollTo(0, 0);
  }, [area]);
  useEffect(() => {
    if (open !== 'user') return;
    const onPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.popover-anchor'))
        setOpen(undefined);
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
  const orgName = organisationName(organisation, t);
  const multi = session.organisations.length > 1;
  const actions = organisation.actions ?? profile.rights;
  const actionsKey = actions.join('\u0000');
  const { rights, labels } = useMemo(() => rightsFor(actions, t), [actionsKey, t]);
  useEffect(() => onRights?.(rights), [onRights, rights]);
  const gated =
    unregistered && !readableUnregistered.some((p) => path === p || path.startsWith(`${p}/`));
  const orgMeta = t(unregistered ? 'shell.orgMetaUnregistered' : 'shell.orgMeta', { orgNr });
  const [above, setAbove] = useState<CSSProperties>();
  // In the sidebar and the phone menu the user menu opens above its button, placed from where the button is now.
  const toggleUser = (from: HTMLElement) => {
    const box = from.getBoundingClientRect();
    setAbove({ left: box.left, bottom: window.innerHeight - box.top + 8 });
    setOpen((o) => (o === 'user' ? undefined : 'user'));
  };
  // The sidebar or the phone menu holds the user menu; an unregistered organisation keeps it in the header.
  const userInSidebar = !narrow && !unregistered;
  const userInMenu = narrow && !unregistered;
  const userBelow = userInSidebar || userInMenu;
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
    <div className={userBelow ? 'popover-anchor sidebar-user' : 'popover-anchor'}>
      <Button
        ref={userButton}
        variant="tertiary"
        data-size="sm"
        aria-expanded={open === 'user'}
        aria-haspopup="menu"
        aria-controls={open === 'user' ? 'user-menu' : undefined}
        aria-label={t('shell.userMenuButton', { name: session.name, organisation: orgName })}
        className="user-button"
        onClick={(e) => toggleUser(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          if (open !== 'user') toggleUser(e.currentTarget);
        }}
      >
        <Avatar data-size="sm" aria-hidden="true">
          {initials(session.name)}
        </Avatar>
        {(narrow && !userInMenu) || (userInSidebar && collapsed) ? null : (
          <span className="user-button-text">
            <span className="user-button-name">{session.name}</span>
            {userBelow ? <span className="user-button-org">{orgName}</span> : null}
          </span>
        )}
      </Button>
      {open === 'user' ? (
        <div
          id="user-menu"
          ref={userMenuRef}
          role="menu"
          aria-label={t('shell.userMenu')}
          className="popover user-menu"
          style={userBelow ? above : undefined}
          onKeyDown={(e) => {
            if (e.key === 'Tab') closeAll();
            else moveFocus(e);
          }}
        >
          <div className="popover-head" role="presentation">
            <span className="popover-title">{session.name}</span>
            {session.email && session.email !== session.name ? (
              <span className="meta">{session.email}</span>
            ) : null}
            {multi ? null : (
              <span className="user-menu-org">
                {hasOwnName(organisation)
                  ? t('shell.actingFor', { name: orgName })
                  : t('shell.actingForNumber', { orgNr })}
              </span>
            )}
          </div>
          {multi ? (
            <fieldset className="org-options" role="group">
              <legend className="org-options-legend">{t('shell.actingForLabel')}</legend>
              {session.organisations.map((org) => {
                const checked = org.orgNumber === organisation.orgNumber;
                const nr = formatOrgNumber(org.orgNumber);
                return (
                  <label
                    key={org.orgNumber}
                    className={checked ? 'org-option checked' : 'org-option'}
                  >
                    <input
                      className="ds-input"
                      type="radio"
                      role="menuitemradio"
                      name="org"
                      tabIndex={-1}
                      checked={checked}
                      aria-checked={checked}
                      onChange={() => {
                        onSwitch(org);
                        closeToButton();
                      }}
                    />
                    <span className="org-option-text">
                      <span className="org-option-name">{organisationName(org, t)}</span>
                      <span className="meta">
                        {checked && unregistered
                          ? t('shell.orgOptionUnregistered', { orgNr: nr })
                          : t('shell.orgOptionMeta', { orgNr: nr })}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <ul className="user-menu-list" role="presentation">
            {userMenuLinks.map(([href, label]) => (
              <li key={href} role="presentation">
                <a href={href} role="menuitem" tabIndex={-1} onClick={closeAll}>
                  {t(label)}
                </a>
              </li>
            ))}
          </ul>
          <Divider />
          <Button
            role="menuitem"
            tabIndex={-1}
            variant="secondary"
            data-size="sm"
            onClick={onLogout}
          >
            {t('shell.logout')}
          </Button>
        </div>
      ) : null}
    </div>
  );

  const orgStatic = (
    <div className="org-static">
      <span className="visually-hidden">{t('shell.actingForLabel')} </span>
      <span className="org-button">
        <span className="org-name">{orgName}</span>
        {narrow ? null : <span className="meta">{orgMeta}</span>}
      </span>
    </div>
  );

  return (
    <div className={userInSidebar ? 'shell no-header' : 'shell'}>
      <SkipLink href="#hovedinnhold">{t('shell.skipToContent')}</SkipLink>
      {userInSidebar ? null : (
        <header className="header">
          <div className="header-bar">
            {brand}
            <div className="header-spacer" />
            {unregistered ? (
              <>
                {orgStatic}
                {userMenu}
              </>
            ) : (
              <Button
                ref={menuButton}
                variant="secondary"
                data-size="sm"
                aria-expanded={menuOpen}
                aria-controls="hovedmeny"
                onClick={() => setMenuOpen((o) => !o)}
              >
                <Icon icon={MenuHamburgerIcon} />
                <span>{t('shell.menu')}</span>
              </Button>
            )}
          </div>
          {menuOpen && userInMenu ? (
            <nav id="hovedmeny" aria-label={t('shell.mainMenu')} className="narrow-nav">
              <NavLinks path={path} onNavigate={closeAll} />
              <div className="narrow-account">{userMenu}</div>
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
                <Icon icon={SidebarLeftIcon} />
              </Button>
            </div>
            <NavLinks path={path} onNavigate={closeAll} compact={collapsed} />
            <div className="sidebar-account">{userMenu}</div>
          </nav>
        )}
        <main id="hovedinnhold" className="main" tabIndex={-1}>
          <div className="main-inner">
            <LockdownBanner api={api} />
            {gated ? (
              <Unregistered
                api={api}
                organisation={organisation}
                contactName={session.name}
                onLogout={onLogout}
                registeredElsewhere={registeredElsewhere}
                {...(multi ? { onSwitch: () => setOpen('user') } : {})}
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
