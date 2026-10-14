import { Alert, Avatar, Button, Link, SkipLink, Tag } from '@digdir/designsystemet-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LanguageChoice } from '@genai/i18n/react';
import type { ApiClient } from './api';
import { Icon, icons } from './components/Icon';
import { formatOrgNumber, profileFor } from './data/organisations';
import { useEscape, useNarrow } from './hooks';
import { translator, useT, type PlainKey, type T } from './i18n';
import { Unregistered } from './screens/Unregistered';
import type { Organisation, PortalRight, Session } from './types';

export const navigation = [
  { path: '/overview', label: 'shell.navOverview' },
  { path: '/services', label: 'shell.navServices', also: ['/step-flows'] },
  { path: '/shared-services', label: 'shell.navSharedServices' },
  { path: '/datasets', label: 'shell.navDatasets' },
  { path: '/building-blocks', label: 'shell.navBuildingBlocks', also: ['/skills'] },
  { path: '/playground', label: 'shell.navPlayground' },
  { path: '/access', label: 'shell.navAccess' },
  { path: '/usage', label: 'shell.navUsage' },
  { path: '/integrations', label: 'shell.navIntegrations', also: ['/api-reference'] },
  { path: '/log', label: 'shell.navLog' },
  { path: '/settings', label: 'shell.navSettings' },
] as const satisfies readonly { path: string; label: PlainKey; also?: readonly string[] }[];

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

const isActive = (path: string, item: (typeof navigation)[number]) => {
  const roots: readonly string[] = [item.path, ...('also' in item ? item.also : [])];
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
};

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

export const LockdownBanner = ({ api }: { api: Pick<ApiClient, 'getHealth'> }) => {
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
      {t('shell.lockdown')}
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
    <ul className="nav-list">
      {navigation.map((item) => {
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
  const closeAll = useCallback(() => setOpen(undefined), []);
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
  const toggle = (which: 'org' | 'user' | 'menu') =>
    setOpen((o) => (o === which ? undefined : which));

  return (
    <div className="shell">
      <SkipLink href="#hovedinnhold">{t('shell.skipToContent')}</SkipLink>
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
          <a className="brand" href="#/overview">
            <img src="/emblem-felleslosning.svg" alt="" width={32} height={32} />
            <span className="brand-text">
              <span className="brand-owner">{t('shell.owner')}</span>
              <span className="brand-name">
                {narrow ? t('shell.brandShort') : t('shell.brandFull')}
              </span>
            </span>
          </a>
          <div className="header-spacer" />
          <div className="popover-anchor">
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
                onClick={() => toggle('org')}
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
              <div role="dialog" aria-label={t('shell.chooseOrg')} className="popover">
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
          <div className="popover-anchor">
            <Button
              variant="tertiary"
              data-size="sm"
              aria-expanded={open === 'user'}
              aria-haspopup="true"
              aria-label={t('shell.userMenuButton', { name: session.name })}
              onClick={() => toggle('user')}
            >
              <Avatar data-size="sm" aria-hidden="true">
                {initials(session.name)}
              </Avatar>
              {narrow ? null : <span>{session.name}</span>}
            </Button>
            {open === 'user' ? (
              <div role="dialog" aria-label={t('shell.userMenu')} className="popover user-menu">
                <div className="popover-head">
                  <span className="popover-title">{session.name}</span>
                  <span className="meta">
                    {t('shell.actingFor', { name: organisation.name, orgNr })}
                  </span>
                </div>
                <div className="user-rights">
                  <span className="meta">{t('shell.yourRights')}</span>
                  <div className="tag-row">
                    {labels.map((r) => (
                      <Tag key={r} data-color="neutral" data-size="sm">
                        {r}
                      </Tag>
                    ))}
                  </div>
                  <span className="small">{t('shell.rightsGivenBy')}</span>
                  <Link href="https://www.altinn.no" target="_blank" rel="noopener">
                    {t('shell.seeInAltinn')}
                  </Link>
                </div>
                <LanguageChoice className="user-language" />
                <Button variant="secondary" data-size="sm" onClick={onLogout}>
                  {t('shell.logout')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {narrow && open === 'menu' && !unregistered ? (
          <nav id="hovedmeny" aria-label={t('shell.mainMenu')} className="narrow-nav">
            <NavLinks path={path} badges={badges} onNavigate={closeAll} />
          </nav>
        ) : null}
      </header>
      <div className="body">
        {narrow || unregistered ? null : (
          <nav aria-label={t('shell.mainMenu')} className="sidebar">
            <NavLinks path={path} badges={badges} onNavigate={closeAll} />
            <div className="sidebar-spacer" />
            <div className="sidebar-links">
              <Link href="#/help">{t('shell.guide')}</Link>
              <Link href="#/status">{t('shell.status')}</Link>
              <Link href="#/contact">{t('shell.contact')}</Link>
            </div>
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
                {...(multi ? { onSwitch: () => setOpen('org') } : {})}
              />
            ) : (
              <UserNameContext.Provider value={session.name}>
                <RightsContext.Provider value={rights}>{children}</RightsContext.Provider>
              </UserNameContext.Provider>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};
