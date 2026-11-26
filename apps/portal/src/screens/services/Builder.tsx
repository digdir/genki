import {
  Alert,
  Button,
  Heading,
  Link,
  Paragraph,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { ExternalLinkIcon, PlayIcon, TrashIcon } from '@navikt/aksel-icons';
import { Icon } from '../../components/Icon';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { AssistantProposal } from '../../api/assistant';
import { PlaygroundPanel } from '../../components/playground/PlaygroundPanel';
import type { PublishInput } from '../../components/PublishSummary';
import {
  assistantStates,
  assistantUserMessages,
  exampleAssistantTurn,
  exampleTemplate,
  type AssistantState,
  batchRows,
  cards,
  formatOre,
  jobs,
  models,
  questions,
  slug,
  type ChangeCard,
  type ChatMessage,
  type JobId,
  type ServiceStatus,
  modelFor,
} from '../../data/services';
import {
  applySpec,
  asServiceDefinition,
  forTenant,
  renamed,
  specChanges,
  specKeysOf,
  type RiskClass,
  type ServiceDefinition,
  type SpecEdit,
  type SpecPatch,
} from '../../data/service-definition';
import {
  autoPublicName,
  examplesOf,
  flowOf,
  guardOn,
  renameService,
  riskConfirmationFor,
  variantsOf,
  withExamples,
  withPublicName,
} from '../../data/service-form';
import { sharedInstructionsOf, withSharedInstructions } from '../../data/service-languages';
import { useFormat, useLocale } from '@genai/i18n/react';
import { actorLabel, formatDateTime, notPricedLabel } from '../../format';
import { useT, type PlainKey } from '../../i18n';
import { rightLabel, useRights, useUserName } from '../../Shell';
import { navigate, useAsync, useNarrow, type Route } from '../../hooks';
import { toYaml } from '../../yaml';
import { AssistantPanel } from './AssistantPanel';
import { ImproveInstructions } from './assistant/ImproveInstructions';
import { SuggestedTests } from './assistant/SuggestedTests';
import { proposalKey, useAssistant, type TurnEntry } from './assistant/useAssistant';
import type { InputOptionLookup } from './InputFormEditor';
import {
  areaSummaries,
  summaries as setupSummaries,
  datasetName,
  modelWord,
  riskConfirmedFor,
  riskNeedsConfirming,
  SetupTab,
  withPromptFiles,
  type SectionId,
} from './SetupTab';
import {
  newVariantsOf,
  withVariantChoices,
  type NewVariant,
  type VariantChoice,
} from './publish-choices';
import { gateStopReason, gateStops } from '../quality/QualityOverview';
import { productionEnvironment } from '../../api/environments';
import { DraftBar, savedByOf, saverOf, type SaveState, type SavedBy } from './DraftBar';
import { DiscardDialog } from './DiscardDialog';
import { newDraftId } from './draft-id';
import { HandoverNotice } from './HandoverNotice';
import { PublishDiff, type TestWarning } from './PublishDiff';
import { SetupForm, type AreaFact } from './setup-form';
import { areaLabelKeys, changeLabel, changeText, type ChangeNames } from './setup-change-text';
import { draftChecks } from './setup-checks';
import { areaOfPath, draftChanges as diffDraft, setupAreas, type SetupArea } from './setup-diff';
import { initialTestState, scoreText, testKind, type TestState } from './testState';
import {
  latestRunFact,
  type DraftConflict,
  type OpenedDraft,
  type ServiceDraft,
} from '../../api/quality';
import { setAt } from '../../definition-path';
import { checkFlowInputs } from '../../data/flow-inputs';
import { hasOperationSteps, operationKindsIn } from '../../data/step-operations';
import { PublishedTest } from '../service/PublishedTest';
import { useServiceAddress } from '../service/service-address';
import { DraftOutdated, type ConflictPick } from './DraftOutdated';
import type { VersionItem } from './VersionsTab';
import { YamlTab } from './YamlTab';
import { ServiceChannels } from '../service/Channels';
import { ServicePageContext } from '../service/context';
import { GuardrailRules } from '../service/GuardrailRules';
import { LogSection } from '../service/LogSection';
import { OverviewSection } from '../service/OverviewSection';
import { QualitySection } from '../service/QualitySection';
import { BatchSection } from '../batch/BatchSection';
import {
  advancedItemOf,
  advancedItems,
  availableSections,
  editionPath,
  editionView,
  servicePath,
  serviceTabs,
  subSections,
  switchPaths,
  tabLabels,
  tabOf,
  type Edition,
  type ServiceSection,
} from '../service/sections';
import { ServiceHeader } from '../service/ServiceHeader';
import { ArchivedBanner, ServiceLifecycle } from '../service/ServiceLifecycle';
import { lifecycleChanged, useServiceLifecycle } from '../service/lifecycle';
import { useDraftChanges } from '../service/draft-events';
import { ServiceNav, ServiceSubNav } from '../service/ServiceNav';
import { SettingsSection } from '../service/SettingsSection';
import { StrategyPanel } from '../service/StrategyPanel';
import { History } from '../service/History';
import { problemErrors } from '../service/definition';
import { describeProblem, publishDraft, type PublishProblem } from '../service/publish';
import { EnvironmentsSection } from '../service/EnvironmentsSection';
import { LanguageInstructionTabs } from './LanguageInstructionTabs';
import { isAssistantLayout, type AssistantLayout } from '@genai/ui-blocks/builder';
import { AdvancedTab } from './AdvancedTab';
import { ConfirmedTag, FirstPublish, type Left } from './FirstPublish';
import { InterfaceTab } from './blocks/InterfaceTab';
import type { PinActions } from './blocks/FromDesign';
import { LayoutTransfer } from './blocks/LayoutTransfer';
import { draftLayoutOf, shownLayoutOf, withPinsOf } from './blocks/layoutStore';
import { TryViewKeeper } from './blocks/TryViewKeeper';
import { UnmaskedInputConsent } from './UnmaskedInputConsent';
import {
  isUnmaskedReasonGiven,
  mediaKind,
  refusedUnmaskedInput,
  unmaskedTypes,
  withUnmaskedInput,
} from '../../data/unmasked-input';
import type { PublishedDefinition, PublishResult, UnmaskedInputUse } from '../../types';
import '../service/service.css';

const setupSections: SectionId[] = [
  'purpose',
  'io',
  'instructions',
  'knowledge',
  'tools',
  'how',
  'model',
  'variants',
  'guards',
];

export interface BuilderInit {
  id: string;
  isNew: boolean;
  definition: ServiceDefinition;
  messages: ChatMessage[];
  extraCards: Record<string, ChangeCard>;
  versions: VersionItem[];
  status: ServiceStatus;
  files?: Record<string, string>;
  draftRevision?: number;
  rebasedTo?: number;
  opened?: OpenedDraft | null;
  autoSend?: string;
}

interface AssistedChange {
  title: string;
  section: string;
  before: SpecPatch;
  after: SpecPatch;
}

const draftDelayMs = 600;

const areaOfSection: Partial<Record<string, SetupArea>> = {
  purpose: 'purpose',
  io: 'input',
  instructions: 'purpose',
  knowledge: 'sources',
  tools: 'tools',
  how: 'how',
  model: 'model',
  variants: 'variants',
  guards: 'guards',
  start: 'channels',
};

const areaOf = (detail: string | undefined): SetupArea | undefined =>
  detail && (setupAreas as string[]).includes(detail)
    ? (detail as SetupArea)
    : detail
      ? areaOfSection[detail]
      : undefined;

export { newDraftId } from './draft-id';

const isAssistantState = (v: string | null): v is AssistantState =>
  !!v && (assistantStates as readonly string[]).includes(v);

interface Props {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  live?: boolean;
  init: BuilderInit;
  route: Route;
  section: ServiceSection;
  detail?: string | undefined;
  pane: 'assistent' | 'tjeneste' | undefined;
  openPublish: boolean;
  edition?: Edition;
  inUseEdition?: PublishedDefinition;
  onPublished?: () => void;
}

const riskReasons = (high: boolean) =>
  high
    ? [
        'Resultatet brukes når det tas beslutninger om enkeltpersoner.',
        'Krever menneskelig godkjenning og strengere logging.',
      ]
    : [
        'Ansatte bruker resultatene, men tjenesten tar ikke beslutninger om folk.',
        'Resultatene vises som laget av KI.',
      ];

const riskLabelKey: Record<string, PlainKey> = {
  minimal: 'setup.riskMinimal',
  limited: 'setup.riskLimited',
  high: 'setup.riskHigh',
};

const fromTemplate = (template: Record<string, unknown>, name: string): ServiceDefinition =>
  renamed(
    applySpec(asServiceDefinition(template), (d) => ({
      purpose: '',
      ...withPublicName(d.spec, autoPublicName(name)),
    })),
    name,
  );

export const newServiceInit = (
  job: JobId,
  userText: string,
  name = '',
  live = false,
  template?: Record<string, unknown>,
): BuilderInit => {
  const label = jobs.find((j) => j.id === job)?.label.toLowerCase() ?? '';
  const qs = questions[job] ?? [];
  if (live)
    return {
      id: 'new',
      isNew: true,
      definition: template ? fromTemplate(template, name) : exampleTemplate(job, name),
      messages: [],
      extraCards: {},
      versions: [],
      status: 'Utkast',
      autoSend: userText,
    };
  return {
    id: 'new',
    isNew: true,
    definition: exampleTemplate(job, name),
    messages: [
      { role: 'user', text: userText },
      {
        role: 'assistant',
        text: `Da setter jeg opp en tjeneste som ${label}. Noen spørsmål først:\n${qs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
        cards: ['n-job'],
      },
    ],
    extraCards: {
      'n-job': {
        title: `Satte jobb: ${label}`,
        detail: 'Inn og ut, verktøy og start er fylt ut med forslag som passer jobben.',
        section: 'io',
      },
    },
    versions: [],
    status: 'Utkast',
  };
};

const withRiskStamp = (definition: Record<string, unknown>, stamp: object) => {
  const spec = (definition.spec ?? {}) as { riskConfirmation?: { unmaskedInput?: unknown } };
  const unmaskedInput = spec.riskConfirmation?.unmaskedInput;
  return {
    ...definition,
    spec: { ...spec, riskConfirmation: { ...stamp, ...(unmaskedInput ? { unmaskedInput } : {}) } },
  };
};

const archivedSections: ServiceSection[] = ['overview', 'quality', 'versions', 'log'];

// New services whose Publiser was pressed this page session; the publish page remounts the Builder.
const publishTriedFor = new Set<string>();

export const Builder = ({
  api,
  tenant,
  tenantName,
  live = false,
  init,
  route,
  section: routeSection,
  detail,
  pane: initialPane,
  openPublish,
  edition = 'test',
  inUseEdition,
  onPublished,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const locale = useLocale().locale;
  const dayAndTime = (iso: string) =>
    new Date(iso).toDateString() === new Date().toDateString()
      ? t('serviceDraft.todayAt', { time: f.time(iso) })
      : t('serviceDraft.dayAt', { date: f.date(iso, 'medium'), time: f.time(iso) });
  const tRef = useRef(t);
  tRef.current = t;
  const narrow = useNarrow();
  const [catalog] = useAsync(
    (signal) => (live ? api.listModels({}, signal) : Promise.resolve([])),
    [api, live],
  );
  const modelCatalog =
    live && catalog.status === 'ready'
      ? catalog.data.map((m) => ({ ...modelFor(m.id, m.residency, true), price: m.price ?? null }))
      : live
        ? []
        : undefined;
  const [datasetOptions] = useAsync(
    async (signal) =>
      live
        ? (await api.datasets.list(tenant, signal)).map((d) => ({
            id: d.fullId,
            name: d.name || d.id,
            shared: (d.owner?.tenant ?? d.scope) !== tenant,
            documents: d.documents,
            updatedAt: d.updatedAt ?? null,
            ...(d.owner ? { owner: d.owner } : {}),
          }))
        : [],
    [api, tenant, live],
  );
  const [toolOptions] = useAsync(
    async (signal) =>
      live
        ? (await api.integrations(tenant, signal)).connections.flatMap((c) =>
            c.tools.map((t) => ({
              ref: `${t.name}@${c.version}`,
              name: t.name,
              description: t.description,
              connection: c.name,
            })),
          )
        : [],
    [api, tenant, live],
  );
  const userName = useUserName();
  const { id, isNew } = init;
  const [service, setService] = useState(init.definition);
  const [variantPicks, setVariantPicks] = useState<Record<string, VariantChoice>>({});
  const [frontends, setFrontends] = useState<string[]>();
  // A new service's form lists what an area lacks only once the person has tried to publish (#995).
  const [publishTried, setTried] = useState(() => publishTriedFor.has(id));
  const setPublishTried = (tried: true) => {
    publishTriedFor.add(id);
    setTried(tried);
  };
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const [files, setFiles] = useState(init.files ?? {});
  const filesRef = useRef(files);
  filesRef.current = files;
  const showsInUse = edition === 'inUse';
  const serverDraft = live && (!isNew || id !== 'new') && !showsInUse;
  // Every service gets the shared Oppsett; only a live #/services/new has no draft yet.
  const setupLayout = !isNew || !live || init.draftRevision !== undefined;
  const areaShown = (d: string | undefined) => {
    const area = areaOf(d);
    return isNew && area === 'limits' ? undefined : area;
  };
  const [draftRevision, setDraftRevision] = useState(init.draftRevision ?? 0);
  const revisionRef = useRef(draftRevision);
  const routeId = isNew && draftRevision === 0 ? 'new' : id;
  const [edits, setEdits] = useState(0);
  const editsRef = useRef(0);
  const unsaved = useRef(false);
  const saving = useRef(false);
  const savingRun = useRef<Promise<void>>(Promise.resolve());
  const draftBlocked = useRef(false);
  const [messages, setMessages] = useState(init.messages);
  const [extra, setExtra] = useState(init.extraCards);
  const [undone, setUndone] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, SpecPatch>>({});
  const [assisted, setAssisted] = useState<Record<string, AssistedChange>>({});
  const [adding, setAdding] = useState<{ key: string; blocks: readonly string[] }>();
  const clearAdding = useCallback(() => setAdding(undefined), []);
  const rights = useRights();
  const lifecycle = useServiceLifecycle(api, tenant, id, !isNew);
  const reloadLifecycle = () => lifecycleChanged(tenant, id);
  const archived = lifecycle?.state === 'archived';
  const section = archived && !archivedSections.includes(routeSection) ? 'overview' : routeSection;
  const readOnly = !rights.has('manage-services') || archived || showsInUse;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState(false);
  const [composer, setComposer] = useState('');
  const [pane, setPane] = useState<'assistent' | 'tjeneste'>(
    initialPane ?? (section === 'setup' ? 'assistent' : 'tjeneste'),
  );
  const [open, setOpen] = useState<Partial<Record<SectionId, boolean>>>(
    isNew
      ? { purpose: true }
      : live
        ? { start: true }
        : testKind(id, init.definition) === 'fields'
          ? { io: true }
          : { instructions: true },
  );
  const [highlight, setHighlight] = useState('');
  const [test, setTest] = useState<TestState>(() => initialTestState(init.definition));
  const [evalRuns] = useAsync(
    async (signal) => (live && !isNew ? api.quality.runs(tenant, id, signal) : []),
    [api, tenant, id, live, isNew],
  );
  const [testSets] = useAsync(
    async (signal) => (live && !isNew ? api.quality.testSets(tenant, id, signal) : []),
    [api, tenant, id, live, isNew],
  );
  const hasTestSet = live
    ? testSets.status === 'ready' && Array.isArray(testSets.data) && testSets.data.length > 0
    : Boolean(test.testset);
  const scoreFact = live
    ? evalRuns.status === 'ready' && Array.isArray(evalRuns.data)
      ? latestRunFact(evalRuns.data, t)
      : t('services.scoreNotRun')
    : scoreText(test.batch.snap);
  const [prohibited, setProhibited] = useState<Record<number, boolean>>({});
  const riskConfirmed = riskConfirmedFor(service.spec);
  const riskOpen = riskNeedsConfirming(service.spec);
  const [versions, setVersions] = useState(init.versions);
  const [published, setPublished] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState('');
  const [publish, setPublish] = useState<'test' | 'prod' | null>(
    openPublish && edition !== 'inUse' ? 'prod' : null,
  );
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | undefined>(
    init.draftRevision ? init.opened?.at : undefined,
  );
  const [savedBy, setSavedBy] = useState<SavedBy | undefined>(
    init.draftRevision && init.opened ? savedByOf(init.opened) : undefined,
  );
  const selfActor = useRef<string | undefined>(undefined);
  const self = { actor: selfActor.current, name: userName };
  const [failedAt, setFailedAt] = useState<string>();
  const [conflictDraft, setConflictDraft] = useState<ServiceDraft>();
  const [discarding, setDiscarding] = useState(false);
  const [discardedTo, setDiscardedTo] = useState<number>();
  const discardTrigger = useRef<HTMLElement | null>(null);
  const discardedAlert = useRef<HTMLDivElement>(null);
  const wasDiscarding = useRef(false);
  const discardedNow = useRef(false);
  const [baseline, setBaseline] = useState<{
    version: number;
    definition: Record<string, unknown>;
    files?: Record<string, string>;
  }>();

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const change = useCallback((next: (d: ServiceDefinition) => ServiceDefinition) => {
    if (readOnlyRef.current) return;
    unsaved.current = true;
    setSaveState('unsaved');
    editsRef.current += 1;
    setEdits(editsRef.current);
    setService(next);
  }, []);
  const patch = useCallback((edit: SpecEdit) => change((d) => applySpec(d, edit)), [change]);
  const writeLayout = useCallback(
    (layout: AssistantLayout) => patch((d) => ({ interface: { ...d.spec.interface, layout } })),
    [patch],
  );
  const editFile = useCallback((path: string, text: string) => {
    if (readOnlyRef.current) return;
    unsaved.current = true;
    setSaveState('unsaved');
    editsRef.current += 1;
    setEdits(editsRef.current);
    setFiles((current) => ({ ...current, [path]: text }));
  }, []);
  const replaceWith = (next: ServiceDefinition) =>
    change((d) => renamed({ ...d, spec: next.spec }, next.metadata.name ?? ''));
  const keepRevision = (revision: number) => {
    revisionRef.current = revision;
    setDraftRevision(revision);
  };
  const cardFor = (cid: string) => cards[cid] ?? extra[cid];
  const pushMsg = (m: ChatMessage) => setMessages((ms) => [...ms, m]);
  const addCard = (cid: string, card: ChangeCard) => setExtra((x) => ({ ...x, [cid]: card }));
  const split = !narrow;
  const showPane = (p: 'assistent' | 'tjeneste') => !split && setPane(p);

  const sessionCards = messages.flatMap((m) => m.cards ?? []);
  const assistedKeys = Object.keys(assisted).filter((k) => !published[k] && !undone[k]);
  const changes = [
    ...sessionCards
      .filter((cid) => !published[cid] && !undone[cid])
      .map(cardFor)
      .filter((c): c is ChangeCard => !!c && !!c.undo)
      .map((c) => c.title),
    ...assistedKeys.map((k) => assisted[k]?.title ?? ''),
  ];
  const fromAi: Record<string, boolean> = {};
  sessionCards.forEach((cid) => {
    const c = cardFor(cid);
    if (c?.undo && !undone[cid]) fromAi[c.section] = true;
  });
  assistedKeys.forEach((k) => {
    const section = assisted[k]?.section;
    if (section) fromAi[section] = true;
  });

  const go = (target: ServiceSection, rest = '') => navigate(servicePath(routeId, target, rest));
  const goTab = (t: ServiceSection) => {
    go(t);
    if (t !== 'setup') showPane('tjeneste');
  };

  useEffect(() => {
    if (!detail) window.scrollTo?.(0, 0);
  }, [section, detail]);

  useEffect(() => setDiscardedTo(undefined), [section]);

  useEffect(() => {
    if (discarding) {
      wasDiscarding.current = true;
      return;
    }
    if (!wasDiscarding.current) return;
    wasDiscarding.current = false;
    const target = discardedNow.current ? discardedAlert.current : discardTrigger.current;
    discardedNow.current = false;
    if (target?.isConnected) target.focus();
  }, [discarding, discardedTo]);

  const addressed = route.segments[2];
  const unshownArea =
    isNew &&
    section === 'setup' &&
    !!detail &&
    (setupAreas as string[]).includes(detail) &&
    (setupLayout
      ? !areaShown(detail)
      : !Object.values(areaOfSection).includes(detail as SetupArea));
  useEffect(() => {
    if (!addressed || (addressed === section && !unshownArea)) return;
    const alias = section === routeSection && detail && !unshownArea ? `/${detail}` : '';
    window.location.replace(`#${servicePath(routeId, section, alias)}`);
  }, [addressed, section, routeSection, routeId, detail, unshownArea]);

  useEffect(() => {
    const target: SectionId | undefined =
      section === 'setup' && setupSections.includes(detail as SectionId)
        ? (detail as SectionId)
        : undefined;
    if (!target) return;
    setOpen((o) => ({ ...o, [target]: true }));
    if (section !== 'setup') return;
    const timer = setTimeout(
      () => document.getElementById(`sek-${target}`)?.scrollIntoView?.({ block: 'start' }),
      60,
    );
    return () => clearTimeout(timer);
  }, [section, detail]);

  const showCard = (cid: string) => {
    const c = cardFor(cid) ?? assisted[cid];
    if (!c) return;
    showPane('tjeneste');
    if (c.section === 'test') {
      setTest((s) => ({ ...s, mode: 'batch' }));
      go('test');
      return;
    }
    const section = c.section as SectionId;
    go('setup', `/${areaOfSection[section] ?? 'purpose'}`);
    setOpen((o) => ({ ...o, [section]: true }));
    setHighlight(section);
    later(() => {
      document
        .getElementById(`sek-${section}`)
        ?.querySelector('button')
        ?.focus({ preventScroll: false });
    }, 60);
    later(() => setHighlight(''), 2600);
  };

  const toggleUndo = (cid: string) => {
    const change = assisted[cid];
    if (change) {
      patch(undone[cid] ? change.after : change.before);
      setUndone((u) => ({ ...u, [cid]: !u[cid] }));
      return;
    }
    const c = cardFor(cid);
    if (!c?.undo) return;
    if (!undone[cid]) {
      const p = c.undo(service);
      const before = specKeysOf(service, p);
      setSaved((s) => ({ ...s, [cid]: before }));
      setUndone((u) => ({ ...u, [cid]: true }));
      patch(p);
    } else {
      patch(saved[cid] ?? {});
      setUndone((u) => ({ ...u, [cid]: false }));
    }
  };

  const runBatch = (fromChat: boolean) => {
    setTest((s) => ({ ...s, mode: 'batch', batch: { ...s.batch, running: true } }));
    go('test');
    showPane('tjeneste');
    later(() => {
      const spec = serviceRef.current.spec;
      const snap = {
        ocr: spec.input.ocr === true,
        example: examplesOf(spec).some((e) => e.input.includes('1,2 mill')),
        model: spec.model.primary,
      };
      const rows = batchRows(snap);
      const ok = rows.filter((r) => r.ok).length;
      const cost = rows.reduce((a, r) => a + r.ore, 0);
      setTest((s) => ({ ...s, batch: { ran: true, running: false, snap } }));
      if (fromChat) {
        const cid = `c-batch-${Date.now()}`;
        addCard(cid, {
          title: 'Kjørte prøve på 10 filer',
          detail: `${ok} ser riktige ut. Kostnad ${formatOre(cost)}.`,
          section: 'test',
          tag: 'Prøve',
        });
        pushMsg({
          role: 'assistant',
          text:
            ok === 10
              ? 'Alle 10 ser riktige ut nå. Søknad_2025_007 får riktig beløp, og den skannede søknaden blir lest. Merk gjerne noen resultater som bra, så kan de bli et testsett.'
              : `Prøven er ferdig. ${ok} av 10 ser riktige ut.`,
          cards: [cid],
        });
      }
    }, 1500);
  };

  const action = (aid: string) => {
    const nextDone = { ...done, [aid]: true };
    setDone(nextDone);
    if (aid === 'a-gotest') {
      goTab('test');
      return;
    }
    if (aid === 'a-rerun') {
      runBatch(true);
      return;
    }
    setTyping(true);
    later(() => {
      if (aid === 'a-example') {
        patch((cur) =>
          withExamples(cur.spec, [
            ...examplesOf(cur.spec),
            {
              input: '«Vi søker om kr 1,2 mill. til nytt øvingslokale.»',
              output: 'Omsøkt beløp: 1200000',
            },
          ]),
        );
        pushMsg({
          role: 'assistant',
          text: 'Lagt til. Eksempelet ligger under Instruksjoner.',
          cards: ['c-example'],
        });
      }
      if (aid === 'a-ocr') {
        patch((cur) => ({ input: { ...cur.spec.input, ocr: true } }));
        pushMsg({ role: 'assistant', text: 'Tekstgjenkjenning er slått på.', cards: ['c-ocr'] });
      }
      setTyping(false);
      if (nextDone['a-example'] && nextDone['a-ocr'])
        pushMsg({
          role: 'assistant',
          text: 'Begge endringene er gjort. Vil du kjøre prøven på nytt?',
          actions: [['a-rerun', 'Kjør prøven på nytt']],
        });
    }, 700);
  };

  const draftChanges = useDraftChanges(tenant, id);
  const firstOpen = useRef({ changes: draftChanges, draft: init.opened });
  const [remote] = useAsync(
    async (signal) => {
      if (!serverDraft || isNew) return undefined;
      const reload = unsaved.current || firstOpen.current.changes !== draftChanges;
      const reused = firstOpen.current.draft;
      const [draft, opened] = await Promise.all([
        reload ? api.quality.draft(tenant, id, signal) : undefined,
        reload || reused === null
          ? undefined
          : (reused ?? api.quality.openDraft(tenant, id, tRef.current('services.rebaseReason'))),
      ]);
      if (opened?.behind && readOnlyRef.current)
        return { draft: undefined, conflicts: [] as DraftConflict[] };
      if (opened?.rebasedFrom !== undefined)
        return {
          draft: opened,
          conflicts: [] as DraftConflict[],
          rebasedTo: opened.latestVersion ?? undefined,
        };
      return { draft: draft ?? opened, conflicts: opened?.conflicts ?? [] };
    },
    [api, tenant, id, serverDraft, draftChanges],
    { keepPreviousFor: id },
  );
  const [publishedLatest] = useAsync(
    async (signal) =>
      serverDraft && !isNew
        ? (await api.getDefinition(tenant, 'Service', id, signal)).latest
        : undefined,
    [api, tenant, id, serverDraft],
    { keepPreviousFor: id },
  );
  const remoteDraft = remote.status === 'ready' ? remote.data?.draft : undefined;
  const remoteLatest = publishedLatest.status === 'ready' ? publishedLatest.data : undefined;
  const openConflicts = remote.status === 'ready' ? remote.data?.conflicts : undefined;
  const [rebasedNotice, setRebasedNotice] = useState(init.rebasedTo);
  const rebasedTo =
    remote.status === 'ready' && remote.data && 'rebasedTo' in remote.data
      ? (remote.data.rebasedTo ?? remoteLatest?.version)
      : undefined;
  useEffect(() => {
    if (rebasedTo !== undefined) setRebasedNotice(rebasedTo);
  }, [rebasedTo]);
  const [rebased, setRebased] = useState<{ base: number; latest: number }>();
  const draftBase = rebased?.base ?? remoteDraft?.baseVersion;
  const remoteLatestVersion = Math.max(
    remoteLatest?.version ?? 0,
    remoteDraft?.latestVersion ?? 0,
    rebased?.latest ?? 0,
  );
  const forbidden = Object.values(prohibited).some(Boolean);
  const canPublish = rights.has('manage-services');
  const canDelete = serverDraft && isNew && draftRevision > 0 && canPublish;
  const [deleting, setDeleting] = useState<'asking' | 'busy' | 'failed'>();
  const edited = JSON.stringify(service) !== JSON.stringify(init.definition);
  const high = service.spec.riskClass === 'high';
  const serviceId = isNew ? slug(service.metadata.name ?? '') || 'ny-tjeneste' : id;
  const current = Math.max(versions[0]?.n ?? 0, remoteLatestVersion);
  const definition = useMemo(
    () =>
      forTenant(service, {
        tenant,
        id: serviceId,
        version: current + 1,
      }) as unknown as Record<string, unknown>,
    [service, tenant, serviceId, current],
  );
  const rename = (name: string) => change((d) => renameService(d, name, current > 0));
  const confirmRisk = (risk: RiskClass | undefined) =>
    change((d) =>
      applySpec(d, {
        riskConfirmation: risk
          ? riskConfirmationFor(risk, riskReasons(high), new Date())
          : undefined,
      }),
    );
  const yaml = useMemo(() => toYaml(definition), [definition]);
  const flowRef = flowOf(service.spec);
  const [flowDefinition] = useAsync(
    async (signal) => {
      if (!flowRef) return undefined;
      const at = flowRef.lastIndexOf('@');
      return api
        .getVersion(tenant, 'StepFlow', flowRef.slice(0, at), Number(flowRef.slice(at + 1)), signal)
        .catch(() => undefined);
    },
    [api, tenant, flowRef],
  );
  const [operationCatalog] = useAsync((signal) => api.listModels({}, signal), [api]);
  const pinnedFlow =
    flowDefinition.status === 'ready' ? flowDefinition.data?.definition : undefined;
  const operationModels = useMemo(
    () =>
      operationKindsIn(pinnedFlow).map((kind) => ({
        kind,
        models:
          operationCatalog.status === 'ready'
            ? operationCatalog.data
                .filter((m) => m.operations?.includes(kind))
                .map((m) => {
                  const choice = modelFor(m.id, m.residency, true);
                  return { id: m.id, name: choice.name, where: choice.where };
                })
            : [],
      })),
    [pinnedFlow, operationCatalog],
  );
  const flowCheck =
    flowRef && flowDefinition.status === 'ready' && flowDefinition.data
      ? checkFlowInputs(
          flowRef,
          flowDefinition.data.definition,
          (service.spec.input.fields ?? []).map((f) => f.id),
        )
      : undefined;
  const inputLookup = useMemo<InputOptionLookup | undefined>(
    () =>
      live
        ? {
            datasets: async (signal) =>
              (await api.datasets.list(tenant, signal)).flatMap((d) =>
                d.facets ? [{ ref: d.fullId, name: d.name, facets: d.facets }] : [],
              ),
            values: async (dataset, facet, signal) =>
              ((await api.facets(dataset, tenant, [facet], signal))[0]?.options ?? []).map((o) => ({
                value: o.value,
                count: o.count,
              })),
          }
        : undefined,
    [api, tenant, live],
  );
  const publishedFieldIds = (
    ((remoteLatest?.definition as { spec?: { input?: { fields?: unknown } } } | undefined)?.spec
      ?.input?.fields as { id?: unknown }[] | undefined) ?? []
  ).flatMap((f) => (typeof f.id === 'string' ? [f.id] : []));
  const definitionRef = useRef(definition);
  definitionRef.current = definition;

  const saveDraft = async (): Promise<void> => {
    if (!serverDraft || !unsaved.current || draftBlocked.current || saving.current) return;
    saving.current = true;
    let settle: () => void = () => undefined;
    savingRun.current = new Promise<void>((resolve) => (settle = resolve));
    setSaveState('saving');
    const tick = editsRef.current;
    const first = isNew && revisionRef.current === 0;
    try {
      const saved = await api.quality.saveDraft(
        tenant,
        id,
        {
          definition: definitionRef.current,
          files: filesRef.current,
          revision: revisionRef.current,
        },
        tRef.current('services.draftSavedReason'),
      );
      keepRevision(saved.revision);
      setSavedAt(saved.at);
      if (saved.by) selfActor.current = saved.by;
      setSavedBy(savedByOf(saved));
      if (first)
        window.location.replace(
          window.location.hash.replace(/^#\/services\/new\b/, `#${servicePath(id)}`),
        );
      if (editsRef.current === tick) unsaved.current = false;
      setSaveState(unsaved.current ? 'unsaved' : 'idle');
    } catch (error) {
      draftBlocked.current = error instanceof ApiError && error.status === 409;
      setSaveState(draftBlocked.current ? 'conflict' : 'failed');
      if (draftBlocked.current && !isNew)
        void api.quality.draft(tenant, id).then(setConflictDraft, () => undefined);
      setFailedAt(f.time(new Date()));
      if (isNew)
        setFlash(
          draftBlocked.current
            ? tRef.current('services.draftChangedElsewhere')
            : tRef.current('services.draftSaveFailed'),
        );
      return;
    } finally {
      saving.current = false;
      settle();
    }
    if (unsaved.current) await saveDraft();
  };

  useEffect(() => {
    if (!serverDraft || !unsaved.current) return;
    const timer = setTimeout(() => void saveDraft(), draftDelayMs);
    return () => clearTimeout(timer);
  }, [edits]);
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  useEffect(() => () => void saveDraftRef.current(), []);

  useEffect(() => {
    if (!remoteDraft || remoteDraft.revision === revisionRef.current || unsaved.current) return;
    keepRevision(remoteDraft.revision);
    setSavedAt(remoteDraft.at);
    setSavedBy(savedByOf(remoteDraft));
    setService(asServiceDefinition(remoteDraft.definition));
    setFiles(remoteDraft.files);
  }, [remoteDraft]);

  const draftBar = serverDraft && !isNew;
  const liveVersion = baseline ?? remoteLatest;
  const [pointerRound, setPointerRound] = useState(0);
  const [pointers] = useAsync(
    async (signal) =>
      draftBar && liveVersion ? api.environments.list(tenant, id, signal) : undefined,
    [api, tenant, id, draftBar, liveVersion?.version, pointerRound],
    { keepPreviousFor: id },
  );
  const { address, known: addressKnown } = useServiceAddress(
    api,
    tenant,
    id,
    Boolean((draftBar && liveVersion) || (live && !isNew && showsInUse)),
  );
  // A published service whose address sources both answered without one.
  const noAddress = !address && addressKnown && !archived;
  const inUseVersion =
    pointers.status === 'ready'
      ? (pointers.data?.environments?.find((e) => e.name === productionEnvironment)?.version ??
        undefined)
      : pointers.status === 'error'
        ? liveVersion?.version
        : undefined;
  const [olderInUse] = useAsync(
    async (signal) =>
      draftBar && liveVersion && inUseVersion !== undefined && inUseVersion !== liveVersion.version
        ? api.getVersion(tenant, 'Service', id, inUseVersion, signal)
        : undefined,
    [api, tenant, id, draftBar, inUseVersion, liveVersion?.version],
    { keepPreviousFor: id },
  );
  const inUseBase =
    olderInUse.status === 'ready' && olderInUse.data ? olderInUse.data : liveVersion;
  const inUseDefinition = useMemo(
    () => (inUseBase ? asServiceDefinition(inUseBase.definition) : undefined),
    [inUseBase],
  );
  const fileKey = JSON.stringify([
    service.spec.input.accepts,
    service.spec.knowledge?.runtimeDocuments === true,
  ]);
  // The Oppsett form always holds Inndata; Avansert and the publish page do not.
  const onInputArea = section === 'setup' && detail !== 'publish';
  const [fileInput] = useAsync(
    async () =>
      live && draftBar && onInputArea
        ? api.draftFileInput(tenant, definitionRef.current)
        : undefined,
    [api, tenant, live, draftBar, onInputArea, fileKey],
  );
  const publishedDefinition = useMemo(
    () => (liveVersion ? asServiceDefinition(liveVersion.definition) : undefined),
    [liveVersion],
  );
  const changeList = useMemo(
    () =>
      publishedDefinition
        ? diffDraft(
            withPromptFiles(publishedDefinition, liveVersion?.files ?? {}),
            withPromptFiles(service, files),
          )
        : [],
    [publishedDefinition, service, liveVersion, files],
  );
  const unpublished = useMemo(
    () =>
      inUseDefinition && inUseBase !== liveVersion
        ? diffDraft(
            withPromptFiles(inUseDefinition, inUseBase?.files ?? {}),
            withPromptFiles(service, files),
          )
        : changeList,
    [inUseDefinition, inUseBase, liveVersion, service, files, changeList],
  );
  const hasDraft = draftRevision > 0 || changeList.length > 0;
  const canSend = hasDraft || unpublished.length > 0;
  // A published service sets its risk and Sikkerhetsregler on the publish page, so it opens with nothing changed.
  const canOpenPublish = canSend || !isNew;
  const listedChanges = unpublished.filter((c) => c.topic !== 'riskConfirmation');
  const overviewPublished = inUseEdition ?? remoteLatest;
  const [checks, retryChecks] = useAsync(
    (signal) =>
      serverDraft && draftRevision > 0
        ? draftChecks(api, tenant, id, signal)
        : Promise.resolve(null),
    [api, tenant, id, serverDraft, draftRevision],
  );
  const checkProblems = checks.status === 'ready' && checks.data ? checks.data.problems : [];

  useEffect(() => {
    if (!draftBar || (saveState !== 'unsaved' && saveState !== 'saving' && saveState !== 'failed'))
      return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draftBar, saveState]);

  useEffect(() => {
    if (openPublish && edition !== 'inUse') go('setup', '/publish');
  }, []);

  // In the one long form, an area's address scrolls to it.
  useEffect(() => {
    if (section !== 'setup' || !detail) return;
    const timer = setTimeout(
      () => document.getElementById(`omrade-${detail}`)?.scrollIntoView?.({ block: 'start' }),
      60,
    );
    return () => clearTimeout(timer);
  }, [section, detail]);

  const applyProposal = (entry: TurnEntry, proposal: AssistantProposal) => {
    if (proposal.kind === 'interface' && proposal.blocks?.length) {
      setAdding({ key: proposalKey(entry.id, proposal.id), blocks: proposal.blocks });
      goTab('interface');
      return;
    }
    if (!proposal.after) return;
    const after = specChanges(
      asServiceDefinition(entry.draft).spec,
      asServiceDefinition(proposal.after).spec,
    );
    const before = specKeysOf(serviceRef.current, after);
    setAssisted((a) => ({
      ...a,
      [proposalKey(entry.id, proposal.id)]: {
        title: proposal.title,
        section: proposal.section ?? 'instructions',
        before,
        after,
      },
    }));
    patch(after);
  };

  const assistant = useAssistant({
    api,
    tenant,
    service: isNew ? 'new' : id,
    definition: () => definitionRef.current,
    onMessage: pushMsg,
    onApply: applyProposal,
  });

  const send = (text: string) => {
    const v = text.trim();
    if (!v || typing || assistant.pending || assistant.streaming) return;
    setComposer('');
    void assistant.send(v);
  };

  const tweak = live ? null : route.query.get('assistent');
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!isAssistantState(tweak) || tweak === 'normal' || seeded.current === tweak) return;
    seeded.current = tweak;
    const turn = exampleAssistantTurn(tweak, definitionRef.current);
    if (tweak === 'avslatt') assistant.setAvailability({ kind: 'disabled' });
    if (tweak === 'forbedre-instruksjoner') {
      setOpen((o) => ({ ...o, instructions: true }));
      setPane('tjeneste');
    }
    if (tweak === 'testforslag') {
      setPane('tjeneste');
      go('test');
    }
    if (turn) assistant.seed(assistantUserMessages[tweak], turn, definitionRef.current);
  }, [tweak]);

  const autoSent = useRef(false);
  useEffect(() => {
    if (!init.autoSend || autoSent.current) return;
    autoSent.current = true;
    void assistant.send(init.autoSend);
  }, []);

  const canApprove = (level: number) =>
    level === 3
      ? tweak !== 'plattform-3-uten-rett' && rights.has('register-building-blocks')
      : rights.has('manage-services');

  const decide = (
    proposal: AssistantProposal,
    action: 'approve' | 'reject' | 'send',
    reason: string,
  ) => {
    const pid = proposal.storedProposalId ?? proposal.id;
    return action === 'approve'
      ? api.assistant.approveProposal(tenant, pid, reason)
      : action === 'reject'
        ? api.assistant.rejectProposal(tenant, pid, reason)
        : api.assistant.sendProposalForApproval(tenant, pid, reason);
  };
  const assistantOff = assistant.availability.kind !== 'ready';
  const improve = assistant.improve;
  const improveSlot = (
    <ImproveInstructions
      state={improve}
      off={assistantOff}
      onToggle={() => void assistant.startImprove(sharedInstructionsOf(serviceRef.current.spec))}
      onApply={() => {
        if (improve.status !== 'open') return;
        const text = improve.data.after;
        patch((cur) => withSharedInstructions(cur.spec, text));
        assistant.setImprove({ ...improve, status: 'applied' });
      }}
      onUndo={() => {
        if (improve.status !== 'applied') return;
        const text = improve.previous;
        patch((cur) => withSharedInstructions(cur.spec, text));
        assistant.setImprove({ ...improve, status: 'open' });
      }}
      onClose={() => assistant.setImprove({ status: 'idle' })}
    />
  );
  const model =
    modelCatalog?.find((m) => m.id === service.spec.model.primary) ??
    modelFor(service.spec.model.primary, service.spec.model.residency, live);
  const fallback = (modelCatalog ?? models).find((x) => x.id === service.spec.model.fallback);
  const per1000 = Math.round(
    (model?.ore ?? 0) * (service.spec.strategy.id === 'agent-loop' ? 3 : 1) * 10,
  );
  const riskSet = !!service.spec.riskClass;
  const riskPassed = riskConfirmed && riskSet;
  const riskKey = riskLabelKey[service.spec.riskClass ?? ''];
  const riskLabel = riskKey ? t(riskKey) : undefined;

  const [problems, setProblems] = useState<{
    errors: PublishProblem[];
    refusedByGates: boolean;
    outdated?: true;
  }>();
  const rebasedDraft = useRef<ServiceDraft | undefined>(undefined);

  const keepConfirmation = (next: ServiceDefinition) => {
    const mine = serviceRef.current.spec.riskConfirmation;
    return mine && !next.spec.riskConfirmation && next.spec.riskClass === mine.riskClass
      ? applySpec(next, { riskConfirmation: mine })
      : next;
  };

  const takeDraft = (draft: ServiceDraft) => {
    rebasedDraft.current = draft;
    unsaved.current = false;
    keepRevision(draft.revision);
    setService(keepConfirmation(asServiceDefinition(draft.definition)));
    setFiles(draft.files);
    if (typeof draft.latestVersion === 'number')
      setRebased({ base: draft.baseVersion ?? draft.latestVersion, latest: draft.latestVersion });
  };

  const [pinDone, setPinDone] = useState(false);
  const pinTick = useRef(0);
  const pinActions: PinActions = {
    beforePin: async (layout?: AssistantLayout) => {
      while (saving.current) await savingRun.current;
      if (layout) {
        writeLayout(layout);
        definitionRef.current = forTenant(
          applySpec(serviceRef.current, (d) => ({ interface: { ...d.spec.interface, layout } })),
          { tenant, id: serviceId, version: current + 1 },
        ) as unknown as Record<string, unknown>;
      }
      await saveDraft();
      if (unsaved.current || draftBlocked.current)
        throw new Error(
          tRef.current(
            draftBlocked.current ? 'services.draftChangedElsewhere' : 'services.draftSaveFailed',
          ),
        );
      pinTick.current = editsRef.current;
    },
    done: pinDone,
    onPinned: (draft, pinned) => {
      setPinDone(pinned);
      keepRevision(draft.revision);
      const local = draftLayoutOf(definitionRef.current);
      if (editsRef.current !== pinTick.current && isAssistantLayout(local)) {
        writeLayout(withPinsOf(local, draftLayoutOf(draft.definition)));
        return;
      }
      unsaved.current = false;
      setService(asServiceDefinition(draft.definition));
      setFiles(draft.files);
    },
  };

  const rebaseDraft = async (): Promise<DraftConflict[]> => {
    await saveDraft();
    const result = await api.quality.rebaseDraft(tenant, id, tRef.current('services.rebaseReason'));
    takeDraft(result.draft);
    return result.conflicts;
  };

  const resolveConflicts = async (
    picks: Record<string, ConflictPick>,
    conflicts: DraftConflict[],
  ) => {
    const base = rebasedDraft.current;
    if (!base) return;
    const chosen = conflicts.filter((c) => picks[c.path] === 'published');
    if (chosen.length === 0) return;
    const definition = chosen.reduce((d, c) => setAt(d, c.path, c.published), base.definition);
    const saved = await api.quality.saveDraft(
      tenant,
      id,
      { definition, files: base.files, revision: revisionRef.current },
      tRef.current('services.pickedReason'),
    );
    takeDraft(saved);
  };
  const resolveOpenConflicts = async (
    picks: Record<string, ConflictPick>,
    conflicts: DraftConflict[],
  ) => {
    await rebaseDraft();
    await resolveConflicts(picks, conflicts);
  };
  const [check, setCheck] = useState<
    | { status: 'checking' }
    | { status: 'done'; errors: PublishProblem[]; unmasked: UnmaskedInputUse[] }
    | undefined
  >();
  const [unmaskedReasons, setUnmaskedReasons] = useState<Record<string, string>>({});
  const [unmaskedRefused, setUnmaskedRefused] = useState<{
    uses: UnmaskedInputUse[];
    messages: Record<string, string>;
  }>({ uses: [], messages: {} });
  const checkedRef = useRef<Record<string, unknown>>(undefined);
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    if (!publish) {
      setCheck(undefined);
      setUnmaskedRefused({ uses: [], messages: {} });
      return;
    }
    let active = true;
    checkedRef.current = definitionRef.current;
    setCheck({ status: 'checking' });
    api
      .completeDefinition(definitionRef.current)
      .then((completed) => api.validate(completed, filesRef.current))
      .then(
        (result) => {
          if (!active) return;
          const unmasked = result.unmaskedInput ?? [];
          setUnmaskedReasons((given) => ({
            ...Object.fromEntries(
              unmasked.flatMap((u) => (u.consent ? [[u.mediaType, u.consent.reason]] : [])),
            ),
            ...given,
          }));
          setCheck({ status: 'done', errors: result.errors, unmasked });
        },
        (error: unknown) =>
          active &&
          setCheck({
            status: 'done',
            errors: problemErrors(error, tRef.current),
            unmasked: [],
          }),
      );
    return () => {
      active = false;
    };
  }, [publish, recheck]);
  // Risk and guards can be fixed on the publish page, so a change there is checked again.
  useEffect(() => {
    if (!publish || definition === checkedRef.current) return;
    const timer = setTimeout(() => setRecheck((n) => n + 1), 400);
    return () => clearTimeout(timer);
  }, [publish, definition]);
  const validationErrors = check?.status === 'done' ? check.errors : [];
  const unmaskedUses = [
    ...(check?.status === 'done' ? check.unmasked : []),
    ...unmaskedRefused.uses,
  ];
  const unmaskedTypeList = unmaskedTypes(unmaskedUses);
  const unmaskedMissing = unmaskedTypeList.filter(
    (m) => !isUnmaskedReasonGiven(unmaskedReasons[m]),
  ).length;
  const publishable = withUnmaskedInput(
    definition,
    Object.fromEntries(unmaskedTypeList.map((m) => [m, unmaskedReasons[m] ?? ''])),
  );
  const invalid = validationErrors.length > 0;
  const blockedBy =
    check?.status === 'checking'
      ? t('services.checkingDraft')
      : invalid
        ? t('services.publishLocked')
        : undefined;

  const record = (n: number, mode: 'test' | 'prod', who: string, reason: string) => {
    const nv: VersionItem = {
      n,
      when: tRef.current('services.today', { time: f.time(new Date()) }),
      who,
      state: mode === 'test' ? 'I test' : 'I bruk',
      score: hasTestSet
        ? tRef.current('services.testsetScore', { score: scoreFact })
        : tRef.current('services.noTestset'),
      diff: changes,
      ...(reason ? { reason } : {}),
    };
    setVersions((vs) => [
      nv,
      ...vs.map((v) =>
        (mode === 'prod' && v.state === 'I bruk') || (mode === 'test' && v.state === 'I test')
          ? { ...v, state: 'Tidligere' as const }
          : v,
      ),
    ]);
    const pub = { ...published };
    sessionCards.forEach((cid) => (pub[cid] = true));
    setPublished(pub);
    setPublish(null);
    setFlash(
      tRef.current(mode === 'test' ? 'services.publishedTest' : 'services.published', { n }),
    );
  };

  const doPublish = async ({
    reason,
    stampRisk = false,
    variantChoices = {},
  }: PublishInput & { stampRisk?: boolean; variantChoices?: Record<string, VariantChoice> }) => {
    setProblems(undefined);
    setUnmaskedRefused({ uses: [], messages: {} });
    draftBlocked.current = true;
    const chosen = withVariantChoices(
      publishable as unknown as ServiceDefinition,
      variantChoices,
    ) as unknown as Record<string, unknown>;
    const outcome = await publishDraft(
      api,
      stampRisk && service.spec.riskClass
        ? withRiskStamp(
            chosen,
            riskConfirmationFor(service.spec.riskClass, riskReasons(high), new Date()),
          )
        : chosen,
      files,
      reason,
      serverDraft && revisionRef.current > 0 ? revisionRef.current : undefined,
    );
    if (!outcome.ok) {
      draftBlocked.current = false;
      const refused = refusedUnmaskedInput(outcome.errors);
      setUnmaskedRefused({
        uses: refused,
        messages: Object.fromEntries(
          refused.map((u) => [
            u.mediaType,
            tRef.current('unmaskedInput.refused', {
              kind: mediaKind(tRef.current, u.mediaType),
              mediaType: u.mediaType,
            }),
          ]),
        ),
      });
      setProblems(outcome);
      throw new Error(outcome.errors[0]?.message ?? tRef.current('services.publishFailed'));
    }
    unsaved.current = false;
    draftBlocked.current = false;
    if (serverDraft && revisionRef.current > 0) {
      const cleared = await api.quality
        .deleteDraft(tenant, id, revisionRef.current, reason)
        .then(() => true)
        .catch(() => false);
      if (cleared) keepRevision(0);
    }
    const result = outcome.published;
    if (draftBar && result.definition) {
      setBaseline({
        version: result.version,
        definition: result.definition,
        ...(result.files ? { files: result.files } : {}),
      });
      setService(asServiceDefinition(result.definition));
      setSaveState('idle');
      setSavedAt(undefined);
      setSavedBy(undefined);
      setDiscardedTo(undefined);
    }
    record(
      result.version,
      'prod',
      actorLabel(result.publishedBy, tRef.current, result.publishedByName),
      reason,
    );
    await giveUsers(result, reason);
    if (isNew && serverDraft) window.location.replace(`#${servicePath(result.id)}`);
  };

  const giveUsers = async (result: PublishResult, reason: string) => {
    try {
      const environments =
        result.environments ?? (await api.environments.list(tenant, id)).environments;
      const prod = environments.find((e) => e.name === productionEnvironment);
      if (!prod || prod.version === result.version) return;
      const follower = environments.find((e) => e.followsPublishes && e.version === result.version);
      if (follower)
        await api.environments.promote(
          tenant,
          id,
          productionEnvironment,
          follower.name,
          reason,
          result.version,
        );
      else
        await api.environments.rollback(tenant, id, productionEnvironment, result.version, reason);
    } catch {
      setFlash(tRef.current('edition.notGivenToUsers'));
    } finally {
      setPointerRound((r) => r + 1);
    }
  };

  const copyService = async () => {
    const source = service.metadata.name || id;
    const copyName = tRef.current('serviceLifecycle.copyName', { name: source });
    const copyId = newDraftId();
    const copy = applySpec(renamed(service, copyName), (d) =>
      withPublicName(d.spec, autoPublicName(copyName)),
    );
    setFlash(tRef.current('serviceLifecycle.copying'));
    try {
      await api.quality.saveDraft(
        tenant,
        copyId,
        {
          definition: forTenant(copy, {
            tenant,
            id: slug(copyName),
            version: 1,
          }) as unknown as Record<string, unknown>,
          files,
          revision: 0,
        },
        tRef.current('serviceLifecycle.copyReason', { name: source }),
      );
    } catch {
      setFlash(tRef.current('serviceLifecycle.copyFailed'));
      return;
    }
    setFlash('');
    navigate(servicePath(copyId, 'setup'));
  };

  const deleteDraft = async () => {
    setDeleting('busy');
    draftBlocked.current = true;
    try {
      await api.quality.deleteDraft(
        tenant,
        id,
        revisionRef.current,
        tRef.current('services.deleteDraftReason'),
      );
    } catch {
      draftBlocked.current = false;
      setDeleting('failed');
      return;
    }
    unsaved.current = false;
    window.location.replace('#/services');
  };

  const discardDraft = async () => {
    if (!liveVersion) return;
    draftBlocked.current = true;
    try {
      await api.quality.deleteDraft(
        tenant,
        id,
        revisionRef.current,
        tRef.current('serviceDraft.discardReason'),
      );
    } catch (error) {
      draftBlocked.current = false;
      throw new Error(
        error instanceof ApiError && error.status === 409
          ? tRef.current('serviceDraft.discardChangedElsewhere')
          : tRef.current('serviceDraft.discardFailed'),
        { cause: error },
      );
    }
    unsaved.current = false;
    draftBlocked.current = false;
    keepRevision(0);
    setService(asServiceDefinition(liveVersion.definition));
    setFiles(liveVersion.files ?? {});
    setSaveState('idle');
    setSavedAt(undefined);
    setSavedBy(undefined);
    discardedNow.current = true;
    setDiscarding(false);
    setDiscardedTo(liveVersion.version);
  };

  const testsetFact = hasTestSet ? scoreFact : t('services.testsetNotMade');
  const suggestions =
    testKind(id, service) === 'fields'
      ? [t('services.suggestCost'), t('services.suggestRerun'), t('services.suggestPrivacy')]
      : [t('services.suggestCost'), t('services.suggestShorter')];
  const name = service.metadata.name || t('services.newServiceName');
  const sections = archived
    ? availableSections({ isNew }).filter((s) => archivedSections.includes(s))
    : availableSections({ isNew });
  const tabs = serviceTabs(sections);
  const nextTab = tabs[tabs.findIndex((each) => each.tab === tabOf(section)) + 1];
  const withAssistant = !readOnly && ((section === 'setup' && !setupLayout) || section === 'test');
  const datasetNames =
    datasetOptions.status === 'ready'
      ? new Map(datasetOptions.data.map((x) => [x.id, x.name] as const))
      : undefined;
  const changeNames: ChangeNames = {
    dataset: (ref) => datasetName(ref, datasetNames),
    model: (mid) =>
      modelCatalog?.find((m) => m.id === mid)?.name ?? modelFor(mid, undefined, live).name,
    tool: (ref) =>
      (toolOptions.status === 'ready'
        ? toolOptions.data.find((o) => o.ref === ref)?.name
        : undefined) ?? ref,
  };
  const publishedVersion = liveVersion?.version ?? current;
  const riskChecked = live && checkProblems.some((p) => areaOfPath(p.path) === 'risk');
  const riskProblem = riskOpen && !riskChecked ? t('serviceDraft.missingRisk') : undefined;
  const areaProblems = new Map<SetupArea, string[]>();
  for (const p of live ? checkProblems : []) {
    const area = areaOfPath(p.path);
    if (area)
      areaProblems.set(area, [...(areaProblems.get(area) ?? []), describeProblem(p, t).message]);
  }
  if (riskProblem) areaProblems.set('risk', [...(areaProblems.get('risk') ?? []), riskProblem]);
  // A new service's form lists what an area lacks only once the person has tried to publish (#995).
  const areaFacts = Object.fromEntries(
    setupAreas.map((area): [SetupArea, AreaFact] => [
      area,
      { problems: publishTried ? (areaProblems.get(area) ?? []) : [] },
    ]),
  ) as Record<SetupArea, AreaFact>;
  const modelChange = changeList.find((c) => c.topic === 'model');
  const inUseModel = draftBar ? inUseDefinition?.spec.model.primary : undefined;
  const publishHref = `#${servicePath(routeId, 'setup', '/publish')}`;
  const publishPage = draftBar && canPublish && section === 'setup' && detail === 'publish';
  const variantTitle = (title: { nb: string; en: string } | undefined) =>
    title ? (locale === 'en' ? title.en || title.nb : title.nb || title.en) : undefined;
  const standardName =
    variantTitle(variantsOf(service.spec)[0]?.title) ?? t('edition.variantStandard');
  const variantName = (v: NewVariant) => variantTitle(v.title) ?? v.id;
  const standardId = variantsOf(service.spec)[0]?.id;
  const variantNames = (spec: ServiceDefinition['spec']) =>
    variantsOf(spec)
      .map((v) => {
        const name =
          variantTitle(v.title) ?? (v.id === standardId ? t('edition.variantStandard') : v.id);
        return v.chat === false ? t('edition.variantHiddenName', { name }) : name;
      })
      .join(', ');
  const editionSummary = (d: ServiceDefinition) => ({
    ...areaSummaries(t, d, modelCatalog, datasetNames),
    instructions: setupSummaries(t, d, modelCatalog, datasetNames).instructions,
    variants: variantNames(d.spec),
  });
  const comparedWith = inUseDefinition ?? publishedDefinition;
  const newVariants = publishPage ? newVariantsOf(comparedWith?.spec, service.spec) : [];
  const variantChoices = Object.fromEntries(
    newVariants.map((v) => [v.id, variantPicks[v.id] ?? v.choice]),
  );
  const chooseVariant = (id: string, choice: VariantChoice) =>
    setVariantPicks((now) => ({
      ...Object.fromEntries(
        Object.entries(now).map(([other, picked]) => [
          other,
          choice === 'replaces' && picked === 'replaces' ? 'choosable' : picked,
        ]),
      ),
      [id]: choice,
    }));
  const publishSummaries =
    publishPage && comparedWith
      ? {
          before: editionSummary(withPromptFiles(comparedWith, inUseBase?.files ?? {})),
          after: editionSummary(
            withPromptFiles(withVariantChoices(service, variantChoices), files),
          ),
        }
      : undefined;
  const [gates] = useAsync(
    async (signal) =>
      publishPage
        ? (await api.configList(`/tenants/${encodeURIComponent(tenant)}/gates`, signal)).data
        : [],
    [api, tenant, publishPage],
  );
  const listedGates = service.spec.evaluation?.gates ?? [];
  const runsForGates =
    evalRuns.status === 'ready' && Array.isArray(evalRuns.data) ? evalRuns.data : [];
  const belowPoints =
    gates.status === 'ready' && Array.isArray(gates.data)
      ? gates.data
          .filter((g) => g.mandatory || listedGates.includes(g.id))
          .filter((g) => gateStops(g, runsForGates, inUseVersion ?? publishedVersion))
          .map((g) => {
            const reason = gateStopReason(t, f, g, runsForGates, inUseVersion ?? publishedVersion);
            return reason.charAt(0).toLowerCase() + reason.slice(1);
          })
      : [];
  const qualityBelow = belowPoints.length
    ? t('edition.qualityBelow', { count: belowPoints.length, points: belowPoints.join('; ') })
    : undefined;
  const draftRuns =
    evalRuns.status === 'ready' && Array.isArray(evalRuns.data)
      ? evalRuns.data.filter(
          (r) => r.version === 'draft' && draftRevision > 0 && r.draftRevision === draftRevision,
        )
      : [];
  const testWarning: TestWarning =
    hasTestSet && changeList.length && draftRuns.length === 0
      ? modelChange
        ? 'model'
        : 'draft'
      : undefined;
  const riskToConfirm = (riskOpen || riskChecked) && riskSet && !forbidden;
  const blockingProblems = checkProblems.filter(
    (p) => !(riskToConfirm && areaOfPath(p.path) === 'risk'),
  );
  const missingCount = blockingProblems.length + (riskProblem && !riskToConfirm ? 1 : 0);
  const onlyProblem = blockingProblems[0];
  const onlyArea = onlyProblem ? areaOfPath(onlyProblem.path) : undefined;
  const missingText =
    missingCount === 0
      ? ''
      : missingCount > 1
        ? t('serviceDraft.missingMany', { count: missingCount })
        : riskProblem && !onlyProblem
          ? riskProblem
          : t('serviceDraft.missingOne', {
              section: onlyArea
                ? t(areaLabelKeys[onlyArea])
                : onlyProblem
                  ? describeProblem(onlyProblem, t).section
                  : '',
            });

  useEffect(() => {
    if (!draftBar) return;
    setPublish(publishPage ? 'prod' : null);
    if (publishPage) void saveDraft();
  }, [draftBar, publishPage]);
  const firstPublishPage =
    !draftBar && !showsInUse && canPublish && section === 'setup' && detail === 'publish';
  useEffect(() => {
    if (publishPage || firstPublishPage) setPublishTried(true);
  }, [publishPage, firstPublishPage]);
  useEffect(() => {
    if (draftBar) return;
    if (!firstPublishPage) {
      setPublish(null);
      return;
    }
    setPublish((now) => now ?? 'prod');
    if (serverDraft) void saveDraft();
  }, [draftBar, firstPublishPage]);
  const screenProps = { api, tenant, tenantName, route, live };
  const latest = versions[0];
  const shown =
    remoteLatest && remoteLatest.version > (latest?.n ?? 0)
      ? {
          n: remoteLatest.version,
          when: remoteLatest.publishedAt ? formatDateTime(remoteLatest.publishedAt, f) : '',
        }
      : latest;
  const status: ServiceStatus = archived
    ? 'Arkivert'
    : lifecycle?.state === 'paused'
      ? 'Satt på pause'
      : init.status === 'Utkast' && versions.some((v) => v.state === 'I bruk')
        ? 'I bruk'
        : init.status === 'Utkast' && versions.some((v) => v.state === 'I test')
          ? 'I test'
          : init.status;

  const setup = (only: SectionId[], area?: SetupArea) => (
    <SetupTab
      area={area}
      {...(readOnly ? {} : { ask: send })}
      modelNote={
        inUseModel && inUseModel !== service.spec.model.primary ? (
          <Paragraph data-size="sm" className="meta">
            {t('edition.modelInUse', { model: changeNames.model(inUseModel) })}
          </Paragraph>
        ) : null
      }
      serviceId={id}
      definition={service}
      patch={patch}
      files={files}
      onFile={editFile}
      onRename={rename}
      open={open}
      onToggle={(sid) => setOpen((o) => ({ ...o, [sid]: !o[sid] }))}
      highlight={highlight}
      fromAi={fromAi}
      prohibited={prohibited}
      onProhibited={(i) => {
        setProhibited((p) => ({ ...p, [i]: !p[i] }));
        confirmRisk(undefined);
      }}
      riskConfirmed={riskConfirmed}
      onConfirmRisk={() => !forbidden && riskSet && confirmRisk(service.spec.riskClass)}
      narrow={narrow}
      modelCatalog={modelCatalog}
      {...(live ? { live: { datasets: datasetOptions, tools: toolOptions } } : {})}
      sections={only}
      readOnly={readOnly}
      inUse={publishedDefinition}
      productionHasApp={inUseDefinition?.spec.interface?.layout !== undefined}
      fileInput={fileInput}
      {...(frontends ? { frontends } : {})}
      inputLockedIds={publishedFieldIds}
      inputLookup={inputLookup}
      tenant={tenant}
      flowCheck={flowCheck}
      operationModels={operationModels}
      api={api}
      strategy={
        <StrategyPanel
          api={api}
          tenant={tenant}
          definition={service}
          patch={patch}
          {...(isNew ? {} : { service: id })}
        />
      }
      instructionsAssist={improveSlot}
      assistantOff={assistantOff}
      {...(service.spec.strategy.id === 'remote-agent'
        ? {}
        : {
            languageTabs: (shared: ReactNode) => (
              <LanguageInstructionTabs
                api={api}
                tenant={tenant}
                definition={service}
                patch={patch}
                shared={shared}
                readOnly={readOnly}
              />
            ),
          })}
      {...(live ? { guardrails: <GuardrailRules api={api} tenant={tenant} /> } : {})}
    />
  );

  const assistantPanel = (
    <AssistantPanel
      messages={messages}
      cardFor={cardFor}
      undone={undone}
      done={done}
      applied={Object.fromEntries(Object.keys(assisted).map((k) => [k, true]))}
      typing={typing}
      composer={composer}
      suggestions={suggestions}
      userName={userName}
      tenantName={tenantName}
      assistant={assistant}
      canApprove={canApprove}
      onDecide={decide}
      onComposer={setComposer}
      onSend={send}
      onShow={showCard}
      onUndo={toggleUndo}
      onAction={action}
    />
  );

  const chatAssistantPanel = (
    <AssistantPanel
      chat
      messages={messages}
      cardFor={cardFor}
      undone={undone}
      done={done}
      applied={Object.fromEntries(Object.keys(assisted).map((k) => [k, true]))}
      typing={typing}
      composer={composer}
      suggestions={[]}
      userName={userName}
      tenantName={tenantName}
      assistant={assistant}
      canApprove={canApprove}
      onDecide={decide}
      onComposer={setComposer}
      onSend={send}
      onShow={showCard}
      onUndo={toggleUndo}
      onAction={action}
    />
  );

  const deleteQuestion =
    canDelete && deleting ? (
      <Alert data-color="danger" data-size="sm">
        <Paragraph data-size="sm">{t('services.deleteDraftQuestion', { name })}</Paragraph>
        {deleting === 'failed' ? (
          <Paragraph data-size="sm">{t('services.deleteDraftFailed')}</Paragraph>
        ) : null}
        {deleting === 'busy' ? null : (
          <div className="actions">
            <Button
              variant="primary"
              data-color="danger"
              data-size="sm"
              onClick={() => void deleteDraft()}
            >
              {t('services.deleteDraft')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setDeleting(undefined)}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
      </Alert>
    ) : null;

  const body = (() => {
    if (section === 'overview')
      return (
        <OverviewSection
          api={api}
          tenant={tenant}
          id={id}
          definition={service}
          versions={versions}
          tenantName={tenantName}
          {...(overviewPublished ? { published: overviewPublished } : {})}
        />
      );
    if (section === 'test')
      return (
        <div className="stack">
          <SuggestedTests
            state={assistant.tests}
            off={assistantOff}
            onSuggest={() => void assistant.suggestTests()}
            onDecide={(cid, decision) => {
              assistant.decideTest(cid, decision);
              if (decision === 'accepted') setTest((t) => ({ ...t, testset: true }));
            }}
          />
          {hasOperationSteps(pinnedFlow) ? (
            <PublishedTest
              api={api}
              model={variantsOf(service.spec)[0]?.publicName || `${serviceId}__default`}
              version={isNew ? undefined : shown?.n}
            />
          ) : null}
          <PlaygroundPanel
            layout="full"
            context="service"
            name={serviceId}
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            serviceDraft={{ definition, files }}
            timelinePanel
          />
        </div>
      );
    if (section === 'interface')
      return (
        <InterfaceTab
          api={api}
          tenant={tenant}
          service={id}
          definition={definition}
          files={files}
          narrow={narrow}
          onLayout={readOnly ? undefined : writeLayout}
          pins={!readOnly && serverDraft ? pinActions : undefined}
          fullscreen={detail === 'preview'}
          backHref={`#${servicePath(routeId, 'interface')}`}
          adding={adding}
          onAdded={clearAdding}
          onFullscreen={() => go('interface', '/preview')}
          onExitFullscreen={() => go('interface')}
          published={!isNew}
        />
      );
    if (section === 'advanced') {
      const item = advancedItemOf(detail);
      const shownLayout = shownLayoutOf(definition);
      return (
        <AdvancedTab id={routeId} current={item}>
          {item === 'limits' ? (
            <>
              {isNew ? <Paragraph>{t('service.limitsAfterPublish')}</Paragraph> : null}
              <SettingsSection
                {...screenProps}
                id={id}
                readOnly={readOnly || isNew}
                limits={{
                  logMasked: guardOn(service.spec, 'pii-out-of-log'),
                  own: service.spec.settings ?? {},
                  onLogging: () => go('setup', '/publish'),
                }}
              />
            </>
          ) : item === 'json' ? (
            shownLayout ? (
              <LayoutTransfer layout={shownLayout} onPaste={writeLayout} titled={false} />
            ) : (
              <Paragraph>{t('builderBlocks.foreignText')}</Paragraph>
            )
          ) : item === 'yaml' ? (
            <YamlTab
              api={api}
              generated={yaml}
              onApply={(d) => replaceWith(asServiceDefinition(d))}
            />
          ) : item === 'channels' && !isNew ? (
            <>
              {detail?.split('/')[1] ? null : setup(setupSections, item)}
              <ServiceChannels
                api={api}
                tenant={tenant}
                service={id}
                publicName={variantsOf(service.spec)[0]?.publicName ?? ''}
                onFrontends={setFrontends}
                frontend={detail?.split('/')[1]}
                hasApp={inUseDefinition?.spec.interface?.layout !== undefined}
                listHref={`#${servicePath(routeId, 'advanced', '/channels')}`}
                titled={false}
              />
            </>
          ) : (
            setup(setupSections, item)
          )}
        </AdvancedTab>
      );
    }
    if (section === 'settings') return <SettingsSection {...screenProps} id={id} />;
    if (section === 'quality') return <QualitySection {...screenProps} id={id} />;
    if (section === 'batch')
      return <BatchSection api={api} tenant={tenant} id={id} runId={detail} />;
    if (section === 'log')
      return <LogSection api={api} tenant={tenant} id={id} runId={detail} live={live} />;
    if (section === 'environments')
      return <EnvironmentsSection api={api} tenant={tenant} serviceId={id} />;
    if (section === 'versions')
      return (
        <History
          api={api}
          tenant={tenant}
          serviceId={id}
          askUndo={route.query.get('undo') === '1'}
          onAsked={() => {
            window.location.hash = `#${servicePath(routeId, 'versions')}`;
          }}
          onChanged={onPublished}
        />
      );
    if (setupLayout)
      return (
        <SetupForm
          facts={areaFacts}
          area={(a) => setup(setupSections, a)}
          {...(readOnly ? {} : { assistant: chatAssistantPanel })}
          footer={
            <div className="stack">
              <div className="stack-xs">
                {isNew ? (
                  <Paragraph data-size="sm" className="meta">
                    {t('service.draftNote')}
                  </Paragraph>
                ) : null}
                <Paragraph data-size="sm" className="meta">
                  {t('setupList.savedNote')}
                </Paragraph>
              </div>
              <div className="row-wrap spread">
                {nextTab ? (
                  <Button asChild variant="primary" data-size="sm">
                    <a href={`#${editionPath(routeId, nextTab.target, edition)}`}>
                      {t('service.continueTo', { tab: t(tabLabels[nextTab.tab]) })}
                    </a>
                  </Button>
                ) : null}
                {canDelete && !deleting ? (
                  <Button
                    variant="tertiary"
                    data-color="danger"
                    data-size="sm"
                    onClick={() => setDeleting('asking')}
                  >
                    <Icon icon={TrashIcon} />
                    {t('services.deleteDraft')}
                  </Button>
                ) : null}
              </div>
              {deleteQuestion}
            </div>
          }
        />
      );
    return (
      <div className="stack-sm">
        {setup(setupSections)}
        {isNew ? (
          <Paragraph data-size="sm" className="meta">
            {t('service.draftNote')}
          </Paragraph>
        ) : sections.includes('settings') ? (
          <Paragraph data-size="sm">
            <Link href={`#${servicePath(routeId, 'settings')}`}>{t('service.settingsLink')}</Link>
          </Paragraph>
        ) : null}
      </div>
    );
  })();

  const subNav = (
    <ServiceSubNav id={routeId} sections={sections} current={section} api={api} tenant={tenant} />
  );
  const content = (
    <div className={`service-body service-${section}`}>
      {subSections(tabOf(section), sections).length > 1 ? (
        <div className="service-sub">
          {subNav}
          <div className="service-sub-body">{body}</div>
        </div>
      ) : (
        body
      )}
    </div>
  );

  const invalidAlert = invalid ? (
    <Alert data-color="danger" data-size="sm" role="alert">
      <Heading level={3} data-size="2xs">
        {t('services.notAccepted')}
      </Heading>
      <ul className="bullets">
        {validationErrors.map((e) => {
          const problem = describeProblem(e, t);
          return (
            <li key={`${e.path}-${e.message}`}>
              <strong>{problem.section}:</strong> {problem.message}
            </li>
          );
        })}
      </ul>
    </Alert>
  ) : null;
  // What the first publish page lists in its summary is not repeated below it.
  const publishProblemsAfter = (
    <>
      {draftBase !== undefined && draftBase !== remoteLatestVersion && draftBase > 0 ? (
        <Paragraph data-size="sm">
          {t('services.basedOnVersion', { base: draftBase, latest: remoteLatestVersion })}
        </Paragraph>
      ) : null}
      {problems?.outdated ? (
        <DraftOutdated
          paths={problems.errors.map((e) => e.path)}
          onRebase={rebaseDraft}
          onResolve={resolveConflicts}
        />
      ) : problems ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Paragraph data-size="sm">
            {problems.refusedByGates
              ? t('services.refusedByGates')
              : t('services.notAcceptedShort')}
          </Paragraph>
          <ul className="bullets">
            {problems.errors.map((e) => {
              const problem = describeProblem(e, t);
              return (
                <li key={`${e.path}-${e.message}`}>
                  <strong>{problem.section}:</strong> {problem.message}
                </li>
              );
            })}
          </ul>
        </Alert>
      ) : null}
      {unmaskedTypeList.length ? (
        <UnmaskedInputConsent
          uses={unmaskedUses}
          reasons={unmaskedReasons}
          refused={unmaskedRefused.messages}
          onReason={(mediaType, reason) => {
            setUnmaskedReasons((given) => ({ ...given, [mediaType]: reason }));
            setUnmaskedRefused(({ uses, messages }) => ({
              uses,
              messages: Object.fromEntries(
                Object.entries(messages).filter(([m]) => m !== mediaType),
              ),
            }));
          }}
        />
      ) : null}
    </>
  );
  const publishProblems = (
    <>
      {invalidAlert}
      {publishProblemsAfter}
    </>
  );

  const view = editionView(section, edition);
  const shownInUse =
    inUseEdition ??
    (olderInUse.status === 'ready' && olderInUse.data
      ? olderInUse.data
      : remoteLatest && (inUseVersion ?? remoteLatest.version) === remoteLatest.version
        ? remoteLatest
        : undefined);
  const statusLine =
    view === 'both' ? (
      t('edition.bothStatus')
    ) : view === 'inUse' ? (
      shownInUse ? (
        <>
          {t('edition.inUseStatus', {
            date: f.date(shownInUse.publishedAt, 'medium'),
            who: actorLabel(shownInUse.publishedBy, t, shownInUse.publishedByName),
          })}
          {canPublish && !archived && shownInUse.version > 1 ? (
            <>
              {' '}
              <Link href={`#${servicePath(routeId, 'versions', '?undo=1')}`}>
                {t('edition.undo')}
              </Link>
            </>
          ) : null}
        </>
      ) : null
    ) : (
      <>
        {t('edition.testStatus')}
        {!draftBar ? null : listedChanges.length && canPublish ? (
          <>
            {' '}
            <Link href={publishHref}>
              {t('edition.unpublished', { count: listedChanges.length })}
            </Link>
          </>
        ) : listedChanges.length ? (
          ` ${t('edition.unpublished', { count: listedChanges.length })}`
        ) : (
          ` ${t('edition.allPublished')}`
        )}
      </>
    );

  const page = (
    <ServicePageContext.Provider value>
      <div className="service-page">
        <ServiceHeader
          name={name}
          view={view}
          switchHrefs={isNew || archived ? undefined : switchPaths(routeId, section)}
          status={statusLine}
          lifecycle={status === 'Arkivert' || status === 'Satt på pause' ? status : undefined}
          flash={flash}
          actions={
            <>
              {canPublish && draftBar && !archived && view !== 'inUse' && missingText ? (
                <span className="meta service-missing">{missingText}</span>
              ) : null}
              {canPublish && !isNew && lifecycle && !archived ? (
                <ServiceLifecycle
                  api={api}
                  tenant={tenant}
                  id={id}
                  name={service.metadata.name || id}
                  onChanged={() => {
                    reloadLifecycle();
                    onPublished?.();
                  }}
                  {...(live ? { onCopy: () => void copyService() } : {})}
                />
              ) : null}
              {address && !archived ? (
                <Button asChild variant="secondary" data-size="sm">
                  <a href={address} target="_blank" rel="noopener noreferrer">
                    {t('edition.openService')}
                    <Icon icon={ExternalLinkIcon} />
                    <span className="visually-hidden"> {t('edition.opensInNewTab')}</span>
                  </a>
                </Button>
              ) : noAddress ? (
                <Link
                  className="meta service-no-address"
                  href={`#${servicePath(routeId, 'setup', '/channels')}`}
                >
                  {t('edition.noAddress')}
                </Link>
              ) : null}
              <Button asChild variant="secondary" data-size="sm">
                <a href={`#${servicePath(routeId, 'interface', '/preview')}`}>
                  <Icon icon={PlayIcon} />
                  {t('edition.testService')}
                </a>
              </Button>
              {archived || view === 'inUse' ? null : !canPublish ? (
                <Button
                  variant="primary"
                  data-size="sm"
                  aria-disabled
                  title={t('edition.ownersOnly')}
                >
                  {t('edition.publish')}
                </Button>
              ) : !draftBar &&
                !isNew &&
                current > 0 &&
                !changes.length &&
                draftRevision === 0 &&
                !edited ? (
                <span className="meta">{t('services.nothingToPublish')}</span>
              ) : draftBar ? (
                <Button
                  variant="primary"
                  data-size="sm"
                  aria-disabled={!canOpenPublish || missingCount > 0 || undefined}
                  onClick={() => {
                    setPublishTried(true);
                    if (canOpenPublish && missingCount === 0) go('setup', '/publish');
                  }}
                >
                  {t('edition.publish')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  data-size="sm"
                  onClick={() => {
                    setPublishTried(true);
                    go('setup', '/publish');
                  }}
                >
                  {t('edition.publish')}
                </Button>
              )}
            </>
          }
        />
        <ServiceNav
          id={routeId}
          name={service.metadata.name}
          sections={sections}
          current={section}
          edition={edition}
          icons
        />
        {draftBar && !archived && (saveState === 'failed' || saveState === 'conflict') ? (
          <DraftBar
            state={saveState}
            hasDraft={hasDraft}
            failedAt={failedAt}
            conflictBy={
              conflictDraft
                ? {
                    saver: saverOf(savedByOf(conflictDraft), self),
                    at: f.time(conflictDraft.at),
                  }
                : undefined
            }
            conflictDiff={
              conflictDraft ? (
                <ul className="discard-lost">
                  {diffDraft(asServiceDefinition(conflictDraft.definition), service).map((c, i) => (
                    <li key={`${c.topic}-${i}`}>
                      <span className="meta">{changeLabel(t, c)}</span>
                      <span>{changeText(t, c, changeNames)}</span>
                    </li>
                  ))}
                </ul>
              ) : undefined
            }
            canEdit={!readOnly}
            changesHref={publishHref}
            onSave={() => void saveDraft()}
            onDiscard={() => {
              discardTrigger.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              setDiscarding(true);
            }}
          />
        ) : null}
        {discardedTo !== undefined ? (
          <Alert
            ref={discardedAlert}
            tabIndex={-1}
            data-color="success"
            data-size="sm"
            role="status"
          >
            {t('serviceDraft.discarded', { n: discardedTo })}
          </Alert>
        ) : null}
        {discarding && liveVersion ? (
          <DiscardDialog
            name={name}
            version={liveVersion.version}
            items={changeList.map((c) => ({
              label: changeLabel(t, c),
              text: changeText(t, c, changeNames),
            }))}
            savedAt={savedAt ? dayAndTime(savedAt) : undefined}
            savedBy={saverOf(savedBy, self)}
            detailsHref={publishHref}
            onKeep={() => setDiscarding(false)}
            onConfirm={discardDraft}
          />
        ) : null}
        {archived && lifecycle ? (
          <ArchivedBanner
            api={api}
            tenant={tenant}
            id={id}
            name={service.metadata.name || id}
            lifecycle={lifecycle}
            canRestore={rights.has('manage-services')}
            onChanged={() => {
              reloadLifecycle();
              onPublished?.();
            }}
          />
        ) : readOnly && !showsInUse ? (
          <Alert data-color="info" data-size="sm">
            <Heading level={2} data-size="2xs">
              {t('servicesScreen.readOnlyTitle')}
            </Heading>
            <Paragraph data-size="sm">
              {t('servicesScreen.readOnlyText', { right: rightLabel(t, 'manage-services') })}
            </Paragraph>
          </Alert>
        ) : null}
        {section === 'setup' ? <HandoverNotice draft={id} /> : null}
        {rebasedNotice !== undefined ? (
          <Alert data-color="success" data-size="sm">
            {t('services.draftRebasedTo', { n: rebasedNotice })}
          </Alert>
        ) : null}
        {openConflicts?.length ? (
          <DraftOutdated
            paths={openConflicts.map((c) => c.path)}
            conflicts={openConflicts}
            onRebase={rebaseDraft}
            onResolve={resolveOpenConflicts}
          />
        ) : null}
        {!withAssistant ? (
          content
        ) : split ? (
          <div className="builder-split">
            {assistantPanel}
            <div className="builder-canvas">{content}</div>
          </div>
        ) : (
          <Tabs value={pane} onChange={(v) => setPane(v as 'assistent' | 'tjeneste')}>
            <TabsList aria-label={t('services.viewLabel')}>
              <TabsTab value="assistent">{t('services.tabAssistant')}</TabsTab>
              <TabsTab value="tjeneste">{t('services.tabService')}</TabsTab>
            </TabsList>
            <TabsPanel value="assistent">{pane === 'assistent' ? assistantPanel : null}</TabsPanel>
            <TabsPanel value="tjeneste">{pane === 'tjeneste' ? content : null}</TabsPanel>
          </Tabs>
        )}
      </div>
    </ServicePageContext.Provider>
  );
  const formAreas: SetupArea[] = ['purpose', 'sources', 'input', 'result', 'model'];
  const leftFor = (p: { path: string; message: string }, key: string): Left => {
    const area = areaOfPath(p.path);
    const problem = describeProblem(p as PublishProblem, t);
    const where = area === 'risk' ? 'risk' : area === 'guards' ? 'guards' : undefined;
    return {
      key,
      text: t('publish.leftProblem', {
        problem: problem.message,
        area: area ? t(areaLabelKeys[area]) : problem.section,
      }),
      ...(where ? { on: where } : {}),
      href:
        area && formAreas.includes(area)
          ? `#${servicePath(routeId, 'setup', `/${area}`)}`
          : area && (advancedItems as readonly string[]).includes(area)
            ? `#${servicePath(routeId, 'advanced', `/${area}`)}`
            : `#${servicePath(routeId, 'setup', '/publish')}`,
    };
  };
  const listed: Left[] = [
    ...(check?.status === 'checking' ? [{ key: 'checking', text: t('publish.leftChecking') }] : []),
    ...validationErrors.map((e, i) => leftFor(e, `invalid-${i}`)),
    ...checkProblems
      .filter((p) => areaOfPath(p.path) !== 'risk')
      .map((p, i) => leftFor(p, `check-${i}`)),
    ...(forbidden
      ? [{ key: 'forbidden', text: t('publish.leftForbidden'), on: 'risk' as const }]
      : riskPassed
        ? []
        : [
            {
              key: 'risk',
              text: riskSet
                ? t('publish.leftConfirmRisk')
                : (riskProblem ?? t('services.riskNotSet')),
              on: 'risk' as const,
            },
          ]),
    ...(unmaskedMissing ? [{ key: 'unmasked', text: t('publish.leftUnmasked') }] : []),
  ];
  // The draft checks and the schema check can name the same problem.
  const left = listed.filter((item, i) => listed.findIndex((x) => x.text === item.text) === i);
  const freshPublish = (
    <FirstPublish
      title={t('services.publishTitle', {
        name: service.metadata.name || t('services.publishFallbackName'),
      })}
      intro={current === 0 ? t('services.publishFirstInfo') : t('services.publishProdInfo')}
      backHref={`#${servicePath(routeId, 'setup')}`}
      left={left}
      facts={[
        { label: t('services.factTestset'), value: testsetFact },
        {
          label: t('services.factCost'),
          value: live
            ? notPricedLabel(t)
            : per1000
              ? t('services.factCostPer1000', { cost: per1000 })
              : t('services.factNotCalculated'),
        },
        {
          label: t('services.factResidency'),
          value: fallback
            ? t('services.residencyWithReserve', {
                where: modelWord(t, model?.where ?? 'Norge'),
                reserve: modelWord(t, fallback.where),
              })
            : modelWord(t, model?.where ?? 'Norge'),
        },
        {
          label: t('services.factRisk'),
          value: (
            <span className="tag-row">
              <ConfirmedTag confirmed={riskPassed} />
              {riskLabel ?? t('services.riskNotSet')}
            </span>
          ),
        },
      ]}
      riskConfirmed={riskPassed}
      riskName={riskLabel ?? t('services.riskNotSet')}
      risk={setup(setupSections, 'risk')}
      guards={setup(setupSections, 'guards')}
      problems={publishProblemsAfter}
      apiCall={{
        action: t('services.publishAction'),
        method: 'POST',
        path: '/definitions',
        body: { definition: publishable, files },
        right: rightLabel(t, 'manage-services'),
      }}
      canPublish={canPublish}
      onPublish={async (reason) => {
        await doPublish({ reason, include: [] });
        if (!(isNew && serverDraft)) go('setup');
      }}
    />
  );
  const firstPublishView = firstPublishPage ? (
    <ServicePageContext.Provider value>
      <div className="service-page">{freshPublish}</div>
    </ServicePageContext.Provider>
  ) : null;
  const publishView =
    publishPage && liveVersion && publishedDefinition ? (
      <ServicePageContext.Provider value>
        <div className="service-page">
          <PublishDiff
            name={name}
            published={withPromptFiles(
              inUseDefinition ?? publishedDefinition,
              inUseBase?.files ?? {},
            )}
            draft={withPromptFiles(service, files)}
            changes={listedChanges}
            names={changeNames}
            summaries={publishSummaries}
            variants={newVariants}
            choices={variantChoices}
            onChoose={chooseVariant}
            variantName={variantName}
            standardName={standardName}
            checks={checks}
            onRetryChecks={retryChecks}
            quality={
              !hasTestSet
                ? 'none'
                : testWarning
                  ? 'stale'
                  : gates.status === 'error' || evalRuns.status === 'error'
                    ? 'unknown'
                    : gates.status === 'ready' && evalRuns.status === 'ready'
                      ? 'met'
                      : 'checking'
            }
            qualityBelow={qualityBelow}
            testHref={`#${servicePath(routeId, 'quality')}`}
            backHref={`#${servicePath(routeId, 'setup')}`}
            canPublish={canPublish}
            blocked={check?.status !== 'done' || invalid || missingCount > 0 || unmaskedMissing > 0}
            blockedReason={
              riskProblem && !riskToConfirm
                ? riskProblem
                : check?.status === 'done'
                  ? blockedBy
                  : t('services.checkingDraft')
            }
            risk={setup(setupSections, 'risk')}
            guards={setup(setupSections, 'guards')}
            riskLevel={
              riskToConfirm && service.spec.riskClass
                ? t(riskLabelKey[service.spec.riskClass] ?? 'setup.riskLimited')
                : undefined
            }
            onPublish={async (reason, stampRisk) => {
              await doPublish({ reason, include: [], stampRisk, variantChoices });
              go('setup');
            }}
          >
            {publishProblems}
          </PublishDiff>
        </div>
      </ServicePageContext.Provider>
    ) : null;
  // The «Grensesnitt» tab's try view goes on while the reader is on another tab of the page.
  return <TryViewKeeper>{firstPublishView ?? publishView ?? page}</TryViewKeeper>;
};
