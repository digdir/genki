import {
  Alert,
  Button,
  Chip,
  ErrorSummary,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Radio,
  Select,
  Spinner,
  Switch,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ChangeEvent, type ComponentRef } from 'react';
import { Icon } from '../../components/Icon';
import { kudosTypes, sampleFiles } from '../../data/datasets';
import { useT, type Format, type PlainKey, type T } from '../../i18n';
import { count } from './model';

const back = 'M15 6l-6 6 6 6';
type Source = 'kudos' | 'web' | 'upload';

export interface NewDatasetResult {
  name: string;
  source: Source;
  description: string;
  settings: [string, string][];
  estimatedDocs: number;
}

interface FileItem {
  name: string;
  size: string;
  ok: boolean;
}

interface Form {
  step: number;
  source: Source;
  name: string;
  org: 'alle' | 'egen';
  types: Record<string, boolean>;
  fromYear: string;
  url: string;
  include: string;
  exclude: string;
  pdf: boolean;
  files: FileItem[];
  schedule: 'natt' | 'uke' | 'manuelt';
  ocr: boolean;
  pii: boolean;
  tried: Record<number, boolean>;
  checking: boolean;
  checkOk: string;
}

const blank = (): Form => ({
  step: 1,
  source: 'kudos',
  name: '',
  org: 'alle',
  types: { Evaluering: true },
  fromYear: '2020',
  url: '',
  include: '',
  exclude: '/sok\n/logg-inn',
  pdf: true,
  files: [],
  schedule: 'natt',
  ocr: true,
  pii: true,
  tried: {},
  checking: false,
  checkOk: '',
});

export const exampleWebForm = (): Form => ({
  ...blank(),
  step: 2,
  source: 'web',
  name: 'Nettsidene til Prøvetilsynet',
  url: 'https://provetilsynet.example.no',
});

const urlPattern = /^https:\/\/[^\s.]+\.[^\s]+/;
const sourceNames: Record<Source, PlainKey> = {
  kudos: 'datasets.sourceKudos',
  web: 'datasets.sourceWeb',
  upload: 'datasets.sourceUpload',
};
const scheduleNames: Record<Form['schedule'], PlainKey> = {
  natt: 'datasets.scheduleNightly',
  uke: 'datasets.scheduleWeekly',
  manuelt: 'datasets.scheduleManual',
};

const errorsFor = (t: T, f: Form) => {
  const e: { name?: string; url?: string; files?: string } = {};
  if (f.step !== 2) return e;
  if (!f.name.trim()) e.name = t('datasets.nameProblem');
  if (f.source === 'web' && !urlPattern.test(f.url.trim())) e.url = t('datasets.urlProblem');
  if (f.source === 'upload' && !f.files.some((x) => x.ok)) e.files = t('datasets.filesProblem');
  return e;
};

const kudosEstimate = (f: Form) => {
  const chosen = kudosTypes.filter(([type]) => f.types[type]);
  const sum =
    (chosen.length ? chosen : kudosTypes).reduce((a, [, n]) => a + n, 0) +
    (chosen.length ? 0 : 4776);
  const factor: Record<string, number> = {
    2010: 1,
    2015: 0.78,
    2018: 0.6,
    2020: 0.47,
    2022: 0.33,
    2024: 0.13,
  };
  return Math.round(sum * (factor[f.fromYear] ?? 0.5) * (f.org === 'egen' ? 0.038 : 1));
};

const sizeLabel = (t: T, f: Format, bytes: number) =>
  bytes / 1024 > 1024
    ? t('datasets.sizeMb', { value: f.decimal(bytes / 1048576, 1) })
    : t('datasets.sizeKb', { value: f.number(Math.round(bytes / 1024)) });

