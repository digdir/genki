import { ChevronLeftIcon } from '@navikt/aksel-icons';
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
  Radio,
  Select,
  Spinner,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useRef, useState, type ComponentRef } from 'react';
import type { ApiClient } from '../../api';
import type { EndpointAuth, PipelineSource, Schedule, SearchScope } from '../../api/datasets';
import { Icon } from '../../components/Icon';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import { kudosDocumentTypes } from '../../data/datasets';
import { useAsync } from '../../hooks';
import { ErrorState } from '../../states';
import { ApiError } from '../../api/error';
import { useT, type PlainKey, type T } from '../../i18n';
import { FilePicker } from './FilePicker';
import {
  fileProblem,
  platformEngine,
  residencyWords,
  usableBy,
  sizeText,
  toGlobs,
  uniqueId,
  widest,
  failureText,
} from './live-model';

type Source = 'web' | 'upload' | 'endpoint' | 'kudos';
type AuthKind = EndpointAuth['kind'];

const urlPattern = /^https:\/\/[^\s.]+\.[^\s]+/;
const headerPattern = /^[A-Za-z0-9-]{1,64}$/;
const years = ['2010', '2015', '2018', '2020', '2022', '2024'];

const choices: [Source, PlainKey, PlainKey][] = [
  ['web', 'datasets.sourceWeb', 'datasets.liveChoiceWebDesc'],
  ['upload', 'datasets.uploadFiles', 'datasets.liveChoiceUploadDesc'],
  ['endpoint', 'datasets.sourceEndpoint', 'datasets.choiceEndpointDesc'],
  ['kudos', 'datasets.sourceKudos', 'datasets.choiceKudosDesc'],
];

const authKinds: [AuthKind, PlainKey][] = [
  ['api-key', 'datasets.authApiKey'],
  ['none', 'datasets.authNone'],
];

const scopeChoices: SearchScope[] = ['tenant', 'all'];

const frequencies: [Schedule, PlainKey][] = [
  ['daily', 'datasets.scheduleNightly'],
  ['weekly', 'datasets.scheduleWeeklyOption'],
  ['none', 'datasets.scheduleManual'],
];

const pipelineIds: Record<Exclude<Source, 'endpoint'>, string> = {
  web: 'website',
  upload: 'upload',
  kudos: 'kudos',
};

interface Picked {
  file: File;
  problem?: string;
}

interface Form {
  source: Source;
  name: string;
  sitemap: string;
  include: string;
  exclude: string;
  types: Record<string, boolean>;
  fromYear: string;
  files: Picked[];
  schedule: Schedule;
  endpointUrl: string;
  auth: AuthKind;
  apiKey: string;
  apiKeyHeader: string;
  searchScope: SearchScope;
  reason: string;
  tried: boolean;
}

const blank: Form = {
  source: 'web',
  name: '',
  sitemap: '',
  include: '',
  exclude: '',
  types: {},
  fromYear: '2020',
  files: [],
  schedule: 'daily',
  endpointUrl: '',
  auth: 'api-key',
  apiKey: '',
  apiKeyHeader: '',
  searchScope: 'tenant',
  reason: '',
  tried: false,
};

type FieldKey = 'name' | 'sitemap' | 'files' | 'endpointUrl' | 'auth' | 'header' | 'reason';
const anchors: Record<FieldKey, string> = {
  name: '#felt-navn',
  sitemap: '#felt-sitemap',
  files: '#filvelger-sone',
  endpointUrl: '#felt-endepunkt',
  auth: '#felt-innlogging-verdi',
  header: '#felt-innlogging-header',
  reason: '#felt-begrunnelse',
};

const errorsFor = (t: T, f: Form, taken: string[]): Partial<Record<FieldKey, string>> => {
  const e: Partial<Record<FieldKey, string>> = {};
  const name = f.name.trim();
  if (!name) e.name = t('datasets.nameProblem');
  else if (taken.includes(name.toLowerCase())) e.name = t('datasets.nameTaken', { name });
  if (f.source === 'web' && !urlPattern.test(f.sitemap.trim()))
    e.sitemap = t('datasets.sitemapProblem');
  if (f.source === 'upload' && !f.files.some((x) => !x.problem))
    e.files = t('datasets.filesProblem');
  if (f.source === 'endpoint' && !urlPattern.test(f.endpointUrl.trim()))
    e.endpointUrl = t('datasets.urlProblem');
  if (f.source === 'endpoint' && f.auth === 'api-key' && !f.apiKey.trim())
    e.auth = t('datasets.apiKeyProblem');
  if (
    f.source === 'endpoint' &&
    f.auth === 'api-key' &&
    f.apiKeyHeader.trim() &&
    !headerPattern.test(f.apiKeyHeader.trim())
  )
    e.header = t('datasets.headerProblem');
  const reason = reasonProblem(f.reason, t);
  if (reason) e.reason = reason;
  return e;
};

