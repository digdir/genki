import { ExternalLinkIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Radio,
  Select,
  Tabs,
  Tag,
  Textarea,
} from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useState } from 'react';
import type { AccessPeopleView, AccessPerson, ServiceAccess } from '../api/access';
import { ApiError } from '../api/error';
import { Icon } from '../components/Icon';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import type { ScreenProps } from '../screen';
import type { PortalRight, ServiceSummaryView } from '../types';
import { useRightLabels, useRights, useUserName } from '../Shell';
import { EmptyState, ErrorState, Loading } from '../states';
import { NoAccess } from './NoAccess';
import './access.css';

type Tab = 'people' | 'services';
type FilterKey = 'all' | PortalRight;

const rightOrder: { right: PortalRight; label: PlainKey }[] = [
  { right: 'use-services', label: 'access.rightUse' },
  { right: 'manage-services', label: 'access.rightServices' },
  { right: 'manage-datasets', label: 'access.rightDatasets' },
  { right: 'register-building-blocks', label: 'access.rightBlocks' },
  { right: 'view-usage', label: 'access.rightUsage' },
];

const grantChoices: {
  right: PortalRight;
  label: PlainKey;
  help: (t: T, tenant: string) => string;
  altinn: PlainKey;
}[] = [
  {
    right: 'use-services',
    label: 'access.rightUse',
    help: (t, tenant) => t('access.rightUseHelp', { tenant }),
    altinn: 'rights.useServices',
  },
  {
    right: 'manage-services',
    label: 'access.rightServices',
    help: (t) => t('access.rightServicesHelp'),
    altinn: 'rights.manageServices',
  },
  {
    right: 'manage-datasets',
    label: 'access.rightDatasets',
    help: (t) => t('access.rightDatasetsHelp'),
    altinn: 'rights.manageDatasets',
  },
  {
    right: 'view-usage',
    label: 'access.rightUsage',
    help: (t) => t('access.rightUsageHelp'),
    altinn: 'rights.viewUsage',
  },
];

const orgNumberText = (org: string) =>
  /^\d{9}$/.test(org) ? `${org.slice(0, 3)} ${org.slice(3, 6)} ${org.slice(6)}` : org;

const oldTabs = new Set(['services', 'datasets', 'groups']);

type NoList = 'altinn' | 'groups';

const problemCode = (error: unknown) =>
  error instanceof ApiError ? (error.problem as { code?: string } | undefined)?.code : undefined;

const canUse = (person: AccessPerson | undefined) =>
  person?.rights.includes('use-services') ?? false;

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

const OwnRights = () => {
  const name = useUserName();
  const labels = useRightLabels();
  return (
    <section aria-labelledby="own-rights-h" className="stack-xs">
      <Heading level={2} data-size="xs" id="own-rights-h">
        {name}
      </Heading>
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
      ) : null}
    </section>
  );
};

interface AccessData {
  people: AccessPeopleView;
  limits: ServiceAccess[];
  services: ServiceSummaryView[];
}

const limitOf = (limits: ServiceAccess[], service: string) =>
  limits.find((l) => l.id === service && l.mode === 'selected');

