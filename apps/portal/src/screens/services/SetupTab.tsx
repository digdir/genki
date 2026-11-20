import { ChevronDownIcon, XMarkIcon } from '@navikt/aksel-icons';
import type { FlowInputCheck } from '../../data/flow-inputs';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Details,
  Field,
  Input,
  Label,
  Link,
  Radio,
  Select,
  Switch,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import {
  exampleDatasets,
  modelFor,
  models,
  prohibitedUses,
  toolGroups,
  tools,
  type ModelChoice,
} from '../../data/services';
import {
  applySpec,
  type OutputField,
  type OutputFieldType,
  type ServiceDefinition,
  type ServiceSpec,
  type SpecEdit,
  type SpecPatch,
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
  withOperationModel,
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
import {
  languagesOf,
  sharedInstructionsOf,
  withSharedInstructions,
  type AnswerLanguage,
} from '../../data/service-languages';
import { kindName } from '../../data/step-operations';
import { defaultInstructionsOf, strategyFor, takesOf } from '../../data/strategies';
import { useAsync, type AsyncState } from '../../hooks';
import type { CatalogModel } from '../../api/models';
import { ModelPicker } from '../../components/ModelPicker';
import { useModelText } from '../../components/model-text';
import { modelLabel } from '../../models';
import type { Residency } from '../../types';
import { useT, type PlainKey, type T } from '../../i18n';
import { useUserName } from '../../Shell';
import { ErrorState } from '../../states';
import { InputFieldsEditor, type InputOptionLookup } from './InputFormEditor';
import { TableColumnsEditor, type TableSpec } from './TableOutputEditor';
import { VariantsEditor } from './VariantsEditor';
import type { ApiClient } from '../../api';
import { A2aChannel } from '../integrations/A2aChannel';
import { VariantsList } from '../service/VariantsList';
import { StrategyRow } from '../service/StrategyPanel';
import type { SetupArea } from './setup-diff';
import {
  AskChip,
  InputArea,
  KindCard,
  RowsArea,
  SourcesArea,
  type DatasetOption,
  type FileInput,
} from './setup-area-views';

export interface OperationModelChoice {
  kind: string;
  models: { id: string; name: string; where: string }[];
}

export type { DatasetOption } from './setup-area-views';

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
  | 'instructions'
  | 'knowledge'
  | 'tools'
  | 'how'
  | 'model'
  | 'variants'
  | 'guards'
  | 'start';

export const sectionTitles: Record<SectionId, PlainKey> = {
  purpose: 'setup.sectionPurpose',
  io: 'setup.sectionIo',
  instructions: 'setup.sectionInstructions',
  knowledge: 'setup.sectionKnowledge',
  tools: 'setup.sectionTools',
  how: 'setup.sectionHow',
  model: 'setup.sectionModel',
  variants: 'setup.sectionVariants',
  guards: 'setup.sectionGuards',
  start: 'setup.sectionStart',
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

export const rerankerOf = (spec: ServiceSpec) => {
  const id = spec.knowledge?.reranker;
  return typeof id === 'string' && id ? id : undefined;
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
  );
};

const inputChoiceIds = Object.keys(inputChoices) as InputChoice[];
const textTypes = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];

export const datasetName = (ref: string, names?: Map<string, string>) =>
  names?.get(ref) ?? exampleDatasets[ref]?.name ?? ref;

const toolName = (ref: string) => tools.find((x) => x.ref === ref)?.name ?? ref;

const inputSummary = (t: T, s: ServiceSpec) =>
  `${
    inputChoiceIds
      .filter((i) => inputChoiceOn(s, i))
      .map((i) => labelOf(t, inputKeys, i))
      .join(', ') || t('setup.nothingChosen')
  }${s.input.fields?.length ? t('setup.formWithFields', { count: s.input.fields.length }) : ''}`;

const outputSummary = (t: T, s: ServiceSpec) =>
  s.output.kind === 'fields'
    ? t('setup.outFields', { count: s.output.fields?.length ?? 0 })
    : s.output.kind === 'document'
      ? t('setup.outDocument', { template: s.output.template || '?' })
      : s.output.kind === 'table'
        ? t('setup.outTable')
        : t(s.output.withSources ? 'setup.outAnswerSources' : 'setup.outAnswer');

