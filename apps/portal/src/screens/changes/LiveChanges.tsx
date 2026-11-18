import {
  Button,
  Chip,
  Field,
  Fieldset,
  Label,
  Paragraph,
  Select,
  Switch,
  Tag,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient, AuditRow } from '../../api';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { useAuditPages } from './audit-pages';
import { relativeTime } from '../log/format';
import {
  actorOf,
  areaOfEntry,
  changeAreas,
  changeParts,
  collapseRepeats,
  isDigdirCatalogChange,
  keyOfActor,
  newestFirst,
  type ChangeArea,
} from './changes';
import './paging.css';

export const auditPageSize = 50;

const areaKeys: Record<ChangeArea, PlainKey> = {
  services: 'changes.areaServices',
  datasets: 'changes.areaDatasets',
  access: 'changes.areaAccess',
  settings: 'changes.areaSettings',
};

interface Loaded {
  entries: AuditRow[];
  services: Map<string, string>;
  keys: Map<string, string>;
  models: Map<string, string>;
  datasets: Map<string, { name: string; fullId: string }>;
  auditDays?: number;
}

const load = async (
  api: ApiClient,
  tenant: string,
  signal: AbortSignal,
  paged: boolean,
): Promise<Loaded> => {
  const [audit, services, models, datasets, settings] = await Promise.all([
    paged
      ? []
      : api.auditPage(tenant, { limit: auditPageSize, offset: 0 }, signal).then((p) => p.data),
    api.services(tenant, signal).then(
      (r) => r.data,
      () => [],
    ),
    api.listModels({}, signal).catch(() => []),
    api.datasets.list(tenant, signal).catch(() => []),
    paged ? api.tenantEffectiveSettings(tenant, signal).catch(() => undefined) : undefined,
  ]);
  const auditDays = settings?.['retention.auditDays']?.value;
  const entries = Array.isArray(audit) ? audit : [];
  const keys =
    paged || entries.some((e) => keyOfActor(e.actor) !== undefined)
      ? await api.access(tenant, signal).then(
          (a) => a.keys,
          () => [],
        )
      : [];
  return {
    entries: collapseRepeats(newestFirst(entries)),
    services: new Map(services.map((s) => [s.id, s.name])),
    keys: new Map(keys.map((k) => [k.id, k.name])),
    models: new Map(models.flatMap((m) => (m.name ? [[m.id, m.name] as const] : []))),
    datasets: new Map(
      datasets.flatMap((d) => {
        const named = { name: d.name, fullId: d.fullId };
        return [[d.fullId, named] as const, [d.id, named] as const];
      }),
    ),
    ...(typeof auditDays === 'number' ? { auditDays } : {}),
  };
};

