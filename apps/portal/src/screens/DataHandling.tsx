import { Heading, List, Paragraph, Spinner } from '@digdir/designsystemet-react';
import type { ApiClient } from '../api';
import { NotDecided } from '../components/NotDecided';
import { access, logged, stored, undecided } from '../data/data-handling';
import { useAsync, type AsyncState } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import { modelLabel } from '../models';
import type { ModelOption, Residency } from '../types';
import './startside.css';

const residencyKeys: Record<Residency, PlainKey> = {
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

const Processing = ({ models }: { models?: AsyncState<ModelOption[]> }) => {
  const t = useT();
  if (models?.status === 'loading')
    return (
      <span role="status" className="row-wrap">
        <Spinner aria-hidden="true" data-size="xs" />
        {t('dataHandling.loadingModels')}
      </span>
    );
  if (models?.status !== 'ready') return <Paragraph>{t('dataHandling.processingToday')}</Paragraph>;
  if (models.data.length === 0) return <Paragraph>{t('dataHandling.noModels')}</Paragraph>;
  return (
    <>
      <Paragraph>{t('dataHandling.modelsIntro')}</Paragraph>
      <List.Unordered aria-label={t('dataHandling.modelsLabel')}>
        {models.data.map((m) => (
          <List.Item key={m.id}>
            {t('dataHandling.modelAt', {
              model: modelLabel(m.id, models.data),
              where: t(residencyKeys[m.residency]),
            })}
          </List.Item>
        ))}
      </List.Unordered>
    </>
  );
};

export const DataHandlingContent = ({ models }: { models?: AsyncState<ModelOption[]> }) => {
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
        <Processing {...(models ? { models } : {})} />
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
  const [models] = useAsync((signal) => api.listModels({}, signal), [api]);
  return <DataHandlingContent models={models} />;
};
