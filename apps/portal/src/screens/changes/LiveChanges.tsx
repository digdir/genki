import { Button, Chip, Field, Fieldset, Label, Select, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient, AuditRow } from '../../api';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { relativeTime } from '../log/format';
import {
  actorOf,
  areaOf,
  changeAreas,
  changeParts,
  collapseRepeats,
  keyOfActor,
  newestFirst,
  type ChangeArea,
} from './changes';

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
}

const load = async (api: ApiClient, tenant: string, signal: AbortSignal): Promise<Loaded> => {
  const [audit, services] = await Promise.all([
    api.audit(tenant, signal),
    api.services(tenant, signal).then(
      (r) => r.data,
      () => [],
    ),
  ]);
  const entries = Array.isArray(audit) ? audit : [];
  const keys = entries.some((e) => keyOfActor(e.actor) !== undefined)
    ? await api.access(tenant, signal).then(
        (a) => a.keys,
        () => [],
      )
    : [];
  return {
    entries: collapseRepeats(newestFirst(entries)),
    services: new Map(services.map((s) => [s.id, s.name])),
    keys: new Map(keys.map((k) => [k.id, k.name])),
  };
};

export const LiveChanges = ({
  api,
  tenant,
  limit = 5,
  filters = false,
}: {
  api: ApiClient;
  tenant: string;
  limit?: number;
  filters?: boolean;
}) => {
  const p = usePortalFormat();
  const { t, f } = p;
  const allowed = useRights().has('manage-services');
  const [area, setArea] = useState<ChangeArea | ''>('');
  const [person, setPerson] = useState('');
  const [state, retry] = useAsync(
    async (signal) => (allowed ? load(api, tenant, signal) : undefined),
    [api, tenant, allowed],
  );
  if (!allowed)
    return (
      <div className="card-empty">
        <span className="empty-text">{needsRight('manage-services', t)}</span>
      </div>
    );
  if (state.status === 'loading') return <Loading label={t('changes.loading')} />;
  if (state.status === 'error')
    return <ErrorState error={state.error} onRetry={retry} headingLevel={3} />;
  const data = state.data;
  if (!data || data.entries.length === 0)
    return (
      <div className="card-empty">
        <span className="empty-title">{t('changes.none')}</span>
        <span className="empty-text">{t('changes.noneText')}</span>
      </div>
    );
  const who = (e: AuditRow) => actorOf(e, t, (id) => data.keys.get(id));
  const people = [...new Set(data.entries.map(who))].sort((a, b) => a.localeCompare(b));
  const shown = data.entries
    .filter((e) => !area || areaOf(e.action) === area)
    .filter((e) => !person || who(e) === person)
    .slice(0, limit);
  const reset = () => {
    setArea('');
    setPerson('');
  };
  const sentence = (e: AuditRow) => {
    const { label, target, suffix } = changeParts(e, t, (id) => data.services.get(id));
    return (
      <>
        <strong>{who(e)}</strong> {label}
        {target ? ' ' : null}
        {target?.service ? (
          <a href={`#/services/${encodeURIComponent(target.service)}`}>{target.text}</a>
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
      <div className="row-between">
        <p role="status" className="changes-count">
          {t('changes.showing', { shown: f.number(shown.length), count: data.entries.length })}
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
            const a = areaOf(e.action);
            return (
              <li key={e.task} className="changes-row">
                <Tag data-size="sm" data-color="neutral" className="changes-area-tag">
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
    </div>
  );
};