export const summaries = (
  t: T,
  d: ServiceDefinition,
  catalog?: ModelChoice[],
  datasetNames?: Map<string, string>,
  frontends: string[] = [],
): Record<SectionId, string> => {
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
  return {
    purpose: [
      riskLabel(t, s.riskClass ?? '') ?? t('setup.riskNotSet'),
      audienceIds
        .filter((a) => (s.audience as string[] | undefined)?.includes(a))
        .map((a) => labelOf(t, audienceKeys, a))
        .join(', '),
    ]
      .filter(Boolean)
      .join(' · '),
    io: `${inputSummary(t, s)} → ${outputSummary(t, s)}`,
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
    start:
      [
        ...channelKeys.filter((x) => channelOn(s, x)).map((x) => labelOf(t, startKeys, x)),
        ...(frontends.length ? [t('setup.startFrontends', { names: frontends.join(', ') })] : []),
      ].join(', ') || t('setup.noStart'),
  };
};

const promptPath = /^prompts\/[a-z0-9][a-z0-9._/-]*\.md$/;

export const promptFileOf = (text: string, files: Record<string, string>) =>
  promptPath.test(text) && text in files ? text : undefined;

export const withPromptFiles = (
  d: ServiceDefinition,
  files: Record<string, string>,
): ServiceDefinition => {
  const file = promptFileOf(sharedInstructionsOf(d.spec), files);
  return file ? applySpec(d, withSharedInstructions(d.spec, files[file] ?? '')) : d;
};

export const riskConfirmedFor = (spec: ServiceSpec) =>
  !!spec.riskConfirmation &&
  (spec.riskConfirmation.riskClass === undefined ||
    spec.riskConfirmation.riskClass === spec.riskClass);

export const riskNeedsConfirming = (spec: ServiceSpec) =>
  (spec.riskClass === 'limited' || spec.riskClass === 'high') && !riskConfirmedFor(spec);

const languageNameKeys: Record<AnswerLanguage, PlainKey> = {
  nb: 'setupList.languageNb',
  nn: 'setupList.languageNn',
  en: 'setupList.languageEn',
};

const residencyWordKeys: Record<string, PlainKey> = {
  norway: 'setupList.whereNorway',
  Norge: 'setupList.whereNorway',
  eu: 'setupList.whereEu',
  EU: 'setupList.whereEu',
  global: 'setupList.whereGlobal',
};

export const areaSummaries = (
  t: T,
  d: ServiceDefinition,
  catalog?: ModelChoice[],
  datasetNames?: Map<string, string>,
): Record<SetupArea, string> => {
  const s = d.spec;
  const sum = summaries(t, d, catalog, datasetNames);
  const level = riskLabel(t, s.riskClass ?? '');
  const own = Object.keys(s.settings ?? {}).length;
  return {
    purpose: s.purpose
      ? `${s.purpose.slice(0, 60)}${s.purpose.length > 60 ? '…' : ''}`
      : t('setupList.notWrittenPurpose'),
    sources: t('setupList.sourcesSummary', { count: datasetsOf(s).length }),
    input: [
      t('setupList.kindText'),
      s.input.fields?.length ? t('setupList.fieldsSummary', { count: s.input.fields.length }) : '',
      s.knowledge?.runtimeDocuments === true ? t('setupList.filesSummary') : '',
      ...(['audio', 'system'] as const)
        .filter((c) => inputChoiceOn(s, c))
        .map((c) => labelOf(t, inputKeys, c).toLowerCase()),
    ]
      .filter(Boolean)
      .join(', '),
    result: capitalised(outputSummary(t, s)),
    model: modelAreaSummary(t, s, catalog),
    tools: sum.tools,
    how: sum.how,
    variants: sum.variants,
    channels: sum.start,
    guards: sum.guards,
    risk: riskNeedsConfirming(s)
      ? t('setupList.riskRequiredSummary')
      : level
        ? riskConfirmedFor(s)
          ? t('setupList.riskConfirmedSummary', { level })
          : level
        : t('setup.riskNotSet'),
    limits: own ? t('setupList.limitsOwn', { count: own }) : t('setupList.limitsDefault'),
  };
};

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const modelAreaSummary = (t: T, s: ServiceSpec, catalog?: ModelChoice[]) => {
  const m =
    catalog?.find((x) => x.id === s.model.primary) ??
    modelFor(s.model.primary, s.model.residency, !!catalog);
  const key = residencyWordKeys[m?.residency ?? m?.where ?? s.model.residency ?? ''];
  const name = m?.name ?? s.model.primary;
  return key ? t('setupList.modelAreaSummary', { name, where: t(key) }) : name;
};

export const modelWord = (t: T, word: string) => labelOf(t, modelWordKeys, word);

