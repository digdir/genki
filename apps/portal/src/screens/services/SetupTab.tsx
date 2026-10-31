import type { FlowInputCheck } from '../../data/flow-inputs';
import {
  Alert,
  Button,
  EXPERIMENTAL_FileUpload,
  EXPERIMENTAL_Suggestion,
  Card,
  Heading,
  Checkbox,
  Chip,
  Details,
  Field,
  Input,
  Label,
  Radio,
  Select,
  Switch,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { SparklesIcon } from '@navikt/aksel-icons';
import { useId, useState, type ReactNode } from 'react';
import { Icon, icons } from '../../components/Icon';
import {
  exampleDatasets,
  modelFor,
  models,
  prohibitedUses,
  toolGroups,
  tools,
  type ModelChoice,
} from '../../data/services';
import type {
  OutputField,
  OutputFieldType,
  ServiceDefinition,
  ServiceSpec,
  SpecEdit,
} from '../../data/service-definition';
import {
  audienceIds,
  channelGroups,
  channelKeys,
  channelOn,
  datasetsOf,
  defaultPublicName,
  examplesOf,
  filterText,
  flowOf,
  guardOn,
  improves,
  inputChoiceOn,
  inputChoices,
  languageModeOf,
  offeredAudiences,
  presetOf,
  refuseTopicsOf,
  riskClasses,
  schedulePresets,
  toolRefsOf,
  triggerOf,
  variantsOf,
  withChannel,
  withDatasets,
  withExamples,
  withFallback,
  withGuard,
  withImprove,
  withInputChoice,
  withLanguageMode,
  withModel,
  withOutputKind,
  withPublicCard,
  withPublicName,
  withRefuseTopics,
  withRisk,
  withRuntimeDocuments,
  withTool,
  withTrigger,
  type InputChoice,
  type LanguageMode,
  type SchedulePreset,
} from '../../data/service-form';
import { sharedInstructionsOf, withSharedInstructions } from '../../data/service-languages';
import { defaultInstructionsOf, strategyFor, takesOf } from '../../data/strategies';
import type { AsyncState } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { useUserName } from '../../Shell';
import { ErrorState } from '../../states';
import { InputFieldsEditor, type InputOptionLookup } from './InputFormEditor';
import { TableColumnsEditor, type TableSpec } from './TableOutputEditor';
import { VariantsEditor } from './VariantsEditor';
import type { ApiClient } from '../../api';
import { A2aChannel } from '../integrations/A2aChannel';

export interface DatasetOption {
  id: string;
  name: string;
  shared: boolean;
}

export interface ToolOption {
  ref: string;
  name: string;
  description: string;
  connection: string;
}

export interface LiveCatalogs {
  datasets: AsyncState<DatasetOption[]>;
  tools: AsyncState<ToolOption[]>;
}

export type SectionId =
  | 'purpose'
  | 'io'
  | 'result'
  | 'instructions'
  | 'knowledge'
  | 'tools'
  | 'how'
  | 'model'
  | 'variants'
  | 'risk'
  | 'guards'
  | 'start'
  | 'inputKinds'
  | 'inputForm'
  | 'refuse';

export const sectionTitles: Record<SectionId, PlainKey> = {
  purpose: 'setup.sectionPurpose',
  io: 'setup.sectionIo',
  result: 'setup.sectionResult',
  instructions: 'setup.sectionInstructions',
  knowledge: 'setup.sectionKnowledge',
  tools: 'setup.sectionTools',
  how: 'setup.sectionHow',
  model: 'setup.sectionModel',
  variants: 'setup.sectionVariants',
  risk: 'setup.sectionRisk',
  guards: 'setup.sectionGuards',
  start: 'setup.sectionStart',
  inputKinds: 'setup.sectionInput',
  inputForm: 'inputForm.heading',
  refuse: 'setup.refuseTopics',
};

const audienceKeys: Record<string, PlainKey> = {
  employees: 'setup.audienceEmployees',
  agencies: 'setup.audienceAgencies',
  public: 'setup.audiencePublic',
};

const inputKeys: Record<string, PlainKey> = {
  text: 'setup.inputText',
  files: 'setup.inputFiles',
  audio: 'setup.inputAudio',
  system: 'setup.inputSystem',
};

const riskKeys: Record<string, [PlainKey, PlainKey]> = {
  minimal: ['setup.riskMinimal', 'setup.riskMinimalDesc'],
  limited: ['setup.riskLimited', 'setup.riskLimitedDesc'],
  high: ['setup.riskHigh', 'setup.riskHighDesc'],
};

const fieldTypeKeys: Record<OutputFieldType, PlainKey> = {
  string: 'setup.typeText',
  number: 'setup.typeNumber',
  date: 'setup.typeDate',
  boolean: 'setup.typeYesNo',
  list: 'setup.typeList',
};

const docTemplateKeys: Record<string, PlainKey> = {
  Svarbrev: 'setup.templateReply',
  Vedtaksutkast: 'setup.templateDecision',
  Oppsummering: 'setup.templateSummary',
  Møtereferat: 'setup.templateMinutes',
  Notat: 'setup.templateNote',
};

const toolGroupKeys: Record<string, PlainKey> = {
  Plattformverktøy: 'setup.groupPlatform',
  'Fellestjenester fra Digdir': 'setup.groupDigdir',
  'API-er og MCP-servere': 'setup.groupApis',
  'Andre tjenester på plattformen': 'setup.groupServices',
};

const startGroupKeys: Record<string, PlainKey> = {
  chat: 'setup.groupChat',
  system: 'setup.groupSystem',
  trigger: 'setup.groupTrigger',
  batch: 'setup.groupBatch',
};

export const startKeys: Record<string, PlainKey> = {
  chatOwn: 'setup.startChatOwn',
  api: 'setup.startApi',
  mcp: 'setup.startMcp',
  openai: 'setup.startOpenai',
  a2a: 'setup.startA2a',
  fileTrigger: 'setup.startFileTrigger',
  queue: 'setup.startQueue',
  schedule: 'setup.startSchedule',
  batch: 'setup.startBatch',
};

const modelWordKeys: Record<string, PlainKey> = {
  Norge: 'setup.wordNorway',
  Lav: 'setup.wordLow',
  Middels: 'setup.wordMedium',
  Høy: 'setup.wordHigh',
  Rask: 'setup.wordFast',
  'Ikke oppgitt': 'setup.wordNotStated',
};

const prohibitedKeys: PlainKey[] = [
  'setup.prohibited1',
  'setup.prohibited2',
  'setup.prohibited3',
  'setup.prohibited4',
  'setup.prohibited5',
];

const labelOf = (t: T, table: Record<string, PlainKey>, id: string) => {
  const key = table[id];
  return key ? t(key) : id;
};

const pairLabel = (t: T, table: Record<string, [PlainKey, PlainKey]>, id: string) => {
  const keys = table[id];
  return keys ? t(keys[0]) : undefined;
};

const riskLabel = (t: T, id: string) => pairLabel(t, riskKeys, id);

const rerankerNames: Record<string, string> = { colbert: 'ColBERT' };

export const rerankerOf = (spec: ServiceSpec) => {
  const id = spec.knowledge?.reranker;
  return typeof id === 'string' && id ? (rerankerNames[id] ?? id) : undefined;
};

export const defaultInstructions = (t: T, spec: ServiceSpec) => {
  if (sharedInstructionsOf(spec)) return undefined;
  const flow = flowOf(spec);
  if (flow) return t('setup.instructionsInFlow', { flow });
  if (spec.strategy.id === 'remote-agent') return t('setup.instructionsRemote');
  return spec.strategy.id && !['single-call', 'step-flow'].includes(spec.strategy.id)
    ? t('setup.instructionsBuiltIn')
    : undefined;
};

const BuiltInInstructions = ({
  strategy,
  own,
  onUse,
}: {
  strategy: string | undefined;
  own: boolean;
  onUse?: ((text: string) => void) | undefined;
}) => {
  const t = useT();
  const found = defaultInstructionsOf(strategy, t.locale);
  if (!found) return null;
  return (
    <Card data-color="neutral" data-variant="default">
      <Details data-size="sm">
        <Details.Summary>
          {own ? t('setup.defaultInstructionsCompare') : t('setup.defaultInstructionsShow')}
        </Details.Summary>
        <Details.Content>
          <div className="stack-xs">
            <Field>
              <Label htmlFor="felt-standardinstr">{t('setup.defaultInstructionsLabel')}</Label>
              <Textarea
                id="felt-standardinstr"
                rows={10}
                readOnly
                className="instructions-editor"
                value={found.text}
              />
            </Field>
            {found.note ? <p className="meta">{found.note}</p> : null}
            {own || !onUse ? null : (
              <Button
                variant="secondary"
                data-size="sm"
                className="align-start"
                onClick={() => onUse(found.text)}
              >
                {t('setup.defaultInstructionsUse')}
              </Button>
            )}
          </div>
        </Details.Content>
      </Details>
    </Card>
  );
};

const inputChoiceIds = Object.keys(inputChoices) as InputChoice[];

export const datasetName = (ref: string, names?: Map<string, string>) =>
  names?.get(ref) ?? exampleDatasets[ref]?.name ?? ref;

const toolName = (ref: string) => tools.find((x) => x.ref === ref)?.name ?? ref;

export const summaries = (
  t: T,
  d: ServiceDefinition,
  catalog?: ModelChoice[],
  datasetNames?: Map<string, string>,
  frontends: string[] = [],
): Record<SectionId | 'input', string> => {
  const s = d.spec;
  const m =
    catalog?.find((x) => x.id === s.model.primary) ??
    modelFor(s.model.primary, s.model.residency, !!catalog);
  const fb = (catalog ?? models).find((x) => x.id === s.model.fallback);
  const high = s.riskClass === 'high';
  const instructions = sharedInstructionsOf(s);
  const datasets = datasetsOf(s);
  const toolRefs = toolRefsOf(s);
  const variants = variantsOf(s);
  const ioIn = `${
    inputChoiceIds
      .filter((i) => inputChoiceOn(s, i))
      .map((i) => labelOf(t, inputKeys, i))
      .join(', ') || t('setup.nothingChosen')
  }${s.input.fields?.length ? t('setup.formWithFields', { count: s.input.fields.length }) : ''}`;
  const ioOut =
    s.output.kind === 'fields'
      ? t('setup.outFields', { count: s.output.fields?.length ?? 0 })
      : s.output.kind === 'document'
        ? t('setup.outDocument', { template: s.output.template || '?' })
        : s.output.kind === 'table'
          ? t('setup.outTable')
          : t(s.output.withSources ? 'setup.outAnswerSources' : 'setup.outAnswer');
  return {
    purpose:
      audienceIds
        .filter((a) => (s.audience as string[] | undefined)?.includes(a))
        .map((a) => labelOf(t, audienceKeys, a))
        .join(', ') || t('setup.nothingChosen'),
    risk: riskLabel(t, s.riskClass ?? '') ?? t('setup.riskNotSet'),
    input: ioIn,
    io: `${ioIn} → ${ioOut}`,
    result: ioOut,
    instructions: instructions
      ? `${(instructions.split('\n')[0] ?? '').slice(0, 90)}${instructions.length > 90 ? '…' : ''}`
      : (defaultInstructions(t, s) ?? t('setup.notWritten')),
    knowledge: `${
      datasets.length
        ? datasets.map((ref) => datasetName(ref.dataset, datasetNames)).join(', ')
        : t('setup.noDatasetsShort')
    }${datasets.length && rerankerOf(s) ? t('setup.rerankedSuffix', { name: rerankerOf(s) ?? '' }) : ''}${
      s.knowledge?.runtimeDocuments ? t('setup.runtimeDocsSuffix') : ''
    }`,
    tools: toolRefs.length ? toolRefs.map(toolName).join(', ') : t('setup.noToolsShort'),
    how: strategyFor(s.strategy.id, t)?.name ?? t('setup.notChosen'),
    variants: `${t('setup.variantsSummary', { count: variants.length })}${
      variants.some((v) => v.strategy)
        ? t('setup.variantsOwnWaySummary', {
            count: variants.filter((v) => v.strategy).length,
          })
        : ''
    }`,
    model: `${t('setup.modelSummary', { name: m?.name ?? s.model.primary, where: modelWord(t, m?.where ?? 'Norge') })}${fb ? t('setup.reserveSummary', { name: fb.name }) : t('setup.noReserveSummary')}`,
    guards:
      [
        (guardOn(s, 'pii-before-model') || guardOn(s, 'pii-out-of-log')) && t('setup.guardPii'),
        guardOn(s, 'require-sources') && s.output.kind !== 'fields' && t('setup.guardSources'),
        refuseTopicsOf(s).length && t('setup.guardRefuse', { count: refuseTopicsOf(s).length }),
        (guardOn(s, 'human-approval') || high) && t('setup.guardHuman'),
      ]
        .filter(Boolean)
        .join(', ') || t('setup.guardNone'),
    inputKinds: ioIn,
    inputForm: s.input.fields?.length
      ? t('setup.formWithFields', { count: s.input.fields.length })
      : t('setup.nothingChosen'),
    refuse: refuseTopicsOf(s).join(', ') || t('setup.nothingChosen'),
    start:
      [
        ...channelKeys.filter((x) => channelOn(s, x)).map((x) => labelOf(t, startKeys, x)),
        ...(frontends.length ? [t('setup.startFrontends', { names: frontends.join(', ') })] : []),
      ].join(', ') || t('setup.noStart'),
  };
};

export const modelWord = (t: T, word: string) => labelOf(t, modelWordKeys, word);

export const piiConflict = (t: T, spec: ServiceSpec) =>
  guardOn(spec, 'pii-before-model') &&
  spec.output.kind === 'fields' &&
  (spec.output.fields ?? []).some((f) => /navn|fødselsnummer|adresse/i.test(f.name))
    ? t('setup.piiConflict')
    : '';

const residencyOfChoice = (m: ModelChoice, live: boolean) =>
  live ? m.residency : m.where === 'Norge' ? 'norway' : m.where === 'EU' ? 'eu' : undefined;

const required = ({ required: _optional, ...field }: OutputField): OutputField => field;

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const Section = ({
  id,
  visible,
  open,
  highlight,
  fromAi,
  summary,
  onToggle,
  readOnly = false,
  continuous = false,
  title,
  children,
}: {
  continuous?: boolean;
  title?: string;
  id: SectionId;
  visible: boolean;
  open: boolean;
  highlight: boolean;
  fromAi: boolean;
  summary: string;
  onToggle: () => void;
  readOnly?: boolean;
  children: ReactNode;
}) => {
  const t = useT();
  const body = readOnly ? (
    <fieldset disabled className="setup-readonly">
      {children}
    </fieldset>
  ) : (
    children
  );
  if (!visible) return null;
  if (continuous)
    return (
      <section
        id={`sek-${id}`}
        aria-labelledby={`sek-${id}-tittel`}
        className={highlight ? 'setup-part highlight' : 'setup-part'}
      >
        <div className="setup-part-head">
          <Heading level={2} data-size="xs" id={`sek-${id}-tittel`}>
            {title ?? t(sectionTitles[id])}
          </Heading>
          {fromAi ? (
            <Tag data-size="sm" data-color="info">
              {t('setup.fromAssistant')}
            </Tag>
          ) : null}
        </div>
        <div id={`sek-${id}-innhold`} className="setup-body">
          {body}
        </div>
      </section>
    );
  return (
    <section id={`sek-${id}`} className={highlight ? 'setup-section highlight' : 'setup-section'}>
      <h2 className="setup-heading">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`sek-${id}-innhold`}
          onClick={onToggle}
          className="setup-toggle"
        >
          <span className="setup-toggle-text">
            <span className="setup-title">{title ?? t(sectionTitles[id])}</span>
            {summary ? <span className="meta setup-summary">{summary}</span> : null}
          </span>
          {fromAi ? (
            <Tag data-size="sm" data-color="info">
              {t('setup.fromAssistant')}
            </Tag>
          ) : null}
          <span className={open ? 'chevron open' : 'chevron'}>
            <Icon d={icons.chevronDown} />
          </span>
        </button>
      </h2>
      {open ? (
        <div id={`sek-${id}-innhold`} className="setup-body">
          {body}
        </div>
      ) : null}
    </section>
  );
};

