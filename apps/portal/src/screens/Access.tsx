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
  Radio,
  Spinner,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Icon, icons } from '../components/Icon';
import { NotAvailable } from '../components/NotAvailable';
import {
  altinnSync,
  groups as initialGroups,
  people as examplePeople,
  resources as initialResources,
  rights,
  type Group,
  type Person,
  type Resource,
  type RightKey,
} from '../data/access';
import { useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import type { ScreenProps } from '../screen';
import { NoAccess } from './NoAccess';
import './access.css';

type Tab = 'services' | 'datasets' | 'groups';
type DialogState = { kind: 'resource'; id: string } | { kind: 'group'; id: string } | undefined;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((x) => x[0] ?? '')
    .join('')
    .slice(0, 2);
const rightKeys: Record<RightKey, { label: PlainKey; description: PlainKey }> = {
  use: { label: 'rights.useServices', description: 'access.rightUseDesc' },
  services: { label: 'rights.manageServices', description: 'access.rightServicesDesc' },
  datasets: { label: 'rights.manageDatasets', description: 'access.rightDatasetsDesc' },
  usage: { label: 'rights.viewUsage', description: 'access.rightUsageDesc' },
};
const canUseRight = (p: Person) => p.rights.includes('use');

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
        <Icon d={icons.chevronDown} size={18} />
      </span>
    </button>
    {open ? children : null}
  </li>
);