export const piiConflict = (t: T, spec: ServiceSpec) =>
  guardOn(spec, 'pii-before-model') &&
  spec.output.kind === 'fields' &&
  (spec.output.fields ?? []).some((f) => /navn|fødselsnummer|adresse/i.test(f.name))
    ? t('setup.piiConflict')
    : '';

const choiceModel = (m: ModelChoice): CatalogModel => ({
  id: m.id,
  name: m.name,
  maker: m.via,
  residency: m.residency
    ? (m.residency as Residency)
    : m.where === 'Norge'
      ? 'norway'
      : m.where === 'EU'
        ? 'eu'
        : 'global',
  capabilities: [],
  operations: ['chat'],
  price: m.price ?? null,
  available: true,
});

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
  children,
}: {
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
  return !visible ? null : (
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
            <span className="setup-title">{t(sectionTitles[id])}</span>
            <span className="meta setup-summary">{summary}</span>
          </span>
          {fromAi ? (
            <Tag data-size="sm" data-color="info">
              {t('setup.fromAssistant')}
            </Tag>
          ) : null}
          <span className={open ? 'chevron open' : 'chevron'}>
            <Icon icon={ChevronDownIcon} />
          </span>
        </button>
      </h2>
      {open ? (
        <div id={`sek-${id}-innhold`} className="setup-body">
          {readOnly ? (
            <fieldset disabled className="setup-readonly">
              {children}
            </fieldset>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  );
};

interface Props {
  serviceId: string;
  definition: ServiceDefinition;
  patch: (edit: SpecEdit) => void;
  files?: Record<string, string>;
  onFile?: (path: string, text: string) => void;
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
  languageTabs?: (shared: ReactNode) => ReactNode;
  inputLockedIds?: string[];
  inputLookup?: InputOptionLookup | undefined;
  tenant?: string;
  flowCheck?: FlowInputCheck | undefined;
  frontends?: string[];
  readOnly?: boolean;
  api?: ApiClient | undefined;
  operationModels?: OperationModelChoice[] | undefined;
  area?: SetupArea | undefined;
  ask?: ((question: string) => void) | undefined;
  modelNote?: ReactNode;
  inUse?: ServiceDefinition | undefined;
  fileInput?: AsyncState<FileInput | undefined>;
  assistantOff?: boolean;
}

const pickClass = (on: boolean) => (on ? 'pick-card picked' : 'pick-card');

export const SetupTab = ({
  serviceId,
  definition: d,
  patch,
  files = {},
  onFile,
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
  languageTabs,
  inputLockedIds,
  inputLookup,
  tenant,
  flowCheck,
  frontends,
  readOnly = false,
  api,
  operationModels = [],
  area,
  ask,
  modelNote,
  inUse,
  fileInput = { status: 'loading' },
  assistantOff = false,
}: Props) => {
  const t = useT();
  const userName = useUserName();
  const modelList = modelCatalog ?? models;
  const [liveModels, retryModels] = useAsync(
    (signal) =>
      modelCatalog && api ? api.models.catalog(signal) : Promise.resolve<CatalogModel[]>([]),
    [api, !!modelCatalog],
  );
  const pickerModels: AsyncState<CatalogModel[]> =
    modelCatalog && api ? liveModels : { status: 'ready', data: modelList.map(choiceModel) };
  const [catalog, setCatalog] = useState(false);
  const [datasetPicker, setDatasetPicker] = useState(false);
  const [modelEdit, setModelEdit] = useState<'fallback' | 'operations'>();
  const [areaEdit, setAreaEdit] = useState<SetupArea>();
  const [refuseInput, setRefuseInput] = useState('');
  const s = d.spec;
  const modelText = useModelText();
  const operationLine = operationModels
    .filter(({ kind }) => kind !== 'chat')
    .map(({ kind }) => {
      const chosen = s.model.operations?.[kind];
      const name =
        (pickerModels.status === 'ready'
          ? pickerModels.data.find((x) => x.id === chosen)?.name
          : undefined) ?? (chosen ? modelLabel(chosen) : '');
      return chosen
        ? t('modelPicker.operationUses', { kind: modelText.use(kind), model: name })
        : t('modelPicker.operationSame', { kind: modelText.use(kind) });
    });
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
  const instructionsRef = sharedInstructionsOf(s);
  const instructionsFile = onFile ? promptFileOf(instructionsRef, files) : undefined;
  const instructions = instructionsFile ? (files[instructionsFile] ?? '') : instructionsRef;
  const setInstructions = (text: string) =>
    instructionsFile && text.trim()
      ? onFile?.(instructionsFile, text)
      : patch((cur) => withSharedInstructions(cur.spec, text));
  const publicName = variantsOf(s)[0]?.publicName ?? '';
  const folder = triggerOf(s, 'document-arrives')?.folder;
  const queue = triggerOf(s, 'queue-message')?.queue;
  const cron = triggerOf(s, 'schedule')?.cron;
  const preset = presetOf(cron);
  const props = (id: SectionId) => ({
    id,
    visible: !sections || sections.includes(id),
    open: !!open[id],
    highlight: highlight === id,
    fromAi: !!fromAi[id],
    summary: sum[id],
    onToggle: () => onToggle(id),
    readOnly,
  });

  const nameField = (
    <>
      <Textfield
        label={t('setup.name')}
        id="felt-navn"
        value={d.metadata.name ?? ''}
        onChange={(e) => onRename(e.target.value)}
      />
    </>
  );
  const purposeField = (
    <>
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
    </>
  );
  const audienceField = (
    <>
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
    </>
  );
  const riskBody = (
    <>
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
    </>
  );
  const inputBody = (
    <>
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
        <Switch
          label={t('setup.ocr')}
          description={t('setup.ocrHelp')}
          checked={s.input.ocr === true}
          onChange={() =>
            patch((cur) => ({ input: { ...cur.spec.input, ocr: cur.spec.input.ocr !== true } }))
          }
        />
      </fieldset>
      <InputFieldsEditor
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
    </>
  );
  const outputBody = (
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
                onChange={() => patch((cur) => withOutputKind(cur.spec, id))}
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
                  <Icon icon={XMarkIcon} size={18} />
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
      {s.output.kind === 'answer' ? (
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
  const builtInBlock = (
    <>
      {flowOf(s) || s.strategy.id === 'remote-agent' ? null : (
        <BuiltInInstructions
          strategy={s.strategy.id}
          own={!!instructions || typeof s.strategy.config.instructions === 'object'}
          onUse={
            readOnly ? undefined : (text) => patch((cur) => withSharedInstructions(cur.spec, text))
          }
        />
      )}
    </>
  );
  const examplesBlock = (
    <>
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
              {defaultInstructions(t, s) ? (
                <p className="meta">{t('setup.instructionsBuiltInHelp')}</p>
              ) : null}
              <Textarea
                id="felt-instr"
                rows={14}
                className="instructions-editor"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
              <span className="meta">{t('setup.characters', { count: instructions.length })}</span>
            </>
          )}
        </Field>,
      )}
      {builtInBlock}
      {instructionsAssist}
      {examplesBlock}
    </>
  );
  const instructionsExtras = (
    <>
      {languageTabs ? languageTabs(<p className="meta">{t('setupList.sharedAbove')}</p>) : null}
      {builtInBlock}
      {examplesBlock}
    </>
  );
  const knowledgeBody = (
    <>
      {datasets.map((ref, i) => {
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
      {datasets.length === 0 ? <p className="meta">{t('setup.noDatasets')}</p> : null}
      {live ? (
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
                patch((cur) => withDatasets(cur.spec, [...datasetsOf(cur.spec), { dataset: o.id }]))
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
    </>
  );
  const toolsBody = (
    <>
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
                        onClick={() => !added && patch((cur) => withTool(cur.spec, tool.ref, true))}
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
    </>
  );
  const howBody = (
    <>
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
    </>
  );
  const modelPicker = (
    <>
      <ModelPicker
        models={pickerModels}
        value={primary}
        service={d.metadata.name ?? serviceId}
        {...(s.model.residency ? { residency: s.model.residency as Residency } : {})}
        readOnly={readOnly}
        onRetry={retryModels}
        onChange={(id) => {
          const choice = modelList.find((x) => x.id === id);
          const picked =
            pickerModels.status === 'ready'
              ? pickerModels.data.find((x) => x.id === id)
              : undefined;
          patch((cur) =>
            withModel(
              cur.spec,
              id,
              choice ? residencyOfChoice(choice, !!modelCatalog) : picked?.residency,
            ),
          );
        }}
      />
    </>
  );
  const fallbackBlock = (
    <>
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
    </>
  );
  const operationsBlock = (
    <>
      {operationModels.length ? (
        <fieldset id="setup-operation-models" className="plain-fieldset stack-xs">
          <legend className="ds-label">{t('setup.operationModels')}</legend>
          <p className="meta">{t('setup.operationModelsHelp')}</p>
          {operationModels.map(({ kind, models: offered }) => {
            const name = kindName(kind);
            const chosen = s.model.operations?.[kind] ?? '';
            return (
              <Field key={kind} className="narrow-field">
                <Label htmlFor={`felt-operasjon-${kind}`}>
                  {t('setup.operationModelFor', { kind: name })}
                </Label>
                {offered.length ? null : (
                  <Field.Description>
                    {t('setup.operationModelNone', { kind: name })}
                  </Field.Description>
                )}
                <Select
                  id={`felt-operasjon-${kind}`}
                  value={chosen}
                  onChange={(e) => {
                    const id = e.target.value;
                    patch((cur) => withOperationModel(cur.spec, kind, id));
                  }}
                >
                  <Select.Option value="">{t('setup.operationModelMain')}</Select.Option>
                  {chosen && !offered.some((x) => x.id === chosen) ? (
                    <Select.Option value={chosen}>{chosen}</Select.Option>
                  ) : null}
                  {offered.map((x) => (
                    <Select.Option key={x.id} value={x.id}>
                      {x.name} ({modelWord(t, x.where)})
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            );
          })}
        </fieldset>
      ) : null}
    </>
  );
  const modelBody = (
    <>
      {modelPicker}
      {modelNote}
      {operationLine.length ? (
        <p className="meta">
          {operationLine.join(' ')}{' '}
          <Link asChild>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                const target = document.getElementById('setup-operation-models');
                target?.scrollIntoView?.({ block: 'start' });
                target?.querySelector('select')?.focus();
              }}
            >
              {t('modelPicker.operationLink')}
            </button>
          </Link>
        </p>
      ) : null}
      {fallbackBlock}
      {operationsBlock}
    </>
  );
  const modelArea = (
    <div className="stack-sm">
      {modelPicker}
      {modelNote}
      <ul className="area-rows">
        {operationModels.length ? (
          <li>
            <span className="area-row-text">
              <span className="area-row-title">{t('setupList.operationModelsRow')}</span>
              <span className="meta">
                {operationLine.length && Object.keys(s.model.operations ?? {}).length
                  ? operationLine.join(' ')
                  : t('setupList.operationModelsSame')}
              </span>
            </span>
            {readOnly ? null : (
              <button
                type="button"
                className="link-button area-row-action"
                aria-expanded={modelEdit === 'operations'}
                onClick={() => setModelEdit((x) => (x === 'operations' ? undefined : 'operations'))}
              >
                {t('setupList.operationModelsPick')}
              </button>
            )}
          </li>
        ) : null}
        <li>
          <span className="area-row-text">
            <span className="area-row-title">{t('setup.fallbackModel')}</span>
            <span className="meta">
              {fb && fb.id === m?.id
                ? t('setup.fallbackSame')
                : fb
                  ? `${fb.name} (${modelWord(t, fb.where)})`
                  : t('setup.noFallback')}
            </span>
          </span>
          {readOnly ? null : (
            <button
              type="button"
              className="link-button area-row-action"
              aria-expanded={modelEdit === 'fallback'}
              aria-label={t('setupList.fallbackEdit')}
              onClick={() => setModelEdit((x) => (x === 'fallback' ? undefined : 'fallback'))}
            >
              {t('setupList.edit')}
            </button>
          )}
        </li>
      </ul>
      {modelEdit === 'fallback' ? fallbackBlock : null}
      {modelEdit === 'operations' ? operationsBlock : null}
    </div>
  );
  const variantsBody = (
    <>
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
    </>
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
      <div className="stack-xs">
        <Label htmlFor="felt-avsla">{t('setup.refuseTopics')}</Label>
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
  const startBody = (
    <>
      {channelGroups.map(([group, keys]) => (
        <fieldset key={group} className="chip-fieldset">
          <legend className="ds-label">{labelOf(t, startGroupKeys, group)}</legend>
          <div className="tag-row">
            {keys.map((id) => (
              <Chip.Checkbox
                key={id}
                checked={channelOn(s, id)}
                onChange={() => patch((cur) => withChannel(cur.spec, id, !channelOn(cur.spec, id)))}
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
              <Select.Option value="custom">{t('setup.schedulePublished', { cron })}</Select.Option>
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
    </>
  );

  const publishedDatasets = inUse ? datasetsOf(inUse.spec).map((x) => x.dataset) : [];
  const sourcesArea = live ? (
    <SourcesArea
      chosen={datasets.map((x) => x.dataset)}
      options={live.datasets}
      addedInDraft={(ref) => !!inUse && !publishedDatasets.includes(ref)}
      withSources={s.output.kind !== 'answer' || s.output.withSources === true}
      readOnly={readOnly}
      onAdd={(ref) =>
        patch((cur) => withDatasets(cur.spec, [...datasetsOf(cur.spec), { dataset: ref }]))
      }
      onRemove={(i) =>
        patch((cur) =>
          withDatasets(
            cur.spec,
            datasetsOf(cur.spec).filter((_x, j) => j !== i),
          ),
        )
      }
      onClear={() => patch((cur) => withDatasets(cur.spec, []))}
      ask={ask}
      nameOf={(ref) => datasetName(ref, datasetNames)}
    />
  ) : null;
  const publishedFieldIds = new Set((inUse?.spec.input.fields ?? []).map((x) => x.id));
  const inputFields = s.input.fields ?? [];
  const [fieldsOn, setFieldsOn] = useState(false);
  const filesOn = s.knowledge?.runtimeDocuments === true;
  const withFiles = (spec: ServiceSpec, on: boolean) =>
    ({
      input: {
        ...spec.input,
        accepts: [
          ...spec.input.accepts.filter((m) => !textTypes.includes(m)),
          ...(on ? textTypes : []),
        ],
      },
      knowledge: { ...spec.knowledge, runtimeDocuments: on },
    }) as SpecPatch;
  const inputArea = (
    <InputArea
      fields={inputFields}
      newFieldIds={
        new Set(inUse ? inputFields.map((x) => x.id).filter((x) => !publishedFieldIds.has(x)) : [])
      }
      useFields={fieldsOn || inputFields.length > 0}
      useFiles={filesOn}
      fileInput={fileInput}
      extraKinds={(['audio', 'system'] as const).map((c) => (
        <KindCard
          key={c}
          name={labelOf(t, inputKeys, c)}
          description={t(c === 'audio' ? 'setupList.kindAudioDesc' : 'setupList.kindSystemDesc')}
          checked={inputChoiceOn(s, c)}
          locked={readOnly}
          onToggle={() => patch((cur) => withInputChoice(cur.spec, c))}
        />
      ))}
      fieldsEditor={(_open, close) => (
        <div className="stack-xs">
          <InputFieldsEditor
            fields={inputFields}
            datasets={datasets.map((x) => x.dataset)}
            onChange={(next) =>
              patch((cur) => ({
                input: defined({ ...cur.spec.input, fields: next }) as ServiceSpec['input'],
              }))
            }
            {...(inputLockedIds ? { lockedIds: inputLockedIds } : {})}
            flowCheck={flowCheck}
            lookup={inputLookup}
            serviceId={serviceId}
            tenant={tenant ?? d.metadata.tenant}
          />
          <Button variant="secondary" data-size="sm" className="align-start" onClick={close}>
            {t('setupList.doneEditing')}
          </Button>
        </div>
      )}
      readOnly={readOnly}
      onFields={(on) => {
        setFieldsOn(on);
        if (!on)
          patch((cur) => {
            const rest = { ...cur.spec.input };
            delete rest.fields;
            return { input: rest };
          });
      }}
      onFiles={(on) => patch((cur) => withFiles(cur.spec, on))}
      ask={ask}
    />
  );

  const purposeArea = (
    <div className="stack area-stack">
      <Textfield
        label={t('setup.name')}
        id="felt-navn"
        className="area-name"
        value={d.metadata.name ?? ''}
        onChange={(e) => onRename(e.target.value)}
      />
      <Field>
        <Label htmlFor="felt-formal">{t('setup.purpose')}</Label>
        <Field.Description>{t('setup.purposeHelp')}</Field.Description>
        <Textarea
          id="felt-formal"
          rows={3}
          value={s.purpose}
          onChange={(e) => patch({ purpose: e.target.value })}
        />
        <AskChip label={t('setupList.askGoal')} onAsk={ask} />
      </Field>
      <fieldset className="plain-fieldset stack-xs">
        <legend className="ds-label">{t('setup.audience')}</legend>
        {audienceIds.map((id) => (
          <Radio
            key={id}
            name="area-audience"
            label={
              offeredAudiences.has(id)
                ? labelOf(t, audienceKeys, id)
                : t('setup.comingLater', { label: labelOf(t, audienceKeys, id) })
            }
            value={id}
            checked={(s.audience as string[] | undefined)?.includes(id) ?? false}
            {...(offeredAudiences.has(id) ? {} : { 'aria-disabled': true, readOnly: true })}
            onChange={() => offeredAudiences.has(id) && patch({ audience: [id as 'employees'] })}
          />
        ))}
      </fieldset>
      <div className="stack-xs area-block">
        {flowOf(s) || s.strategy.id === 'remote-agent' ? (
          instructionsBody
        ) : (
          <Field>
            <Label htmlFor="felt-instr">{t('setup.instructionsLabel')}</Label>
            <Field.Description>{t('setup.instructionsHelp')}</Field.Description>
            <Textarea
              id="felt-instr"
              rows={6}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="area-instr-foot">
              <span className="meta">{t('setup.characters', { count: instructions.length })}</span>
              {ask ? (
                <div className="area-instr-improve">
                  <AskChip label={t('setupList.askImprove')} onAsk={ask} off={assistantOff} />
                </div>
              ) : null}
            </div>
          </Field>
        )}
        {flowOf(s) || s.strategy.id === 'remote-agent' ? null : (
          <details className="area-more">
            <summary>
              <span>{t('setupList.moreInstructions')}</span>
              <span className="area-more-facts">
                <span className="meta">
                  {t('setupList.languagesFact', {
                    languages: languagesOf(s)
                      .map((l) => t(languageNameKeys[l]))
                      .join(', '),
                  })}
                </span>
                <span className="meta">
                  {t('setupList.examplesFact', { count: examples.length })}
                </span>
                <span className="meta">
                  {t('setupList.builtInFact', {
                    count: defaultInstructionsOf(s.strategy.id, t.locale) ? 1 : 0,
                  })}
                </span>
              </span>
            </summary>
            <div className="stack">{instructionsExtras}</div>
          </details>
        )}
      </div>
    </div>
  );

  const inUseTools = inUse ? toolRefsOf(inUse.spec) : [];
  const liveTool = (ref: string) =>
    live?.tools.status === 'ready' ? live.tools.data.find((x) => x.ref === ref) : undefined;
  const liveToolName = (ref: string) => liveTool(ref)?.name ?? toolName(ref);
  const liveToolText = (ref: string) =>
    liveTool(ref)?.description ?? tools.find((x) => x.ref === ref)?.reach;

  if (area) {
    const askButton = (question: PlainKey) => <AskChip label={t(question)} onAsk={ask} />;
    const flat = (() => {
      switch (area) {
        case 'purpose':
          return purposeArea;
        case 'sources':
          return live ? (
            sourcesArea
          ) : (
            <>
              {askButton('setupList.askSources')}
              {knowledgeBody}
            </>
          );
        case 'input':
          return inputArea;
        case 'result':
          return (
            <div className="stack area-stack area-result">
              {outputBody}
              {askButton('setupList.askOutcome')}
            </div>
          );
        case 'model':
          return modelArea;
        case 'tools':
          return (
            <RowsArea
              rows={[
                ...toolRefs.map((ref) => ({
                  key: ref,
                  title: liveToolName(ref),
                  text: liveToolText(ref),
                  tag: !inUse
                    ? undefined
                    : inUseTools.includes(ref)
                      ? t('setupList.tagInUse')
                      : t('setupList.tagNew'),
                  action: {
                    label: t('setup.remove'),
                    aria: t('setupList.removeNamed', { name: liveToolName(ref) }),
                    onClick: () => patch((cur) => withTool(cur.spec, ref, false)),
                  },
                })),
                ...(s.skills ?? []).map((skill) => ({
                  key: `skill-${skill}`,
                  title: skill,
                  text: t('setupList.skillRow'),
                })),
              ]}
              emptyText={t('setupList.noTools')}
              addLabel={t('setupList.addTool')}
              editor={toolsBody}
              readOnly={readOnly}
              editing={areaEdit === 'tools'}
              onEditing={(on) => setAreaEdit(on ? 'tools' : undefined)}
            />
          );
        case 'how':
          return api && tenant ? (
            <div className="stack-sm">
              <StrategyRow
                api={api}
                tenant={tenant}
                definition={d}
                service={serviceId}
                editing={areaEdit === 'how'}
                onEditing={(on) => setAreaEdit(on ? 'how' : undefined)}
                readOnly={readOnly}
              />
              {areaEdit === 'how' ? <div className="stack area-editor">{howBody}</div> : null}
            </div>
          ) : (
            howBody
          );
        case 'channels':
          return (
            <>
              <VariantsList
                service={serviceId}
                publicName={variantsOf(s)[0]?.publicName ?? ''}
                variants={variantsOf(s)}
              />
              {startBody}
            </>
          );
        case 'variants':
          return (
            <RowsArea
              rows={variantsOf(s)
                .slice(1)
                .map((v) => ({
                  key: v.id,
                  title:
                    (t.locale === 'en' ? v.title?.en || v.title?.nb : v.title?.nb || v.title?.en) ||
                    v.id,
                  text: v.model ?? '',
                  action: {
                    label: t('setupList.edit'),
                    onClick: () => setAreaEdit('variants'),
                  },
                }))}
              emptyText={t('setupList.noVariants')}
              addLabel={t('setupList.addVariant')}
              editor={variantsBody}
              readOnly={readOnly}
              editing={areaEdit === 'variants'}
              onEditing={(on) => setAreaEdit(on ? 'variants' : undefined)}
            />
          );
        case 'guards':
          return (
            <RowsArea
              rows={[
                ...(
                  [
                    ['pii-before-model', 'setup.piiBefore'],
                    ['pii-out-of-log', 'setup.piiLog'],
                    ['require-sources', 'setup.requireSources'],
                    ['human-approval', 'setup.humanApproval'],
                  ] as const
                )
                  .filter(([g]) => guardOn(s, g) || (g === 'human-approval' && high))
                  .map(([g, key]) => ({
                    key: g,
                    title: t(key),
                    text:
                      g === 'human-approval' && high
                        ? t('setupList.requiredByRisk')
                        : inUse && !guardOn(inUse.spec, g)
                          ? t('setupList.addedInDraft')
                          : t('setupList.addedByService'),
                    ...(g === 'human-approval' && high
                      ? {}
                      : {
                          action: {
                            label: t('setup.remove'),
                            aria: t('setupList.removeNamed', { name: t(key) }),
                            onClick: () => toggleGuard(g),
                          },
                        }),
                  })),
                ...refuse.map((topic) => ({
                  key: `refuse-${topic}`,
                  title: t('setupList.refuseRow', { topic }),
                  action: {
                    label: t('setup.remove'),
                    aria: t('setup.removeTopicLabel', { topic }),
                    onClick: () =>
                      patch((cur) =>
                        withRefuseTopics(
                          cur.spec,
                          refuseTopicsOf(cur.spec).filter((x) => x !== topic),
                        ),
                      ),
                  },
                })),
              ]}
              emptyText={t('setupList.noGuards')}
              addLabel={t('setupList.addGuard')}
              editor={guardsBody}
              readOnly={readOnly}
              editing={areaEdit === 'guards'}
              onEditing={(on) => setAreaEdit(on ? 'guards' : undefined)}
            />
          );
        case 'risk':
          return (
            <RowsArea
              rows={[
                {
                  key: 'risk',
                  title: riskLabel(t, s.riskClass ?? '') ?? t('setup.riskNotSet'),
                  text: (high
                    ? [t('setup.riskReasonHigh1'), t('setup.riskReasonHigh2')]
                    : s.riskClass === 'limited'
                      ? [t('setup.riskReasonLimited1'), t('setup.riskReasonLimited2')]
                      : s.riskClass === 'minimal'
                        ? [t('setup.riskMinimalDesc')]
                        : []
                  ).join(' '),
                  ...(riskConfirmed
                    ? { tag: t('setup.confirmedBy', { name: userName || t('setup.you') }) }
                    : forbidden || !s.riskClass
                      ? {}
                      : { action: { label: t('setup.confirmRisk'), onClick: onConfirmRisk } }),
                },
              ]}
              addLabel={t('setupList.otherRiskLevel')}
              editor={riskBody}
              readOnly={readOnly}
              editing={areaEdit === 'risk' || forbidden}
              onEditing={(on) => setAreaEdit(on ? 'risk' : undefined)}
            />
          );
        default:
          return null;
      }
    })();
    return (
      <div className="stack setup-area-body">
        {readOnly ? (
          <fieldset disabled className="setup-readonly stack">
            {flat}
          </fieldset>
        ) : (
          flat
        )}
      </div>
    );
  }

  return (
    <div className="stack-sm">
      {!sections || sections.includes('purpose') ? (
        <p className="meta setup-intro">{t('setup.intro')}</p>
      ) : null}

      <Section {...props('purpose')}>
        {nameField}
        {purposeField}
        {audienceField}
        {riskBody}
      </Section>

      <Section {...props('io')}>
        {inputBody}
        {outputBody}
      </Section>

      <Section {...props('instructions')}>{instructionsBody}</Section>

      <Section {...props('knowledge')}>{knowledgeBody}</Section>

      <Section {...props('tools')}>{toolsBody}</Section>

      <Section {...props('how')}>{howBody}</Section>

      <Section {...props('model')}>{modelBody}</Section>

      <Section {...props('variants')}>{variantsBody}</Section>

      <Section {...props('guards')}>{guardsBody}</Section>

      <Section {...props('start')}>{startBody}</Section>
    </div>
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
