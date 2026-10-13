import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { DatasetDetails } from '../data/datasets';
import { navigate, useAsync } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { EmptyState, ErrorState, Loading } from '../states';
import { useRights } from '../Shell';
import type { DatasetSummary } from '../types';
import { DatasetDetail, type DetailTab } from './datasets/DatasetDetail';
import { DatasetList, listItemFor } from './datasets/DatasetList';
import { LiveDatasets } from './datasets/LiveDatasets';
import {
  datasetHref,
  fromSummary,
  nowLabel,
  outcomeFor,
  startRun,
  type RunOutcome,
} from './datasets/model';
import { exampleWebForm, NewDataset, type NewDatasetResult } from './datasets/NewDataset';
import './datasets.css';
import './shared.css';

const tabs: Record<string, DetailTab> = {
  ingestions: 'ingestions',
  filters: 'filters',
  source: 'source',
};

const shortId = (id: string) => id.slice(id.lastIndexOf('/') + 1);

const UnlistedDataset = ({
  api,
  id,
  onFound,
}: {
  api: ScreenProps['api'];
  id: string;
  onFound: (dataset: DatasetSummary) => void;
}) => {
  const t = useT();
  const [state] = useAsync((signal) => api.getDataset(id, signal), [api, id]);
  useEffect(() => {
    if (state.status === 'ready') onFound(state.data);
  }, [state]);
  if (state.status !== 'error') return <Loading label={t('datasets.loadingOne')} />;
  return (
    <>
      <Heading level={1} data-size="lg">
        {t('datasets.notFound')}
      </Heading>
      <Paragraph>
        {t('datasets.notFoundText')} <a href="#/datasets">{t('datasets.goToDatasets')}</a>
      </Paragraph>
    </>
  );
};

