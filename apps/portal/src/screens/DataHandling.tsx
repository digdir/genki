import {
  Heading,
  List,
  Paragraph,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@digdir/designsystemet-react';
import type { ApiClient } from '../api';
import { NotDecided } from '../components/NotDecided';
import { access, logged, stored, undecided } from '../data/data-handling';
import { useAsync, type AsyncState } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import { modelLabel } from '../models';
import { ErrorState } from '../states';
import type { ModelOption, Residency } from '../types';
import './startside.css';

export const residencyKeys: Record<Residency, PlainKey> = {
  norway: 'dataHandling.residencyNorway',
  eu: 'dataHandling.residencyEu',
  global: 'dataHandling.residencyGlobal',
};

const Section = ({ id, title, items }: { id: string; title: PlainKey; items: PlainKey[] }) => {
  const t = useT();
  return (
    <section aria-labelledby={id} className="stack-sm">
      <Heading level={2} data-size="sm" id={id}>
        {t(title)}
      </Heading>
      <List.Unordered>
        {items.map((item) => (
          <List.Item key={item}>{t(item)}</List.Item>
        ))}
      </List.Unordered>
    </section>
  );
};

const Processing = ({
  models,
  onRetry,
}: {
  models?: AsyncState<ModelOption[]>;
  onRetry?: () => void;
}) => {
  const t = useT();
  if (models?.status === 'loading')
    return (
      <span role="status" className="row-wrap">
        <Spinner aria-hidden="true" data-size="xs" />
        {t('dataHandling.loadingModels')}
      </span>
    );
  if (models?.status === 'error')
    return <ErrorState error={models.error} headingLevel={3} {...(onRetry ? { onRetry } : {})} />;
  if (models?.status !== 'ready') return <Paragraph>{t('dataHandling.processingToday')}</Paragraph>;
  if (models.data.length === 0) return <Paragraph>{t('dataHandling.noModels')}</Paragraph>;
  const outside = models.data.filter((m) => m.residency === 'global').length;
  return (
    <>
      <Paragraph>
        {outside === 0
          ? t('dataHandling.allInside')
          : t('dataHandling.someOutside', { count: outside, total: models.data.length })}
      </Paragraph>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t('dataHandling.modelsLabel')}
      >
        <Table border>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">{t('dataHandling.columnModel')}</TableHeaderCell>
              <TableHeaderCell scope="col">{t('dataHandling.columnWhere')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {models.data.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <span className="stack-xs">
                    <span>{modelLabel(m.id, models.data)}</span>
                    <code className="meta">{m.id}</code>
                  </span>
                </TableCell>
                <TableCell>{t(residencyKeys[m.residency])}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
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
    <div className="stack">
      <Heading level={1} data-size="lg">
        {t('dataHandling.title')}
      </Heading>
      <Section id="lagres-h" title="dataHandling.storedHeading" items={stored} />
      <Section id="tilgang-h" title="dataHandling.accessHeading" items={access} />
      <section aria-labelledby="behandles-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="behandles-h">
          {t('dataHandling.processingHeading')}
        </Heading>
        <Processing {...(models ? { models } : {})} {...(onRetry ? { onRetry } : {})} />
      </section>
      <Section id="logges-h" title="dataHandling.loggedHeading" items={logged} />
      <section aria-labelledby="merking-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="merking-h">
          {t('dataHandling.markingHeading')}
        </Heading>
        <List.Unordered>
          <List.Item>{t('dataHandling.marking1')}</List.Item>
          <List.Item>
            {t.rich('dataHandling.marking2', { code: (c) => <code>{c}</code> })}
          </List.Item>
        </List.Unordered>
      </section>
      <section aria-labelledby="ikke-bestemt-h" className="stack-sm">
        <Heading level={2} data-size="sm" id="ikke-bestemt-h">
          {t('dataHandling.undecidedHeading')}
        </Heading>
        <List.Unordered aria-labelledby="ikke-bestemt-h">
          {undecided.map((term) => (
            <List.Item key={term}>
              <span className="row-wrap">
                {t(term)} <NotDecided />
              </span>
            </List.Item>
          ))}
        </List.Unordered>
      </section>
    </div>
  );
};

export const DataHandling = ({ api }: { api: ApiClient }) => {
  const [models, retry] = useAsync((signal) => api.listModels({}, signal), [api]);
  return <DataHandlingContent models={models} onRetry={retry} />;
};