const authOf = (f: Form): EndpointAuth =>
  f.auth === 'api-key'
    ? {
        kind: 'api-key',
        apiKey: f.apiKey.trim(),
        ...(f.apiKeyHeader.trim() ? { header: f.apiKeyHeader.trim() } : {}),
      }
    : { kind: 'none' };

const endpointProblems: Record<number, PlainKey> = {
  403: 'datasets.endpointKeyRights',
  409: 'datasets.endpointExists',
};

const endpointFailure = (t: T, error: unknown) => {
  if (error instanceof ApiError) {
    if (error.problem?.type === 'urn:genai:problem:endpoint-not-allowed')
      return t('datasets.endpointNotAllowed');
    const known = endpointProblems[error.status];
    if (known) return t(known);
  }
  return failureText(t, error);
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
  tenantName,
  onCreated,
  onCancel,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
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
  const done = useRef<{
    id?: string;
    created?: boolean;
    pipeline?: boolean;
    uploaded?: boolean;
  }>({});
  const [engines, retryEngines] = useAsync(
    (signal) => api.searchEngines.endpoints(tenant, signal),
    [api, tenant],
  );
  const [existing, retryExisting] = useAsync(
    (signal) => api.datasets.list(tenant, signal),
    [api, tenant],
  );
  const prerequisitesReady = engines.status === 'ready' && existing.status === 'ready';
  const set = (patch: Partial<Form> | ((x: Form) => Partial<Form>)) =>
    setF((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) }));

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
  const takenNames =
    existing.status === 'ready' ? existing.data.map((d) => d.name.trim().toLowerCase()) : [];
  const errors = f.tried ? errorsFor(t, f, takenNames) : {};
  const errorList = Object.entries(errors) as [FieldKey, string][];
  const okFiles = f.files.filter((x) => !x.problem);

  const start = async () => {
    setFailure('');
    if (!prerequisitesReady) return;
    const taken = existing.status === 'ready' ? existing.data.map((d) => d.id) : [];
    const reason = f.reason.trim();
    if (f.source === 'endpoint') {
      try {
        setBusy(tRef.current('datasets.busyCreating'));
        const created = await api.datasets.createEndpoint(
          tenant,
          {
            name: f.name.trim(),
            residency: 'global',
            searchScope: f.searchScope,
            endpointSource: { url: f.endpointUrl.trim(), auth: authOf(f) },
          },
          reason,
        );
        onCreated(created.fullId);
      } catch (error) {
        setFailure(endpointFailure(tRef.current, error));
        setBusy('');
      }
      return;
    }
    const id = done.current.id ?? uniqueId(f.name, taken);
    done.current.id = id;
    const pipelineId = pipelineIds[f.source];
    try {
      if (!done.current.created) {
        setBusy(tRef.current('datasets.busyCreating'));
        await api.datasets.create(
          tenant,
          id,
          {
            name: f.name.trim(),
            endpoint: platformEngine,
            residency,
            searchScope: f.searchScope,
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
            schedule: f.schedule,
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

  const submit = () => {
    if (busy) return;
    if (Object.keys(errorsFor(t, f, takenNames)).length) {
      set({ tried: true });
      setTimeout(() => summaryRef.current?.focus(), 30);
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
        <Icon icon={ChevronLeftIcon} size={18} />
        {t('datasets.title')}
      </a>
      <div className="stack-xs">
        <Heading level={1} data-size="md">
          {t('datasets.newTitle')}
        </Heading>
        <p className="lead">{t('datasets.newLead')}</p>
      </div>
      {existing.status === 'error' ? (
        <div className="stack-xs">
          <Paragraph data-size="sm">{t('datasets.existingUnknown')}</Paragraph>
          <ErrorState error={existing.error} onRetry={retryExisting} headingLevel={2} />
        </div>
      ) : null}
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
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Textfield
          id="felt-navn"
          className="narrow-field"
          label={t('datasets.name')}
          description={t('datasets.newNameHelp')}
          value={f.name}
          error={errors.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <Fieldset className="source-options">
          <Fieldset.Legend>{t('datasets.whereFrom')}</Fieldset.Legend>
          {choices.map(([id, label, desc]) => (
            <label key={id} className={f.source === id ? 'source-option checked' : 'source-option'}>
              <input
                className="ds-input"
                type="radio"
                name="kilde"
                checked={f.source === id}
                onChange={() => set({ source: id, schedule: id === 'upload' ? 'none' : 'daily' })}
              />
              <span className="stack-xs">
                <span className="source-option-label">{t(label)}</span>
                <span className="source-option-desc">{t(desc)}</span>
              </span>
            </label>
          ))}
        </Fieldset>
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
        {f.source === 'endpoint' ? (
          <div className="stack">
            <Textfield
              id="felt-endepunkt"
              className="narrow-field"
              type="url"
              placeholder="https://"
              label={t('datasets.endpointUrl')}
              description={t('datasets.endpointUrlHelp')}
              value={f.endpointUrl}
              error={errors.endpointUrl}
              onChange={(e) => set({ endpointUrl: e.target.value })}
            />
            <Field className="narrow-field">
              <Label htmlFor="felt-innlogging">{t('datasets.endpointAuth')}</Label>
              <Select
                id="felt-innlogging"
                value={f.auth}
                onChange={(e) => set({ auth: e.target.value as AuthKind })}
              >
                {authKinds.map(([value, label]) => (
                  <Select.Option key={value} value={value}>
                    {t(label)}
                  </Select.Option>
                ))}
              </Select>
            </Field>
            {f.auth === 'api-key' ? (
              <>
                <Textfield
                  id="felt-innlogging-verdi"
                  className="narrow-field"
                  type="password"
                  autoComplete="off"
                  label={t('datasets.apiKey')}
                  description={t('datasets.apiKeyHelp')}
                  value={f.apiKey}
                  error={errors.auth}
                  onChange={(e) => set({ apiKey: e.target.value })}
                />
                <Textfield
                  id="felt-innlogging-header"
                  className="narrow-field"
                  autoComplete="off"
                  label={t('datasets.apiKeyHeader')}
                  description={t('datasets.apiKeyHeaderHelp')}
                  placeholder="x-api-key"
                  value={f.apiKeyHeader}
                  error={errors.header}
                  onChange={(e) => set({ apiKeyHeader: e.target.value })}
                />
              </>
            ) : null}
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
                    onChange={() => set((x) => ({ types: { ...x.types, [type]: !x.types[type] } }))}
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
                  {okFiles.length < f.files.length ? ` ${t('datasets.unreadableNotUploaded')}` : ''}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        {f.source !== 'endpoint' ? (
          <Fieldset>
            <Fieldset.Legend>{t('datasets.howOftenAgain')}</Fieldset.Legend>
            {frequencies.map(([value, label]) => (
              <Radio
                key={value}
                name="frequency"
                value={value}
                label={t(label)}
                checked={f.schedule === value}
                onChange={() => set({ schedule: value })}
              />
            ))}
          </Fieldset>
        ) : null}
        <Fieldset>
          <Fieldset.Legend>{t('datasets.whoSearchesQuestion')}</Fieldset.Legend>
          {scopeChoices.map((value) => (
            <Radio
              key={value}
              name="search-scope"
              value={value}
              label={
                value === 'tenant'
                  ? t('datasets.scopeTenant', { tenant: tenantName })
                  : t('datasets.scopeAll')
              }
              checked={f.searchScope === value}
              onChange={() => set({ searchScope: value })}
            />
          ))}
        </Fieldset>
        {f.source !== 'endpoint' ? (
          <section aria-labelledby="lagring-h" className="stack-xs">
            <Heading level={2} data-size="2xs" id="lagring-h">
              {t('datasets.whereStored')}
            </Heading>
            {engines.status === 'loading' ? (
              <span role="status" className="row-wrap">
                <Spinner aria-hidden="true" data-size="xs" />
                {t('searchEngine.loading')}
              </span>
            ) : engines.status === 'error' ? (
              <ErrorState error={engines.error} onRetry={retryEngines} headingLevel={3} />
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
        ) : null}
        <div id="felt-begrunnelse">
          <ReasonField
            value={f.reason}
            onChange={(reason) => set({ reason })}
            showError={f.tried}
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
        <div className="wizard-actions">
          <Button
            type="submit"
            variant="primary"
            aria-disabled={busy || !prerequisitesReady ? true : undefined}
          >
            {busy ? t('datasets.creating') : t('datasets.createAndIngest')}
          </Button>
          <Button type="button" variant="tertiary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
};