export const LiveChanges = ({
  api,
  tenant,
  limit = 5,
  filters = false,
  paged = false,
}: {
  api: ApiClient;
  tenant: string;
  limit?: number;
  filters?: boolean;
  paged?: boolean;
}) => {
  const p = usePortalFormat();
  const { t, f } = p;
  const allowed = useRights().has('manage-services');
  const [area, setArea] = useState<ChangeArea | ''>('');
  const [person, setPerson] = useState('');
  const [digdir, setDigdir] = useState(false);
  const pages = useAuditPages(api, tenant, auditPageSize, allowed && paged);
  const [loaded, retryLoad] = useAsync(
    async (signal) => (allowed ? load(api, tenant, signal, paged) : undefined),
    [api, tenant, allowed, paged],
  );
  if (!allowed)
    return (
      <div className="card-empty">
        <span className="empty-text">{needsRight('manage-services', t)}</span>
      </div>
    );
  if (paged && pages.first.status === 'error')
    return <ErrorState error={pages.first.error} onRetry={pages.retry} headingLevel={3} />;
  if (loaded.status === 'error')
    return <ErrorState error={loaded.error} onRetry={retryLoad} headingLevel={3} />;
  if ((paged && pages.first.status === 'loading') || loaded.status === 'loading')
    return (
      <Loading
        label={t('changes.loading')}
        shape="list"
        headingLevel={3}
        onRetry={paged ? pages.retry : retryLoad}
      />
    );
  const data = loaded.data;
  const all = paged ? collapseRepeats(newestFirst(pages.rows)) : (data?.entries ?? []);
  const entries = filters && !digdir ? all.filter((e) => !isDigdirCatalogChange(e)) : all;
  if (!data || all.length === 0)
    return (
      <div className="card-empty">
        <span className="empty-title">{t('changes.none')}</span>
        <span className="empty-text">{t('changes.noneText')}</span>
      </div>
    );
  const who = (e: AuditRow) => actorOf(e, t, (id) => data.keys.get(id));
  const people = [...new Set(entries.map(who))].sort((a, b) => a.localeCompare(b));
  const matching = entries
    .filter((e) => !area || areaOfEntry(e) === area)
    .filter((e) => !person || who(e) === person);
  const shown = paged ? matching : matching.slice(0, limit);
  const reset = () => {
    setArea('');
    setPerson('');
  };
  const sentence = (e: AuditRow) => {
    const { label, target, suffix } = changeParts(
      e,
      t,
      (id) => data.services.get(id),
      (kind, id) =>
        kind === 'model'
          ? data.models.get(id)
          : kind === 'dataset'
            ? data.datasets.get(id)?.name
            : undefined,
      (id) => data.datasets.get(id)?.fullId,
    );
    return (
      <>
        <strong>{who(e)}</strong> {label}
        {target ? ' ' : null}
        {target?.service ? (
          <a href={`#/services/${encodeURIComponent(target.service)}`}>{target.text}</a>
        ) : target?.href ? (
          <a href={target.href}>{target.text}</a>
        ) : (
          target?.text
        )}
        {suffix}
      </>
    );
  };
  const when = (e: AuditRow) => (
    <time className="meta" dateTime={e.at}>
      {relativeTime(e.at, t, f)}
    </time>
  );

  if (!filters)
    return (
      <ol className="plain-list card-rows">
        {shown.map((e) => (
          <li key={e.task} className="change-row">
            <div className="change-text">
              <span>{sentence(e)}</span>
              {when(e)}
            </div>
          </li>
        ))}
      </ol>
    );

  return (
    <div className="stack-md">
      <div className="changes-filters">
        <Fieldset className="changes-area">
          <Fieldset.Legend>{t('changes.areaLegend')}</Fieldset.Legend>
          <div className="tag-row">
            {(['', ...changeAreas] as const).map((a) => (
              <Chip.Radio
                key={a || 'all'}
                name="changes-area"
                checked={area === a}
                onChange={() => setArea(a)}
              >
                {a ? t(areaKeys[a]) : t('changes.areaAll')}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <Field className="changes-person">
          <Label htmlFor="changes-person">{t('changes.person')}</Label>
          <Select id="changes-person" value={person} onChange={(e) => setPerson(e.target.value)}>
            <Select.Option value="">{t('changes.allPeople')}</Select.Option>
            {people.map((name) => (
              <Select.Option key={name} value={name}>
                {name}
              </Select.Option>
            ))}
          </Select>
        </Field>
      </div>
      <Switch
        label={t('logChanges.showDigdir')}
        checked={digdir}
        onChange={() => setDigdir(!digdir)}
      />
      <div className="row-between">
        <p role="status" className="changes-count">
          {t('changes.showing', {
            shown: f.number(shown.length),
            count: entries.length + (paged ? pages.total - pages.rows.length : 0),
          })}
        </p>
        {area || person ? (
          <Button variant="tertiary" data-size="sm" onClick={reset}>
            {t('changes.reset')}
          </Button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <div className="card-empty">
          <span className="empty-title">{t('changes.noMatch')}</span>
          <Button variant="secondary" data-size="sm" onClick={reset}>
            {t('changes.resetFilters')}
          </Button>
        </div>
      ) : (
        <ol className="plain-list changes-list" aria-label={t('log.tabChanges')}>
          {shown.map((e) => {
            const a = areaOfEntry(e);
            const fromDigdir = isDigdirCatalogChange(e);
            return (
              <li key={e.task} className="changes-row">
                <Tag
                  data-size="sm"
                  data-color={fromDigdir ? 'info' : 'neutral'}
                  className="changes-area-tag"
                >
                  {t(areaKeys[a])}
                </Tag>
                <span className="changes-text">
                  {sentence(e)}
                  {e.reason ? <span className="changes-reason">«{e.reason}»</span> : null}
                </span>
                {when(e)}
              </li>
            );
          })}
        </ol>
      )}
      {paged && pages.rows.length < pages.total ? (
        <div className="changes-paging">
          {pages.more === 'error' ? (
            <p className="meta" role="alert">
              {t('changesPaging.moreFailed')}
            </p>
          ) : null}
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={pages.more === 'loading' || undefined}
            onClick={() => void pages.loadMore()}
          >
            {pages.more === 'loading' ? t('changesPaging.loadingMore') : t('changesPaging.more')}
          </Button>
        </div>
      ) : null}
      {data.auditDays ? (
        <Paragraph data-size="sm" className="meta">
          {data.auditDays === 730
            ? t('logChanges.keptTwoYears')
            : t('logChanges.keptDays', { count: data.auditDays })}
        </Paragraph>
      ) : null}
    </div>
  );
};
