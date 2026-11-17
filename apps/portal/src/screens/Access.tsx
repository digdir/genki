import { ChevronDownIcon, ExternalLinkIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Chip,
  Dialog,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Tabs,
  Tag,
  Textarea,
} from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import {
  altinnSync,
  exampleServices,
  people as examplePeople,
  rights,
  type Person,
  type RightKey,
} from '../data/access';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { useRightLabels, useUserName } from '../Shell';
import { EmptyState, ErrorState, Loading } from '../states';
import { NoAccess } from './NoAccess';
import './access.css';

type Tab = 'people' | 'services';

const rightKeys: Record<RightKey, { label: PlainKey; description: PlainKey }> = {
  use: { label: 'rights.useServices', description: 'access.rightUseDesc' },
  services: { label: 'rights.manageServices', description: 'access.rightServicesDesc' },
  datasets: { label: 'rights.manageDatasets', description: 'access.rightDatasetsDesc' },
  usage: { label: 'rights.viewUsage', description: 'access.rightUsageDesc' },
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((x) => x[0] ?? '')
    .join('')
    .slice(0, 2);

const orgNumberText = (org: string) =>
  /^\d{9}$/.test(org) ? `${org.slice(0, 3)} ${org.slice(3, 6)} ${org.slice(6)}` : org;

const oldTabs = new Set(['services', 'datasets', 'groups']);

const AltinnLink = ({ label }: { label: string }) => {
  const t = useT();
  return (
    <a href="https://www.altinn.no" target="_blank" rel="noopener">
      {label}
      <Icon icon={ExternalLinkIcon} size={18} />
      <span className="visually-hidden">{t('access.newTab')}</span>
    </a>
  );
};

const Expandable = ({
  open,
  onToggle,
  header,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  header: ReactNode;
  children: ReactNode;
}) => (
  <li className={open ? 'expand-row open' : 'expand-row'}>
    <button type="button" aria-expanded={open} onClick={onToggle} className="expand-button">
      {header}
      <span className={open ? 'chevron open' : 'chevron'}>
        <Icon icon={ChevronDownIcon} size={18} />
      </span>
    </button>
    {open ? children : null}
  </li>
);

const ExamplePeople = ({ people }: { people: Person[] }) => {
  const t = useT();
  const searchId = useId();
  const useRight = t('rights.useServices');
  const [q, setQ] = useState('');
  const [rf, setRf] = useState<RightKey | 'all' | 'none'>('all');
  const [openP, setOpenP] = useState<string | null>(null);
  const query = q.trim().toLowerCase();
  const filtered = people.filter(
    (p) =>
      (rf === 'all' ? true : rf === 'none' ? p.rights.length === 0 : p.rights.includes(rf)) &&
      (!query || `${p.name} ${p.unit}`.toLowerCase().includes(query)),
  );
  return (
    <div className="access-stack">
      <div className="people-filters">
        <Field className="people-search">
          <Label htmlFor={searchId}>{t('access.searchPerson')}</Label>
          <Input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Fieldset>
          <Fieldset.Legend>{t('access.showWhoCan')}</Fieldset.Legend>
          <div className="tag-row">
            {[
              ['all', t('access.filterAll')] as const,
              ...rights.map((r) => [r.key, t(rightKeys[r.key].label)] as const),
              ['none', t('access.noRights')] as const,
            ].map(([k, l]) => (
              <Chip.Radio key={k} name="rightfilter" checked={rf === k} onChange={() => setRf(k)}>
                {l}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
      </div>
      <p aria-live="polite" className="body-sm subtle">
        {t('access.showing', { shown: filtered.length, total: people.length })}
      </p>
      {filtered.length ? (
        <ul className="plain-list expand-list">
          {filtered.map((p) => {
            const open = openP === p.id;
            const canUse = p.rights.includes('use');
            return (
              <Expandable
                key={p.id}
                open={open}
                onToggle={() => setOpenP(open ? null : p.id)}
                header={
                  <>
                    <Avatar data-size="sm" aria-hidden="true">
                      {initials(p.name)}
                    </Avatar>
                    <span className="expand-title col">
                      <span className="strong-md">{p.name}</span>
                      <span className="body-xs subtle">{p.unit}</span>
                    </span>
                    <span className="person-tags">
                      {p.rights.length ? (
                        rights
                          .filter((r) => p.rights.includes(r.key))
                          .map((r) => (
                            <Tag key={r.key} data-size="sm" data-color="accent">
                              {t(rightKeys[r.key].label)}
                            </Tag>
                          ))
                      ) : (
                        <Tag data-size="sm" data-color="neutral">
                          {t('access.noRights')}
                        </Tag>
                      )}
                      {canUse ? null : (
                        <Tag data-size="sm" data-color="warning">
                          {t('access.missingRight', { right: useRight })}
                        </Tag>
                      )}
                    </span>
                  </>
                }
              >
                <div className="person-details">
                  <div>
                    <span className="detail-label">{t('access.detailServices')}</span>
                    <span>
                      {canUse
                        ? t('access.allServices')
                        : t('access.needsUseRight', { right: useRight })}
                    </span>
                  </div>
                  <div>
                    <span className="detail-label">{t('access.detailSource')}</span>
                    <span>{p.source}</span>
                  </div>
                </div>
              </Expandable>
            );
          })}
        </ul>
      ) : (
        <div className="no-people">
          <span className="strong-lg">{t('access.noMatch')}</span>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              setQ('');
              setRf('all');
            }}
          >
            {t('access.resetFilter')}
          </Button>
        </div>
      )}
    </div>
  );
};

const OwnRights = () => {
  const t = useT();
  const name = useUserName();
  const labels = useRightLabels();
  return (
    <div className="access-stack">
      <section aria-labelledby="own-rights-h" className="stack-xs">
        <Heading level={2} data-size="xs" id="own-rights-h">
          {t('access.yourRights')}
        </Heading>
        <span className="strong-md">{name}</span>
        {labels.length ? (
          <ul className="plain-list chip-list" aria-labelledby="own-rights-h">
            {labels.map((l) => (
              <li key={l}>
                <Tag data-size="sm" data-color="accent">
                  {l}
                </Tag>
              </li>
            ))}
          </ul>
        ) : (
          <Paragraph data-size="sm">{t('access.youHaveNoRights')}</Paragraph>
        )}
      </section>
      <Paragraph data-size="sm" className="narrow-text">
        {t('access.colleaguesInAltinn')} <AltinnLink label={t('access.openAltinn')} />
      </Paragraph>
    </div>
  );
};

interface ServiceRow {
  id: string;
  name: string;
  tag: string;
  archived: boolean;
}

const ServicesTab = ({ api, tenant, live }: Pick<ScreenProps, 'api' | 'tenant' | 'live'>) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync(
    async (signal) => {
      const [access, summaries] = await Promise.all([
        api.access(tenant, signal),
        live ? api.services(tenant, signal).then((s) => s.data) : Promise.resolve([]),
      ]);
      const rows = new Map<string, ServiceRow>();
      if (!live) for (const s of exampleServices) rows.set(s.id, { ...s, archived: false });
      for (const s of access.services) {
        if (rows.has(s.id)) continue;
        const summary = summaries.find((x) => x.id === s.id);
        const archived = summary?.lifecycle === 'archived';
        rows.set(s.id, {
          id: s.id,
          name: summary?.name ?? s.name,
          tag: archived ? t('serviceLifecycle.tagArchived') : '',
          archived,
        });
      }
      return [...rows.values()];
    },
    [api, tenant, live],
    { keepPreviousFor: tenant },
  );
  if (state.status === 'loading') return <Loading label={t('access.loadingServices')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const collator = new Intl.Collator(intlLocale(f.locale));
  const services = [...state.data].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || collator.compare(a.name, b.name),
  );
  return (
    <div className="access-stack">
      <Paragraph data-size="sm">
        {t('access.servicesLead', { right: t('rights.useServices') })}
      </Paragraph>
      {services.length === 0 ? (
        <EmptyState title={t('access.noServicesTitle')}>
          <Paragraph>{t('access.noServicesText')}</Paragraph>
        </EmptyState>
      ) : (
        <ul className="plain-list expand-list" aria-label={t('access.tabServices')}>
          {services.map((s) => (
            <li key={s.id} className="expand-row access-service-row">
              <a className="strong-md" href={`#/services/${encodeURIComponent(s.id)}`}>
                {s.name}
              </a>
              {s.tag ? (
                <Tag data-size="sm" data-color="neutral">
                  {s.tag}
                </Tag>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const GrantDialog = ({
  open,
  onClose,
  tenant,
  tenantName,
}: {
  open: boolean;
  onClose: () => void;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const f = useFormat();
  const sender = useUserName();
  const whoId = useId();
  const messageId = useId();
  const [who, setWho] = useState('');
  const [picked, setPicked] = useState<RightKey[]>([]);
  const [copied, setCopied] = useState<'ok' | 'failed' | ''>('');
  const [asking, setAsking] = useState(false);

  const reset = () => {
    setWho('');
    setPicked([]);
    setCopied('');
    setAsking(false);
  };
  const close = () => {
    reset();
    onClose();
  };
  const requestClose = () => {
    if (who.trim() || picked.length) setAsking(true);
    else close();
  };

  const chosen = rights.filter((r) => picked.includes(r.key));
  const message = t('access.message', {
    count: chosen.length,
    name: who.trim() || t('access.colleague'),
    rights: f.list(chosen.map((r) => `«${t(rightKeys[r.key].label)}»`)),
    tenant: tenantName,
    org: orgNumberText(tenant),
    sender,
  });

  return (
    <Dialog
      open={open}
      closeButton={false}
      closedby="none"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      aria-labelledby={open ? 'grant-h' : undefined}
      className="access-dialog"
    >
      {open ? (
        <div className="access-stack">
          <div className="access-head-row">
            <Heading level={2} data-size="xs" id="grant-h">
              {t('access.grant')}
            </Heading>
            <Button variant="tertiary" data-size="sm" onClick={requestClose}>
              {t('common.close')}
            </Button>
          </div>
          <Field>
            <Label htmlFor={whoId}>{t('access.dialogWho')}</Label>
            <Input
              id={whoId}
              autoFocus
              value={who}
              onChange={(e) => {
                setWho(e.target.value);
                setCopied('');
              }}
            />
          </Field>
          <Fieldset>
            <Fieldset.Legend>{t('access.dialogWhat')}</Fieldset.Legend>
            {rights.map((r) => (
              <Checkbox
                key={r.key}
                label={t(rightKeys[r.key].label)}
                description={t(rightKeys[r.key].description)}
                checked={picked.includes(r.key)}
                onChange={() => {
                  setPicked((all) =>
                    all.includes(r.key) ? all.filter((k) => k !== r.key) : [...all, r.key],
                  );
                  setCopied('');
                }}
              />
            ))}
          </Fieldset>
          <div className="stack-xs">
            <Paragraph data-size="sm">{t('access.dialogInAltinn')}</Paragraph>
            {chosen.length ? (
              <Field>
                <Label htmlFor={messageId}>{t('access.messageLabel')}</Label>
                <Textarea id={messageId} rows={6} readOnly value={message} />
              </Field>
            ) : (
              <Paragraph data-size="sm" className="subtle">
                {t('access.dialogPickOne')}
              </Paragraph>
            )}
            <p role="status" className={copied === 'failed' ? 'warn-text' : 'body-sm'}>
              {copied === 'ok'
                ? t('access.copied')
                : copied === 'failed'
                  ? t('access.copyFailed')
                  : ''}
            </p>
          </div>
          {asking ? (
            <Alert data-color="warning" data-size="sm">
              <Paragraph data-size="sm">{t('access.discardAsk')}</Paragraph>
              <div className="access-actions">
                <Button data-size="sm" data-color="danger" onClick={close}>
                  {t('access.discard')}
                </Button>
                <Button data-size="sm" variant="secondary" onClick={() => setAsking(false)}>
                  {t('access.keepWriting')}
                </Button>
              </div>
            </Alert>
          ) : null}
          <div className="access-actions">
            <Button
              aria-disabled={chosen.length === 0 || undefined}
              onClick={() => {
                if (chosen.length === 0) return;
                const write = navigator.clipboard?.writeText(message);
                if (!write) {
                  setCopied('failed');
                  return;
                }
                write.then(
                  () => setCopied('ok'),
                  () => setCopied('failed'),
                );
              }}
            >
              {t('access.copyMessage')}
            </Button>
            <Button asChild variant="secondary">
              <a href="https://www.altinn.no" target="_blank" rel="noopener">
                {t('access.openAltinn')}
                <Icon icon={ExternalLinkIcon} size={18} />
                <span className="visually-hidden">{t('access.newTab')}</span>
              </a>
            </Button>
            <Button variant="tertiary" onClick={requestClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
};

export const Access = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const t = useT();
  const sub = route.segments[1];
  const oldTab = route.query.get('tab');
  const moved = !sub && oldTab !== null && oldTabs.has(oldTab);
  const tab: Tab = sub === 'services' ? 'services' : 'people';
  const [forcedAltinnError, setForcedAltinnError] = useState(
    !live && route.query.get('altinn') === 'error',
  );
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    if (!moved) return;
    const rest = new URLSearchParams(route.query);
    rest.delete('tab');
    const search = rest.toString();
    window.location.replace(`#/access/services${search ? `?${search}` : ''}`);
  }, [moved, route.query]);

  if (!live && route.query.get('view') === 'no-access')
    return <NoAccess name="Erik Strand" organisation={tenantName} embedded />;
  if (moved) return null;

  const go = (next: Tab) => {
    const rest = new URLSearchParams(route.query);
    rest.delete('tab');
    const search = rest.toString();
    navigate(`/access/${next}${search ? `?${search}` : ''}`);
  };

  return (
    <div className="access">
      <div className="page-head">
        <div className="page-head-text">
          <Heading level={1} data-size="lg">
            {t('access.title')}
          </Heading>
          <p className="lead">{t('access.lead', { tenant: tenantName })}</p>
        </div>
        <Button onClick={() => setGranting(true)}>{t('access.grant')}</Button>
      </div>

      {forcedAltinnError ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="2xs">
            {t('access.altinnErrorTitle')}
          </Heading>
          <p className="alert-text">
            {t('access.altinnErrorStale', { at: altinnSync.lastGoodAt })}
          </p>
          <Button variant="secondary" data-size="sm" onClick={() => setForcedAltinnError(false)}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}

      <Tabs value={tab} onChange={(v) => go(v as Tab)}>
        <Tabs.List aria-label={t('access.tabsLabel')}>
          <Tabs.Tab value="people">{t('access.tabPeople')}</Tabs.Tab>
          <Tabs.Tab value="services">{t('access.tabServices')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="people">
          {tab === 'people' ? (
            live ? (
              <OwnRights />
            ) : (
              <ExamplePeople people={examplePeople} />
            )
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="services">
          {tab === 'services' ? <ServicesTab api={api} tenant={tenant} live={live} /> : null}
        </Tabs.Panel>
      </Tabs>

      <GrantDialog
        open={granting}
        onClose={() => setGranting(false)}
        tenant={tenant}
        tenantName={tenantName}
      />
    </div>
  );
};
