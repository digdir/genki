import {
  Alert,
  Button,
  Fieldset,
  Heading,
  Link,
  Radio,
  Spinner,
  Switch,
  Tabs,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiCallLink } from '../../components/ApiCall';
import { datasetRunCall } from '../../data/api-calls';
import { Icon } from '../../components/Icon';
import { PlaygroundPanel } from '../../components/playground/PlaygroundPanel';
import {
  runColors,
  runKeys,
  statusColors,
  statusKeys,
  type DatasetDetails,
  type Facet,
  type IngestionRun,
} from '../../data/datasets';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { sourceOf } from './DatasetList';
import { count } from './model';
import { SearchEngine } from './SearchEngine';
import './search-engine.css';

const back = 'M15 6l-6 6 6 6';
const chevron = 'M6 9l6 6 6-6';
const play = 'M7 5l12 7-12 7z';

export type DetailTab = 'ingestions' | 'filters' | 'source';

interface Props {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  dataset: DatasetDetails;
  initialTab: DetailTab;
  initialRun?: string;
  flash: string;
  onRun: () => void;
  onStop: (runId: string) => void;
  onUpdate: (dataset: DatasetDetails) => void;
  onFlash: (text: string) => void;
}

const RunItem = ({
  run,
  open,
  onToggle,
  canRetry,
  onRetry,
  onStop,
}: {
  run: IngestionRun;
  open: boolean;
  onToggle: () => void;
  canRetry: boolean;
  onRetry: () => void;
  onStop: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [confirming, setConfirming] = useState(false);
  const running = run.status === 'Pågår';
  const errors = run.errors.length;
  const fatal = run.status === 'Feilet';
  const pct = run.progress ?? 0;
  return (
    <li id={`run-${run.id}`} className={open ? 'run open' : 'run'}>
      <button type="button" className="run-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="run-when">
          <strong>{run.when}</strong>
          <span className="meta">{run.how}</span>
        </span>
        <Tag data-size="sm" data-color={runColors[run.status]}>
          {running ? <Spinner aria-hidden="true" data-size="2xs" /> : null}
          {t(runKeys[run.status])}
        </Tag>
        <span className="run-counts numeric">
          <span>{t('datasets.addedShort', { amount: count(f, run.added) })}</span>
          <span>{t('datasets.changedShort', { amount: count(f, run.changed) })}</span>
          <span>{t('datasets.removedShort', { amount: count(f, run.removed) })}</span>
          <span className={errors ? 'strong' : undefined}>
            {errors ? t('datasets.errorCount', { count: errors }) : t('datasets.noErrors')}
          </span>
        </span>
        <span className={open ? 'chevron up' : 'chevron'}>
          <Icon d={chevron} size={18} />
        </span>
      </button>
      {running ? (
        <div className="run-progress">
          <div
            role="progressbar"
            aria-label={t('datasets.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={t('datasets.percent', { percent: pct })}
            className="bar"
          >
            <div style={{ width: `${pct}%` }} />
          </div>
          <span className="meta">
            {t('datasets.processed', {
              done: count(f, ((run.total ?? 0) * pct) / 100),
              total: count(f, run.total ?? 0),
            })}
          </span>
          {confirming ? (
            <Alert data-color="warning" data-size="sm">
              <p className="alert-text">{t('datasets.stopQuestion')}</p>
              <div className="actions">
                <Button variant="primary" data-size="sm" onClick={onStop}>
                  {t('datasets.stopYes')}
                </Button>
                <Button variant="secondary" data-size="sm" onClick={() => setConfirming(false)}>
                  {t('datasets.stopNo')}
                </Button>
              </div>
            </Alert>
          ) : (
            <Button
              variant="secondary"
              data-size="sm"
              className="align-start"
              onClick={() => setConfirming(true)}
            >
              {t('datasets.stop')}
            </Button>
          )}
        </div>
      ) : null}
      {open && !running ? (
        <div className="run-body">
          <dl className="run-facts">
            {[
              [t('datasets.factNew'), count(f, run.added)],
              [t('datasets.factChanged'), count(f, run.changed)],
              [t('datasets.factRemoved'), count(f, run.removed)],
              [t('datasets.factErrors'), String(errors)],
            ].map(([l, v]) => (
              <div key={l}>
                <dt>{l}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {run.duration ? (
            <span className="meta">{t('datasets.duration', { value: run.duration })}</span>
          ) : null}
          {errors === 0 ? <p className="no-errors">{t('datasets.noErrorsDot')}</p> : null}
          {run.errors.map((e) => (
            <div key={e.item + e.code} className={fatal ? 'run-error fatal' : 'run-error'}>
              <div className="tag-row">
                <Tag data-size="sm" data-color={fatal ? 'danger' : 'warning'}>
                  {fatal ? t('datasets.stoppedIngestion') : t('datasets.skipped')}
                </Tag>
                <strong>{e.what}</strong>
              </div>
              <span className="meta wrap">{e.item}</span>
              <p className="why">{e.why}</p>
              <div className="actions">
                {canRetry ? (
                  <Button variant="secondary" data-size="sm" onClick={onRetry}>
                    {e.fix ?? t('common.tryAgain')}
                  </Button>
                ) : null}
                <span className="code">{t('datasets.technicalCode', { code: e.code })}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
};

const FacetCard = ({
  facet,
  locked,
  onToggle,
}: {
  facet: Facet;
  locked: boolean;
  onToggle: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const max = Math.max(...facet.values.map((v) => v[1]), 1);
  return (
    <section className="facet-card" aria-label={facet.name}>
      <span className="stack-xs">
        <h3 className="facet-name">{facet.name}</h3>
        <span className="meta small-meta">
          {t('datasets.facetMeta', {
            field: facet.field,
            count: facet.values.length + facet.moreValues,
          })}
        </span>
      </span>
      <ul aria-label={t('datasets.valuesFor', { name: facet.name })} className="facet-values">
        {facet.values.map(([label, n]) => (
          <li key={label}>
            <span>{label}</span>
            <span className="numeric right">{count(f, n)}</span>
            <span aria-hidden="true" className="facet-bar">
              <span style={{ width: `${Math.round((n / max) * 100)}%` }} />
            </span>
          </li>
        ))}
      </ul>
      {facet.moreValues ? (
        <span className="meta">
          {t('datasets.facetMore', {
            count: facet.moreValues,
            docs: count(f, facet.moreDocs ?? 0),
          })}
        </span>
      ) : null}
      <div className="facet-switch">
        <Switch
          label={t('datasets.usableAsFilter')}
          checked={facet.enabled}
          aria-disabled={locked || undefined}
          onChange={() => {
            if (!locked) onToggle();
          }}
        />
      </div>
    </section>
  );
};

export const DatasetDetail = ({
  api,
  tenant,
  tenantName,
  dataset: d,
  initialTab,
  initialRun,
  flash,
  onRun,
  onStop,
  onUpdate,
  onFlash,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [openRun, setOpenRun] = useState<string | undefined>(initialRun);
  const [trying, setTrying] = useState(false);
  const rights = useRights();
  const [liveFacets, setLiveFacets] = useState<Record<string, [string, number][]>>({});
  const ocrSetting = d.settings.find(([k]) => k === 'Tekstgjenkjenning');
  const [settings, setSettings] = useState({
    ocr: ocrSetting ? ocrSetting[1] === 'På' : true,
    pii: true,
    share: 'egen' as 'egen' | 'alle',
  });
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => setOpenRun(initialRun), [initialRun]);
  useEffect(() => {
    if (ocrSetting) setSettings((s) => ({ ...s, ocr: ocrSetting[1] === 'På' }));
  }, [ocrSetting?.[1]]);

  const fields = d.facets.map((f) => f.field).join(',');
  useEffect(() => {
    if (!fields) return;
    const controller = new AbortController();
    api.facets(d.id, tenant, fields.split(','), controller.signal).then(
      (result) =>
        setLiveFacets(
          Object.fromEntries(
            result.map((f) => [
              f.field,
              f.options.map((o) => [o.value, o.count] as [string, number]),
            ]),
          ),
        ),
      () => setLiveFacets({}),
    );
    return () => controller.abort();
  }, [api, d.id, tenant, fields]);

  const editable = d.source !== 'shared';
  const latest = d.runs[0];
  const running = latest?.status === 'Pågår';
  const firstError = latest?.errors[0];
  const alert =
    !running && latest && firstError && d.status === 'Feilet'
      ? {
          title: t('datasets.alertFailed'),
          color: 'danger' as const,
          text: firstError.why,
          action: t('common.tryAgain'),
        }
      : !running && latest && firstError && d.status === 'Delvis lest inn'
        ? {
            title: t('datasets.alertPartial'),
            color: 'warning' as const,
            text: firstError.why,
            action: firstError.fix ?? t('common.tryAgain'),
          }
        : undefined;

  const showLatest = () => {
    if (!latest) return;
    setTab('ingestions');
    setOpenRun(latest.id);
    setTimeout(() => document.getElementById(`run-${latest.id}`)?.scrollIntoView?.(), 50);
  };

  return (
    <div className="stack dataset-page">
      <a href="#/datasets" className="back-link">
        <Icon d={back} size={18} />
        {t('datasets.title')}
      </a>
      <div className="page-head">
        <div className="page-head-text">
          <div className="row-wrap">
            <Heading level={1} data-size="md">
              {d.name}
            </Heading>
            <Tag data-color={statusColors[d.status]}>{t(statusKeys[d.status])}</Tag>
            <Tag data-color="neutral">{sourceOf(t, d)}</Tag>
          </div>
          <p className="lead">{d.description}</p>
        </div>
        <div className="actions">
          <Button variant="secondary" aria-pressed={trying} onClick={() => setTrying((x) => !x)}>
            <Icon d={play} />
            {t('datasets.try')}
          </Button>
          {editable ? (
            <>
              <Button
                variant="secondary"
                aria-disabled={running || undefined}
                onClick={() => {
                  if (!running) onRun();
                }}
              >
                {t('datasets.runNow')}
              </Button>
              <ApiCallLink
                call={{
                  ...datasetRunCall(tenant, d.id, '{pipeline}'),
                  action: t('datasets.apiRunAction', { name: d.name }),
                  right: t('rights.manageDatasets'),
                  endpoint: 'ds-pipeline-run',
                }}
              />
            </>
          ) : null}
        </div>
      </div>
      <div aria-live="polite" className="stack-sm">
        {alert ? (
          <Alert data-color={alert.color}>
            <Heading level={2} data-size="2xs">
              {alert.title}
            </Heading>
            <p className="alert-text">{alert.text}</p>
            <div className="actions">
              <Button variant="primary" data-size="sm" onClick={onRun}>
                {alert.action}
              </Button>
              <Button variant="secondary" data-size="sm" onClick={showLatest}>
                {t('datasets.showRun')}
              </Button>
            </div>
          </Alert>
        ) : null}
        {flash ? (
          <Alert data-color="success" data-size="sm">
            {flash}
          </Alert>
        ) : null}
      </div>
      <dl className="facts">
        {[
          [t('datasets.factDocuments'), count(f, d.docs)],
          [t('datasets.factChunks'), d.chunks],
          [t('datasets.factLastOk'), d.lastOk],
          [t('datasets.factNext'), d.next],
        ].map(([l, v]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd className="fact-text">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="tag-row used-by">
        <span className="meta">{t('datasets.usedBy')}</span>
        {d.usedBy.map((u) => (
          <a key={u} className="ds-tag" data-size="sm" data-color="accent" href="#/services">
            {u}
          </a>
        ))}
        {d.usedBy.length === 0 ? <span>{t('datasets.noServicesYet')}</span> : null}
      </div>

      <Tabs value={tab} onChange={(v) => setTab(v as DetailTab)}>
        <Tabs.List aria-label={t('datasets.tabsLabel')}>
          <Tabs.Tab value="ingestions">{t('datasets.tabIngestions')}</Tabs.Tab>
          <Tabs.Tab value="filters">{t('datasets.tabFilters')}</Tabs.Tab>
          <Tabs.Tab value="source">{t('datasets.tabSource')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ingestions">
          {d.runs.length === 0 ? (
            <p className="meta">{t('datasets.noIngestions')}</p>
          ) : (
            <ol className="runs">
              {d.runs.map((r) => (
                <RunItem
                  key={r.id}
                  run={r}
                  open={openRun === r.id}
                  onToggle={() => setOpenRun(openRun === r.id ? undefined : r.id)}
                  canRetry={r === latest && !running && editable}
                  onRetry={onRun}
                  onStop={() => onStop(r.id)}
                />
              ))}
            </ol>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="filters">
          <div className="stack-sm">
            <p className="meta panel-intro">{t('datasets.filtersIntro')}</p>
            {d.facets.length === 0 ? (
              <p className="meta">{t('datasets.noFilters')}</p>
            ) : (
              <div className="facet-grid">
                {d.facets.map((f, i) => (
                  <FacetCard
                    key={f.field}
                    facet={{ ...f, values: liveFacets[f.field] ?? f.values }}
                    locked={!editable}
                    onToggle={() =>
                      onUpdate({
                        ...d,
                        facets: d.facets.map((x, j) =>
                          j === i ? { ...x, enabled: !x.enabled } : x,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="source">
          <div className="source-grid">
            <section aria-labelledby="kilde-h" className="source-card">
              <h2 id="kilde-h" className="card-title">
                {t('datasets.factSource')}
              </h2>
              <dl className="source-dl">
                {d.settings.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {!editable ? (
                <Alert data-color="info" data-size="sm">
                  {t('datasets.ownedBy', { owner: d.owner ?? '' })}
                </Alert>
              ) : null}
              <Link href={`#/datasets/${encodeURIComponent(d.id)}/settings`}>
                {t('datasets.allSettings')}
              </Link>
            </section>
            {editable ? (
              <section aria-labelledby="innst-h" className="source-card">
                <h2 id="innst-h" className="card-title">
                  {t('datasets.ingestAndShare')}
                </h2>
                <Switch
                  label={t('datasets.ocr')}
                  description={t('datasets.ocrDescription')}
                  checked={settings.ocr}
                  onChange={() => setSettings((s) => ({ ...s, ocr: !s.ocr }))}
                />
                <Switch
                  label={t('datasets.pii')}
                  description={t('datasets.piiDescription')}
                  checked={settings.pii}
                  onChange={() => setSettings((s) => ({ ...s, pii: !s.pii }))}
                />
                <Fieldset>
                  <Fieldset.Legend>{t('datasets.whoCanUse')}</Fieldset.Legend>
                  <Radio
                    name="deling"
                    label={t('datasets.onlyServicesOf', { tenant: tenantName })}
                    checked={settings.share === 'egen'}
                    onChange={() => setSettings((s) => ({ ...s, share: 'egen' }))}
                  />
                  <Radio
                    name="deling"
                    label={t('datasets.allOrganisations')}
                    checked={settings.share === 'alle'}
                    onChange={() => setSettings((s) => ({ ...s, share: 'alle' }))}
                  />
                </Fieldset>
                <Button
                  variant="primary"
                  data-size="sm"
                  className="align-start"
                  onClick={() => {
                    onUpdate({
                      ...d,
                      settings: d.settings.map(([k, v]) =>
                        k === 'Tekstgjenkjenning' ? [k, settings.ocr ? 'På' : 'Av'] : [k, v],
                      ),
                    });
                    onFlash(t('datasets.settingsSaved'));
                  }}
                >
                  {t('common.save')}
                </Button>
              </section>
            ) : null}
          </div>
          <SearchEngine
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            datasetId={d.id}
            datasetName={d.name}
            docs={count(f, d.docs)}
            chunks={d.chunks}
            canEdit={editable && rights.has('manage-datasets')}
          />
        </Tabs.Panel>
      </Tabs>
      {trying ? (
        <div className="dataset-try-sheet">
          <PlaygroundPanel
            layout="side"
            context="dataset"
            name={d.id}
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            onClose={() => setTrying(false)}
          />
        </div>
      ) : null}
    </div>
  );
};