export const NewDataset = ({
  tenantName,
  initial,
  onStart,
  onCancel,
}: {
  tenantName: string;
  initial?: Form;
  onStart: (result: NewDatasetResult) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const fmt = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [f, setF] = useState<Form>(initial ?? blank());
  const summaryRef = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(f.step);
  useEffect(() => {
    if (shownStep.current === f.step) return;
    shownStep.current = f.step;
    headingRef.current?.focus();
    window.scrollTo?.({ top: 0 });
  }, [f.step]);
  const set = (patch: Partial<Form> | ((x: Form) => Partial<Form>)) =>
    setF((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) }));

  const errors = f.tried[f.step] ? errorsFor(t, f) : {};
  const errorList = Object.entries(errors) as [keyof typeof errors, string][];
  const okFiles = f.files.filter((x) => x.ok);
  const estimate = kudosEstimate(f);
  const estDocs = f.source === 'kudos' ? estimate : f.source === 'web' ? 1240 : okFiles.length;
  const title = [
    t('datasets.stepChooseSource'),
    t('datasets.stepSetUp', { source: t(sourceNames[f.source]).toLowerCase() }),
    t('datasets.stepReview'),
  ][f.step - 1];
  const chosenTypes = kudosTypes.filter(([type]) => f.types[type]).map(([type]) => type);

  const summary: [string, string][] = [
    [t('datasets.name'), f.name],
    [t('datasets.factSource'), t(sourceNames[f.source])],
    ...(f.source === 'kudos'
      ? ([
          [
            t('datasets.selection'),
            t('datasets.selectionText', {
              scope:
                f.org === 'egen'
                  ? t('datasets.onlyTenant', { tenant: tenantName })
                  : t('datasets.allOrgs'),
              types: chosenTypes.join(', ') || t('datasets.allTypes'),
              year: f.fromYear,
            }),
          ],
        ] as [string, string][])
      : f.source === 'web'
        ? ([
            [t('datasets.startAddress'), f.url],
            [
              t('datasets.excludeShort'),
              f.exclude.split('\n').filter(Boolean).join(', ') || t('datasets.nothing'),
            ],
          ] as [string, string][])
        : ([[t('datasets.files'), okFiles.map((x) => x.name).join(', ')]] as [string, string][])),
    [
      t('datasets.update'),
      f.source === 'upload' ? t('datasets.updateOnUpload') : t(scheduleNames[f.schedule]),
    ],
    [t('datasets.ocr'), f.ocr ? t('datasets.on') : t('datasets.off')],
    [t('datasets.personalData'), f.pii ? t('datasets.piiMarked') : t('datasets.piiNotChecked')],
  ];

  const next = () => {
    if (Object.keys(errorsFor(t, f)).length) {
      set((x) => ({ tried: { ...x.tried, [x.step]: true } }));
      setTimeout(() => summaryRef.current?.focus(), 30);
      return;
    }
    if (f.step < 3) {
      set((x) => ({ step: x.step + 1 }));
      return;
    }
    onStart({
      name: f.name,
      source: f.source,
      description: {
        kudos: t('datasets.descKudos'),
        web: t('datasets.descWeb', { url: f.url }),
        upload: t('datasets.descUpload', { count: okFiles.length }),
      }[f.source],
      settings: [
        {
          kudos: ['Kilde', 'Kudos rapportarkiv'] as [string, string],
          web: ['Startadresse', f.url] as [string, string],
          upload: ['Kilde', `${okFiles.length} opplastede filer`] as [string, string],
        }[f.source],
        ['Tekstgjenkjenning', f.ocr ? 'På' : 'Av'],
      ],
      estimatedDocs: estDocs,
    });
  };

  const checkUrl = () => {
    if (!urlPattern.test(f.url.trim())) {
      set((x) => ({ tried: { ...x.tried, 2: true } }));
      return;
    }
    set({ checking: true, checkOk: '' });
    timer.current = setTimeout(
      () =>
        set({
          checking: false,
          checkOk: tRef.current('datasets.checkOk'),
        }),
      1100,
    );
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []).map((file) => ({
      name: file.name,
      size: sizeLabel(t, fmt, file.size),
      ok: !/\.(pages|key|numbers|zip)$/i.test(file.name),
    }));
    set((x) => ({ files: [...x.files, ...picked] }));
  };

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
                <ErrorSummary.Link
                  href={{ name: '#felt-navn', url: '#felt-url', files: '#felt-filer' }[key]}
                >
                  {text}
                </ErrorSummary.Link>
              </ErrorSummary.Item>
            ))}
          </ErrorSummary.List>
        </ErrorSummary>
      ) : null}

      {f.step === 1 ? (
        <Fieldset className="source-options">
          <Fieldset.Legend>{t('datasets.whereFrom')}</Fieldset.Legend>
          {(
            [
              [
                'kudos',
                t('datasets.sourceKudos'),
                t('datasets.choiceKudosDesc'),
                t('datasets.choiceKudosExample'),
              ],
              [
                'web',
                t('datasets.sourceWeb'),
                t('datasets.choiceWebDesc'),
                t('datasets.choiceWebExample'),
              ],
              [
                'upload',
                t('datasets.uploadFiles'),
                t('datasets.choiceUploadDesc'),
                t('datasets.choiceUploadExample'),
              ],
            ] as const
          ).map(([id, label, desc, example]) => (
            <label key={id} className={f.source === id ? 'source-option checked' : 'source-option'}>
              <input
                className="ds-input"
                type="radio"
                name="kilde"
                checked={f.source === id}
                onChange={() => set({ source: id })}
              />
              <span className="stack-xs">
                <span className="source-option-label">{label}</span>
                <span className="source-option-desc">{desc}</span>
                <span className="meta">{example}</span>
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
          {f.source === 'kudos' ? (
            <div className="stack">
              <Fieldset>
                <Fieldset.Legend>{t('datasets.reportsFrom')}</Fieldset.Legend>
                <Radio
                  name="kudos-org"
                  label={t('datasets.allOrgs')}
                  checked={f.org === 'alle'}
                  onChange={() => set({ org: 'alle' })}
                />
                <Radio
                  name="kudos-org"
                  label={t('datasets.onlyTenant', { tenant: tenantName })}
                  checked={f.org === 'egen'}
                  onChange={() => set({ org: 'egen' })}
                />
              </Fieldset>
              <Fieldset>
                <Fieldset.Legend>{t('datasets.documentTypes')}</Fieldset.Legend>
                <Fieldset.Description>{t('datasets.noTypeMeansAll')}</Fieldset.Description>
                <div className="tag-row">
                  {kudosTypes.map(([type]) => (
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
                  {['2010', '2015', '2018', '2020', '2022', '2024'].map((y) => (
                    <Select.Option key={y} value={y}>
                      {y}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
              <Alert data-color="info" data-size="sm" aria-live="polite">
                {t('datasets.estimateMatches', { amount: count(fmt, estimate) })}
              </Alert>
            </div>
          ) : null}
          {f.source === 'web' ? (
            <div className="stack">
              <Field>
                <Label htmlFor="felt-url">{t('datasets.startAddress')}</Label>
                <Field.Description>{t('datasets.startAddressHelp')}</Field.Description>
                <div className="url-row">
                  <Input
                    id="felt-url"
                    type="url"
                    placeholder="https://"
                    value={f.url}
                    aria-invalid={errors.url ? true : undefined}
                    onChange={(e) => set({ url: e.target.value, checkOk: '' })}
                  />
                  <Button
                    variant="secondary"
                    aria-disabled={f.checking || undefined}
                    onClick={() => {
                      if (!f.checking) checkUrl();
                    }}
                  >
                    {t('datasets.checkAddress')}
                  </Button>
                </div>
                {errors.url ? <ValidationMessage>{errors.url}</ValidationMessage> : null}
                <div aria-live="polite">
                  {f.checking ? (
                    <span role="status" className="row-wrap">
                      <Spinner aria-hidden="true" data-size="xs" />
                      {t('datasets.checkingSite')}
                    </span>
                  ) : null}
                  {f.checkOk ? (
                    <Alert data-color="success" data-size="sm">
                      {f.checkOk}
                    </Alert>
                  ) : null}
                </div>
              </Field>
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
                  <Field.Description>{t('datasets.excludeHelp')}</Field.Description>
                  <Textarea
                    id="felt-utelat"
                    rows={3}
                    value={f.exclude}
                    onChange={(e) => set({ exclude: e.target.value })}
                  />
                </Field>
              </div>
              <Switch
                label={t('datasets.readPdfs')}
                checked={f.pdf}
                onChange={() => set((x) => ({ pdf: !x.pdf }))}
              />
            </div>
          ) : null}
          {f.source === 'upload' ? (
            <div className="stack-sm">
              <div id="felt-filer" className="drop-zone" tabIndex={-1}>
                <Label htmlFor="filvelger">{t('datasets.chooseFiles')}</Label>
                <input
                  id="filvelger"
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.txt,.md,.html"
                  onChange={onFiles}
                />
                <span className="meta">{t('datasets.pickerHelp')}</span>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  onClick={() =>
                    set({
                      files: sampleFiles.map(([name, size]) => ({
                        name,
                        size,
                        ok: !/\.pages$/i.test(name),
                      })),
                    })
                  }
                >
                  {t('datasets.useSamples')}
                </Button>
              </div>
              {errors.files ? <ValidationMessage>{errors.files}</ValidationMessage> : null}
              {f.files.length > 0 ? (
                <>
                  <ul aria-label={t('datasets.chosenFiles')} className="file-list">
                    {f.files.map((file, i) => (
                      <li key={`${file.name}-${i}`}>
                        <span className="file-name">
                          <strong>{file.name}</strong>
                          <span className="meta">{file.size}</span>
                        </span>
                        <Tag data-size="sm" data-color={file.ok ? 'success' : 'danger'}>
                          {file.ok ? t('datasets.canRead') : t('datasets.formatUnsupported')}
                        </Tag>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('datasets.removeFile', { name: file.name })}
                          onClick={() => set((x) => ({ files: x.files.filter((_, j) => j !== i) }))}
                        >
                          {t('common.remove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <span className="meta">
                    {t('datasets.readableOf', { ok: okFiles.length, total: f.files.length })}
                    {okFiles.length < f.files.length ? ` ${t('datasets.unsupportedSkipped')}` : ''}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="options-box">
            {f.source !== 'upload' ? (
              <Field className="schedule-field">
                <Label htmlFor="felt-tidsplan">{t('datasets.update')}</Label>
                <Select
                  id="felt-tidsplan"
                  value={f.schedule}
                  onChange={(e) => set({ schedule: e.target.value as Form['schedule'] })}
                >
                  <Select.Option value="natt">{t('datasets.scheduleNightly')}</Select.Option>
                  <Select.Option value="uke">{t('datasets.scheduleWeekly')}</Select.Option>
                  <Select.Option value="manuelt">{t('datasets.scheduleManual')}</Select.Option>
                </Select>
              </Field>
            ) : null}
            <Switch
              label={t('datasets.ocr')}
              description={t('datasets.ocrDescriptionShort')}
              checked={f.ocr}
              onChange={() => set((x) => ({ ocr: !x.ocr }))}
            />
            <Switch
              label={t('datasets.pii')}
              description={t('datasets.piiDescriptionShort')}
              checked={f.pii}
              onChange={() => set((x) => ({ pii: !x.pii }))}
            />
          </div>
        </div>
      ) : null}

      {f.step === 3 ? (
        <div className="stack-sm">
          <dl className="summary-dl">
            {summary.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <dl className="facts">
            {[
              [t('datasets.factDocuments'), t('datasets.about', { value: count(fmt, estDocs) })],
              [
                t('datasets.time'),
                estDocs > 5000
                  ? t('datasets.about', { value: t('datasets.minutesShort', { count: 25 }) })
                  : estDocs > 500
                    ? t('datasets.about', { value: t('datasets.minutesShort', { count: 8 }) })
                    : t('datasets.underMinutes'),
              ],
              [
                t('datasets.ingestionCost'),
                t('datasets.about', {
                  value: t('datasets.krAmount', {
                    value: fmt.number(Math.max(1, Math.round(estDocs * 0.0016))),
                  }),
                }),
              ],
            ].map(([l, v]) => (
              <div key={l}>
                <dt>{l}</dt>
                <dd className="fact-text">{v}</dd>
              </div>
            ))}
          </dl>
          <Alert data-color="info" data-size="sm">
            {t('datasets.backgroundNote')}
          </Alert>
        </div>
      ) : null}

      <div className="wizard-actions">
        {f.step > 1 ? (
          <Button variant="secondary" onClick={() => set((x) => ({ step: x.step - 1 }))}>
            {t('common.previous')}
          </Button>
        ) : null}
        <Button variant="primary" onClick={next}>
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