export const Access = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const join = (a: string[]) => (a.length ? f.list(a) : t('access.none'));
  const useRight = t('rights.useServices');
  const people = live ? [] : examplePeople;
  const personById = (id: string) => people.find((p) => p.id === id);
  const searchId = useId();
  const dialogSearchId = useId();
  const [state, retry] = useAsync(
    async (signal) => {
      const [access, summaries] = await Promise.all([
        api.access(tenant, signal),
        live ? api.services(tenant, signal).catch(() => undefined) : undefined,
      ]);
      return { ...access, summaries: summaries?.data ?? [] };
    },
    [api, tenant, live],
  );
  const [forcedAltinnError, setForcedAltinnError] = useState(route.query.get('altinn') === 'error');
  const [groups, setGroups] = useState<Record<string, Group>>(live ? {} : initialGroups);
  const [res, setRes] = useState<Resource[]>(live ? [] : initialResources);
  const [q, setQ] = useState('');
  const [rf, setRf] = useState<RightKey | 'all' | 'none'>('all');
  const [openP, setOpenP] = useState<string | null>('per');
  const initialTab = route.query.get('tab');
  const [tab, setTab] = useState<Tab>(
    initialTab === 'datasets' || initialTab === 'groups' ? initialTab : 'services',
  );
  const [openR, setOpenR] = useState<string | null>('vedtaksutkast');
  const [openG, setOpenG] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>();
  const [dialogQ, setDialogQ] = useState('');
  const [dialogSel, setDialogSel] = useState<string[]>([]);
  const [flash, setFlash] = useState('');

  const allResources = useMemo(() => {
    if (state.status !== 'ready') return res;
    const summaryOf = (id: string) => state.data.summaries.find((x) => x.id === id);
    const archived = (id: string) => summaryOf(id)?.lifecycle === 'archived';
    const extra = state.data.services
      .filter((s) => !res.some((r) => r.id === s.id))
      .map((s): Resource => ({
        id: s.id,
        kind: 'service',
        name: summaryOf(s.id)?.name ?? s.name,
        tag: archived(s.id) ? t('serviceLifecycle.tagArchived') : '',
        mode: 'all',
        who: [],
      }));
    return [...res, ...extra]
      .map((r, i) => ({ r, i }))
      .sort((a, b) => Number(archived(a.r.id)) - Number(archived(b.r.id)) || a.i - b.i)
      .map(({ r }) => r);
  }, [res, state, t]);

  if (!live && route.query.get('view') === 'no-access')
    return <NoAccess name="Erik Strand" organisation={tenantName} embedded />;

  const syncing = state.status === 'loading';
  const altinnErr = forcedAltinnError || state.status === 'error';
  const label = (w: string) => {
    const [k, id = ''] = w.split(':');
    if (k === 'g') {
      const g = groups[id];
      return g ? `${g.name} (${g.members.length})` : id;
    }
    return personById(id)?.name ?? id;
  };
  const plain = (w: string) => label(w).replace(/ \(\d+\)$/, '');
  const canUse = (p: Person, r: Resource) => {
    if (!canUseRight(p)) return false;
    if (r.mode === 'all') return true;
    return r.who.some((w) => {
      const [k, id = ''] = w.split(':');
      return k === 'p' ? id === p.id : (groups[id]?.members.includes(p.id) ?? false);
    });
  };
  const updateRes = (id: string, fn: (r: Resource) => Resource) => {
    setRes((all) => {
      const known = all.some((r) => r.id === id);
      const base = known ? all : [...all, ...allResources.filter((r) => r.id === id)];
      return base.map((r) => (r.id === id ? fn(r) : r));
    });
    setFlash('');
  };

  const query = q.trim().toLowerCase();
  const filtered = people.filter(
    (p) =>
      (rf === 'all' ? true : rf === 'none' ? p.rights.length === 0 : p.rights.includes(rf)) &&
      (!query || `${p.name} ${p.unit}`.toLowerCase().includes(query)),
  );
  const users = people.filter(canUseRight).length;

  const openDialog = (d: DialogState) => {
    setDialogQ('');
    setDialogSel([]);
    setDialog(d);
  };

  const dialogView = (() => {
    if (!dialog) return undefined;
    const dq = dialogQ.trim().toLowerCase();
    if (dialog.kind === 'resource') {
      const r = allResources.find((x) => x.id === dialog.id);
      if (!r) return undefined;
      const opts = [
        ...Object.entries(groups).map(([id, g]) => ({
          key: `g:${id}`,
          label: g.name,
          desc: t('access.groupOption', {
            members: t('access.memberCount', { count: g.members.length }),
          }),
          blocked: false,
        })),
        ...people.map((p) => ({
          key: `p:${p.id}`,
          label: p.name,
          desc: canUseRight(p) ? p.unit : t('access.blockedOption', { right: useRight }),
          blocked: !canUseRight(p),
        })),
      ].filter((o) => !r.who.includes(o.key));
      return {
        title: t('access.dialogGiveAccess', { name: r.name }),
        legend: t('access.dialogChooseBoth'),
        opts: opts.filter((o) => !dq || `${o.label} ${o.desc}`.toLowerCase().includes(dq)),
        confirm: () => {
          if (dialogSel.length) {
            updateRes(r.id, (x) => ({ ...x, who: [...x.who, ...dialogSel] }));
            setFlash(
              t('access.accessGranted', {
                names: f.list(dialogSel.map(plain)),
                resource: r.name,
              }),
            );
          }
          setDialog(undefined);
        },
      };
    }
    const g = groups[dialog.id];
    if (!g) return undefined;
    const opts = people
      .filter((p) => !g.members.includes(p.id))
      .map((p) => ({
        key: p.id,
        label: p.name,
        desc: canUseRight(p)
          ? p.unit
          : t('access.blockedInGroup', { unit: p.unit, right: useRight }),
        blocked: false,
      }));
    return {
      title: t('access.dialogAddTo', { name: g.name }),
      legend: t('access.dialogChoosePeople'),
      opts: opts.filter((o) => !dq || `${o.label} ${o.desc}`.toLowerCase().includes(dq)),
      confirm: () => {
        if (dialogSel.length) {
          const id = dialog.id;
          setGroups((all) => ({
            ...all,
            [id]: { ...g, members: [...g.members, ...dialogSel] },
          }));
          setFlash(t('access.peopleAdded', { count: dialogSel.length, group: g.name }));
        }
        setDialog(undefined);
      },
    };
  })();

  const resourceList = (kind: Resource['kind']) =>
    live && !allResources.some((r) => r.kind === kind) ? (
      <NotAvailable
        level={3}
        title={kind === 'service' ? t('access.noServicesTitle') : t('access.unavailableTitle')}
      >
        {kind === 'service' ? t('access.noServicesText') : t('access.datasetsUnavailable')}
      </NotAvailable>
    ) : (
      <ul className="plain-list expand-list">
        {allResources
          .filter((r) => r.kind === kind)
          .map((r) => {
            const open = openR === r.id;
            const selected = r.mode === 'selected';
            return (
              <Expandable
                key={r.id}
                open={open}
                onToggle={() => setOpenR(open ? null : r.id)}
                header={
                  <>
                    <span className="expand-title">
                      <span className="strong-md">{r.name}</span>
                      {r.tag ? (
                        <Tag data-size="sm" data-color="neutral">
                          {r.tag}
                        </Tag>
                      ) : null}
                    </span>
                    <span className="expand-summary">
                      {!selected
                        ? live
                          ? t('access.everyoneWithInAltinn', { right: useRight })
                          : t('access.everyoneWith', { right: useRight, count: users })
                        : r.who.length
                          ? f.list(r.who.map(label))
                          : t('access.nobodyYet')}
                    </span>
                  </>
                }
              >
                <div className="expand-body">
                  {r.locked ? (
                    <Alert data-color="info" data-size="sm">
                      {r.locked}
                    </Alert>
                  ) : (
                    <>
                      <Fieldset>
                        <Fieldset.Legend>
                          {kind === 'service'
                            ? t('access.whoUseService')
                            : t('access.whoSearchDataset')}
                        </Fieldset.Legend>
                        <Radio
                          name={`modus-${r.id}`}
                          label={t('access.modeAll', { right: useRight })}
                          description={
                            live
                              ? t('access.modeAllDescAltinn', { tenant: tenantName })
                              : t('access.modeAllDesc', { count: users, tenant: tenantName })
                          }
                          checked={r.mode === 'all'}
                          onChange={() => updateRes(r.id, (x) => ({ ...x, mode: 'all' }))}
                        />
                        <Radio
                          name={`modus-${r.id}`}
                          label={t('access.modeSelected')}
                          description={
                            kind === 'service'
                              ? t('access.othersDontSeeService')
                              : t('access.othersDontSeeDataset')
                          }
                          checked={r.mode === 'selected'}
                          onChange={() => updateRes(r.id, (x) => ({ ...x, mode: 'selected' }))}
                        />
                      </Fieldset>
                      {selected ? (
                        <div className="who-box">
                          <span className="strong-sm">{t('access.hasAccess')}</span>
                          <ul className="plain-list chip-list">
                            {r.who.map((w) => {
                              const [k, id = ''] = w.split(':');
                              const p = k === 'p' ? personById(id) : undefined;
                              const g = k === 'g' ? groups[id] : undefined;
                              const missing = g
                                ? g.members.filter((m) => {
                                    const person = personById(m);
                                    return person && !canUseRight(person);
                                  }).length
                                : 0;
                              const warn =
                                p && !canUseRight(p)
                                  ? t('access.warnPerson', { right: useRight })
                                  : missing
                                    ? t('access.warnGroup', { count: missing, right: useRight })
                                    : '';
                              return (
                                <li key={w}>
                                  <Chip.Removable
                                    aria-label={t('access.removeAccessFor', { name: label(w) })}
                                    onClick={() => {
                                      updateRes(r.id, (x) => ({
                                        ...x,
                                        who: x.who.filter((y) => y !== w),
                                      }));
                                      setFlash(
                                        t('access.accessRemoved', {
                                          name: plain(w),
                                          resource: r.name,
                                        }),
                                      );
                                    }}
                                  >
                                    {label(w)}
                                  </Chip.Removable>
                                  {warn ? <span className="warn-text">{warn}</span> : null}
                                </li>
                              );
                            })}
                          </ul>
                          {r.who.length === 0 ? (
                            <p className="body-sm subtle">{t('access.nobodyAddHint')}</p>
                          ) : null}
                          <Button
                            variant="secondary"
                            data-size="sm"
                            onClick={() => openDialog({ kind: 'resource', id: r.id })}
                          >
                            <Icon d={icons.plus} size={18} />
                            {t('access.addGroupOrPerson')}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </Expandable>
            );
          })}
      </ul>
    );

  return (
    <div className="access">
      <div className="page-head">
        <div className="page-head-text">
          <Heading level={1} data-size="lg">
            {t('access.title')}
          </Heading>
          <p className="lead">{t('access.lead', { tenant: tenantName })}</p>
        </div>
        <Button asChild>
          <a href="https://www.altinn.no" target="_blank" rel="noopener">
            {t('access.changeInAltinn')}
            <Icon d={icons.external} size={18} />
            <span className="visually-hidden">{t('access.newTab')}</span>
          </a>
        </Button>
      </div>

      {altinnErr ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="2xs">
            {t('access.altinnErrorTitle')}
          </Heading>
          <p className="alert-text">
            {live
              ? t('access.altinnErrorLive')
              : t('access.altinnErrorStale', { at: altinnSync.lastGoodAt })}
          </p>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={syncing || undefined}
            onClick={() => {
              if (syncing) return;
              setForcedAltinnError(false);
              retry();
            }}
          >
            {t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}

      <section aria-labelledby="rett-h" className="stack-md">
        <div className="row-between">
          <Heading level={2} data-size="sm" id="rett-h">
            {t('access.rightsTitle')}
          </Heading>
          <span role="status" className="sync-status">
            {syncing ? <Spinner aria-hidden="true" data-size="2xs" /> : null}
            {syncing
              ? t('access.syncLoading')
              : live
                ? t('access.syncNotConnected')
                : altinnErr
                  ? t('access.syncLastGood', { at: altinnSync.lastGoodAt })
                  : t('access.syncFetched', { at: altinnSync.fetchedAt })}
          </span>
        </div>
        {live ? (
          <NotAvailable level={3}>{t('access.notFetched')}</NotAvailable>
        ) : (
          <>
            <div className="right-cards">
              {rights.map((r) => {
                const n = people.filter((p) => p.rights.includes(r.key)).length;
                return (
                  <div key={r.key} className="right-card">
                    <span className="right-card-head">
                      <span className="strong-md">{t(rightKeys[r.key].label)}</span>
                      <span className="numeric subtle">
                        {t('access.personCount', { count: n })}
                      </span>
                    </span>
                    <span className="body-xs subtle">{t(rightKeys[r.key].description)}</span>
                  </div>
                );
              })}
            </div>
            <div className="people-filters">
              <Field className="people-search">
                <Label htmlFor={searchId}>{t('access.searchPerson')}</Label>
                <Input
                  id={searchId}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </Field>
              <Fieldset>
                <Fieldset.Legend>{t('access.showWhoCan')}</Fieldset.Legend>
                <div className="tag-row">
                  {[
                    ['all', t('access.filterAll')] as const,
                    ...rights.map((r) => [r.key, t(rightKeys[r.key].label)] as const),
                    ['none', t('access.noRights')] as const,
                  ].map(([k, l]) => (
                    <Chip.Radio
                      key={k}
                      name="rettfilter"
                      checked={rf === k}
                      onChange={() => setRf(k)}
                    >
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
                  const svc = allResources
                    .filter((r) => r.kind === 'service' && canUse(p, r))
                    .map((r) => r.name);
                  const ds = allResources
                    .filter((r) => r.kind === 'dataset' && canUse(p, r))
                    .map((r) => r.name);
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
                                    <Icon d={icons.check} size={14} strokeWidth={2} />
                                    {t(rightKeys[r.key].label)}
                                  </Tag>
                                ))
                            ) : (
                              <Tag data-size="sm" data-color="neutral">
                                {t('access.noRights')}
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
                            {canUseRight(p)
                              ? join(svc)
                              : t('access.needsUseRight', { right: useRight })}
                          </span>
                        </div>
                        <div>
                          <span className="detail-label">{t('access.detailDatasets')}</span>
                          <span>{canUseRight(p) ? join(ds) : t('access.none')}</span>
                        </div>
                        <div>
                          <span className="detail-label">{t('access.detailGroups')}</span>
                          <span>
                            {join(
                              Object.values(groups)
                                .filter((g) => g.members.includes(p.id))
                                .map((g) => g.name),
                            )}
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
          </>
        )}
      </section>

      <section aria-labelledby="fin-h" className="stack-md">
        <div className="stack-xs">
          <Heading level={2} data-size="sm" id="fin-h">
            {t('access.accessTitle')}
          </Heading>
          <p className="body-md subtle">{t('access.accessLead', { right: useRight })}</p>
        </div>
        <Tabs
          value={tab}
          onChange={(v) => {
            setTab(v as Tab);
            setFlash('');
          }}
        >
          <TabsList aria-label={t('access.tabsLabel')}>
            <TabsTab value="services">{t('access.tabServices')}</TabsTab>
            {live ? null : <TabsTab value="datasets">{t('access.tabDatasets')}</TabsTab>}
            <TabsTab value="groups">{t('access.tabGroups')}</TabsTab>
          </TabsList>
          <div aria-live="polite" className="flash-slot">
            {flash ? (
              <Alert data-color="success" data-size="sm">
                {flash}
              </Alert>
            ) : null}
          </div>
          <TabsPanel value="services">{resourceList('service')}</TabsPanel>
          {live ? null : <TabsPanel value="datasets">{resourceList('dataset')}</TabsPanel>}
          <TabsPanel value="groups">
            <div className="stack-sm">
              <p className="body-sm subtle narrow-text">{t('access.groupsLead')}</p>
              {live && Object.keys(groups).length === 0 ? (
                <NotAvailable level={3} title={t('access.noGroupsTitle')}>
                  {t('access.noGroupsText')}
                </NotAvailable>
              ) : null}
              <ul className="plain-list expand-list">
                {Object.entries(groups).map(([id, g]) => {
                  const open = openG === id;
                  const used = allResources
                    .filter((r) => r.who.includes(`g:${id}`))
                    .map((r) => r.name);
                  return (
                    <Expandable
                      key={id}
                      open={open}
                      onToggle={() => setOpenG(open ? null : id)}
                      header={
                        <>
                          <span className="expand-title col">
                            <span className="strong-md">{g.name}</span>
                            <span className="body-xs subtle">
                              {t('access.memberCount', { count: g.members.length })}
                            </span>
                          </span>
                          <span className="expand-summary">
                            {used.length
                              ? t('access.groupUsedIn', { names: f.list(used) })
                              : t('access.groupUnused')}
                          </span>
                        </>
                      }
                    >
                      <div className="expand-body">
                        <ul className="plain-list chip-list">
                          {g.members.map((m) => {
                            const p = personById(m);
                            if (!p) return null;
                            return (
                              <li key={m}>
                                <Chip.Removable
                                  aria-label={t('access.removeFromGroup', {
                                    person: p.name,
                                    group: g.name,
                                  })}
                                  onClick={() => {
                                    setGroups((all) => ({
                                      ...all,
                                      [id]: { ...g, members: g.members.filter((y) => y !== m) },
                                    }));
                                    setFlash(
                                      t('access.removedFromGroup', {
                                        person: p.name,
                                        group: g.name,
                                      }),
                                    );
                                  }}
                                >
                                  {p.name}
                                </Chip.Removable>
                              </li>
                            );
                          })}
                        </ul>
                        {g.members.length === 0 ? (
                          <p className="body-sm subtle">{t('access.groupEmpty')}</p>
                        ) : null}
                        <Button
                          variant="secondary"
                          data-size="sm"
                          onClick={() => openDialog({ kind: 'group', id })}
                        >
                          {t('access.addPeople')}
                        </Button>
                      </div>
                    </Expandable>
                  );
                })}
              </ul>
            </div>
          </TabsPanel>
        </Tabs>
      </section>

      <Dialog
        open={dialogView !== undefined}
        onClose={() => setDialog(undefined)}
        closeButton={t('common.close')}
        aria-labelledby={dialogView ? 'access-dlg-h' : undefined}
        className="access-dialog"
      >
        {dialogView ? (
          <div className="stack-md">
            <Heading level={2} data-size="xs" id="access-dlg-h">
              {dialogView.title}
            </Heading>
            <Field>
              <Label htmlFor={dialogSearchId}>{t('common.search')}</Label>
              <Input
                id={dialogSearchId}
                type="search"
                value={dialogQ}
                onChange={(e) => setDialogQ(e.target.value)}
              />
            </Field>
            <Fieldset className="dialog-options">
              <Fieldset.Legend>{dialogView.legend}</Fieldset.Legend>
              {dialogView.opts.map((o) => (
                <Checkbox
                  key={o.key}
                  label={o.label}
                  description={o.desc}
                  checked={dialogSel.includes(o.key)}
                  aria-disabled={o.blocked || undefined}
                  onChange={() => {
                    if (o.blocked) return;
                    setDialogSel((sel) =>
                      sel.includes(o.key) ? sel.filter((k) => k !== o.key) : [...sel, o.key],
                    );
                  }}
                />
              ))}
              {dialogView.opts.length === 0 ? (
                <p className="body-sm subtle">{t('access.noHits')}</p>
              ) : null}
            </Fieldset>
            <div className="actions">
              <Button onClick={dialogView.confirm}>
                {dialogSel.length
                  ? t('access.addButtonCount', { count: dialogSel.length })
                  : t('access.addButton')}
              </Button>
              <Button variant="secondary" onClick={() => setDialog(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
};