interface Props {
  serviceId: string;
  definition: ServiceDefinition;
  patch: (edit: SpecEdit) => void;
  onRename: (name: string) => void;
  open: Partial<Record<SectionId, boolean>>;
  onToggle: (id: SectionId) => void;
  highlight: string;
  fromAi: Partial<Record<string, boolean>>;
  prohibited: Record<number, boolean>;
  onProhibited: (i: number) => void;
  riskConfirmed: boolean;
  onConfirmRisk: () => void;
  narrow: boolean;
  modelCatalog?: ModelChoice[] | undefined;
  live?: LiveCatalogs;
  sections?: SectionId[];
  strategy?: ReactNode;
  guardrails?: ReactNode;
  instructionsAssist?: ReactNode;
  instructionsUnderPurpose?: boolean;
  safetyTogether?: boolean;
  sourcesTogether?: boolean;
  continuous?: boolean;
  apart?: boolean;
  resultWish?: string;
  onResultWish?: (text: string) => void;
  onAsk?: ((question: string) => void) | undefined;
  askOff?: boolean;
  languageTabs?: (shared: ReactNode) => ReactNode;
  inputLockedIds?: string[];
  inputLookup?: InputOptionLookup | undefined;
  tenant?: string;
  flowCheck?: FlowInputCheck | undefined;
  frontends?: string[];
  readOnly?: boolean;
  api?: ApiClient | undefined;
}

