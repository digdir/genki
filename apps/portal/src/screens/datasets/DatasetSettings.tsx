import {
  Alert,
  Button,
  Chip,
  Details,
  DetailsContent,
  DetailsSummary,
  Dialog,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type {
  DatasetDeleteResult,
  DatasetDetailView,
  PipelineSource,
  PipelineView,
  Schedule,
  SearchScope,
} from '../../api/datasets';
import { reasonProblem, ReasonField } from '../../components/ReasonField';
import { kudosDocumentTypes } from '../../data/datasets';
import { useT, type PlainKey } from '../../i18n';
import {
  countText,
  failureText,
  fromGlobs,
  residencyText,
  sourceText,
  toGlobs,
} from './live-model';

const years = ['2010', '2015', '2018', '2020', '2022', '2024'];
const defaultFromYear = '2020';

interface SourceForm {
  name: string;
  description: string;
  sitemap: string;
  include: string;
  exclude: string;
  types: string[];
  fromYear: string;
  schedule: Schedule;
  searchScope: SearchScope;
}

const formOf = (view: DatasetDetailView, pipeline: PipelineView | undefined): SourceForm => {
  const source = pipeline?.spec.source;
  return {
    name: view.name,
    description: view.description ?? '',
    sitemap: source?.kind === 'website' ? source.sitemap : '',
    include: source?.kind === 'website' ? fromGlobs(source.include) : '',
    exclude: source?.kind === 'website' ? fromGlobs(source.exclude) : '',
    types: source?.kind === 'kudos' ? source.types : [],
    fromYear: source?.kind === 'kudos' && source.since ? source.since.slice(0, 4) : defaultFromYear,
    schedule: pipeline?.spec.schedule ?? 'none',
    searchScope: view.searchScope ?? 'tenant',
  };
};

/** A source with no start date lists every year, so the default year is written only when changed. */
const kudosSourceFrom = (
  form: SourceForm,
  current: Extract<PipelineSource, { kind: 'kudos' }>,
): PipelineSource => {
  const next: Extract<PipelineSource, { kind: 'kudos' }> = { ...current, types: form.types };
  if (current.since || form.fromYear !== defaultFromYear) next.since = `${form.fromYear}-01-01`;
  return next;
};

const sourceFrom = (form: SourceForm, current: PipelineSource): PipelineSource =>
  current.kind === 'website'
    ? {
        kind: 'website',
        sitemap: form.sitemap.trim(),
        include: toGlobs(form.include),
        exclude: toGlobs(form.exclude),
      }
    : current.kind === 'kudos'
      ? kudosSourceFrom(form, current)
      : current;

const frequencies: [Schedule, PlainKey, PlainKey][] = [
  ['daily', 'datasets.scheduleNightly', 'datasets.scheduleNightlyHelp'],
  ['weekly', 'datasets.scheduleWeeklyOption', 'datasets.scheduleWeeklyHelp'],
  ['none', 'datasets.scheduleManual', 'datasets.scheduleManualHelp'],
];

const scopes: SearchScope[] = ['tenant', 'all'];

export const SourceSettings = ({
  api,
  tenant,
  tenantName,
  view,
  pipeline,
  onSaved,
  onDirty,
  children,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  view: DatasetDetailView;
  pipeline: PipelineView | undefined;
  onSaved: (text: string) => void;
  onDirty: (dirty: boolean) => void;
  children?: ReactNode;
}) => {
  const t = useT();
  const fmt = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const ownScope = view.editable;
  const [saved, setSaved] = useState(() => formOf(view, pipeline));
  const [form, setForm] = useState(saved);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const set = (patch: Partial<SourceForm>) => setForm((f) => ({ ...f, ...patch }));
  const source = pipeline?.spec.source;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const nameMissing = !form.name.trim();

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const discard = () => {
    setForm(saved);
    setReason('');
    setTried(false);
    setFailure('');
  };

  const save = async () => {
    if (busy) return;
    setTried(true);
    if (reasonProblem(reason, t) || nameMissing) return;
    setBusy(true);
    setFailure('');
    const why = reason.trim();
    try {
      const scopeChanged = form.searchScope !== saved.searchScope;
      if (
        form.name.trim() !== view.name ||
        form.description.trim() !== (view.description ?? '') ||
        scopeChanged
      )
        await api.datasets.rename(
          tenant,
          view.id,
          {
            name: form.name.trim(),
            description: form.description.trim(),
            ...(scopeChanged ? { searchScope: form.searchScope } : {}),
          },
          why,
        );
      if (pipeline && source) {
        const spec = {
          ...pipeline.spec,
          name: form.name.trim(),
          source: sourceFrom(form, source),
          schedule: form.schedule,
        };
        if (JSON.stringify(spec) !== JSON.stringify(pipeline.spec))
          await api.datasets.savePipeline(tenant, view.id, pipeline.id, spec, why);
      }
      setSaved(form);
      setReason('');
      setTried(false);
      onSaved(tRef.current('datasets.savedAt', { time: fmt.time(new Date()) }));
    } catch (error) {
      setFailure(failureText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack dataset-settings">
      <section aria-labelledby="om-h" className="source-card">
        <h2 id="om-h" className="card-title">
          {t('datasets.aboutDataset')}
        </h2>
        <Textfield
          label={t('datasets.name')}
          description={t('datasets.nameHelp')}
          value={form.name}
          error={nameMissing ? t('datasets.nameProblem') : undefined}
          onChange={(e) => set({ name: e.target.value })}
        />
        <Textfield
          label={t('datasets.description')}
          multiline
          rows={2}
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
        />
        <dl className="source-dl">
          <div>
            <dt>{t('datasets.factSource')}</dt>
            <dd>{t(sourceText[view.source])}</dd>
          </div>
        </dl>
        {source?.kind === 'website' ? (
          <>
            <Textfield
              type="url"
              label={t('datasets.sitemapLabel')}
              value={form.sitemap}
              onChange={(e) => set({ sitemap: e.target.value })}
            />
            <Field>
              <Label htmlFor="kilde-med">{t('datasets.includeOnly')}</Label>
              <Field.Description>{t('datasets.includeHelp')}</Field.Description>
              <Textarea
                id="kilde-med"
                rows={3}
                value={form.include}
                onChange={(e) => set({ include: e.target.value })}
              />
            </Field>
            <Field>
              <Label htmlFor="kilde-utelat">{t('datasets.exclude')}</Label>
              <Textarea
                id="kilde-utelat"
                rows={3}
                value={form.exclude}
                onChange={(e) => set({ exclude: e.target.value })}
              />
            </Field>
          </>
        ) : null}
        {source?.kind === 'kudos' ? (
          <>
            <Fieldset>
              <Fieldset.Legend>{t('datasets.documentTypes')}</Fieldset.Legend>
              <Fieldset.Description>{t('datasets.noTypeMeansAll')}</Fieldset.Description>
              <div className="tag-row">
                {kudosDocumentTypes.map((type) => (
                  <Chip.Checkbox
                    key={type}
                    checked={form.types.includes(type)}
                    onChange={() =>
                      set({
                        types: form.types.includes(type)
                          ? form.types.filter((x) => x !== type)
                          : [...form.types, type],
                      })
                    }
                  >
                    {type}
                  </Chip.Checkbox>
                ))}
              </div>
            </Fieldset>
            <Field className="year-field">
              <Label htmlFor="kilde-fra-ar">{t('datasets.fromYear')}</Label>
              <Select
                id="kilde-fra-ar"
                value={form.fromYear}
                onChange={(e) => set({ fromYear: e.target.value })}
              >
                {years.map((y) => (
                  <Select.Option key={y} value={y}>
                    {y}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          </>
        ) : null}
      </section>
      {source ? (
        <section aria-labelledby="innlesing-h" className="source-card">
          <h2 id="innlesing-h" className="card-title">
            {t('datasets.ingestionHeading')}
          </h2>
          <Fieldset>
            <Fieldset.Legend>{t('datasets.howOften')}</Fieldset.Legend>
            {frequencies.map(([value, label, help]) => (
              <Radio
                key={value}
                name="frequency"
                value={value}
                label={t(label)}
                description={t(
                  value === 'none' && source.kind === 'upload'
                    ? 'datasets.scheduleManualUploadHelp'
                    : help,
                )}
                checked={form.schedule === value}
                onChange={() => set({ schedule: value })}
              />
            ))}
          </Fieldset>
        </section>
      ) : null}
      {ownScope ? (
        <section aria-labelledby="hvem-h" className="source-card">
          <h2 id="hvem-h" className="card-title">
            {t('datasets.whoSearches')}
          </h2>
          <Fieldset>
            <Fieldset.Legend className="visually-hidden">
              {t('datasets.whoSearches')}
            </Fieldset.Legend>
            {scopes.map((value) => (
              <Radio
                key={value}
                name="search-scope"
                value={value}
                label={
                  value === 'tenant'
                    ? t('datasets.scopeTenant', { tenant: tenantName })
                    : t('datasets.scopeAll')
                }
                description={
                  value === 'tenant'
                    ? t('datasets.scopeTenantHelp', { tenant: tenantName })
                    : t('datasets.scopeAllHelp')
                }
                checked={form.searchScope === value}
                onChange={() => set({ searchScope: value })}
              />
            ))}
          </Fieldset>
        </section>
      ) : null}
      {children}
      {dirty ? (
        <section className="dataset-save-bar stack-sm" aria-label={t('datasets.unsaved')}>
          <strong>{t('datasets.unsaved')}</strong>
          <ReasonField value={reason} onChange={setReason} showError={tried} rows={1} />
          <div aria-live="polite">
            {failure ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {t('datasets.changesNotSaved', { problem: failure })}
              </Alert>
            ) : null}
          </div>
          <div className="actions">
            <Button variant="secondary" onClick={discard}>
              {t('datasets.discard')}
            </Button>
            <Button variant="primary" aria-disabled={busy || undefined} onClick={() => void save()}>
              {busy ? t('datasets.saving') : t('datasets.saveChanges')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
};

export const Technical = ({
  view,
  children,
}: {
  view: DatasetDetailView;
  children: (open: boolean) => ReactNode;
}) => {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  return (
    <Details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <DetailsSummary>{t('datasets.technical')}</DetailsSummary>
      <DetailsContent>
        <div className="stack">
          <dl className="facts">
            {[
              [t('datasets.factEngine'), view.index?.endpoint ?? t('datasets.notAvailable')],
              [t('datasets.factProcessed'), residencyText(t, view.effectiveResidency)],
              [t('datasets.factDocuments'), countText(t, f, view.documents)],
              [t('datasets.factChunks'), countText(t, f, view.chunks)],
              [t('datasets.factDatasetId'), view.fullId],
            ].map(([l, v]) => (
              <div key={l}>
                <dt>{l}</dt>
                <dd className="fact-text">{v}</dd>
              </div>
            ))}
          </dl>
          {children(open)}
        </div>
      </DetailsContent>
    </Details>
  );
};

export const DeleteDataset = ({
  api,
  tenant,
  view,
  onDeleted,
}: {
  api: ApiClient;
  tenant: string;
  view: DatasetDetailView;
  onDeleted: (result: DatasetDeleteResult) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const readers = view.usedBy ?? [];
  const blocked = readers.length > 0;
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const matches = typed.trim() === view.name.trim();

  const close = () => {
    setConfirming(false);
    setTyped('');
    setReason('');
    setTried(false);
    setFailure('');
  };

  const confirm = async () => {
    setTried(true);
    if (blocked || busy || !matches || reasonProblem(reason, t)) return;
    setBusy(true);
    setFailure('');
    try {
      onDeleted(await api.datasets.remove(tenant, view.id, reason.trim()));
    } catch (error) {
      setFailure(failureText(tRef.current, error));
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="slett-h" className="source-card">
      <h2 id="slett-h" className="card-title">
        {t('datasets.deleteTitle')}
      </h2>
      <p className="meta">{t('datasets.deleteIntro')}</p>
      {blocked ? (
        <Alert data-color="info" data-size="sm">
          {t('datasets.deleteBlockedBy', {
            names: readers
              .map((r) =>
                r.kind === 'service' ? r.name : t('datasets.readerAdoption', { tenant: r.tenant }),
              )
              .join(', '),
          })}
        </Alert>
      ) : null}
      <Button
        variant="secondary"
        data-color="danger"
        data-size="sm"
        className="align-start"
        aria-disabled={blocked || undefined}
        onClick={() => !blocked && setConfirming(true)}
      >
        {t('datasets.deleteDataset')}
      </Button>
      {confirming ? (
        <Dialog open modal onClose={close} aria-labelledby="slett-dialog-h">
          <div className="stack-sm">
            <Heading level={2} data-size="xs" id="slett-dialog-h">
              {t('datasets.deleteQuestion', { name: view.name })}
            </Heading>
            <Paragraph>
              {t('datasets.deleteForGood')}
              {view.source === 'endpoint' ? ` ${t('datasets.deleteEndpointToo')}` : ''}
            </Paragraph>
            <Textfield
              label={t('datasets.typeNameToConfirm')}
              autoComplete="off"
              value={typed}
              error={tried && !matches ? t('datasets.typeNameProblem') : undefined}
              onChange={(e) => setTyped(e.target.value)}
            />
            <ReasonField value={reason} onChange={setReason} showError={tried} rows={1} />
            <div aria-live="polite">
              {failure ? (
                <Alert data-color="danger" data-size="sm" role="alert">
                  {t('datasets.deleteFailed', { problem: failure })}
                </Alert>
              ) : null}
            </div>
            <div className="actions">
              <Button variant="secondary" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                data-color="danger"
                aria-disabled={!matches || busy || undefined}
                onClick={() => void confirm()}
              >
                {busy ? t('datasets.deleting') : t('datasets.deleteDataset')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
};

export const LeaveDialog = ({ onLeave, onStay }: { onLeave: () => void; onStay: () => void }) => {
  const t = useT();
  return (
    <Dialog open modal onClose={onStay} aria-labelledby="leave-h">
      <div className="stack-sm">
        <Heading level={2} data-size="xs" id="leave-h">
          {t('datasets.leaveQuestion')}
        </Heading>
        <Paragraph>{t('datasets.leaveText')}</Paragraph>
        <div className="actions">
          <Button variant="secondary" data-color="danger" onClick={onLeave}>
            {t('datasets.leaveWithoutSaving')}
          </Button>
          <Button variant="primary" autoFocus onClick={onStay}>
            {t('datasets.stay')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
