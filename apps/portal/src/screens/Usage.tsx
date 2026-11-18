import { DownloadIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  Field,
  Fieldset,
  Heading,
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
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { navigate, useAsync } from '../hooks';
import { useT } from '../i18n';
import { needsRight, useRights } from '../Shell';
import { ErrorState, limitOf, refusalOf } from '../states';
import type { ScreenProps } from '../screen';
import type { ModelOption, UsageReport, UsageTotals } from '../types';
import { zeroUsage } from '../data/usage';
import { modelLabel } from '../models';
import {
  add,
  aggregate,
  categories,
  costText,
  decimalText,
  isLowerBound,
  knownCostOf,
  money,
  monthStatus,
  monthUsage,
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
  withTrialRows,
  type Group,
  type Period,
} from './usage/model';
import { quotaFacts } from './quota/model';
import { QuotaRequestAction } from './quota/QuotaRequest';
import { UsageChart } from './usage/UsageChart';
import { UsageSources } from './usage/UsageSources';
import './usage.css';

type SortKey = 'name' | 'tok' | 'cost';
type DialogState = { kind: 'export' } | undefined;
type Sort = { key: SortKey; dir: 1 | -1 };

const periods: readonly Period[] = ['current', 'previous', 'six'];
const groups: readonly Group[] = ['service', 'model'];

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
  quota,
  models,
  scoped,
  onProject,
  period,
  group,
  onView,
  sort,
  setSort,
  quotaAction,
}: {
  quotaAction?: ((forecast: number) => ReactNode) | undefined;
  scoped: boolean;
  onProject: (id: string) => void;
  report: UsageReport;
  tenantName: string;
  quota: number | null;
  period: Period;
  group: Group;
  onView: (view: { period?: Period; group?: Group }) => void;
  sort: Sort;
  setSort: (update: (s: Sort) => Sort) => void;
  models: ModelOption[] | null;
  dialog: DialogState;
  setDialog: (d: DialogState) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const ids = { period: useId() };
  const [selBar, setSelBar] = useState<number | null>(null);
  const [flash, setFlash] = useState('');
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [level, setLevel] = useState<'rows' | 'sum'>('rows');

  const labels = periodLabels(report, f, t);
  const missing = report.totals.unpricedModels ?? [];
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
  const rows = cats
    .map((c) => {
      const u: UsageTotals = totalsByCat[c.id] ?? {
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        costMicroNok: 0,
      };
      return {
        ...c,
        u,
        tok: tokensOf(u),
        cost: knownCostOf(u),
        costAtLeast: isLowerBound(u),
      };
    })
    .sort((a, b) =>
      a.extra !== b.extra
        ? a.extra
          ? 1
          : -1
        : sort.key === 'name'
          ? a.label.localeCompare(b.label, f.locale) * sort.dir
          : (sort.key === 'tok' ? a.tok - b.tok : (a.cost ?? -1) - (b.cost ?? -1)) * sort.dir,
    );
  const sumUsage = rows.reduce((a, r) => add(a, r.u), zeroUsage());
  const sum = {
    tin: sumUsage.inputTokens,
    tout: sumUsage.outputTokens,
    runs: rows.reduce((n, r) => n + (group === 'model' ? r.u.requests : runsOf(r.u)), 0),
    cost: knownCostOf(sumUsage),
    costAtLeast: isLowerBound(sumUsage),
  };
  const ariaSort = (key: SortKey) =>
    sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none';
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : '');
  const sortBy = (key: SortKey) =>
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1,
    }));

  const pct = quota === null ? 0 : Math.round((status.used / quota) * 100);
  const forecastPct = quota === null ? 0 : Math.round((status.forecast / quota) * 100);
  const forecastCost =
    status.cost === null ? null : status.used ? (status.cost * status.forecast) / status.used : 0;

  const doExport = () => {
    const records: Record<string, string | number | boolean>[] =
      level === 'sum'
        ? rows.map((r) => ({
            [t('usage.colPeriod')]: range,
            [t('usage.colName')]: r.label,
            [t('usage.colTokensIn')]: Math.round(r.u.inputTokens),
            [t('usage.colTokensOut')]: Math.round(r.u.outputTokens),
            [t('usage.colCost')]:
              r.cost === null ? t('usage.notPriced') : Number(r.cost.toFixed(2)),
            [t('usage.colCostAtLeast')]: r.costAtLeast,
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
                .map((v) =>
                  typeof v === 'number'
                    ? decimalText(f, v)
                    : typeof v === 'boolean'
                      ? String(v)
                      : `"${v.replace(/"/g, '""')}"`,
                )
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
      <div aria-live="polite">
        {flash ? (
          <Alert data-color="success" data-size="sm">
            {flash}
          </Alert>
        ) : null}
      </div>

      {status.costAtLeast ? (
        <Alert data-color="info" data-size="sm" role="status">
          {missing.length > 0
            ? t('usage.priceMissing', {
                count: missing.length,
                models: f.list(missing.map((id) => modelLabel(id, models ?? []))),
              })
            : t('usage.priceMissingUnnamed')}
        </Alert>
      ) : null}

      <section aria-labelledby="kvote-h" className="usage-quota-grid">
        <div className="usage-quota" hidden={scoped}>
          <div className="row-between">
            <h2 id="kvote-h" className="usage-h-small">
              {t('usage.quotaIn', { month })}
            </h2>
            <span className="meta">{t('usage.updated', { time: f.time(report.to) })}</span>
          </div>
          {quotaAction ? (
            <div className="usage-quota-action">{quotaAction(status.forecast)}</div>
          ) : null}
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
        </div>
        {[
          {
            l: t('usage.costIn', { month }),
            v: money(f, t, status.cost, status.costAtLeast),
            sub:
              forecastCost === null
                ? t('usage.someUnpriced')
                : t('usage.forecastCost', {
                    value: money(f, t, forecastCost, status.costAtLeast),
                  }),
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
                  onView({ period: e.target.value as Period });
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
                      onView({ group: id });
                      setSort(() => ({ key: 'tok', dir: -1 }));
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
                <TableHeaderCell scope="col" className="num">
                  {t('usage.share')}
                </TableHeaderCell>
                {group === 'model' ? (
                  <>
                    <TableHeaderCell scope="col">{t('usage.pricePerThousand')}</TableHeaderCell>
                    <TableHeaderCell scope="col">{t('usage.processedIn')}</TableHeaderCell>
                  </>
                ) : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableHeaderCell scope="row" className="usage-name">
                    <span className="row-name">
                      <span aria-hidden="true" className="swatch" style={{ background: r.color }} />
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
                  <TableCell className="num">{money(f, t, r.cost, r.costAtLeast)}</TableCell>
                  <TableCell className="num">
                    {percentText(f, sum.tin + sum.tout ? r.tok / (sum.tin + sum.tout) : 0)}
                  </TableCell>
                  {group === 'model' ? (
                    <TableCell className="small">
                      {r.price === undefined
                        ? t('usage.priceUnknown')
                        : r.price === null
                          ? t('usage.notPriced')
                          : t('usage.modelPrice', {
                              input: f.number(r.price.inputPerThousand, {
                                maximumFractionDigits: 4,
                              }),
                              output: f.number(r.price.outputPerThousand, {
                                maximumFractionDigits: 4,
                              }),
                            })}
                    </TableCell>
                  ) : null}
                  {group === 'model' ? (
                    <TableCell>
                      <Tag data-size="sm" data-color={r.norway ? 'success' : 'info'}>
                        {r.location}
                      </Tag>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
            <TableFoot>
              <TableRow>
                <TableHeaderCell scope="row">{t('usage.sum')}</TableHeaderCell>
                <TableCell className="num">{nb(f, sum.tin)}</TableCell>
                <TableCell className="num">{nb(f, sum.tout)}</TableCell>
                <TableCell className="num">{nb(f, sum.tin + sum.tout)}</TableCell>
                <TableCell className="num">{nb(f, sum.runs)}</TableCell>
                <TableCell className="num">{money(f, t, sum.cost, sum.costAtLeast)}</TableCell>
                <TableCell className="num">{percentText(f, 1)}</TableCell>
                {group === 'model' ? (
                  <>
                    <TableCell />
                    <TableCell />
                  </>
                ) : null}
              </TableRow>
            </TableFoot>
          </Table>
        </div>
        <p className="meta">{t('usage.costNote')}</p>
      </section>

      {!scoped ? <UsageSources report={report} /> : null}

      {!scoped && report.byProject?.length ? (
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
                    <TableCell className="num">{costText(f, t, p.usage)}</TableCell>
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
      </Dialog>
    </div>
  );
};

export const Usage = ({ api, tenant, tenantName, route }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const rights = useRights();
  const ids = { project: useId(), environment: useId() };
  const period = periods.find((p) => p === route.query.get('period')) ?? 'current';
  const group = groups.find((g) => g === route.query.get('by')) ?? 'service';
  const [sort, setSort] = useState<Sort>({ key: 'tok', dir: -1 });
  const onView = (view: { period?: Period; group?: Group }) => {
    const query = new URLSearchParams(route.query);
    const nextPeriod = view.period ?? period;
    const nextGroup = view.group ?? group;
    if (nextPeriod === 'current') query.delete('period');
    else query.set('period', nextPeriod);
    if (nextGroup === 'service') query.delete('by');
    else query.set('by', nextGroup);
    const search = query.toString();
    navigate(`/statistics${search ? `?${search}` : ''}`);
  };
  const [project, setProject] = useState<string>();
  const [environment, setEnvironment] = useState<string>();
  const [projects, setProjects] = useState<{ project: string; name: string }[]>([]);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [usage, retry] = useAsync(
    async (signal) => {
      const report = withTrialRows(
        withPricing(await api.usage(tenant, 190, signal, project, environment)),
      );
      if (project === undefined && environment === undefined) setProjects(report.byProject ?? []);
      if (environment === undefined)
        setEnvironments((report.byEnvironment ?? []).map((e) => e.environment));
      return report;
    },
    [api, tenant, project, environment],
    { keepPreviousFor: tenant },
  );
  const scoped = project !== undefined || environment !== undefined;
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
  const settingsQuota = settings.status === 'ready' ? quotaOf(settings.data) : null;
  const report = state.status === 'ready' ? state.data : undefined;
  const quota = report?.quota?.monthlyTokens ?? settingsQuota;
  const facts = report
    ? quotaFacts(report, settingsQuota, tokensOf(monthUsage(report).total))
    : undefined;
  const quotaAction =
    facts?.alert && report
      ? (forecast: number) => (
          <QuotaRequestAction
            api={api}
            tenant={tenant}
            facts={facts}
            forecast={forecast}
            month={periodLabels(report, f, t).month}
            canRequest={rights.has('manage-services')}
          />
        )
      : undefined;
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
            <Icon icon={DownloadIcon} />
            {t('usage.export')}
          </Button>
        ) : null}
      </div>
      {environments.length > 1 || environment !== undefined ? (
        <div className="stack-sm">
          <Field className="usage-period">
            <Label htmlFor={ids.environment}>{t('usage.environment')}</Label>
            <Select
              id={ids.environment}
              value={environment ?? ''}
              onChange={(e) => setEnvironment(e.target.value || undefined)}
            >
              <option value="">{t('usage.allEnvironments')}</option>
              {environments.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          {environment !== undefined ? (
            <Alert data-color="info" data-size="sm">
              {t('usage.environmentScope', { environment, tenant: tenantName })}
            </Alert>
          ) : null}
        </div>
      ) : null}
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
      {state.status === 'ready' && !hasData && environment !== undefined ? (
        <div className="usage-empty">
          <Heading level={2} data-size="xs">
            {t('usage.emptyEnvironmentTitle')}
          </Heading>
          <p className="usage-empty-text">{t('usage.emptyEnvironmentText')}</p>
        </div>
      ) : null}
      {state.status === 'ready' &&
      !hasData &&
      environment === undefined &&
      project !== undefined ? (
        <div className="usage-empty">
          <Heading level={2} data-size="xs">
            {t('usage.emptyProjectTitle')}
          </Heading>
          <p className="usage-empty-text">{t('usage.emptyProjectText')}</p>
        </div>
      ) : null}
      {state.status === 'ready' && !hasData && !scoped ? (
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
          {rights.has('manage-services') ? (
            <Button asChild>
              <a href="#/services/new">{t('usage.createService')}</a>
            </Button>
          ) : (
            <p className="meta">{needsRight('manage-services', t)}</p>
          )}
        </div>
      ) : null}
      {state.status === 'ready' && hasData ? (
        <UsageView
          report={state.data}
          tenantName={tenantName}
          period={period}
          group={group}
          onView={onView}
          sort={sort}
          setSort={setSort}
          dialog={dialog}
          setDialog={setDialog}
          quota={quota}
          models={models.status === 'ready' ? models.data : null}
          scoped={scoped}
          onProject={setProject}
          quotaAction={quotaAction}
        />
      ) : null}
    </>
  );
};