/** A web address the owner typed, with https added when it is left out, or nothing when it is not one. */
export const webAddress = (text: string) => {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.')
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

const pickClass = (on: boolean) => (on ? 'pick-card picked' : 'pick-card');

export const SetupTab = ({
  serviceId,
  definition: d,
  patch,
  onRename,
  open,
  onToggle,
  highlight,
  fromAi,
  prohibited,
  onProhibited,
  riskConfirmed,
  onConfirmRisk,
  narrow,
  modelCatalog,
  live,
  sections,
  strategy,
  guardrails,
  instructionsAssist,
  instructionsUnderPurpose = false,
  safetyTogether = false,
  sourcesTogether = false,
  continuous = false,
  apart = false,
  resultWish = '',
  onResultWish,
  onAsk,
  askOff = false,
  languageTabs,
  inputLockedIds,
  inputLookup,
  tenant,
  flowCheck,
  frontends,
  readOnly = false,
  api,
}: Props) => {
  const t = useT();
  const userName = useUserName();
  const modelList = modelCatalog ?? models;
  const [catalog, setCatalog] = useState(false);
  const [datasetPicker, setDatasetPicker] = useState(false);
  const [refuseInput, setRefuseInput] = useState('');
  const [ownDocuments, setOwnDocuments] = useState<string[]>([]);
  const ownDocumentsId = useId();
  const [webPages, setWebPages] = useState<string[]>([]);
  const [webInput, setWebInput] = useState('');
  const [webInvalid, setWebInvalid] = useState(false);
  const addWebPage = () => {
    const v = webInput.trim();
    if (!v) return;
    const url = webAddress(v);
    if (!url) return setWebInvalid(true);
    setWebPages((cur) => (cur.includes(url) ? cur : [...cur, url]));
    setWebInput('');
    setWebInvalid(false);
  };
  const s = d.spec;
  const datasetNames =
    live?.datasets.status === 'ready'
      ? new Map(live.datasets.data.map((x) => [x.id, x.name] as const))
      : undefined;
  const sum = summaries(t, d, modelCatalog, datasetNames, frontends);
  const high = s.riskClass === 'high';
  const forbidden = Object.values(prohibited).some(Boolean);
  const primary = s.model.primary;
  const m =
    modelCatalog?.find((x) => x.id === primary) ??
    modelFor(primary, s.model.residency, !!modelCatalog);
  const fb = modelList.find((x) => x.id === s.model.fallback);
  const fallbackWarn =
    fb && m && fb.where !== m.where
      ? t('setup.fallbackDiffers', {
          fallback: modelWord(t, fb.where),
          main: modelWord(t, m.where),
        })
      : fb && fb.id === m?.id
        ? t('setup.fallbackSame')
        : '';
  const conflict = piiConflict(t, s);
  const fields = s.output.fields ?? [];
  const setFields = (fn: (fs: OutputField[]) => OutputField[]) =>
    patch((cur) => ({
      output: { ...cur.spec.output, fields: fn(cur.spec.output.fields ?? []) },
    }));
  const toggleGuard = (name: string) =>
    patch((cur) => withGuard(cur.spec, name, !guardOn(cur.spec, name)));
  const tableAllowed = s.strategy.id === 'step-flow';
  const examples = examplesOf(s);
  const datasets = datasetsOf(s);
  const toolRefs = toolRefsOf(s);
  const refuse = refuseTopicsOf(s);
  const instructions = sharedInstructionsOf(s);
  const publicName = variantsOf(s)[0]?.publicName ?? '';
  const folder = triggerOf(s, 'document-arrives')?.folder;
  const queue = triggerOf(s, 'queue-message')?.queue;
  const cron = triggerOf(s, 'schedule')?.cron;
  const preset = presetOf(cron);
  const merged = (id: SectionId): SectionId[] =>
    instructionsUnderPurpose && id === 'purpose'
      ? ['purpose', 'instructions']
      : safetyTogether && id === 'risk'
        ? ['risk', 'guards']
        : sourcesTogether && id === 'knowledge'
          ? ['knowledge', 'io']
          : sourcesTogether && id === 'result'
            ? ['result', 'io']
            : [id];
  const props = (id: SectionId) => ({
    id,
    visible: !sections || sections.includes(id),
    open: merged(id).some((m) => !!open[m]),
    highlight: merged(id).includes(highlight as SectionId),
    fromAi: merged(id).some((m) => !!fromAi[m]),
    summary:
      safetyTogether && id === 'risk'
        ? ''
        : sourcesTogether && id === 'knowledge'
          ? [sum.knowledge, sum.input].join(' · ')
          : id === 'result'
            ? sum.result.charAt(0).toUpperCase() + sum.result.slice(1)
            : merged(id)
                .map((m) => sum[m])
                .filter(Boolean)
                .join(' · '),
    ...((safetyTogether || apart) && id === 'risk' ? { title: t('setup.sectionSafety') } : {}),
    ...(apart && id === 'guards' ? { title: t('setup.safetyGuards') } : {}),
    ...(sourcesTogether && id === 'knowledge' ? { title: t('setup.sectionSources') } : {}),
    onToggle: () => onToggle(id),
    readOnly,
    continuous,
  });

  const inputFormBody = (
    <InputFieldsEditor
      headingHidden={apart}
      fields={s.input.fields ?? []}
      datasets={datasets.map((x) => x.dataset)}
      onChange={(inputFields) =>
        patch((cur) => ({
          input: defined({ ...cur.spec.input, fields: inputFields }) as ServiceSpec['input'],
        }))
      }
      {...(inputLockedIds ? { lockedIds: inputLockedIds } : {})}
      flowCheck={flowCheck}
      lookup={inputLookup}
      serviceId={serviceId}
      tenant={tenant ?? d.metadata.tenant}
    />
  );

  const runtimeDocsSwitch = (
    <Switch
      label={t('setup.runtimeDocs')}
      description={t.rich('setup.runtimeDocsHelp', {
        notDecided: (chunk) => <span className="not-decided-inline">{chunk}</span>,
      })}
      checked={s.knowledge?.runtimeDocuments === true}
      onChange={() =>
        patch((cur) =>
          withRuntimeDocuments(cur.spec, cur.spec.knowledge?.runtimeDocuments !== true),
        )
      }
    />
  );

  const inputKindsBody = (
    <fieldset className="plain-fieldset stack-xs">
      <legend className="ds-label">{t('setup.whatGoesIn')}</legend>
      <div className="tag-row">
        {inputChoiceIds.map((id) => (
          <Chip.Checkbox
            key={id}
            checked={inputChoiceOn(s, id)}
            onChange={() => patch((cur) => withInputChoice(cur.spec, id))}
          >
            {labelOf(t, inputKeys, id)}
          </Chip.Checkbox>
        ))}
      </div>
      {inputChoiceOn(s, 'files') || s.input.ocr === true ? (
        <Switch
          label={t('setup.ocr')}
          description={t('setup.ocrHelp')}
          checked={s.input.ocr === true}
          onChange={() =>
            patch((cur) => ({ input: { ...cur.spec.input, ocr: cur.spec.input.ocr !== true } }))
          }
        />
      ) : null}
    </fieldset>
  );

  const ioInputBody = (
    <>
      {inputKindsBody}
      {apart ? null : inputFormBody}
    </>
  );

  const ioOutputBody = (
    <>
      <fieldset className="plain-fieldset stack-xs">
        <legend className="ds-label">{t('setup.whatComesOut')}</legend>
        <div className="pick-grid">
          {(
            [
              ['answer', 'setup.outputAnswer', 'setup.outputAnswerDesc'],
              ['fields', 'setup.outputFields', 'setup.outputFieldsDesc'],
              ['document', 'setup.outputDocument', 'setup.outputDocumentDesc'],
              ['table', 'setup.outputTable', 'setup.outputTableDesc'],
            ] as const
          ).map(([id, label, desc]) => (
            <div key={id} className={pickClass(s.output.kind === id)}>
              <Radio
                name="utdata"
                label={t(label)}
                description={t(desc)}
                checked={s.output.kind === id}
                disabled={id === 'table' && !tableAllowed && s.output.kind !== 'table'}
                onChange={() =>
                  patch((cur) =>
                    apart && id === 'answer'
                      ? { output: { ...cur.spec.output, kind: 'answer', withSources: true } }
                      : withOutputKind(cur.spec, id),
                  )
                }
              />
            </div>
          ))}
        </div>
        {s.output.kind === 'table' && !tableAllowed ? (
          <ValidationMessage>{t('setup.tableNeedsFlow')}</ValidationMessage>
        ) : null}
      </fieldset>
      {s.output.kind === 'table' && tableAllowed ? (
        <TableColumnsEditor
          serviceId={serviceId}
          table={s.output}
          onChange={(table: TableSpec) =>
            patch((cur) => ({
              output: defined({ ...cur.spec.output, ...table }) as ServiceSpec['output'],
            }))
          }
        />
      ) : null}
      {s.output.kind === 'fields' ? (
        <div className="stack-xs">
          <span className="ds-label" id="felter-h">
            {t('setup.resultFields')}
          </span>
          <div role="group" aria-labelledby="felter-h" className="field-editor">
            {narrow ? null : (
              <div aria-hidden="true" className="field-row field-row-head">
                <span>{t('setup.fieldName')}</span>
                <span>{t('setup.fieldType')}</span>
                <span>{t('setup.fieldDescription')}</span>
                <span>{t('setup.fieldRequired')}</span>
                <span />
              </div>
            )}
            {fields.map((f, i) => (
              <div key={i} className={narrow ? 'field-row narrow' : 'field-row'}>
                <Input
                  data-size="sm"
                  value={f.name}
                  aria-label={t('setup.fieldNameLabel', { n: i + 1 })}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFields((fs) => fs.map((x, j) => (j === i ? { ...x, name: v } : x)));
                  }}
                />
                <Select
                  data-size="sm"
                  value={f.type}
                  aria-label={t('setup.fieldTypeLabel', { n: i + 1, name: f.name })}
                  onChange={(e) => {
                    const v = e.target.value as OutputFieldType;
                    setFields((fs) => fs.map((x, j) => (j === i ? { ...x, type: v } : x)));
                  }}
                >
                  {(Object.keys(fieldTypeKeys) as OutputFieldType[]).map((ft) => (
                    <Select.Option key={ft} value={ft}>
                      {t(fieldTypeKeys[ft])}
                    </Select.Option>
                  ))}
                </Select>
                <Input
                  data-size="sm"
                  value={f.description}
                  aria-label={t('setup.fieldDescriptionLabel', { n: i + 1, name: f.name })}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFields((fs) => fs.map((x, j) => (j === i ? { ...x, description: v } : x)));
                  }}
                />
                <label className="field-required">
                  <input
                    className="ds-input"
                    type="checkbox"
                    checked={f.required !== false}
                    aria-label={t('setup.fieldRequiredLabel', { n: i + 1, name: f.name })}
                    onChange={() =>
                      setFields((fs) =>
                        fs.map((x, j) =>
                          j !== i
                            ? x
                            : x.required === false
                              ? required(x)
                              : { ...x, required: false },
                        ),
                      )
                    }
                  />
                  <span aria-hidden="true">
                    {f.required !== false ? t('setup.yes') : t('setup.no')}
                  </span>
                </label>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  icon
                  aria-label={t('setup.removeFieldLabel', { name: f.name })}
                  onClick={() => setFields((fs) => fs.filter((_x, j) => j !== i))}
                >
                  <Icon d={icons.close} size={18} />
                </Button>
              </div>
            ))}
            {fields.length === 0 ? <p className="meta field-empty">{t('setup.noFields')}</p> : null}
          </div>
          <Button
            variant="secondary"
            data-size="sm"
            className="align-start"
            onClick={() =>
              setFields((fs) => [
                ...fs,
                { name: t('setup.newFieldName'), type: 'string', description: '' },
              ])
            }
          >
            {t('setup.addField')}
          </Button>
          {conflict ? (
            <Alert data-color="warning" data-size="sm">
              {conflict}
            </Alert>
          ) : null}
        </div>
      ) : null}
      {s.output.kind === 'answer' && !apart ? (
        <Switch
          label={t('setup.showSources')}
          checked={s.output.withSources === true}
          onChange={() =>
            patch((cur) => ({
              output: { ...cur.spec.output, withSources: cur.spec.output.withSources !== true },
            }))
          }
        />
      ) : null}
      {s.output.kind === 'document' ? (
        <Field className="narrow-field">
          <Label htmlFor="felt-mal">{t('setup.docTemplate')}</Label>
          <Select
            id="felt-mal"
            value={s.output.template ?? ''}
            onChange={(e) => {
              const template = e.target.value;
              patch((cur) => ({ output: { ...cur.spec.output, template } }));
            }}
          >
            {Object.keys(docTemplateKeys).map((name) => (
              <Select.Option key={name} value={name}>
                {labelOf(t, docTemplateKeys, name)}
              </Select.Option>
            ))}
          </Select>
        </Field>
      ) : null}
    </>
  );

  const refuseBody = (
    <div className="stack-xs">
      <Label htmlFor="felt-avsla" className={apart ? 'visually-hidden' : undefined}>
        {t('setup.refuseTopics')}
      </Label>
      <div className="tag-row">
        {refuse.map((r) => (
          <Chip.Removable
            key={r}
            aria-label={t('setup.removeTopicLabel', { topic: r })}
            onClick={() =>
              patch((cur) =>
                withRefuseTopics(
                  cur.spec,
                  refuseTopicsOf(cur.spec).filter((x) => x !== r),
                ),
              )
            }
          >
            {r}
          </Chip.Removable>
        ))}
      </div>
      <div className="inline-add">
        <Input
          id="felt-avsla"
          data-size="sm"
          value={refuseInput}
          placeholder={t('setup.refusePlaceholder')}
          onChange={(e) => setRefuseInput(e.target.value)}
        />
        <Button
          variant="secondary"
          data-size="sm"
          onClick={() => {
            const v = refuseInput.trim();
            if (!v) return;
            patch((cur) => withRefuseTopics(cur.spec, [...refuseTopicsOf(cur.spec), v]));
            setRefuseInput('');
          }}
        >
          {t('setup.add')}
        </Button>
      </div>
    </div>
  );

  const guardsBody = (
    <>
      <span className="meta">
        {t('setup.guardDefaults', {
          level: (riskLabel(t, s.riskClass ?? '') ?? t('setup.notSet')).toLowerCase(),
        })}
      </span>
      {conflict ? (
        <Alert data-color="warning" data-size="sm">
          {conflict}
        </Alert>
      ) : null}
      <Switch
        label={t('setup.piiBefore')}
        description={t('setup.piiBeforeHelp')}
        checked={guardOn(s, 'pii-before-model')}
        onChange={() => toggleGuard('pii-before-model')}
      />
      <Switch
        label={t('setup.piiLog')}
        description={t('setup.piiLogHelp')}
        checked={guardOn(s, 'pii-out-of-log')}
        onChange={() => toggleGuard('pii-out-of-log')}
      />
      <Switch
        label={t('setup.requireSources')}
        description={
          s.output.kind === 'fields'
            ? t('setup.requireSourcesFields')
            : t('setup.requireSourcesHelp')
        }
        checked={guardOn(s, 'require-sources')}
        aria-disabled={s.output.kind === 'fields' || undefined}
        readOnly={s.output.kind === 'fields'}
        onChange={() => s.output.kind !== 'fields' && toggleGuard('require-sources')}
      />
      {apart ? null : refuseBody}
      <Field className="narrow-field">
        <Label htmlFor="felt-sprak">{t('setup.resultLanguage')}</Label>
        <Select
          id="felt-sprak"
          value={languageModeOf(s)}
          onChange={(e) => {
            const mode = e.target.value as LanguageMode;
            patch((cur) => withLanguageMode(cur.spec, mode));
          }}
        >
          <Select.Option value="nb">{t('setup.langNb')}</Select.Option>
          <Select.Option value="nn">{t('setup.langNn')}</Select.Option>
          <Select.Option value="en">{t('setup.langEn')}</Select.Option>
          <Select.Option value="same">{t('setup.langSame')}</Select.Option>
        </Select>
      </Field>
      <Switch
        label={t('setup.humanApproval')}
        description={high ? t('setup.humanHigh') : t('setup.humanHelp')}
        checked={guardOn(s, 'human-approval') || high}
        aria-disabled={high || undefined}
        readOnly={high}
        onChange={() => !high && toggleGuard('human-approval')}
      />
      {guardrails}
    </>
  );

  const instructionsBody = (
    <>
      {(languageTabs ?? ((shared: ReactNode) => shared))(
        <Field>
          <Label htmlFor="felt-instr">{t('setup.instructionsLabel')}</Label>
          <Field.Description>{t('setup.instructionsHelp')}</Field.Description>
          {flowOf(s) ? (
            <p className="meta">{t('setup.instructionsInFlowHelp', { flow: flowOf(s) ?? '' })}</p>
          ) : s.strategy.id === 'remote-agent' ? (
            <p className="meta">{t('setup.instructionsRemoteHelp')}</p>
          ) : (
            <>
              {!continuous && defaultInstructions(t, s) ? (
                <p className="meta">{t('setup.instructionsBuiltInHelp')}</p>
              ) : null}
              <Textarea
                id="felt-instr"
                className="instructions-editor"
                value={instructions}
                onChange={(e) => {
                  const text = e.target.value;
                  patch((cur) => withSharedInstructions(cur.spec, text));
                }}
              />
              <span className="meta">{t('setup.characters', { count: instructions.length })}</span>
            </>
          )}
        </Field>,
      )}
      {instructionsAssist ? <div className="field-action">{instructionsAssist}</div> : null}
      {flowOf(s) || s.strategy.id === 'remote-agent' ? null : (
        <BuiltInInstructions
          strategy={s.strategy.id}
          own={!!instructions || typeof s.strategy.config.instructions === 'object'}
          onUse={
            readOnly ? undefined : (text) => patch((cur) => withSharedInstructions(cur.spec, text))
          }
        />
      )}
      {takesOf(s.strategy.id).examples === 'no' ? null : (
        <div className="stack-xs">
          <span className="ds-label">{t('setup.examples')}</span>
          {examples.map((e, i) => (
            <div key={i} className="example-row">
              <span>
                <strong>{t('setup.exampleIn')}</strong> {e.input}
              </span>
              <span>
                <strong>{t('setup.exampleOut')}</strong> {e.output}
              </span>
              <Button
                variant="tertiary"
                data-size="sm"
                aria-label={t('setup.removeExampleLabel', { n: i + 1 })}
                onClick={() =>
                  patch((cur) =>
                    withExamples(
                      cur.spec,
                      examplesOf(cur.spec).filter((_x, j) => j !== i),
                    ),
                  )
                }
              >
                {t('setup.remove')}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            data-size="sm"
            className="align-start"
            onClick={() =>
              patch((cur) =>
                withExamples(cur.spec, [
                  ...examplesOf(cur.spec),
                  { input: t('setup.exampleInDefault'), output: t('setup.exampleOutDefault') },
                ]),
              )
            }
          >
            {t('setup.addExample')}
          </Button>
        </div>
      )}
    </>
  );

  const ask = (key: 'setup.askGoal' | 'setup.askSources' | 'setup.askOutcome') =>
    onAsk && !readOnly ? (
      <Button
        variant="secondary"
        data-size="sm"
        className="align-start field-action"
        aria-disabled={askOff || undefined}
        onClick={() => (askOff ? undefined : onAsk(t(key)))}
      >
        <SparklesIcon aria-hidden fontSize="1.25em" />
        {t(key)}
      </Button>
    ) : null;

  return (
    <div className="stack-sm">
      {!continuous && (!sections || sections.includes('purpose')) ? (
        <p className="meta setup-intro">{t('setup.intro')}</p>
      ) : null}

      <Section {...props('purpose')}>
        <Textfield
          label={t('setup.name')}
          id="felt-navn"
          value={d.metadata.name ?? ''}
          onChange={(e) => onRename(e.target.value)}
        />
        <Field>
          <Label htmlFor="felt-formal">{t('setup.purpose')}</Label>
          <Field.Description>{t('setup.purposeHelp')}</Field.Description>
          <Textarea
            id="felt-formal"
            rows={2}
            value={s.purpose}
            onChange={(e) => patch({ purpose: e.target.value })}
          />
        </Field>
        {ask('setup.askGoal')}
        {instructionsUnderPurpose ? instructionsBody : null}
        <fieldset className="chip-fieldset">
          <legend className="ds-label">{t('setup.audience')}</legend>
          <div className="tag-row">
            {audienceIds.map((id) =>
              offeredAudiences.has(id) ? (
                <Chip.Checkbox
                  key={id}
                  checked={(s.audience as string[] | undefined)?.includes(id) ?? false}
                  onChange={() =>
                    patch((cur) => {
                      const audience = cur.spec.audience ?? [];
                      return {
                        audience: audience.includes(id as 'employees')
                          ? audience.filter((a) => a !== id)
                          : [...audience, id as 'employees'],
                      };
                    })
                  }
                >
                  {labelOf(t, audienceKeys, id)}
                </Chip.Checkbox>
              ) : (
                <Chip.Checkbox key={id} checked={false} aria-disabled="true" readOnly>
                  {t('setup.comingLater', { label: labelOf(t, audienceKeys, id) })}
                </Chip.Checkbox>
              ),
            )}
          </div>
        </fieldset>
      </Section>

      <Section {...props('io')}>
        {ioInputBody}
        {ioOutputBody}
      </Section>

      <Section {...props('instructions')}>
        {instructionsUnderPurpose ? null : instructionsBody}
      </Section>

      <Section {...props('knowledge')}>
        {apart ? (
          <DatasetSuggestion
            options={
              live
                ? live.datasets
                : {
                    status: 'ready',
                    data: Object.entries(exampleDatasets).map(([id, d]) => ({
                      id,
                      name: d.name,
                      shared: false,
                    })),
                  }
            }
            chosen={datasets.map((ref) => ({
              value: ref.dataset,
              label: datasetName(ref.dataset, datasetNames),
            }))}
            onChange={(ids) =>
              patch((cur) =>
                withDatasets(
                  cur.spec,
                  ids.map(
                    (id) => datasetsOf(cur.spec).find((x) => x.dataset === id) ?? { dataset: id },
                  ),
                ),
              )
            }
          />
        ) : null}
        {ask('setup.askSources')}
        {(apart ? [] : datasets).map((ref, i) => {
          const shown = datasetName(ref.dataset, datasetNames);
          const reranker = rerankerOf(s);
          const filter = filterText(ref.filters);
          return (
            <div key={`${ref.dataset}-${i}`} className="item-row">
              <span className="item-text">
                <span className="item-name">{shown}</span>
                <span className="meta">
                  {[
                    live
                      ? shown === ref.dataset
                        ? ''
                        : ref.dataset
                      : (exampleDatasets[ref.dataset]?.meta ?? ''),
                    live && reranker ? t('setup.rerankedWith', { name: reranker }) : '',
                    filter ? t('setup.defaultFilter', { filter }) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Button
                variant="tertiary"
                data-size="sm"
                aria-label={t('setup.removeDatasetLabel', { name: shown })}
                onClick={() =>
                  patch((cur) =>
                    withDatasets(
                      cur.spec,
                      datasetsOf(cur.spec).filter((_x, j) => j !== i),
                    ),
                  )
                }
              >
                {t('setup.remove')}
              </Button>
            </div>
          );
        })}
        {apart ? null : datasets.length === 0 ? (
          <p className="meta">{t('setup.noDatasets')}</p>
        ) : null}
        {apart ? null : live ? (
          <>
            <Button
              variant="secondary"
              data-size="sm"
              className="align-start"
              aria-expanded={datasetPicker}
              onClick={() => setDatasetPicker((x) => !x)}
            >
              {datasetPicker ? t('setup.closeDatasetList') : t('setup.addDataset')}
            </Button>
            {datasetPicker ? (
              <DatasetPicker
                state={live.datasets}
                chosen={datasets.map((x) => x.dataset)}
                onAdd={(o) =>
                  patch((cur) =>
                    withDatasets(cur.spec, [...datasetsOf(cur.spec), { dataset: o.id }]),
                  )
                }
              />
            ) : null}
          </>
        ) : (
          <Button
            variant="secondary"
            data-size="sm"
            className="align-start"
            onClick={() =>
              patch((cur) =>
                withDatasets(cur.spec, [
                  ...datasetsOf(cur.spec),
                  { dataset: 'veiledere-og-rundskriv' },
                ]),
              )
            }
          >
            {t('setup.addDataset')}
          </Button>
        )}
        {apart ? (
          <Field>
            <Label htmlFor="felt-nettside">{t('setup.webPages')}</Label>
            <Field.Description>{t('setup.webPagesHelp')}</Field.Description>
            <div className="inline-add">
              <Input
                id="felt-nettside"
                type="url"
                inputMode="url"
                data-size="sm"
                value={webInput}
                placeholder={t('setup.webPagesPlaceholder')}
                aria-invalid={webInvalid || undefined}
                onChange={(e) => {
                  setWebInput(e.target.value);
                  setWebInvalid(false);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  addWebPage();
                }}
              />
              <Button variant="secondary" data-size="sm" onClick={addWebPage}>
                {t('setup.add')}
              </Button>
            </div>
            {webInvalid ? (
              <ValidationMessage>{t('setup.webPagesInvalid')}</ValidationMessage>
            ) : null}
            {apart ? (
              <Field>
                <Label htmlFor={ownDocumentsId}>{t('setup.ownDocuments')}</Label>
                <Field.Description>{t('setup.ownDocumentsHelp')}</Field.Description>
                <EXPERIMENTAL_FileUpload>
                  <Field.Description>{t('setup.ownDocumentsDrop')}</Field.Description>
                  <Button asChild data-variant="secondary">
                    <span>{t('setup.ownDocumentsPick')}</span>
                  </Button>
                  <input
                    id={ownDocumentsId}
                    type="file"
                    multiple
                    accept=".pdf,.doc,.docx,.txt,.md"
                    onChange={(e) => {
                      const picked = [...(e.target.files ?? [])].map((f) => f.name);
                      setOwnDocuments((cur) => [...cur, ...picked.filter((n) => !cur.includes(n))]);
                      e.target.value = '';
                    }}
                  />
                </EXPERIMENTAL_FileUpload>
                {ownDocuments.length ? (
                  <ul className="own-documents">
                    {ownDocuments.map((name) => (
                      <li key={name} className="item-row">
                        <span className="item-text">{name}</span>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('setup.ownDocumentsRemove', { name })}
                          onClick={() => setOwnDocuments((cur) => cur.filter((n) => n !== name))}
                        >
                          {t('setup.remove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Field>
            ) : null}
            {webPages.length ? (
              <ul className="own-documents">
                {webPages.map((url) => (
                  <li key={url} className="item-row">
                    <span className="item-text">{url}</span>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-label={t('setup.ownDocumentsRemove', { name: url })}
                      onClick={() => setWebPages((cur) => cur.filter((u) => u !== url))}
                    >
                      {t('setup.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Field>
        ) : null}
        {apart ? null : runtimeDocsSwitch}
        {sourcesTogether && !apart ? ioInputBody : null}
      </Section>

      <Section {...props('result')}>
        <Field>
          <Label htmlFor="felt-resultat">{t('setup.resultWish')}</Label>
          <Field.Description>{t('setup.resultWishHelp')}</Field.Description>
          <Textarea
            id="felt-resultat"
            rows={3}
            value={resultWish}
            onChange={(e) => onResultWish?.(e.target.value)}
          />
        </Field>
        {ask('setup.askOutcome')}
        {ioOutputBody}
      </Section>

      <Section {...props('tools')}>
        {live ? (
          <LiveTools
            state={live.tools}
            chosen={toolRefs}
            onAdd={(ref) => patch((cur) => withTool(cur.spec, ref, true))}
            onRemove={(ref) => patch((cur) => withTool(cur.spec, ref, false))}
          />
        ) : null}
        {live
          ? null
          : toolRefs.map((ref) => {
              const tool = tools.find((x) => x.ref === ref);
              if (!tool) return null;
              return (
                <div key={ref} className="item-row">
                  <span className="item-text">
                    <span className="tag-row">
                      <span className="item-name">{tool.name}</span>
                      <Tag data-size="sm" data-color="neutral">
                        {tool.group}
                      </Tag>
                      <code className="meta">{tool.ref}</code>
                    </span>
                    <span className="small">
                      <span className="meta">{t('setup.canReach')}</span> {tool.reach}
                    </span>
                  </span>
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    aria-label={t('setup.removeToolLabel', { name: tool.name })}
                    onClick={() => patch((cur) => withTool(cur.spec, ref, false))}
                  >
                    {t('setup.remove')}
                  </Button>
                </div>
              );
            })}
        {!live && toolRefs.length === 0 ? <p className="meta">{t('setup.noTools')}</p> : null}
        {live ? null : (
          <Button
            variant="secondary"
            data-size="sm"
            className="align-start"
            aria-expanded={catalog}
            onClick={() => setCatalog((x) => !x)}
          >
            {catalog ? t('setup.closeCatalogue') : t('setup.addToolFromCatalogue')}
          </Button>
        )}
        {!live && catalog ? (
          <div className="catalog">
            {toolGroups.map((g) => (
              <div key={g} className="stack-xs">
                <h3 className="catalog-group">{labelOf(t, toolGroupKeys, g)}</h3>
                {tools
                  .filter((tool) => tool.group === g)
                  .map((tool) => {
                    const added = toolRefs.includes(tool.ref);
                    return (
                      <div key={tool.id} className="catalog-item">
                        <span className="item-text">
                          <span className="item-name">{tool.name}</span>
                          <span className="meta">
                            {t('setup.canReachWith', { reach: tool.reach })}
                          </span>
                        </span>
                        <Button
                          variant="secondary"
                          data-size="sm"
                          aria-disabled={added || undefined}
                          aria-label={t('setup.addLabel', { name: tool.name })}
                          onClick={() =>
                            !added && patch((cur) => withTool(cur.spec, tool.ref, true))
                          }
                        >
                          {added ? t('setup.added') : t('setup.add')}
                        </Button>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      <Section {...props('how')}>
        {strategy}
        <fieldset className="plain-fieldset stack-xs">
          <legend className="ds-label">{t('setup.improvement')}</legend>
          <Switch
            label={t('setup.improveLabel')}
            description={t('setup.improveHelp')}
            checked={improves(s, 'instructions')}
            onChange={() =>
              patch((cur) =>
                withImprove(cur.spec, 'instructions', !improves(cur.spec, 'instructions')),
              )
            }
          />
        </fieldset>
      </Section>

      <Section {...props('model')}>
        <fieldset className="plain-fieldset stack-xs">
          <legend className="ds-label">{t('setup.allowedModels')}</legend>
          {modelCatalog && primary && !modelList.some((x) => x.id === primary) ? (
            <Alert data-color="warning" data-size="sm">
              {t('setup.modelNotAllowed', { model: primary })}
            </Alert>
          ) : null}
          {modelCatalog && modelList.length === 0 ? (
            <p className="meta">{t('setup.noModels')}</p>
          ) : null}
          {(modelCatalog || modelList.some((x) => x.id === primary)
            ? modelList
            : [modelFor(primary, s.model.residency), ...modelList]
          ).map((x) => (
            <div key={x.id} className={pickClass(primary === x.id)}>
              <Radio
                name="modell"
                label={
                  <span className="row-wrap">
                    <span>{x.name}</span>
                    <span className="meta">{t('setup.via', { via: x.via })}</span>
                  </span>
                }
                description={
                  <span className="stack-xs">
                    <span className="tag-row">
                      <Tag
                        data-size="sm"
                        data-color={
                          x.where === 'Norge' ? 'success' : x.where === 'EU' ? 'info' : 'warning'
                        }
                      >
                        {t('setup.dataIn', { where: modelWord(t, x.where) })}
                      </Tag>
                      <Tag data-size="sm" data-color="neutral">
                        {t('setup.cost', {
                          cost: modelCatalog
                            ? t('setup.notPriced')
                            : modelWord(t, x.cost).toLowerCase(),
                        })}
                      </Tag>
                      {modelCatalog ? null : (
                        <Tag data-size="sm" data-color="neutral">
                          {t('setup.speed', { speed: modelWord(t, x.speed).toLowerCase() })}
                        </Tag>
                      )}
                    </span>
                    {x.note ? <span>{x.note}</span> : null}
                  </span>
                }
                checked={primary === x.id}
                onChange={() =>
                  patch((cur) => withModel(cur.spec, x.id, residencyOfChoice(x, !!modelCatalog)))
                }
              />
            </div>
          ))}
        </fieldset>
        <Field className="narrow-field">
          <Label htmlFor="felt-reserve">{t('setup.fallbackModel')}</Label>
          <Field.Description>{t('setup.fallbackHelp')}</Field.Description>
          <Select
            id="felt-reserve"
            value={s.model.fallback ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              patch((cur) => withFallback(cur.spec, id));
            }}
          >
            <Select.Option value="">{t('setup.noFallback')}</Select.Option>
            {modelList.map((x) => (
              <Select.Option key={x.id} value={x.id}>
                {x.name} ({modelWord(t, x.where)})
              </Select.Option>
            ))}
          </Select>
        </Field>
        {fallbackWarn ? (
          <Alert data-color="warning" data-size="sm">
            {fallbackWarn}
          </Alert>
        ) : null}
      </Section>

      <Section {...props('variants')}>
        <VariantsEditor
          serviceId={serviceId}
          publicName={publicName}
          variants={variantsOf(s)}
          models={modelList}
          service={{ strategy: s.strategy.id, config: s.strategy.config }}
          model={primary}
          onChange={(variants) => patch({ variants })}
          api={api}
          tenant={tenant}
          dataset={datasets[0]?.dataset}
        />
      </Section>

      <Section {...props('risk')}>
        {safetyTogether ? (
          <Heading level={3} data-size="2xs" className="setup-subheading">
            {t('setup.safetyProhibited')}
          </Heading>
        ) : null}
        <fieldset className="plain-fieldset stack-xs">
          <legend className="ds-label">{t('setup.prohibitedHeading')}</legend>
          <p className="meta">{t('setup.prohibitedHelp')}</p>
          {prohibitedUses.map((use, i) => (
            <Checkbox
              key={use}
              label={prohibitedKeys[i] ? t(prohibitedKeys[i]) : use}
              checked={!!prohibited[i]}
              onChange={() => onProhibited(i)}
            />
          ))}
        </fieldset>
        {forbidden ? (
          <Alert data-color="danger" data-size="sm">
            {t('setup.forbidden')}
          </Alert>
        ) : null}
        {safetyTogether ? (
          <Heading level={3} data-size="2xs" className="setup-subheading">
            {t('setup.safetyRisk')}
          </Heading>
        ) : null}
        <div className="risk-proposal">
          <span className="risk-proposal-title">
            {t('setup.riskProposal', { level: t(high ? 'setup.riskHigh' : 'setup.riskLimited') })}
          </span>
          <ul className="bullets small">
            {(high
              ? [t('setup.riskReasonHigh1'), t('setup.riskReasonHigh2')]
              : [t('setup.riskReasonLimited1'), t('setup.riskReasonLimited2')]
            ).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <div className="row-wrap">
            {riskConfirmed ? (
              <Tag data-size="sm" data-color="success">
                {t('setup.confirmedBy', { name: userName || t('setup.you') })}
              </Tag>
            ) : (
              <>
                <Button
                  variant="primary"
                  data-size="sm"
                  aria-disabled={forbidden || undefined}
                  onClick={() => !forbidden && onConfirmRisk()}
                >
                  {t('setup.confirmRisk')}
                </Button>
                <span className="small">{t('setup.confirmFirst')}</span>
              </>
            )}
          </div>
        </div>
        <fieldset className="plain-fieldset stack-xs">
          <legend className="ds-label">{t('setup.riskLevel')}</legend>
          {riskClasses.map((id) => (
            <div key={id} className={pickClass(s.riskClass === id)}>
              <Radio
                name="risiko"
                label={t(riskKeys[id]?.[0] ?? 'setup.notChosen')}
                description={t(riskKeys[id]?.[1] ?? 'setup.notChosen')}
                checked={s.riskClass === id}
                onChange={() => patch(withRisk(id))}
              />
            </div>
          ))}
          {high ? (
            <Alert data-color="info" data-size="sm">
              {t('setup.highRiskInfo')}
            </Alert>
          ) : null}
        </fieldset>
        {safetyTogether ? (
          <Heading level={3} data-size="2xs" className="setup-subheading">
            {t('setup.safetyGuards')}
          </Heading>
        ) : null}
        {safetyTogether ? guardsBody : null}
      </Section>

      <Section {...props('guards')}>{safetyTogether ? null : guardsBody}</Section>

      {apart ? (
        <Section {...props('inputKinds')}>
          {inputKindsBody}
          {runtimeDocsSwitch}
        </Section>
      ) : null}
      {apart ? <Section {...props('inputForm')}>{inputFormBody}</Section> : null}
      {apart ? <Section {...props('refuse')}>{refuseBody}</Section> : null}

      <Section {...props('start')}>
        {channelGroups.map(([group, keys]) => (
          <fieldset key={group} className="chip-fieldset">
            <legend className="ds-label">{labelOf(t, startGroupKeys, group)}</legend>
            <div className="tag-row">
              {keys.map((id) => (
                <Chip.Checkbox
                  key={id}
                  checked={channelOn(s, id)}
                  onChange={() =>
                    patch((cur) => withChannel(cur.spec, id, !channelOn(cur.spec, id)))
                  }
                >
                  {labelOf(t, startKeys, id)}
                </Chip.Checkbox>
              ))}
            </div>
          </fieldset>
        ))}
        {frontends ? (
          <p className="meta">
            {frontends.length
              ? t('setup.registeredFrontends', { names: frontends.join(', ') })
              : t('setup.noFrontends')}
          </p>
        ) : null}
        {channelOn(s, 'a2a') ? (
          <A2aChannel
            name={d.metadata.name ?? ''}
            purpose={s.purpose}
            publicName={publicName || defaultPublicName(serviceId)}
            hasInputForm={!!s.input.fields?.length}
          />
        ) : null}
        {channelOn(s, 'a2a') ? (
          <Switch
            label={t('setup.publicCard')}
            description={t('setup.publicCardHelp')}
            checked={s.exposure?.a2aPublicCard === true}
            onChange={() =>
              patch((cur) => withPublicCard(cur.spec, cur.spec.exposure?.a2aPublicCard !== true))
            }
          />
        ) : null}
        {folder !== undefined ? (
          <Textfield
            className="narrow-field"
            id="felt-mappe"
            label={t('setup.folder')}
            description={t('setup.folderHelp')}
            value={folder}
            onChange={(e) => {
              const value = e.target.value;
              patch((cur) => withTrigger(cur.spec, { kind: 'document-arrives', folder: value }));
            }}
          />
        ) : null}
        {queue !== undefined ? (
          <Textfield
            className="narrow-field"
            id="felt-ko"
            label={t('setup.queue')}
            description={t('setup.queueHelp')}
            value={queue}
            onChange={(e) => {
              const value = e.target.value;
              patch((cur) => withTrigger(cur.spec, { kind: 'queue-message', queue: value }));
            }}
          />
        ) : null}
        {cron !== undefined ? (
          <Field className="narrow-field">
            <Label htmlFor="felt-tidsplan">{t('setup.schedule')}</Label>
            <Select
              id="felt-tidsplan"
              value={preset ?? 'custom'}
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'custom') return;
                patch((cur) =>
                  withTrigger(cur.spec, {
                    kind: 'schedule',
                    cron: schedulePresets[value as SchedulePreset],
                  }),
                );
              }}
            >
              {preset ? null : (
                <Select.Option value="custom">
                  {t('setup.schedulePublished', { cron })}
                </Select.Option>
              )}
              <Select.Option value="nightly">{t('setup.scheduleNightly')}</Select.Option>
              <Select.Option value="hourly">{t('setup.scheduleHourly')}</Select.Option>
              <Select.Option value="monday">{t('setup.scheduleMonday')}</Select.Option>
            </Select>
          </Field>
        ) : null}
        {channelOn(s, 'api') || channelOn(s, 'mcp') || channelOn(s, 'openai') ? (
          <Textfield
            className="narrow-field"
            id="felt-offentlig"
            label={t('setup.publicName')}
            description={t('setup.publicNameHelp')}
            value={publicName}
            onChange={(e) => {
              const value = e.target.value;
              patch((cur) => withPublicName(cur.spec, value));
            }}
          />
        ) : null}
        {!channelKeys.some((x) => channelOn(s, x)) && !frontends?.length ? (
          <Alert data-color="info" data-size="sm">
            {t('setup.noChannel')}
          </Alert>
        ) : null}
      </Section>
    </div>
  );
};

/** Datasets picked by searching, with the chosen ones as chips. */
const DatasetSuggestion = ({
  options,
  chosen,
  onChange,
}: {
  options: AsyncState<DatasetOption[]>;
  chosen: { value: string; label: string }[];
  onChange: (ids: string[]) => void;
}) => {
  const t = useT();
  const items = options.status === 'ready' ? options.data : [];
  return (
    <Field>
      <Label>{t('setup.datasets')}</Label>
      <Field.Description>{t('setup.datasetsHelp')}</Field.Description>
      <EXPERIMENTAL_Suggestion
        multiple
        selected={chosen}
        onSelectedChange={(picked) => onChange(picked.map((p) => p.value))}
      >
        <EXPERIMENTAL_Suggestion.Input />
        <EXPERIMENTAL_Suggestion.Clear aria-label={t('setup.datasetsClear')} />
        <EXPERIMENTAL_Suggestion.List>
          <EXPERIMENTAL_Suggestion.Empty>
            {options.status === 'loading'
              ? t('setup.loadingDatasets')
              : options.status === 'error'
                ? t('setup.datasetsFailed')
                : t('setup.datasetsNone')}
          </EXPERIMENTAL_Suggestion.Empty>
          {items.map((d) => (
            <EXPERIMENTAL_Suggestion.Option key={d.id} label={d.name} value={d.id}>
              {d.name}
              <div className="meta">{d.shared ? t('setup.sharedDatasets') : d.id}</div>
            </EXPERIMENTAL_Suggestion.Option>
          ))}
        </EXPERIMENTAL_Suggestion.List>
      </EXPERIMENTAL_Suggestion>
    </Field>
  );
};

const DatasetPicker = ({
  state,
  chosen,
  onAdd,
}: {
  state: AsyncState<DatasetOption[]>;
  chosen: string[];
  onAdd: (option: DatasetOption) => void;
}) => {
  const t = useT();
  if (state.status === 'loading') return <p className="meta">{t('setup.loadingDatasets')}</p>;
  if (state.status === 'error') return <ErrorState error={state.error} headingLevel={3} />;
  if (state.data.length === 0)
    return (
      <p className="meta">
        {t.rich('setup.noDatasetsAvailable', {
          link: (chunk) => <a href="#/datasets">{chunk}</a>,
        })}
      </p>
    );
  const groups: [string, DatasetOption[]][] = [
    [t('setup.ownDatasets'), state.data.filter((d) => !d.shared)],
    [t('setup.sharedDatasets'), state.data.filter((d) => d.shared)],
  ];
  return (
    <div className="catalog">
      {groups
        .filter(([, items]) => items.length > 0)
        .map(([group, items]) => (
          <div key={group} className="stack-xs">
            <h3 className="catalog-group">{group}</h3>
            {items.map((d) => {
              const added = chosen.includes(d.id);
              return (
                <div key={d.id} className="catalog-item">
                  <span className="item-text">
                    <span className="item-name">{d.name}</span>
                    <code className="meta">{d.id}</code>
                  </span>
                  <Button
                    variant="secondary"
                    data-size="sm"
                    aria-disabled={added || undefined}
                    aria-label={t('setup.addLabel', { name: d.name })}
                    onClick={() => !added && onAdd(d)}
                  >
                    {added ? t('setup.added') : t('setup.add')}
                  </Button>
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
};

const LiveTools = ({
  state,
  chosen,
  onAdd,
  onRemove,
}: {
  state: AsyncState<ToolOption[]>;
  chosen: string[];
  onAdd: (ref: string) => void;
  onRemove: (ref: string) => void;
}) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const options = state.status === 'ready' ? state.data : [];
  return (
    <>
      {chosen.map((ref) => {
        const tool = options.find((o) => o.ref === ref);
        return (
          <div key={ref} className="item-row">
            <span className="item-text">
              <span className="tag-row">
                <span className="item-name">{tool?.name ?? ref}</span>
                {tool ? (
                  <Tag data-size="sm" data-color="neutral">
                    {tool.connection}
                  </Tag>
                ) : state.status === 'ready' ? (
                  <Tag data-size="sm" data-color="warning">
                    {t('setup.notInCatalogue')}
                  </Tag>
                ) : null}
                <code className="meta">{ref}</code>
              </span>
              {tool?.description ? <span className="small">{tool.description}</span> : null}
            </span>
            <Button
              variant="tertiary"
              data-size="sm"
              aria-label={t('setup.removeToolLabel', { name: tool?.name ?? ref })}
              onClick={() => onRemove(ref)}
            >
              {t('setup.remove')}
            </Button>
          </div>
        );
      })}
      {chosen.length === 0 ? <p className="meta">{t('setup.noTools')}</p> : null}
      <Button
        variant="secondary"
        data-size="sm"
        className="align-start"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        {open ? t('setup.closeCatalogue') : t('setup.addToolFromCatalogue')}
      </Button>
      {open && state.status === 'loading' ? (
        <p className="meta">{t('setup.loadingTools')}</p>
      ) : null}
      {open && state.status === 'error' ? (
        <ErrorState error={state.error} headingLevel={3} />
      ) : null}
      {open && state.status === 'ready' && options.length === 0 ? (
        <p className="meta">
          {t.rich('setup.noToolsConnected', {
            link: (chunk) => <a href="#/building-blocks">{chunk}</a>,
          })}
        </p>
      ) : null}
      {open && options.length > 0 ? (
        <div className="catalog">
          {options.map((tool) => {
            const added = chosen.includes(tool.ref);
            return (
              <div key={tool.ref} className="catalog-item">
                <span className="item-text">
                  <span className="item-name">{tool.name}</span>
                  <span className="meta">
                    {[tool.connection, tool.description].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-disabled={added || undefined}
                  aria-label={t('setup.addLabel', { name: tool.name })}
                  onClick={() => !added && onAdd(tool.ref)}
                >
                  {added ? t('setup.added') : t('setup.add')}
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
};
