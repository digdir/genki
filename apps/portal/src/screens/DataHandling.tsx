import {
  Alert,
  Button,
  Heading,
  List,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../api';
import { access } from '../data/data-handling';
import { useAsync, type AsyncState } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import { modelLabel } from '../models';
import { Loading } from '../states';
import type { ModelOption, Residency } from '../types';
import './data-handling.css';

export const residencyKeys: Record<Residency, PlainKey> = {
  norway: 'about.dhWhereNorway',
  eu: 'about.dhWhereEu',
  global: 'about.dhWhereGlobal',
};

const gatewayPrefix = 'ai-gateway/';

type ModelFacts = ModelOption & {
  maker?: string;
  operator?: { name: string; region?: string };
  gateway?: boolean;
};

type Column = 'model' | 'where' | 'operator' | 'stored' | 'howLong';

const columns: readonly (readonly [Column, PlainKey])[] = [
  ['model', 'about.dhColumnModel'],
  ['where', 'about.dhColumnWhere'],
  ['operator', 'about.dhColumnOperator'],
  ['stored', 'about.dhColumnStored'],
  ['howLong', 'about.dhColumnHowLong'],
];

interface Row {
  id: string;
  model: string;
  where: string;
  operator: string;
  stored: string;
  howLong: string;
}

const isPlatformHost = (m: ModelFacts) => /azure|microsoft/i.test(m.operator?.name ?? '');

const isGateway = (m: ModelFacts) =>
  m.gateway ?? (m.operator ? /gateway/i.test(m.operator.name) : m.id.startsWith(gatewayPrefix));

const ModelTable = ({ models }: { models: ModelFacts[] }) => {
  const t = useT();
  const [sort, setSort] = useState<{ key: Column; dir: 1 | -1 }>({ key: 'model', dir: 1 });
  const rows: Row[] = models.map((m) => ({
    id: m.id,
    model: modelLabel(m.id, models),
    where: m.operator?.region
      ? t('about.dhWhereRegion', {
          where: t(residencyKeys[m.residency]),
          region: m.operator.region,
        })
      : t(residencyKeys[m.residency]),
    operator: m.operator?.name ?? t('about.dhOperatorUnknown'),
    stored: t('about.dhStoredWhere'),
    howLong: t('about.dhHowLongStandard'),
  }));
  rows.sort(
    (a, b) => a[sort.key].localeCompare(b[sort.key], 'nb') * sort.dir || a.id.localeCompare(b.id),
  );
  const global = models.filter((m) => m.residency === 'global').length;
  return (
    <>
      {global > 0 ? (
        <Paragraph>{t('about.dhGlobalCount', { count: global, total: models.length })}</Paragraph>
      ) : null}
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t('about.dhModelsLabel')}
      >
        <Table border>
          <TableHead>
            <TableRow>
              {columns.map(([key, label]) => (
                <TableHeaderCell
                  key={key}
                  scope="col"
                  sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  onClick={() =>
                    setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 })
                  }
                >
                  {t(label)}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <span className="stack-xs">
                    <span>{r.model}</span>
                    <code className="meta">{r.id}</code>
                  </span>
                </TableCell>
                <TableCell>{r.where}</TableCell>
                <TableCell>{r.operator}</TableCell>
                <TableCell>{r.stored}</TableCell>
                <TableCell>{r.howLong}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
};

const Models = ({
  models,
  onRetry,
}: {
  models?: AsyncState<ModelOption[]>;
  onRetry?: () => void;
}) => {
  const t = useT();
  if (!models) return <Paragraph>{t('about.dhModelsSignIn')}</Paragraph>;
  if (models.status === 'loading')
    return (
      <Loading
        label={t('about.dhModelsLoading')}
        shape="table"
        columns={columns.map(([, label]) => t(label))}
        {...(onRetry ? { onRetry } : {})}
      />
    );
  if (models.status === 'error')
    return (
      <Alert data-color="danger">
        <Heading level={3} data-size="2xs">
          {t('about.dhModelsError')}
        </Heading>
        <Paragraph>{t('about.dhModelsErrorText')}</Paragraph>
        {onRetry ? (
          <Button variant="secondary" data-size="sm" onClick={onRetry}>
            {t('common.tryAgain')}
          </Button>
        ) : null}
      </Alert>
    );
  if (models.status !== 'ready') return null;
  if (models.data.length === 0) return <Paragraph>{t('about.dhNoModels')}</Paragraph>;
  return <ModelTable models={models.data} />;
};

const Subprocessors = ({ models }: { models?: AsyncState<ModelFacts[]> }) => {
  const t = useT();
  const known: ModelFacts[] = models?.status === 'ready' ? models.data : [];
  const names = (list: ModelFacts[]) => list.map((m) => modelLabel(m.id, known)).join(', ');
  const gateway = known.filter(isGateway);
  const hosted = known.filter(isPlatformHost);
  const hostRegions = [...new Set(hosted.flatMap((m) => m.operator?.region ?? []))];
  return (
    <dl className="data-handling-subprocessors">
      <div>
        <dt>{t('about.dhMicrosoft')}</dt>
        <dd>
          {hosted.length && hostRegions.length
            ? t('about.dhMicrosoftRuns', {
                models: names(hosted),
                regions: hostRegions.join(', '),
              })
            : t('about.dhMicrosoftText')}
        </dd>
      </div>
      {gateway.length ? (
        <div>
          <dt>{t('about.dhGateway')}</dt>
          <dd>{t('about.dhGatewayText', { models: names(gateway) })}</dd>
        </div>
      ) : null}
    </dl>
  );
};

export const DataHandlingContent = ({
  models,
  onRetry,
}: {
  models?: AsyncState<ModelOption[]>;
  onRetry?: () => void;
}) => {
  const t = useT();
  return (
    <div className="stack data-handling">
      <div className="stack-sm">
        <Heading level={1} data-size="lg">
          {t('dataHandling.title')}
        </Heading>
        <Paragraph className="lede">{t('about.residencyStatement')}</Paragraph>
        <Paragraph data-size="sm" className="meta">
          {t('about.dhUpdated')}
        </Paragraph>
        <div className="row-wrap data-handling-pdf">
          <Button variant="secondary" data-size="sm" onClick={() => window.print()}>
            {t('about.dhPdf')}
          </Button>
          <span className="meta">{t('about.dhPdfHelp')}</span>
        </div>
      </div>
      <section aria-labelledby="dh-models-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="dh-models-h">
          {t('about.dhModelsHeading')}
        </Heading>
        <Models {...(models ? { models } : {})} {...(onRetry ? { onRetry } : {})} />
      </section>
      <section aria-labelledby="dh-stored-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="dh-stored-h">
          {t('about.dhStoredHeading')}
        </Heading>
        <Paragraph>{t('about.dhStoredLede')}</Paragraph>
        <List.Unordered>
          <List.Item>{t('about.dhStored1')}</List.Item>
          <List.Item>{t('about.dhStored2')}</List.Item>
          <List.Item>{t('about.dhStored3')}</List.Item>
        </List.Unordered>
      </section>
      <section aria-labelledby="dh-access-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="dh-access-h">
          {t('dataHandling.accessHeading')}
        </Heading>
        <List.Unordered>
          {access.map((item) => (
            <List.Item key={item}>{t(item)}</List.Item>
          ))}
        </List.Unordered>
      </section>
      <section aria-labelledby="dh-sub-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="dh-sub-h">
          {t('about.dhSubprocessorsHeading')}
        </Heading>
        <Subprocessors {...(models ? { models } : {})} />
      </section>
    </div>
  );
};

export const DataHandling = ({ api }: { api: ApiClient }) => {
  const [models, retry] = useAsync((signal) => api.listModels({}, signal), [api]);
  return <DataHandlingContent models={models} onRetry={retry} />;
};
