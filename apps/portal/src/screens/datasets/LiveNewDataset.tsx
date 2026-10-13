import {
  Alert,
  Button,
  Chip,
  ErrorSummary,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Select,
  Spinner,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import type { ApiClient } from '../../api';
import type { PipelineSource, Schedule } from '../../api/datasets';
import { Icon } from '../../components/Icon';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import { kudosDocumentTypes } from '../../data/datasets';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { FilePicker } from './FilePicker';
import {
  fileProblem,
  lines,
  platformEngine,
  residencyWords,
  usableBy,
  scheduleText,
  sizeText,
  toGlobs,
  uniqueId,
  widest,
  failureText,
} from './live-model';

type Source = 'web' | 'upload' | 'kudos';

const back = 'M15 6l-6 6 6 6';
const urlPattern = /^https:\/\/[^\s.]+\.[^\s]+/;
const years = ['2010', '2015', '2018', '2020', '2022', '2024'];

const choices: [Source, PlainKey, PlainKey, PlainKey][] = [
  ['web', 'datasets.sourceWeb', 'datasets.liveChoiceWebDesc', 'datasets.choiceWebExample'],
  [
    'upload',
    'datasets.uploadFiles',
    'datasets.liveChoiceUploadDesc',
    'datasets.choiceUploadExample',
  ],
  ['kudos', 'datasets.sourceKudos', 'datasets.choiceKudosDesc', 'datasets.choiceKudosExample'],
];

const sourceNames: Record<Source, PlainKey> = {
  web: 'datasets.sourceWeb',
  upload: 'datasets.sourceUpload',
  kudos: 'datasets.sourceKudos',
};

const pipelineIds: Record<Source, string> = { web: 'website', upload: 'upload', kudos: 'kudos' };

interface Picked {
  file: File;
  problem?: string;
}

interface Form {
  step: number;
  source: Source;
  name: string;
  description: string;
  sitemap: string;
  include: string;
  exclude: string;
  types: Record<string, boolean>;
  fromYear: string;
  files: Picked[];
  schedule: Schedule;
  reason: string;
  tried: Record<number, boolean>;
}

const blank: Form = {
  step: 1,
  source: 'web',
  name: '',
  description: '',
  sitemap: '',
  include: '',
  exclude: '',
  types: {},
  fromYear: '2020',
  files: [],
  schedule: 'daily',
  reason: '',
  tried: {},
};

type FieldKey = 'name' | 'sitemap' | 'files' | 'reason';
const anchors: Record<FieldKey, string> = {
  name: '#felt-navn',
  sitemap: '#felt-sitemap',
  files: '#filvelger-sone',
  reason: '#felt-begrunnelse',
};

const errorsFor = (t: T, f: Form): Partial<Record<FieldKey, string>> => {
  const e: Partial<Record<FieldKey, string>> = {};
  if (f.step === 2) {
    if (!f.name.trim()) e.name = t('datasets.nameProblem');
    if (f.source === 'web' && !urlPattern.test(f.sitemap.trim()))
      e.sitemap = t('datasets.sitemapProblem');
    if (f.source === 'upload' && !f.files.some((x) => !x.problem))
      e.files = t('datasets.filesProblem');
  }
  if (f.step === 3) {
    const reason = reasonProblem(f.reason, t);
    if (reason) e.reason = reason;
  }
  return e;
};

const sourceOf = (f: Form): PipelineSource =>
  f.source === 'web'
    ? {
        kind: 'website',
        sitemap: f.sitemap.trim(),
        include: toGlobs(f.include),
        exclude: toGlobs(f.exclude),
      }
    : f.source === 'upload'
      ? { kind: 'upload' }
      : {
          kind: 'kudos',
          types: kudosDocumentTypes.filter((type) => f.types[type]),
          since: `${f.fromYear}-01-01`,
        };

export const LiveNewDataset = ({
  api,
  tenant,
  onCreated,
  onCancel,
}: {
  api: ApiClient;
  tenant: string;
  onCreated: (fullId: string) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const fmt = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [f, setF] = useState<Form>(blank);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const summaryRef = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const done = useRef<{ id?: string; created?: boolean; pipeline?: boolean; uploaded?: boolean }>(
    {},
  );
  const [engines] = useAsync(
    (signal) => api.searchEngines.endpoints(tenant, signal),
    [api, tenant],
  );
  const [existing] = useAsync((signal) => api.datasets.list(tenant, signal), [api, tenant]);
  const set = (patch: Partial<Form> | ((x: Form) => Partial<Form>)) =>
    setF((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) }));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(f.step);
  useEffect(() => {
    if (shownStep.current === f.step) return;
    shownStep.current = f.step;
    headingRef.current?.focus();
    window.scrollTo?.({ top: 0 });
  }, [f.step]);

  const engine =
    engines.status === 'ready'
      ? engines.data.engines.find((e) => e.id === platformEngine)
      : undefined;
  const embedding = engines.status === 'ready' ? engines.data.defaultEmbedding : null;
  const known =
    engine?.dataLocation && embedding?.residency
      ? widest(engine.dataLocation, embedding.residency)
      : undefined;
  const residency = known ?? 'global';
  const errors = f.tried[f.step] ? errorsFor(t, f) : {};
  const errorList = Object.entries(errors) as [FieldKey, string][];
  const okFiles = f.files.filter((x) => !x.problem);
  const chosenTypes = kudosDocumentTypes.filter((type) => f.types[type]);
  const title = [
    t('datasets.stepChooseSource'),
    t('datasets.stepSetUp', { source: t(sourceNames[f.source]).toLowerCase() }),
    t('datasets.stepReview'),
  ][f.step - 1];

  const summary: [string, string][] = [
    [t('datasets.name'), f.name],
    ...(f.description.trim()
      ? ([[t('datasets.description'), f.description.trim()]] as [string, string][])
      : []),
    [t('datasets.factSource'), t(sourceNames[f.source])],
    ...(f.source === 'web'
      ? ([
          [t('datasets.sitemap'), f.sitemap],
          [t('datasets.include'), lines(f.include).join(', ') || t('datasets.wholeSite')],
          [t('datasets.excludeShort'), lines(f.exclude).join(', ') || t('datasets.nothing')],
        ] as [string, string][])
      : f.source === 'kudos'
        ? ([
            [
              t('datasets.selection'),
              t('datasets.selectionLive', {
                types: chosenTypes.join(', ') || t('datasets.allTypes'),
                year: f.fromYear,
              }),
            ],
          ] as [string, string][])
        : ([[t('datasets.files'), okFiles.map((x) => x.file.name).join(', ')]] as [
            string,
            string,
          ][])),
    [
      t('datasets.update'),
      f.source === 'upload' ? t('datasets.updateOnUploadLive') : t(scheduleText[f.schedule]),
    ],
  ];

  const start = async () => {
    setFailure('');
    const taken = existing.status === 'ready' ? existing.data.map((d) => d.id) : [];
    const id = done.current.id ?? uniqueId(f.name, taken);
    done.current.id = id;
    const reason = f.reason.trim();
    const pipelineId = pipelineIds[f.source];
    try {
      if (!done.current.created) {
        setBusy(tRef.current('datasets.busyCreating'));
        await api.datasets.create(
          tenant,
          id,
          {
            name: f.name.trim(),
            ...(f.description.trim() ? { description: f.description.trim() } : {}),
            endpoint: platformEngine,
            residency,
            ...(embedding
              ? { embedding: { model: embedding.model, dimensions: embedding.dimensions } }
              : {}),
          },
          reason,
        );
        done.current.created = true;
      }
      if (!done.current.pipeline) {
        setBusy(tRef.current('datasets.busyPipeline'));
        await api.datasets.createPipeline(
          tenant,
          id,
          {
            id: pipelineId,
            name: f.name.trim(),
            source: sourceOf(f),
            schedule: f.source === 'upload' ? 'none' : f.schedule,
          },
          reason,
        );
        done.current.pipeline = true;
      }
      if (f.source === 'upload' && !done.current.uploaded) {
        setBusy(tRef.current('datasets.busyUploading'));
        await api.datasets.upload(
          tenant,
          id,
          okFiles.map((x) => x.file),
          reason,
        );
        done.current.uploaded = true;
      }
      setBusy(tRef.current('datasets.busyStarting'));
      await api.datasets.execute(tenant, id, pipelineId, reason);
      onCreated(`${tenant}/${id}`);
    } catch (error) {
      setFailure(failureText(tRef.current, error));
      setBusy('');
    }
  };

  const next = () => {
    if (busy) return;
    if (Object.keys(errorsFor(t, f)).length) {
      set((x) => ({ tried: { ...x.tried, [x.step]: true } }));
      setTimeout(() => summaryRef.current?.focus(), 30);
      return;
    }
    if (f.step < 3) {
      set((x) => ({ step: x.step + 1 }));
      return;
    }
    void start();
  };

  const addFiles = (files: File[]) =>
    set((x) => ({
      files: [
        ...x.files,
        ...files.map((file) => {
          const problem = fileProblem(t, file);
          return problem ? { file, problem } : { file };
        }),
      ],
    }));

  return (
    <div className="stack dataset-page new-dataset">
      <a
        href="#/datasets"
        className="back-link"
        onClick={(e) => {
          e.preventDefault();
          onCancel();
        }}
      >
        <Icon d={back} size={18} />
        {t('datasets.title')}
      </a>
      <div className="stack-sm">
        <span className="step-label">{t('datasets.stepOf', { step: f.step })}</span>
        <Heading level={1} data-size="md" ref={headingRef} tabIndex={-1}>
          {title}
        </Heading>
        <div aria-hidden="true" className="step-bar">
          <div style={{ width: `${Math.round((f.step / 3) * 100)}%` }} />
        </div>
      </div>
      {errorList.length > 0 ? (
        <ErrorSummary ref={summaryRef} tabIndex={-1}>
          <ErrorSummary.Heading>{t('datasets.fixFirst')}</ErrorSummary.Heading>
          <ErrorSummary.List>
            {errorList.map(([key, text]) => (
              <ErrorSummary.Item key={key}>
                <ErrorSummary.Link href={anchors[key]}>{text}</ErrorSummary.Link>
              </ErrorSummary.Item>
            ))}
          </ErrorSummary.List>
        </ErrorSummary>
      ) : null}

      {f.step === 1 ? (
        <Fieldset className="source-options">
          <Fieldset.Legend>{t('datasets.whereFrom')}</Fieldset.Legend>
          {choices.map(([id, label, desc, example]) => (
            <label key={id} className={f.source === id ? 'source-option checked' : 'source-option'}>
              <input
                className="ds-input"
                type="radio"
                name="kilde"
                checked={f.source === id}
                onChange={() => set({ source: id })}
              />
              <span className="stack-xs">
                <span className="source-option-label">{t(label)}</span>
                <span className="source-option-desc">{t(desc)}</span>
                <span className="meta">{t(example)}</span>
              </span>
            </label>
          ))}
          <p className="meta">
            {t.rich('datasets.integrationsHint', { link: (c) => <a href="#/integrations">{c}</a> })}
          </p>
        </Fieldset>
      ) : null}

      {f.step === 2 ? (
        <div className="stack">
          <Textfield
            id="felt-navn"
            className="narrow-field"
            label={t('datasets.nameOfDataset')}
            value={f.name}
            error={errors.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <Textfield
            id="felt-beskrivelse"
            className="narrow-field"
            label={t('datasets.description')}
            description={t('datasets.descriptionHelp')}
            multiline
            rows={2}
            value={f.description}
            onChange={(e) => set({ description: e.target.value })}
          />
          {f.source === 'web' ? (
            <div className="stack">
              <Textfield
                id="felt-sitemap"
                className="narrow-field"
                type="url"
                placeholder="https://"
                label={t('datasets.sitemapLabel')}
                description={t('datasets.sitemapHelp')}
                value={f.sitemap}
                error={errors.sitemap}
                onChange={(e) => set({ sitemap: e.target.value })}
              />
              <div className="two-col">
                <Field>
                  <Label htmlFor="felt-med">{t('datasets.includeOnly')}</Label>
                  <Field.Description>{t('datasets.includeHelp')}</Field.Description>
                  <Textarea
                    id="felt-med"
                    rows={3}
                    value={f.include}
                    onChange={(e) => set({ include: e.target.value })}
                  />
                </Field>
                <Field>
                  <Label htmlFor="felt-utelat">{t('datasets.exclude')}</Label>
                  <Field.Description>{t('datasets.excludeHelpLive')}</Field.Description>
                  <Textarea
                    id="felt-utelat"
                    rows={3}
                    value={f.exclude}
                    onChange={(e) => set({ exclude: e.target.value })}
                  />
                </Field>
              </div>
            </div>
          ) : null}
          {f.source === 'kudos' ? (
            <div className="stack">
              <Fieldset>
                <Fieldset.Legend>{t('datasets.documentTypes')}</Fieldset.Legend>
                <Fieldset.Description>{t('datasets.noTypeMeansAll')}</Fieldset.Description>
                <div className="tag-row">
                  {kudosDocumentTypes.map((type) => (
                    <Chip.Checkbox
                      key={type}
                      checked={!!f.types[type]}
                      onChange={() =>
                        set((x) => ({ types: { ...x.types, [type]: !x.types[type] } }))
                      }
                    >
                      {type}
                    </Chip.Checkbox>
                  ))}
                </div>
              </Fieldset>
              <Field className="year-field">
                <Label htmlFor="felt-fra-ar">{t('datasets.fromYear')}</Label>
                <Select
                  id="felt-fra-ar"
                  value={f.fromYear}
                  onChange={(e) => set({ fromYear: e.target.value })}
                >
                  {years.map((y) => (
                    <Select.Option key={y} value={y}>
                      {y}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null}
          {f.source === 'upload' ? (
            <div className="stack-sm">
              <FilePicker id="filvelger" onFiles={addFiles} />
              {errors.files ? <ValidationMessage>{errors.files}</ValidationMessage> : null}
              {f.files.length > 0 ? (
                <>
                  <ul aria-label={t('datasets.chosenFiles')} className="file-list">
                    {f.files.map((x, i) => (
                      <li key={`${x.file.name}-${i}`}>
                        <span className="file-name">
                          <strong>{x.file.name}</strong>
                          <span className="meta">{sizeText(t, fmt, x.file.size)}</span>
                        </span>
                        <Tag data-size="sm" data-color={x.problem ? 'danger' : 'success'}>
                          {x.problem ? t('datasets.cannotRead') : t('datasets.canRead')}
                        </Tag>
                        {x.problem ? <span className="meta wrap">{x.problem}</span> : null}
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('datasets.removeFile', { name: x.file.name })}
                          onClick={() => set((s) => ({ files: s.files.filter((_, j) => j !== i) }))}
                        >
                          {t('common.remove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <span className="meta">
                    {t('datasets.readableOf', { ok: okFiles.length, total: f.files.length })}
                    {okFiles.length < f.files.length
                      ? ` ${t('datasets.unreadableNotUploaded')}`
                      : ''}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          {f.source !== 'upload' ? (
            <div className="options-box">
              <Field className="schedule-field">
                <Label htmlFor="felt-tidsplan">{t('datasets.update')}</Label>
                <Select
                  id="felt-tidsplan"
                  value={f.schedule}
                  onChange={(e) => set({ schedule: e.target.value as Schedule })}
                >
                  <Select.Option value="daily">{t(scheduleText.daily)}</Select.Option>
                  <Select.Option value="weekly">{t(scheduleText.weekly)}</Select.Option>
                  <Select.Option value="none">{t(scheduleText.none)}</Select.Option>
                </Select>
              </Field>
            </div>
          ) : null}
        </div>
      ) : null}

      {f.step === 3 ? (
        <div className="stack">
          <dl className="summary-dl">
            {summary.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <section aria-labelledby="lagring-h" className="stack-xs">
            <Heading level={2} data-size="2xs" id="lagring-h">
              {t('datasets.whereStored')}
            </Heading>
            {engines.status === 'loading' ? (
              <span role="status" className="row-wrap">
                <Spinner aria-hidden="true" data-size="xs" />
                {t('searchEngine.loading')}
              </span>
            ) : (
              <Paragraph data-size="sm">
                {t('datasets.storedIn', {
                  engine: engine?.title ?? t('datasets.builtinSearch'),
                })}
                {engine?.tech ? ` (${engine.tech})` : ''}
                {engine?.dataLocation
                  ? t('datasets.engineRunsAt', { place: t(residencyWords[engine.dataLocation]) })
                  : t('datasets.engineRunsUnknown')}{' '}
                {embedding
                  ? t('datasets.embeddingSent', {
                      model: embedding.model.split('/').pop() ?? '',
                      place: embedding.residency
                        ? t(residencyWords[embedding.residency])
                        : t('datasets.placeUnknown'),
                    })
                  : t('datasets.noEmbedding')}{' '}
                {usableBy(t, known)}
              </Paragraph>
            )}
          </section>
          <div id="felt-begrunnelse">
            <ReasonField
              value={f.reason}
              onChange={(reason) => set({ reason })}
              showError={!!f.tried[3]}
              description={t('datasets.reasonHelp')}
            />
          </div>
          <Alert data-color="info" data-size="sm">
            {t('datasets.backgroundNote')}
          </Alert>
          <div aria-live="polite">
            {busy ? (
              <span role="status" className="row-wrap">
                <Spinner aria-hidden="true" data-size="xs" />
                {busy}
              </span>
            ) : null}
            {failure ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                <Heading level={2} data-size="2xs">
                  {t('datasets.couldNotStartTitle')}
                </Heading>
                <Paragraph data-size="sm">{failure}</Paragraph>
              </Alert>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="wizard-actions">
        {f.step > 1 ? (
          <Button
            variant="secondary"
            aria-disabled={busy ? true : undefined}
            onClick={() => !busy && set((x) => ({ step: x.step - 1 }))}
          >
            {t('common.previous')}
          </Button>
        ) : null}
        <Button variant="primary" aria-disabled={busy ? true : undefined} onClick={next}>
          {f.step === 3 ? t('datasets.startIngestion') : t('common.next')}
        </Button>
        <div className="spacer" />
        <Button variant="tertiary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