const PeopleTab = ({
  data,
  tenantName,
  onGrant,
}: {
  data: AccessData;
  tenantName: string;
  onGrant: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const searchId = useId();
  const filterId = useId();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const query = q.trim().toLowerCase();
  const collator = new Intl.Collator(intlLocale(f.locale));

  const known = new Map(data.people.people.map((p) => [p.id, p]));
  for (const limit of data.limits)
    for (const m of limit.members)
      if (!known.has(m.id)) known.set(m.id, { id: m.id, name: m.name, rights: [] });
  const everyone = [...known.values()].sort((a, b) => collator.compare(a.name, b.name));

  const serviceName = (id: string) => data.services.find((s) => s.id === id)?.name ?? id;
  const selectedIn = (person: AccessPerson) =>
    data.limits.filter((l) => l.mode === 'selected' && l.members.some((m) => m.id === person.id));
  const warns = (person: AccessPerson) => !canUse(person) && selectedIn(person).length > 0;
  const useOnly = (person: AccessPerson) =>
    person.rights.length === 1 && person.rights[0] === 'use-services' && !warns(person);

  const matches = (p: AccessPerson) =>
    (!query || p.name.toLowerCase().includes(query)) &&
    (filter === 'all' || p.rights.includes(filter));
  const showsAll = query !== '' || filter === 'use-services';
  const shown = everyone.filter((p) => matches(p) && (showsAll || !useOnly(p)));
  const hiddenUseOnly = showsAll ? 0 : everyone.filter((p) => matches(p) && useOnly(p)).length;
  const isEmpty = everyone.length <= 1 && !query && filter === 'all';

  const servicesOf = (person: AccessPerson) =>
    data.services
      .filter((s) => s.lifecycle !== 'archived')
      .flatMap((s) => {
        const limit = limitOf(data.limits, s.id);
        const draft = s.latestVersion === null;
        if (draft)
          return person.rights.includes('manage-services')
            ? [{ id: s.id, name: s.name, how: t('access.howDraft') }]
            : [];
        if (!limit)
          return canUse(person) ? [{ id: s.id, name: s.name, how: t('access.howAll') }] : [];
        if (!limit.members.some((m) => m.id === person.id)) return [];
        const how = !canUse(person)
          ? t('access.howSelectedNoEntry')
          : limit.at && limit.byName
            ? t('access.howSelectedBy', { date: f.date(limit.at), name: limit.byName })
            : t('access.howSelected');
        return [{ id: s.id, name: s.name, how }];
      })
      .sort((a, b) => collator.compare(a.name, b.name));

  const rightsText = (person: AccessPerson) =>
    rightOrder
      .filter((r) => person.rights.includes(r.right))
      .map((r) => t(r.label))
      .join(', ');

  if (isEmpty)
    return (
      <div className="access-empty">
        <Heading level={2} data-size="xs">
          {t('access.emptyTitle')}
        </Heading>
        <Paragraph className="narrow-text">{t('access.emptyText')}</Paragraph>
        <div>
          <Button onClick={onGrant}>{t('access.grant')}</Button>
        </div>
      </div>
    );

  return (
    <div className="access-stack">
      <div className="people-filters">
        <Field className="people-search">
          <Label htmlFor={searchId}>{t('access.searchPerson')}</Label>
          <Input
            id={searchId}
            type="search"
            value={q}
            placeholder={t('access.searchPlaceholder')}
            onChange={(e) => setQ(e.target.value)}
          />
        </Field>
        <Field>
          <Label htmlFor={filterId}>{t('access.showWhoCan')}</Label>
          <Select
            id={filterId}
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterKey)}
          >
            <Select.Option value="all">{t('access.filterAll')}</Select.Option>
            {rightOrder.map((r) => (
              <Select.Option key={r.right} value={r.right}>
                {t(r.label)}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <p aria-live="polite" className="body-sm subtle people-count">
          {t('access.showing', { shown: shown.length, total: everyone.length })}
        </p>
      </div>
      {shown.length ? (
        <>
          <ul className="plain-list person-list" aria-label={t('access.tabPeople')}>
            {shown.map((p) => {
              const isOpen = !!open[p.id];
              const warn = warns(p);
              const services = servicesOf(p);
              return (
                <li key={p.id} className="person-row">
                  <button
                    type="button"
                    className="person-button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
                  >
                    <span className="person-name strong-md">{p.name}</span>
                    <span className="person-rights">{rightsText(p)}</span>
                    {warn ? (
                      <Tag data-size="sm" data-color="warning">
                        {t('access.missingUse')}
                      </Tag>
                    ) : null}
                    <span className="person-toggle" aria-hidden="true">
                      {isOpen ? t('access.hideServices') : t('access.showServices')}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="person-open">
                      {warn ? (
                        <p className="warn-line">
                          {t('access.missingUseText', {
                            name: p.name,
                            services: f.list(selectedIn(p).map((l) => serviceName(l.id))),
                          })}
                        </p>
                      ) : null}
                      <span className="subtle">{t('access.canUse')}</span>
                      {services.length ? (
                        <ul className="person-services">
                          {services.map((s) => (
                            <li key={s.id}>
                              <a href={`#/access/services?open=${encodeURIComponent(s.id)}`}>
                                {s.name}
                              </a>{' '}
                              <span className="subtle">{s.how}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span>{t('access.noServicesForPerson')}</span>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {hiddenUseOnly > 0 ? (
            <p className="body-sm subtle">
              {t('access.useOnlyNote', { count: hiddenUseOnly, tenant: tenantName })}
            </p>
          ) : null}
        </>
      ) : (
        <div className="access-empty">
          <Heading level={2} data-size="xs">
            {t('access.noMatch')}
          </Heading>
          <Paragraph>{t('access.noMatchText')}</Paragraph>
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                setQ('');
                setFilter('all');
              }}
            >
              {t('access.resetSearch')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

interface Draft {
  service: string;
  some: boolean;
  members: string[];
}

const ServicesTab = ({
  api,
  tenant,
  data,
  people,
  noList,
  openFirst,
  onDirty,
  leaveAsk,
  onStay,
  onBlocked,
  onSaved,
}: {
  api: ScreenProps['api'];
  tenant: string;
  data: Omit<AccessData, 'people'>;
  people: AccessPerson[] | undefined;
  noList: NoList | undefined;
  openFirst: string | undefined;
  onDirty: (dirty: boolean) => void;
  leaveAsk: boolean;
  onStay: () => void;
  onBlocked: () => void;
  onSaved: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const { has } = useRights();
  const editable = has('manage-services');
  const reasonId = useId();
  const pickId = useId();
  const [openId, setOpenId] = useState<string | undefined>(openFirst);
  const [draft, setDraft] = useState<Draft | undefined>();
  const [reason, setReason] = useState('');
  const [pick, setPick] = useState('');
  const [removeAsk, setRemoveAsk] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [reasonShort, setReasonShort] = useState(false);
  const [saved, setSaved] = useState<{ service: string; text: string } | undefined>();
  const collator = new Intl.Collator(intlLocale(f.locale));

  const users = people?.filter(canUse).length;
  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  const nameOf = (id: string, limit?: ServiceAccess) =>
    byId.get(id)?.name ?? limit?.members.find((m) => m.id === id)?.name ?? id;

  const savedState = (service: string) => {
    const limit = limitOf(data.limits, service);
    return { some: !!limit, members: limit?.members.map((m) => m.id) ?? [] };
  };
  const current = (service: string): Draft =>
    draft?.service === service ? draft : { service, ...savedState(service) };
  const isDirty = (d: Draft | undefined) => {
    if (!d) return false;
    const s = savedState(d.service);
    return d.some !== s.some || (d.some && d.members.join('|') !== s.members.join('|'));
  };
  const dirty = isDirty(draft);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const change = (next: Draft) => {
    setDraft(next);
    setSaved(undefined);
    setSaveError('');
  };
  const discard = () => {
    setDraft(undefined);
    setReason('');
    setReasonShort(false);
    setSaveError('');
    onStay();
  };

  const statusOf = (s: ServiceSummaryView) =>
    s.latestVersion === null
      ? { label: t('access.statusDraft'), color: 'neutral' as const }
      : s.lifecycle === 'archived'
        ? { label: t('access.statusArchived'), color: 'neutral' as const }
        : s.lifecycle === 'paused'
          ? { label: t('access.statusPaused'), color: 'warning' as const }
          : { label: t('access.statusActive'), color: 'success' as const };

  const whoAll =
    users === undefined ? t('access.whoAllUnknown') : t('access.whoAll', { count: users });
  const whoOf = (s: ServiceSummaryView) => {
    if (s.latestVersion === null) return t('access.whoDraft');
    const limit = limitOf(data.limits, s.id);
    return limit
      ? t('access.whoSelected', { names: f.list(limit.members.map((m) => nameOf(m.id, limit))) })
      : whoAll;
  };

  const save = async (service: ServiceSummaryView) => {
    const d = current(service.id);
    if (reason.trim().length < 10) {
      setReasonShort(true);
      return;
    }
    if (d.some && d.members.length === 0) {
      setSaveError(t('access.pickAtLeastOne'));
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await api.accessPeople.limit(
        tenant,
        service.id,
        d.some ? { mode: 'selected', members: d.members } : { mode: 'all' },
        reason.trim(),
      );
      const before = savedState(service.id);
      const added = d.members.filter((m) => !before.members.includes(m)).map((m) => nameOf(m));
      const time = f.time(new Date());
      const text = !d.some
        ? t('access.savedAll', { time, service: service.name })
        : added.length
          ? t('access.savedAdded', { time, names: f.list(added), service: service.name })
          : t('access.savedPlain', { time });
      setSaved({ service: service.id, text });
      setDraft(undefined);
      setReason('');
      setReasonShort(false);
      onSaved();
    } catch {
      setSaveError(t('access.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const services = [...data.services].sort(
    (a, b) =>
      Number(a.lifecycle === 'archived') - Number(b.lifecycle === 'archived') ||
      collator.compare(a.name, b.name),
  );
  const openService = services.find((s) => s.id === openId);
  const noneRestricted = !data.limits.some((l) => l.mode === 'selected');

  if (services.length === 0)
    return (
      <EmptyState title={t('access.noServicesTitle')}>
        <Paragraph>{t('access.noServicesText')}</Paragraph>
      </EmptyState>
    );

  return (
    <div className="access-stack">
      {leaveAsk && dirty ? (
        <Alert data-color="warning" data-size="sm" className="access-leave">
          <span>{t('access.leaveAsk')}</span>
          <Button variant="secondary" data-size="sm" onClick={onStay}>
            {t('access.stay')}
          </Button>
        </Alert>
      ) : null}
      {noneRestricted ? <Paragraph data-size="sm">{t('access.noneRestricted')}</Paragraph> : null}
      <ul className="plain-list service-access-list" aria-label={t('access.tabServices')}>
        {services.map((s) => {
          const status = statusOf(s);
          const isOpen = openId === s.id;
          const canEdit = editable && s.latestVersion !== null && s.lifecycle !== 'archived';
          const head = (
            <>
              <strong className="service-access-name">{s.name}</strong>
              <Tag data-size="sm" data-color={status.color}>
                {status.label}
              </Tag>
              <span className="service-access-who">{whoOf(s)}</span>
            </>
          );
          return (
            <li key={s.id} className="service-access-row">
              {canEdit ? (
                <button
                  type="button"
                  className="service-access-button"
                  aria-expanded={isOpen}
                  aria-label={
                    isOpen
                      ? t('access.closeService', { service: s.name })
                      : t('access.editService', { service: s.name })
                  }
                  onClick={() => {
                    if (dirty) {
                      onBlocked();
                      return;
                    }
                    setOpenId(isOpen ? undefined : s.id);
                    setSaved(undefined);
                  }}
                >
                  {head}
                  <span className="service-access-toggle" aria-hidden="true">
                    {isOpen ? t('common.close') : t('access.edit')}
                  </span>
                </button>
              ) : (
                <div className="service-access-head">{head}</div>
              )}
              {isOpen && canEdit && openService ? (
                <ServiceEditor
                  service={openService}
                  draft={current(s.id)}
                  people={people ?? []}
                  noList={noList}
                  whoAll={whoAll}
                  nameOf={(id) => nameOf(id, limitOf(data.limits, s.id))}
                  pick={pick}
                  pickId={pickId}
                  removeAsk={removeAsk}
                  onPick={setPick}
                  onChange={change}
                  onRemoveAsk={setRemoveAsk}
                  saved={saved?.service === s.id ? saved.text : undefined}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {dirty && openService ? (
        <div className="access-save-bar">
          <div className="access-save-text">
            <strong>{t('access.unsaved')}</strong>
            <Field>
              <Label htmlFor={reasonId}>{t('access.reasonLabel')}</Label>
              <Input
                id={reasonId}
                value={reason}
                aria-invalid={reasonShort || undefined}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (e.target.value.trim().length >= 10) setReasonShort(false);
                }}
              />
              {reasonShort ? (
                <p className="warn-line" role="alert">
                  {t('access.reasonTooShort')}
                </p>
              ) : null}
            </Field>
            {saveError ? (
              <p className="warn-line" role="alert">
                {saveError}
              </p>
            ) : null}
          </div>
          <div className="access-actions">
            <Button variant="secondary" onClick={discard}>
              {t('access.discardChanges')}
            </Button>
            <Button
              aria-disabled={saving || undefined}
              onClick={() => {
                if (!saving) void save(openService);
              }}
            >
              {saving ? t('access.saving') : t('access.save')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const ServiceEditor = ({
  service,
  draft,
  people,
  noList,
  whoAll,
  nameOf,
  pick,
  pickId,
  removeAsk,
  onPick,
  onChange,
  onRemoveAsk,
  saved,
}: {
  service: ServiceSummaryView;
  draft: Draft;
  people: AccessPerson[];
  noList: NoList | undefined;
  whoAll: string;
  nameOf: (id: string) => string;
  pick: string;
  pickId: string;
  removeAsk: string | undefined;
  onPick: (id: string) => void;
  onChange: (draft: Draft) => void;
  onRemoveAsk: (id: string | undefined) => void;
  saved: string | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const collator = new Intl.Collator(intlLocale(f.locale));
  const byId = new Map(people.map((p) => [p.id, p]));
  const candidates = people
    .filter((p) => !draft.members.includes(p.id))
    .sort((a, b) => collator.compare(a.name, b.name));
  const removing = removeAsk ? nameOf(removeAsk) : '';
  const rightsText = (p: AccessPerson) =>
    rightOrder
      .filter((r) => p.rights.includes(r.right))
      .map((r) => t(r.label))
      .join(', ');

  return (
    <div className="service-editor">
      <Fieldset>
        <Fieldset.Legend>{t('access.whoCanUse', { service: service.name })}</Fieldset.Legend>
        <Radio
          name={`mode-${service.id}`}
          label={whoAll}
          checked={!draft.some}
          onChange={() => onChange({ ...draft, some: false })}
        />
        <Radio
          name={`mode-${service.id}`}
          label={t('access.modeSome')}
          checked={draft.some}
          onChange={() => onChange({ ...draft, some: true })}
        />
        {draft.some ? (
          <>
            <Paragraph data-size="sm">{t('access.modeSomeScope')}</Paragraph>
            <Paragraph data-size="sm">{t('access.modeSomeCopy')}</Paragraph>
          </>
        ) : null}
      </Fieldset>
      {draft.some ? (
        <div className="access-stack">
          {draft.members.length ? (
            <ul className="plain-list member-list" aria-label={t('access.modeSome')}>
              {draft.members.map((id) => {
                const person = byId.get(id);
                const warn = !noList && !canUse(person);
                const note = !person
                  ? noList
                    ? ''
                    : t('access.memberGone')
                  : warn
                    ? `${rightsText(person)}. ${t('access.memberLacksUseNote')}`
                    : rightsText(person);
                return (
                  <li key={id} className="member-row">
                    <span className="strong-md">{nameOf(id)}</span>
                    <span className="subtle member-note">{note}</span>
                    {warn ? (
                      <Tag data-size="sm" data-color="warning">
                        {t('access.memberLacksUse')}
                      </Tag>
                    ) : null}
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-label={t('access.removeNamed', { name: nameOf(id) })}
                      onClick={() => onRemoveAsk(id)}
                    >
                      {t('access.remove')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {removeAsk ? (
            <div role="alertdialog" aria-labelledby={`${pickId}-rm`} className="remove-ask">
              <span id={`${pickId}-rm`}>
                {t('access.removeAsk', { name: removing, service: service.name })}
              </span>
              <div className="access-actions">
                <Button
                  data-size="sm"
                  data-color="danger"
                  onClick={() => {
                    onChange({ ...draft, members: draft.members.filter((m) => m !== removeAsk) });
                    onRemoveAsk(undefined);
                  }}
                >
                  {t('access.removeNamed', { name: removing })}
                </Button>
                <Button variant="secondary" data-size="sm" onClick={() => onRemoveAsk(undefined)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {noList ? (
            <Alert data-color="info" data-size="sm">
              <Heading level={3} data-size="2xs">
                {t(noList === 'groups' ? 'access.fromGroups' : 'access.altinnNotConnected')}
              </Heading>
              <Paragraph data-size="sm">
                {t(noList === 'groups' ? 'access.noPeopleToPickGroups' : 'access.noPeopleToPick')}
              </Paragraph>
            </Alert>
          ) : (
            <div className="add-person">
              <Field>
                <Label htmlFor={pickId}>{t('access.addPerson')}</Label>
                <Select id={pickId} value={pick} onChange={(e) => onPick(e.target.value)}>
                  <Select.Option value="">{t('access.pickPerson')}</Select.Option>
                  {candidates.map((c) => (
                    <Select.Option key={c.id} value={c.id}>
                      {c.name}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!pick || draft.members.includes(pick)) return;
                  onChange({ ...draft, members: [...draft.members, pick] });
                  onPick('');
                }}
              >
                {t('access.add')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="body-sm">
          {saved} <a href="#/log/changes">{t('access.seeInLog')}</a>
        </p>
      ) : null}
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
  const [picked, setPicked] = useState<PortalRight[]>([]);
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

  const chosen = grantChoices.filter((r) => picked.includes(r.right));
  const message = t('access.message', {
    count: chosen.length,
    name: who.trim() || t('access.colleague'),
    rights: f.list(chosen.map((r) => `«${t(r.altinn)}»`)),
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
              placeholder={t('access.dialogWhoPlaceholder')}
              onChange={(e) => {
                setWho(e.target.value);
                setCopied('');
              }}
            />
          </Field>
          <Fieldset>
            <Fieldset.Legend>{t('access.dialogWhat')}</Fieldset.Legend>
            {grantChoices.map((r) => (
              <Checkbox
                key={r.right}
                label={t(r.label)}
                description={r.help(t, tenantName)}
                checked={picked.includes(r.right)}
                onChange={() => {
                  setPicked((all) =>
                    all.includes(r.right) ? all.filter((k) => k !== r.right) : [...all, r.right],
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
                {t('access.openAltinnNewTab')}
                <Icon icon={ExternalLinkIcon} size={18} />
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
  const f = useFormat();
  const sub = route.segments[1];
  const oldTab = route.query.get('tab');
  const moved = !sub && oldTab !== null && oldTabs.has(oldTab);
  const tab: Tab = sub === 'services' ? 'services' : 'people';
  const [granting, setGranting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);

  const [peopleState, retryPeople, peoplePending] = useAsync(
    (signal) => api.accessPeople.people(tenant, signal),
    [api, tenant],
    { keepPreviousFor: tenant },
  );
  const [meState] = useAsync((signal) => api.me(signal), [api]);
  const [restState, retryRest, restPending] = useAsync(
    async (signal) => {
      const [limits, services] = await Promise.all([
        api.accessPeople.services(tenant, signal),
        api.services(tenant, signal).then((s) => s.data),
      ]);
      return { limits, services };
    },
    [api, tenant],
    { keepPreviousFor: tenant },
  );

  useEffect(() => {
    if (!moved) return;
    const rest = new URLSearchParams(route.query);
    rest.delete('tab');
    const search = rest.toString();
    window.location.replace(`#/access/services${search ? `?${search}` : ''}`);
  }, [moved, route.query]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!live && route.query.get('view') === 'no-access')
    return <NoAccess name="Erik Strand" organisation={tenantName} embedded />;
  if (moved) return null;

  const guarded = (go: () => void) => {
    if (dirty) setLeaveAsk(true);
    else go();
  };
  const go = (next: Tab) =>
    guarded(() => {
      const rest = new URLSearchParams(route.query);
      rest.delete('tab');
      rest.delete('open');
      const search = rest.toString();
      navigate(`/access/${next}${search ? `?${search}` : ''}`);
    });

  const peopleError = peopleState.status === 'error' ? problemCode(peopleState.error) : undefined;
  const notConnected = peopleError === 'altinn_not_configured';
  const altinnDown =
    (peopleState.status === 'error' && !notConnected) ||
    (peopleState.status === 'ready' && peopleState.data.stale);
  const people = peopleState.status === 'ready' ? peopleState.data : undefined;
  const fromGroups =
    people?.source === 'entra-groups' ||
    (meState.status === 'ready' && meState.data.rightsFrom === 'entra-groups');
  const noList: NoList | undefined = notConnected ? 'altinn' : fromGroups ? 'groups' : undefined;

  const body = () => {
    if (restState.status === 'loading')
      return <Loading label={t('access.loadingServices')} shape="list" onRetry={retryRest} />;
    if (restState.status === 'error') {
      if (tab === 'people') return <ErrorState error={restState.error} onRetry={retryRest} />;
      return (
        <Alert data-color="danger">
          <Heading level={2} data-size="xs">
            {t('access.servicesErrorTitle')}
          </Heading>
          <Paragraph>{t('access.servicesErrorText')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={retryRest}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      );
    }
    if (tab === 'services')
      return (
        <div className="refreshing" aria-busy={restPending || undefined}>
          <ServicesTab
            api={api}
            tenant={tenant}
            data={restState.data}
            people={fromGroups ? undefined : people?.people}
            noList={noList}
            openFirst={route.query.get('open') ?? undefined}
            onDirty={setDirty}
            leaveAsk={leaveAsk}
            onStay={() => setLeaveAsk(false)}
            onBlocked={() => setLeaveAsk(true)}
            onSaved={retryRest}
          />
        </div>
      );
    if (peopleState.status === 'loading')
      return <Loading label={t('access.loadingPeople')} shape="list" onRetry={retryPeople} />;
    if (fromGroups)
      return (
        <div className="access-stack">
          <Alert data-color="info">
            <Heading level={2} data-size="xs">
              {t('access.fromGroups')}
            </Heading>
            <Paragraph>{t('access.fromGroupsText')}</Paragraph>
          </Alert>
          <OwnRights />
        </div>
      );
    if (notConnected)
      return (
        <div className="access-stack">
          <Alert data-color="info">
            <Heading level={2} data-size="xs">
              {t('access.altinnNotConnected')}
            </Heading>
            <Paragraph>
              {t('access.altinnNotConnectedText')} <AltinnLink label={t('access.openAltinn')} />
            </Paragraph>
          </Alert>
          <OwnRights />
        </div>
      );
    if (peopleState.status === 'error') {
      if (
        peopleError === undefined &&
        !(peopleState.error instanceof ApiError && peopleState.error.status === 503)
      )
        return <ErrorState error={peopleState.error} onRetry={retryPeople} />;
      return null;
    }
    return (
      <div className="refreshing" aria-busy={peoplePending || restPending || undefined}>
        <PeopleTab
          data={{ people: peopleState.data, ...restState.data }}
          tenantName={tenantName}
          onGrant={() => guarded(() => setGranting(true))}
        />
      </div>
    );
  };

  return (
    <div className="access">
      <div className="page-head">
        <div className="page-head-text">
          <Heading level={1} data-size="lg">
            {t('access.title')}
          </Heading>
          <p className="lead">{t(fromGroups ? 'access.leadGroups' : 'access.lead')}</p>
        </div>
        {fromGroups || peopleState.status === 'loading' ? null : (
          <Button onClick={() => guarded(() => setGranting(true))}>{t('access.grant')}</Button>
        )}
      </div>

      {altinnDown &&
      !fromGroups &&
      meState.status !== 'loading' &&
      (peopleError === undefined || peopleError === 'altinn_unavailable') ? (
        <Alert data-color="danger" className="access-altinn-alert">
          <div className="access-altinn-text">
            <strong>{t('access.altinnDown')}</strong>{' '}
            {people
              ? t('access.altinnStale', { at: f.dateTime(people.at) })
              : t('access.altinnNoList')}
          </div>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={peoplePending || undefined}
            onClick={() => {
              if (!peoplePending) retryPeople();
            }}
          >
            {peoplePending ? t('access.retrying') : t('common.tryAgain')}
          </Button>
        </Alert>
      ) : null}

      <Tabs value={tab} onChange={(v) => go(v as Tab)}>
        <Tabs.List aria-label={t('access.tabsLabel')}>
          <Tabs.Tab value="people">{t('access.tabPeople')}</Tabs.Tab>
          <Tabs.Tab value="services">{t('access.tabServices')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="people">{tab === 'people' ? body() : null}</Tabs.Panel>
        <Tabs.Panel value="services">{tab === 'services' ? body() : null}</Tabs.Panel>
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
