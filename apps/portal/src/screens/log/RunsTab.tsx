import {
  Button,
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../api';
import { useFormat } from '@genai/i18n/react';
import {
  runExtras,
  serviceNames,
  triggerKindKeys,
  triggerKinds,
  type ChangeEntry,
} from '../../data/log';
import { serviceLabel as serviceLabelOf, statusOf } from '../../format';
import { useT, type PlainKey, type T } from '../../i18n';
import { navigate, useAsync } from '../../hooks';
import { ErrorState, Loading } from '../../states';
import type { TaskRow, TaskStatus } from '../../types';
import { actorText, dateKey, relativeTime } from './format';
import { RunDetail } from './RunDetail';

const statusFilters: [PlainKey, TaskStatus | ''][] = [
  ['logRuns.allStatuses', ''],
  ['taskStatus.running', 'running'],
  ['taskStatus.interrupted', 'interrupted'],
  ['taskStatus.completed', 'completed'],
  ['taskStatus.failed', 'failed'],
  ['taskStatus.cancelled', 'cancelled'],
];

interface Filters {
  q: string;
  service: string;
  status: TaskStatus | '';
  trigger: string;
  date: string;
}

const triggerLabel = (kind: string, t: T) =>
  kind in triggerKindKeys ? t(triggerKindKeys[kind as keyof typeof triggerKindKeys]) : kind;

const empty: Filters = { q: '', service: '', status: '', trigger: '', date: '' };

export const RunsTab = ({
  api,
  tenant,
  runId,
  itemIndex,
  canReveal,
  live = false,
  onChange,
}: {
  api: ApiClient;
  tenant: string;
  runId: string | undefined;
  itemIndex: number | undefined;
  canReveal: boolean;
  live?: boolean;
  onChange: (entry: ChangeEntry) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [form, setForm] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters & { n: number }>({ ...empty, n: 0 });
  const [overrides, setOverrides] = useState<Record<string, TaskStatus>>({});
  const handled = useRef(0);
  const [services] = useAsync(
    async (signal) =>
      live
        ? Object.fromEntries(
            (await api.overview(tenant, signal)).services.map((s) => [s.id, s.name]),
          )
        : serviceNames,
    [api, tenant, live],
  );
  const names: Record<string, string> = services.status === 'ready' ? services.data : {};
  const serviceLabel = (id: string) => names[id] ?? serviceLabelOf(id);
  const titleOf = (row: TaskRow) => row.serviceName ?? serviceLabel(row.service);
  const [state, retry] = useAsync(
    async (signal) => ({
      n: applied.n,
      ...(await api.tasks(
        tenant,
        {
          ...(applied.status ? { status: applied.status } : {}),
          ...(applied.service ? { service: applied.service } : {}),
        },
        signal,
      )),
    }),
    [api, tenant, applied.status, applied.service, applied.n],
  );

  const rows: TaskRow[] =
    state.status === 'ready'
      ? state.data.data.filter((row) => {
          const q = applied.q.trim().toLowerCase();
          const extras = live ? undefined : runExtras[row.id];
          return (
            (!q ||
              row.id.toLowerCase().includes(q) ||
              titleOf(row).toLowerCase().includes(q) ||
              (row.excerpt ?? '').toLowerCase().includes(q) ||
              (row.actor?.name ?? '').toLowerCase().includes(q)) &&
            (live || !applied.trigger || extras?.triggerKind === applied.trigger) &&
            (!applied.date || dateKey(new Date(row.createdAt)) === applied.date)
          );
        })
      : [];

  useEffect(() => {
    if (state.status !== 'ready' || state.data.n !== applied.n) return;
    if (applied.n === 0 || handled.current === applied.n) return;
    handled.current = applied.n;
    const first = rows[0];
    if (first) navigate(`/log/${encodeURIComponent(first.id)}`);
  }, [state, applied.n, rows]);

  const narrowedHere = Boolean(applied.q.trim() || applied.date || (!live && applied.trigger));
  const fetched = state.status === 'ready' ? state.data.data.length : 0;
  const total = state.status === 'ready' ? state.data.total : 0;
  const resultText =
    applied.n === 0 || state.status !== 'ready'
      ? ''
      : !rows.length
        ? t('logRuns.noMatch')
        : !narrowedHere
          ? t('logRuns.matches', { count: Math.max(total, rows.length) })
          : total > fetched
            ? t('logRuns.matchesAtLeast', { count: rows.length, fetched })
            : t('logRuns.matches', { count: rows.length });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied((a) => ({ ...form, n: a.n + 1 }));
  };

  const selected = runId ?? rows[0]?.id;
  const set = (patch: Partial<Filters>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="stack">
      <form role="search" onSubmit={submit} className="log-search">
        <Field className="log-search-q" data-size="sm">
          <Label htmlFor="lg-q">{t('logRuns.query')}</Label>
          <Input id="lg-q" value={form.q} onChange={(e) => set({ q: e.target.value })} />
        </Field>
        <Field className="log-search-select" data-size="sm">
          <Label htmlFor="lg-svc">{t('logRuns.service')}</Label>
          <Select
            id="lg-svc"
            value={form.service}
            onChange={(e) => set({ service: e.target.value })}
          >
            <Select.Option value="">{t('logRuns.allServices')}</Select.Option>
            {Object.entries(names).map(([id, name]) => (
              <Select.Option key={id} value={id}>
                {name}
              </Select.Option>
            ))}
          </Select>
        </Field>
        <Field className="log-search-select" data-size="sm">
          <Label htmlFor="lg-st">{t('logRuns.status')}</Label>
          <Select
            id="lg-st"
            value={form.status}
            onChange={(e) => set({ status: e.target.value as TaskStatus | '' })}
          >
            {statusFilters.map(([label, value]) => (
              <Select.Option key={label} value={value}>
                {t(label)}
              </Select.Option>
            ))}
          </Select>
        </Field>
        {live ? null : (
          <Field className="log-search-select" data-size="sm">
            <Label htmlFor="lg-tr">{t('logRuns.trigger')}</Label>
            <Select
              id="lg-tr"
              value={form.trigger}
              onChange={(e) => set({ trigger: e.target.value })}
            >
              <Select.Option value="">{t('logRuns.allTriggers')}</Select.Option>
              {triggerKinds.map((kind) => (
                <Select.Option key={kind} value={kind}>
                  {t(triggerKindKeys[kind])}
                </Select.Option>
              ))}
            </Select>
          </Field>
        )}
        <Field className="log-search-date" data-size="sm">
          <Label htmlFor="lg-dato">{t('logRuns.date')}</Label>
          <Input
            id="lg-dato"
            type="date"
            value={form.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </Field>
        <Button type="submit" variant="primary" data-size="sm">
          {t('common.search')}
        </Button>
      </form>
      <p role="status" className="log-result">
        {resultText}
      </p>
      <div className="log-split">
        <section aria-labelledby="oppg-h" className="log-list-col">
          <Heading level={2} data-size="2xs" id="oppg-h">
            {t('logRuns.recent')}
          </Heading>
          {state.status === 'loading' ? <Loading label={t('logRuns.loading')} /> : null}
          {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
          {state.status === 'ready' && state.data.data.length === 0 ? (
            <Paragraph>{t('logRuns.empty')}</Paragraph>
          ) : null}
          {rows.length > 0 ? (
            <ul className="plain-list log-runs">
              {rows.map((row) => {
                const extras = live ? undefined : runExtras[row.id];
                const status = statusOf(overrides[row.id] ?? row.status, t);
                const current = row.id === selected;
                return (
                  <li key={row.id}>
                    <a
                      href={`#/log/${encodeURIComponent(row.id)}`}
                      aria-current={current ? 'true' : undefined}
                      className={current ? 'log-run current' : 'log-run'}
                    >
                      <span className="log-run-top">
                        <span className="log-run-service">{titleOf(row)}</span>
                        <Tag data-size="sm" data-color={status.color}>
                          {status.text}
                        </Tag>
                      </span>
                      <span className="log-run-trigger meta">
                        {extras ? (
                          <Tag data-size="sm" data-color="neutral">
                            {triggerLabel(extras.triggerKind, t)}
                          </Tag>
                        ) : null}
                        {live ? (row.excerpt ?? '') : (extras?.triggerDetail ?? row.id)}
                      </span>
                      <span className="log-run-when">
                        {live
                          ? `${actorText(row.actor, t)} · ${relativeTime(row.createdAt, t, f)}`
                          : relativeTime(row.createdAt, t, f)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
        <section aria-labelledby={selected ? 'detalj-h' : undefined} className="log-detail-col">
          {selected ? (
            <RunDetail
              key={selected}
              api={api}
              tenant={tenant}
              runId={selected}
              itemIndex={itemIndex}
              canReveal={canReveal}
              live={live}
              onStatus={(id, status) => setOverrides((o) => ({ ...o, [id]: status }))}
              onChange={onChange}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
};