const ExampleDatasets = ({ api, tenant, tenantName, route, live }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync((signal) => api.listDatasets(signal), [api]);
  const [datasets, setDatasets] = useState<DatasetDetails[] | undefined>();
  const [flash, setFlash] = useState('');
  const outcomes = useRef(new Map<string, RunOutcome>());
  const canCreate = useRights().has('manage-datasets');
  const id = route.segments[1];

  useEffect(() => {
    if (state.status === 'ready')
      setDatasets(state.data.map((s) => fromSummary(s, live, tRef.current)));
  }, [state, live]);
  useEffect(() => setFlash(''), [id]);

  const running = datasets?.some((d) => d.runs[0]?.status === 'Pågår') ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setDatasets((all) =>
        all?.map((d) => {
          const run = d.runs[0];
          if (!run || run.status !== 'Pågår') return d;
          const progress = Math.min(100, (run.progress ?? 0) + 20);
          if (progress < 100) return { ...d, runs: [{ ...run, progress }, ...d.runs.slice(1)] };
          const outcome = outcomes.current.get(run.id) ?? {
            added: 0,
            changed: 0,
            removed: 0,
            flash: tRef.current('datasets.outcomeDone'),
          };
          setFlash(outcome.flash);
          return {
            ...d,
            status: 'Klar',
            last: run.when,
            lastOk: run.when,
            docs: outcome.docs ?? d.docs,
            runs: [
              {
                ...run,
                progress: 100,
                status: 'Fullført',
                duration: outcome.duration ?? tRef.current('datasets.minutesShort', { count: 2 }),
                added: outcome.added,
                changed: outcome.changed,
                removed: outcome.removed,
              },
              ...d.runs.slice(1),
            ],
          };
        }),
      );
    }, 700);
    return () => clearInterval(timer);
  }, [running]);

  if (state.status === 'loading' || (state.status === 'ready' && !datasets))
    return <Loading label={t('datasets.loading')} />;
  if (state.status === 'error')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('datasets.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const all = datasets ?? [];

  const update = (next: DatasetDetails) =>
    setDatasets((list) => list?.map((d) => (d.id === next.id ? next : d)));

  const run = (dataset: DatasetDetails) => {
    const prepared =
      dataset.id === '999888777/tilsynsrapporter-2025'
        ? {
            ...dataset,
            settings: dataset.settings.map(([k, v]): [string, string] =>
              k === 'Tekstgjenkjenning' ? [k, 'På'] : [k, v],
            ),
          }
        : dataset;
    const { total, outcome } = outcomeFor(prepared, t);
    const started = startRun(prepared, t('datasets.manualRun'), total, t, f);
    outcomes.current.set(started.run.id, outcome);
    setFlash('');
    update(started.dataset);
  };

  const stop = (dataset: DatasetDetails, runId: string) => {
    const current = dataset.runs.find((r) => r.id === runId);
    const share = (current?.progress ?? 0) / 100;
    const outcome = outcomes.current.get(runId);
    const kept = Math.round((outcome?.added ?? 0) * share);
    update({
      ...dataset,
      status: 'Klar',
      docs: dataset.docs + kept,
      last: current?.when ?? dataset.last,
      runs: dataset.runs.map((r) =>
        r.id === runId
          ? {
              ...r,
              status: 'Stoppet',
              duration: t('datasets.stoppedMidway'),
              added: kept,
              changed: Math.round((outcome?.changed ?? 0) * share),
            }
          : r,
      ),
    });
    setFlash(t('datasets.stoppedFlash'));
  };

  const create = (result: NewDatasetResult) => {
    const newId = `${tenant}/ny-${Date.now()}`;
    const fresh: DatasetDetails = {
      id: newId,
      name: result.name,
      source: result.source,
      docs: 0,
      chunks: '–',
      last: t('datasets.runRunning'),
      lastOk: t('datasets.notYet'),
      next: t(result.source === 'upload' ? 'datasets.scheduleNone' : 'datasets.tomorrow'),
      status: 'Innlesing pågår',
      usedBy: [],
      description: result.description,
      settings: result.settings,
      runs: [],
      facets: [
        {
          name: t('datasets.facetDocType'),
          field: 'type',
          enabled: true,
          values: [[t('datasets.facetOther'), Math.max(1, result.estimatedDocs)]],
          moreValues: 0,
        },
      ],
    };
    const started = startRun(fresh, t('datasets.firstRun'), result.estimatedDocs, t, f);
    outcomes.current.set(started.run.id, {
      added: result.estimatedDocs,
      changed: 0,
      removed: 0,
      docs: result.estimatedDocs,
      flash: t('datasets.readyFlash', { name: result.name }),
    });
    setDatasets((list) => [{ ...started.dataset, last: nowLabel(t, f) }, ...(list ?? [])]);
    window.location.hash = datasetHref(newId);
  };

  if (id === 'new')
    return (
      <NewDataset
        key={route.query.get('example') ?? 'blank'}
        tenantName={tenantName}
        {...(route.query.get('example') === 'web' ? { initial: exampleWebForm() } : {})}
        onStart={create}
        onCancel={() => navigate('/datasets')}
      />
    );

  if (id) {
    const dataset = all.find((d) => d.id === id) ?? all.find((d) => d.id === shortId(id));
    if (!dataset)
      return (
        <UnlistedDataset
          api={api}
          id={id}
          onFound={(found) =>
            setDatasets((list) =>
              list?.some((d) => d.id === found.id)
                ? list
                : [
                    ...(list ?? []),
                    fromSummary(
                      { ...found, id: found.id === shortId(id) ? found.id : id },
                      live,
                      t,
                    ),
                  ],
            )
          }
        />
      );
    return (
      <DatasetDetail
        api={api}
        tenant={tenant}
        tenantName={tenantName}
        dataset={dataset}
        initialTab={tabs[route.query.get('tab') ?? ''] ?? 'ingestions'}
        {...(route.query.get('run') ? { initialRun: route.query.get('run') as string } : {})}
        flash={flash}
        onRun={() => run(dataset)}
        onStop={(runId) => stop(dataset, runId)}
        onUpdate={update}
        onFlash={setFlash}
      />
    );
  }

  if (all.length === 0)
    return (
      <div className="stack">
        <Heading level={1} data-size="lg">
          {t('datasets.title')}
        </Heading>
        <EmptyState title={t('datasets.emptyTitle')}>
          <Paragraph>{t('datasets.emptyText')}</Paragraph>
          {!canCreate ? null : (
            <Button variant="primary" data-size="sm" onClick={() => navigate('/datasets/new')}>
              {t('datasets.new')}
            </Button>
          )}
        </EmptyState>
      </div>
    );

  return <DatasetList datasets={all.map((d) => listItemFor(t, f, d))} canCreate={canCreate} />;
};

export const Datasets = (props: ScreenProps) =>
  props.live ? <LiveDatasets {...props} /> : <ExampleDatasets {...props} />;
