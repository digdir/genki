import {
  Alert,
  Button,
  Chip,
  Dialog,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Radio,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFoot,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { usageServices } from '../data/usage';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { ErrorState, limitOf, refusalOf } from '../states';
import type { ScreenProps } from '../screen';
import type { ModelOption, UsageReport, UsageTotals } from '../types';
import {
  aggregate,
  categories,
  costOf,
  decimalText,
  money,
  monthStatus,
  nb,
  percentText,
  periodLabels,
  quotaOf,
  runsOf,
  series,
  short,
  today,
  tokensIn,
  tokensOf,
  withPricing,
  type Group,
  type Period,
} from './usage/model';
import { UsageChart } from './usage/UsageChart';
import './usage.css';

const DOWNLOAD = 'M12 4v11M7 10l5 5 5-5M5 20h14';

type SortKey = 'name' | 'tok' | 'cost';
type DialogState = { kind: 'export' } | { kind: 'limit'; id: string } | undefined;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .replace(/[å]/g, 'a')
    .replace(/[^a-z0-9]+/g, '-');

const isEmptyReport = (r: UsageReport) => tokensOf(r.totals) === 0 && r.totals.requests === 0;

const UsageView = ({
  report,
  tenantName,
  dialog,
  setDialog,
  live,
  quota,
  models,
  project,
  onProject,
}: {
  project: string | undefined;
  onProject: (id: string) => void;
  report: UsageReport;
  tenantName: string;
  live: boolean;
  quota: number | null;
  models: ModelOption[] | null;
  dialog: DialogState;
  setDialog: (d: DialogState) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const ids = { period: useId(), limit: useId(), limitHelp: useId() };
  const [period, setPeriod] = useState<Period>('current');
  const [group, setGroup] = useState<Group>('service');
  const [selBar, setSelBar] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'tok', dir: -1 });
  const [limits, setLimits] = useState<Record<string, number | null>>(() =>
    live ? {} : Object.fromEntries(usageServices.map((s) => [s.id, s.limit])),
  );
  const [flash, setFlash] = useState('');
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [level, setLevel] = useState<'rows' | 'sum'>('rows');
  const [limMode, setLimMode] = useState<'on' | 'off'>('on');
  const [limVal, setLimVal] = useState('');
  const [limErr, setLimErr] = useState('');

  const labels = periodLabels(report, f, t);
  const status = useMemo(
    () => monthStatus(report, quota, models, f, t),
    [report, quota, models, f, t],
  );
  const bars = useMemo(() => series(report, period, group, f, t), [report, period, group, f, t]);
  const cats = useMemo(
    () => categories(report, group, models ?? [], t),
    [report, group, models, t],
  );
  const monthly = period === 'six';
  const maxTotal = Math.max(
    ...bars.map((b) => b.total),
    quota === null ? 0 : monthly ? quota : quota / status.daysInMonth,
    1,
  );
  const max = maxTotal * 1.08;
  const fallbackSel = period === 'current' ? today(report).day - 1 : bars.length - 1;
  const selected = selBar !== null && bars[selBar] && !bars[selBar].future ? selBar : fallbackSel;
  const range = labels.ranges[period];
  const month = labels.month;

  const refLine =
    quota === null
      ? undefined
      : monthly
        ? { value: quota, label: t('usage.quotaLine', { quota: short(f, t, quota) }) }
        : period === 'current'
          ? {
              value: quota / status.daysInMonth,
              label: t('usage.averageLine', { value: short(f, t, quota / status.daysInMonth) }),
            }
          : undefined;
  const barMonth = labels.monthShort(period !== 'previous');
  const ticks = monthly
    ? bars.map((b) => b.label)
    : [
        t('usage.tickMonth', { day: '1', month: barMonth }),
        t('usage.tickDay', { day: '8' }),
        t('usage.tickDay', { day: '15' }),
        t('usage.tickDay', { day: '22' }),
        t('usage.tickMonth', { day: String(bars.length), month: barMonth }),
      ];

  const totalsByCat = aggregate(bars);
  const used = status.perService;
  const rows = cats
    .map((c) => {
      const u: UsageTotals = totalsByCat[c.id] ?? {
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        costMicroNok: 0,
      };
      return { ...c, u, tok: tokensOf(u), cost: costOf(u) };
    })
    .sort((a, b) =>
      sort.key === 'name'
        ? a.label.localeCompare(b.label, f.locale) * sort.dir
        : (sort.key === 'tok' ? a.tok - b.tok : (a.cost ?? -1) - (b.cost ?? -1)) * sort.dir,
    );
  const sum = rows.reduce<{ tin: number; tout: number; runs: number; cost: number | null }>(
    (a, r) => ({
      tin: a.tin + r.u.inputTokens,
      tout: a.tout + r.u.outputTokens,
      runs: a.runs + (group === 'model' ? r.u.requests : runsOf(r.u)),
      cost: a.cost === null || r.cost === null ? null : a.cost + r.cost,
    }),
    { tin: 0, tout: 0, runs: 0, cost: 0 },
  );
  const usedOf = (id: string) => (used[id] ? tokensOf(used[id]) : 0);
  const ariaSort = (key: SortKey) =>
    sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none';
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '');
  const sortBy = (key: SortKey) =>
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1,
    }));

  const near = usageServices
    .filter((s) => {
      const l = limits[s.id];
      return l && usedOf(s.id) / l >= 0.8;
    })
    .sort((a, b) => usedOf(b.id) / (limits[b.id] ?? 1) - usedOf(a.id) / (limits[a.id] ?? 1))[0];

  const pct = quota === null ? 0 : Math.round((status.used / quota) * 100);
  const forecastPct = quota === null ? 0 : Math.round((status.forecast / quota) * 100);
  const costPerToken = (id: string) => {
    const u = used[id];
    const cost = u ? costOf(u) : null;
    return u && cost !== null && tokensOf(u) ? cost / tokensOf(u) : null;
  };
  const forecastCost =
    status.cost === null ? null : status.used ? (status.cost * status.forecast) / status.used : 0;

  const openLimit = (id: string) => {
    const l = limits[id];
    setLimMode(l ? 'on' : 'off');
    setLimVal(l ? decimalText(f, l / 1e6) : '2');
    setLimErr('');
    setDialog({ kind: 'limit', id });
  };
  const dlgSvc =
    dialog?.kind === 'limit' ? usageServices.find((s) => s.id === dialog.id) : undefined;
  const parsedLimit = () => {
    const v = parseFloat(limVal.replace(',', '.').replace(/\s/g, ''));
    return Number.isNaN(v) ? null : v;
  };
  const saveLimit = () => {
    if (!dlgSvc) return;
    if (limMode === 'off') {
      setLimits((l) => ({ ...l, [dlgSvc.id]: null }));
      setFlash(t('usage.limitRemoved', { name: dlgSvc.name }));
      setDialog(undefined);
      return;
    }
    const v = parsedLimit();
    if (v === null || v <= 0) {
      setLimErr(t('usage.limitNumberProblem'));
      return;
    }
    if (quota !== null && v > quota / 1e6) {
      setLimErr(t('usage.limitAboveQuota', { tenant: tenantName, millions: quota / 1e6 }));
      return;
    }
    setLimits((l) => ({ ...l, [dlgSvc.id]: v * 1e6 }));
    setFlash(t('usage.limitSet', { name: dlgSvc.name, value: decimalText(f, v) }));
    setDialog(undefined);
  };

  const doExport = () => {
    const records: Record<string, string | number>[] =
      level === 'sum'
        ? rows.map((r) => ({
            [t('usage.colPeriod')]: range,
            [t('usage.colName')]: r.label,
            [t('usage.colTokensIn')]: Math.round(r.u.inputTokens),
            [t('usage.colTokensOut')]: Math.round(r.u.outputTokens),
            [t('usage.colCost')]:
              r.cost === null ? t('usage.notPriced') : Number(r.cost.toFixed(2)),
          }))
        : bars.flatMap((b) =>
            cats
              .map((c) => ({ c, tokens: Math.round(tokensIn(b.values, c.id)) }))
              .filter((r) => r.tokens > 0)
              .map((r) => ({
                [t('usage.colPeriod')]: b.full,
                [t('usage.colName')]: r.c.label,
                [t('usage.colTokens')]: r.tokens,
              })),
          );
    const body =
      format === 'json'
        ? JSON.stringify(records, null, 2)
        : [
            Object.keys(records[0] ?? { [t('usage.colPeriod')]: '' }).join(';'),
            ...records.map((r) =>
              Object.values(r)
                .map((v) => (typeof v === 'number' ? decimalText(f, v) : `"${v}"`))
                .join(';'),
            ),
          ].join('\n');
    const file = t('usage.exportFile', { name: slug(tenantName), format });
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(
        new Blob([`\uFEFF${body}`], { type: format === 'json' ? 'application/json' : 'text/csv' }),
      );
      a.download = file;
      a.click();
    } catch {
      /* download is not available in every browser context */
    }
    setDialog(undefined);
    setFlash(t('usage.downloaded', { file }));
  };

  return (
    <div className="usage">
      {near ? (
        <Alert data-color="warning">
          <Heading level={2} data-size="2xs">
            {t('usage.nearTitle', {
              name: near.name,
              percent: percentText(f, usedOf(near.id) / (limits[near.id] ?? 1)),
            })}
          </Heading>
          <Paragraph>
            {t('usage.nearText', {
              limit: short(f, t, limits[near.id] ?? 0),
              month,
              used: short(f, t, usedOf(near.id)),
            })}
            {near.limitNote ? ` ${near.limitNote}` : ''}
          </Paragraph>
          <div className="actions">
            <Button data-size="sm" onClick={() => openLimit(near.id)}>
              {t('usage.changeLimit')}
            </Button>
            <Button asChild variant="secondary" data-size="sm">
              <a href="#/log">{t('usage.seeRunningJob')}</a>
            </Button>
          </div>
        </Alert>
      ) : null}
      <div aria-live="polite">
        {flash ? (
          <Alert data-color="success" data-size="sm">
            {flash}
          </Alert>
        ) : null}
      </div>

      <section aria-labelledby="kvote-h" className="usage-quota-grid">
        <div className="usage-quota" hidden={project !== undefined}>
          <div className="row-between">
            <h2 id="kvote-h" className="usage-h-small">
              {t('usage.quotaIn', { month })}
            </h2>
            <span className="meta">{t('usage.updated', { time: f.time(report.to) })}</span>
          </div>
          <div className="row-baseline">
            <span className="usage-big numeric">{short(f, t, status.used)}</span>
            <span className="usage-of">
              {quota === null
                ? t('usage.noQuota')
                : t('usage.ofQuota', {
                    quota: short(f, t, quota),
                    percent: percentText(f, pct / 100),
                  })}
            </span>
          </div>
          {quota === null ? null : (
            <>
              <div
                role="meter"
                aria-label={t('usage.meterLabel', { month })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={t('usage.meterText', {
                  used: short(f, t, status.used),
                  quota: short(f, t, quota),
                  forecast: short(f, t, status.forecast),
                })}
                className="usage-meter"
              >
                <div className="forecast" style={{ width: `${Math.min(100, forecastPct)}%` }} />
                <div
                  className="used"
                  style={{ width: `${Math.min(100, (status.used / quota) * 100)}%` }}
                />
              </div>
              <div className="usage-meter-legend">
                <span>
                  <span aria-hidden="true" className="key used" />
                  {t('usage.usedSoFar')}
                </span>
                <span>
                  <span aria-hidden="true" className="key forecast" />
                  {t('usage.forecast', {
                    value: short(f, t, status.forecast),
                    percent: percentText(f, forecastPct / 100),
                  })}
                </span>
              </div>
            </>
          )}
          <p className="usage-note">{t('usage.counted')}</p>
          <p className="usage-note">
            {t.rich('usage.quotaUsedUp', { link: (c) => <a href="#/contact">{c}</a> })}
          </p>
        </div>
        {[
          {
            l: t('usage.costIn', { month }),
            v: money(f, t, status.cost),
            sub:
              forecastCost === null
                ? t('usage.someUnpriced')
                : t('usage.forecastCost', { value: money(f, t, forecastCost) }),
          },
          {
            l: t('usage.runsIn', { month }),
            v: nb(f, status.runs),
            sub: t('usage.runsSub'),
          },
          {
            l: t('usage.inNorway'),
            v:
              status.norwayShare === null
                ? t('usage.unavailable')
                : percentText(f, status.norwayShare),
            sub: t('usage.inNorwaySub'),
          },
        ].map((k) => (
          <div key={k.l} className="usage-kpi">
            <span className="meta">{k.l}</span>
            <span className="usage-kpi-value numeric">{k.v}</span>
            <span className="meta">{k.sub}</span>
          </div>
        ))}
      </section>

      <section aria-labelledby="graf-h" className="stack-md">
        <div className="usage-chart-head">
          <Heading level={2} data-size="sm" id="graf-h">
            {t('usage.overTime')}
          </Heading>
          <div className="usage-controls">
            <Field className="usage-period">
              <Label htmlFor={ids.period}>{t('usage.period')}</Label>
              <Select
                id={ids.period}
                value={period}
                onChange={(e) => {
                  setPeriod(e.target.value as Period);
                  setSelBar(null);
                }}
              >
                <option value="current">{labels.options.current}</option>
                <option value="previous">{labels.options.previous}</option>
                <option value="six">{labels.options.six}</option>
              </Select>
            </Field>
            <Fieldset>
              <Fieldset.Legend>{t('usage.groupBy')}</Fieldset.Legend>
              <div className="tag-row">
                {(
                  [
                    ['service', t('usage.service')],
                    ['model', t('usage.model')],
                  ] as const
                ).map(([id, label]) => (
                  <Chip.Radio
                    key={id}
                    name="fordeling"
                    checked={group === id}
                    onChange={() => {
                      setGroup(id);
                      setSort({ key: 'tok', dir: -1 });
                    }}
                  >
                    {label}
                  </Chip.Radio>
                ))}
              </div>
            </Fieldset>
          </div>
        </div>
        <UsageChart
          bars={bars}
          cats={cats}
          selected={selected}
          onSelect={setSelBar}
          max={max}
          {...(refLine ? { refLine } : {})}
          label={t(monthly ? 'usage.chartMonthly' : 'usage.chartDaily', { range })}
          ticks={ticks}
          monthly={monthly}
        />
      </section>

      <section aria-labelledby="tabell-h" className="stack-sm">
        <div className="row-between">
          <Heading level={2} data-size="sm" id="tabell-h">
            {group === 'model' ? t('usage.byModel') : t('usage.byService')}
          </Heading>
          <span className="meta">{range}</span>
        </div>
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="tabell-h">
          <Table border className="usage-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col" sort={ariaSort('name')} onClick={() => sortBy('name')}>
                  {group === 'model' ? t('usage.model') : t('usage.service')}
                  <span aria-hidden="true">{arrow('name')}</span>
                </TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {t('usage.tokensIn')}
                </TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {t('usage.tokensOut')}
                </TableHeaderCell>
                <TableHeaderCell
                  scope="col"
                  className="num"
                  sort={ariaSort('tok')}
                  onClick={() => sortBy('tok')}
                >
                  {t('usage.total')}
                  <span aria-hidden="true">{arrow('tok')}</span>
                </TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {group === 'model' ? t('usage.modelCalls') : t('usage.runs')}
                </TableHeaderCell>
                <TableHeaderCell
                  scope="col"
                  className="num"
                  sort={ariaSort('cost')}
                  onClick={() => sortBy('cost')}
                >
                  {t('usage.estimatedCost')}
                  <span aria-hidden="true">{arrow('cost')}</span>
                </TableHeaderCell>
                <TableHeaderCell scope="col">
                  {group === 'model' ? t('usage.processedIn') : t('usage.limitIn', { month })}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const lim = limits[r.id] ?? null;
                const known = !live && usageServices.some((s) => s.id === r.id);
                const p = lim ? usedOf(r.id) / lim : 0;
                return (
                  <TableRow key={r.id}>
                    <TableHeaderCell scope="row" className="usage-name">
                      <span className="row-name">
                        <span
                          aria-hidden="true"
                          className="swatch"
                          style={{ background: r.color }}
                        />
                        <span className="col">
                          <span>{r.label}</span>
                          {r.sub ? <span className="meta-xs">{r.sub}</span> : null}
                        </span>
                      </span>
                    </TableHeaderCell>
                    <TableCell className="num">{nb(f, r.u.inputTokens)}</TableCell>
                    <TableCell className="num">{nb(f, r.u.outputTokens)}</TableCell>
                    <TableCell className="num strong">{nb(f, r.tok)}</TableCell>
                    <TableCell className="num">
                      {nb(f, group === 'model' ? r.u.requests : runsOf(r.u))}
                    </TableCell>
                    <TableCell className="num">{money(f, t, r.cost)}</TableCell>
                    <TableCell>
                      {group === 'model' ? (
                        <Tag data-size="sm" data-color={r.norway ? 'success' : 'info'}>
                          {r.location}
                        </Tag>
                      ) : (
                        <span className="usage-limit">
                          <span className="row-wrap small">
                            <span>
                              {lim
                                ? t('usage.limitUsed', {
                                    used: short(f, t, usedOf(r.id)),
                                    limit: short(f, t, lim),
                                    percent: percentText(f, p),
                                  })
                                : live
                                  ? t('usage.limitNotYet')
                                  : t('usage.limitNone')}
                            </span>
                            {p >= 0.8 ? (
                              <Tag data-size="sm" data-color="warning">
                                {t('usage.nearLimit')}
                              </Tag>
                            ) : null}
                          </span>
                          {lim ? (
                            <span aria-hidden="true" className="limit-bar">
                              <span
                                style={{
                                  width: `${Math.min(100, p * 100)}%`,
                                  background:
                                    p >= 0.8
                                      ? 'var(--ds-color-warning-base-default)'
                                      : 'var(--ds-color-accent-base-default)',
                                }}
                              />
                            </span>
                          ) : null}
                          {known ? (
                            <button
                              type="button"
                              className="link-button"
                              aria-label={t(lim ? 'usage.changeLimitFor' : 'usage.setLimitFor', {
                                name: r.label,
                              })}
                              onClick={() => openLimit(r.id)}
                            >
                              {t(lim ? 'usage.changeLimitShort' : 'usage.setLimitShort')}
                            </button>
                          ) : null}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFoot>
              <TableRow>
                <TableHeaderCell scope="row">{t('usage.sum')}</TableHeaderCell>
                <TableCell className="num">{nb(f, sum.tin)}</TableCell>
                <TableCell className="num">{nb(f, sum.tout)}</TableCell>
                <TableCell className="num">{nb(f, sum.tin + sum.tout)}</TableCell>
                <TableCell className="num">{nb(f, sum.runs)}</TableCell>
                <TableCell className="num">{money(f, t, sum.cost)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFoot>
          </Table>
        </div>
        <p className="meta">{t('usage.costNote')}</p>
      </section>

      {project === undefined && report.byProject?.length ? (
        <section aria-labelledby="prosjekt-h" className="stack-sm">
          <div className="row-between">
            <Heading level={2} data-size="sm" id="prosjekt-h">
              {t('usage.byProject')}
            </Heading>
            <span className="meta">{t('usage.from', { date: f.date(report.from) })}</span>
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-labelledby="prosjekt-h">
            <Table border className="usage-table">
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('usage.project')}</TableHeaderCell>
                  <TableHeaderCell scope="col" className="num">
                    {t('usage.tokensIn')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col" className="num">
                    {t('usage.tokensOut')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col" className="num">
                    {t('usage.total')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col" className="num">
                    {t('usage.runs')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col" className="num">
                    {t('usage.estimatedCost')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col">
                    <span className="visually-hidden">{t('usage.action')}</span>
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {report.byProject.map((p) => (
                  <TableRow key={p.project}>
                    <TableHeaderCell scope="row">{p.name}</TableHeaderCell>
                    <TableCell className="num">{nb(f, p.usage.inputTokens)}</TableCell>
                    <TableCell className="num">{nb(f, p.usage.outputTokens)}</TableCell>
                    <TableCell className="num strong">{nb(f, tokensOf(p.usage))}</TableCell>
                    <TableCell className="num">{nb(f, runsOf(p.usage))}</TableCell>
                    <TableCell className="num">{money(f, t, costOf(p.usage))}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={t('usage.showOnly', { name: p.name })}
                        onClick={() => onProject(p.project)}
                      >
                        {t('usage.showOnlyThis')}
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="meta">{t('usage.projectNote')}</p>
        </section>
      ) : null}

      <Dialog
        open={dialog !== undefined}
        onClose={() => setDialog(undefined)}
        closeButton={false}
        aria-labelledby={dialog ? 'dlg-h' : undefined}
        className="usage-dialog"
      >
        {dialog?.kind === 'export' ? (
          <div className="stack-md">
            <Heading level={2} data-size="xs" id="dlg-h">
              {t('usage.exportTitle')}
            </Heading>
            <Paragraph>
              {t(group === 'model' ? 'usage.exportScopeModel' : 'usage.exportScopeService', {
                range: f.locale === 'en' ? range : range.toLowerCase(),
              })}
            </Paragraph>
            <Fieldset>
              <Fieldset.Legend>{t('usage.format')}</Fieldset.Legend>
              <Radio
                name="format"
                label={t('usage.formatCsv')}
                description={t('usage.formatCsvHelp')}
                checked={format === 'csv'}
                onChange={() => setFormat('csv')}
              />
              <Radio
                name="format"
                label="JSON"
                description={t('usage.formatJsonHelp')}
                checked={format === 'json'}
                onChange={() => setFormat('json')}
              />
            </Fieldset>
            <Fieldset>
              <Fieldset.Legend>{t('usage.detail')}</Fieldset.Legend>
              <Radio
                name="niva"
                label={t(monthly ? 'usage.rowPerMonth' : 'usage.rowPerDay')}
                checked={level === 'rows'}
                onChange={() => setLevel('rows')}
              />
              <Radio
                name="niva"
                label={t('usage.sumsOnly')}
                checked={level === 'sum'}
                onChange={() => setLevel('sum')}
              />
            </Fieldset>
            <div className="actions">
              <Button onClick={doExport}>{t('usage.download')}</Button>
              <Button variant="secondary" onClick={() => setDialog(undefined)}>
                {t('usage.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
        {dlgSvc ? (
          <div className="stack-md">
            <Heading level={2} data-size="xs" id="dlg-h">
              {t('usage.limitFor', { name: dlgSvc.name })}
            </Heading>
            <Paragraph>
              {t('usage.limitExplain', { month, used: short(f, t, usedOf(dlgSvc.id)) })}
            </Paragraph>
            <Fieldset>
              <Fieldset.Legend>{t('usage.limitPerMonth')}</Fieldset.Legend>
              <Radio
                name="grensemodus"
                label={t('usage.setLimit')}
                checked={limMode === 'on'}
                onChange={() => {
                  setLimMode('on');
                  setLimErr('');
                }}
              />
              <Radio
                name="grensemodus"
                label={t('usage.noOwnLimit')}
                checked={limMode === 'off'}
                onChange={() => {
                  setLimMode('off');
                  setLimErr('');
                }}
              />
            </Fieldset>
            {limMode === 'on' ? (
              <Field className="usage-limit-field">
                <Label htmlFor={ids.limit}>{t('usage.millionsPerMonth')}</Label>
                <Input
                  id={ids.limit}
                  inputMode="decimal"
                  value={limVal}
                  aria-invalid={limErr ? true : undefined}
                  aria-describedby={ids.limitHelp}
                  onChange={(e) => {
                    setLimVal(e.target.value);
                    setLimErr('');
                  }}
                />
                <p id={ids.limitHelp} className="meta">
                  {(() => {
                    const perToken = costPerToken(dlgSvc.id);
                    return perToken === null
                      ? t('usage.cannotEstimate')
                      : t('usage.aboutPerMonth', {
                          value: money(f, t, perToken * (parsedLimit() ?? 0) * 1e6),
                        });
                  })()}
                </p>
                {limErr ? <ValidationMessage>{limErr}</ValidationMessage> : null}
              </Field>
            ) : null}
            <div className="actions">
              <Button onClick={saveLimit}>{t('usage.save')}</Button>
              <Button variant="secondary" onClick={() => setDialog(undefined)}>
                {t('usage.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
};

export const Usage = ({ api, tenant, tenantName, live }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const ids = { project: useId() };
  const [project, setProject] = useState<string>();
  const [projects, setProjects] = useState<{ project: string; name: string }[]>([]);
  const [usage, retry] = useAsync(
    async (signal) => {
      const report = withPricing(await api.usage(tenant, 190, signal, project));
      if (project === undefined) setProjects(report.byProject ?? []);
      return report;
    },
    [api, tenant, project],
  );
  const projectName = projects.find((p) => p.project === project)?.name ?? project;
  const [settings] = useAsync(
    (signal) => api.tenantEffectiveSettings(tenant, signal),
    [api, tenant],
  );
  const [models] = useAsync((signal) => api.listModels({}, signal), [api]);
  const [dialog, setDialog] = useState<DialogState>();
  const state =
    usage.status === 'ready' && (settings.status === 'loading' || models.status === 'loading')
      ? ({ status: 'loading' } as const)
      : usage;
  const quota = settings.status === 'ready' ? quotaOf(settings.data) : null;
  const hasData = state.status === 'ready' && !isEmptyReport(state.data);
  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <Heading level={1} data-size="lg">
            {t('usage.title')}
          </Heading>
          <p className="lead">{t('usage.lead', { tenant: tenantName })}</p>
        </div>
        {hasData ? (
          <Button variant="secondary" onClick={() => setDialog({ kind: 'export' })}>
            <Icon d={DOWNLOAD} />
            {t('usage.export')}
          </Button>
        ) : null}
      </div>
      {projects.length ? (
        <div className="stack-sm">
          <Field className="usage-period">
            <Label htmlFor={ids.project}>{t('usage.project')}</Label>
            <Select
              id={ids.project}
              value={project ?? ''}
              onChange={(e) => setProject(e.target.value || undefined)}
            >
              <option value="">{t('usage.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {project !== undefined ? (
            <Alert data-color="info" data-size="sm">
              {t('usage.projectScope', { project: projectName ?? '', tenant: tenantName })}
            </Alert>
          ) : null}
        </div>
      ) : null}
      {state.status === 'loading' ? (
        <div role="status" className="usage-skeletons">
          <span className="visually-hidden">{t('usage.loading')}</span>
          <div className="grid-3" aria-hidden="true">
            <Skeleton variant="rectangle" height={110} />
            <Skeleton variant="rectangle" height={110} />
            <Skeleton variant="rectangle" height={110} />
          </div>
          <Skeleton variant="rectangle" height={280} aria-hidden="true" />
        </div>
      ) : null}
      {state.status === 'error' && (refusalOf(state.error) || limitOf(state.error)) ? (
        <ErrorState error={state.error} />
      ) : null}
      {state.status === 'error' && !refusalOf(state.error) && !limitOf(state.error) ? (
        <>
          <Alert data-color="danger">
            <Heading level={2} data-size="2xs">
              {t('usage.errorTitle')}
            </Heading>
            <Paragraph>{t('usage.errorText')}</Paragraph>
            <Button variant="secondary" data-size="sm" onClick={retry}>
              {t('usage.retry')}
            </Button>
          </Alert>
          <div className="grid-3" aria-hidden="true">
            <Skeleton variant="rectangle" height={110} />
            <Skeleton variant="rectangle" height={110} />
            <Skeleton variant="rectangle" height={110} />
          </div>
          <Skeleton variant="rectangle" height={280} aria-hidden="true" />
        </>
      ) : null}
      {state.status === 'ready' && !hasData && project !== undefined ? (
        <div className="usage-empty">
          <Heading level={2} data-size="xs">
            {t('usage.emptyProjectTitle')}
          </Heading>
          <p className="usage-empty-text">{t('usage.emptyProjectText')}</p>
        </div>
      ) : null}
      {state.status === 'ready' && !hasData && project === undefined ? (
        <div className="usage-empty">
          <Heading level={2} data-size="xs">
            {t('usage.emptyTitle')}
          </Heading>
          <p className="usage-empty-text">
            {t('usage.emptyText')}{' '}
            {quota === null
              ? t('usage.quotaUnknown')
              : t('usage.quotaIs', { tenant: tenantName, millions: nb(f, quota / 1e6) })}
          </p>
          <Button asChild>
            <a href="#/services/new">{t('usage.createService')}</a>
          </Button>
        </div>
      ) : null}
      {state.status === 'ready' && hasData ? (
        <UsageView
          report={state.data}
          tenantName={tenantName}
          live={live}
          dialog={dialog}
          setDialog={setDialog}
          quota={quota}
          models={models.status === 'ready' ? models.data : null}
          project={project}
          onProject={setProject}
        />
      ) : null}
    </>
  );
};
