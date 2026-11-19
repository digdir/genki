import {
  Alert,
  Button,
  Dialog,
  Heading,
  Link,
  Paragraph,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { AssistantProposal } from '../../api/assistant';
import { PlaygroundPanel } from '../../components/playground/PlaygroundPanel';
import { PublishSummary, type PublishInput } from '../../components/PublishSummary';
import {
  assistantStates,
  assistantUserMessages,
  exampleAssistantTurn,
  exampleTemplate,
  type AssistantState,
  batchRows,
  cards,
  exampleUpdates,
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
  keepSharing,
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
  toolRefsOf,
  variantsOf,
  withExamples,
  withPublicName,
} from '../../data/service-form';
import { sharedInstructionsOf, withSharedInstructions } from '../../data/service-languages';
import { useFormat } from '@genai/i18n/react';
import { actorLabel, formatDateTime, notPricedLabel } from '../../format';
import { useT, type PlainKey } from '../../i18n';
import { needsRight, rightLabel, useRights, useUserName } from '../../Shell';
import { navigate, useAsync, useNarrow, type Route } from '../../hooks';
import { toYaml } from '../../yaml';
import { AssistantPanel } from './AssistantPanel';
import { ImproveInstructions } from './assistant/ImproveInstructions';
import { SuggestedTests } from './assistant/SuggestedTests';
import { proposalKey, useAssistant, type TurnEntry } from './assistant/useAssistant';
import type { InputOptionLookup } from './InputFormEditor';
import {
  areaSummaries,
  datasetName,
  modelWord,
  riskConfirmedFor,
  riskNeedsConfirming,
  SetupTab,
  withPromptFiles,
  type SectionId,
} from './SetupTab';
import { TryPane } from './setup-try-pane';
import { DraftBar, savedByOf, saverOf, type SaveState, type SavedBy } from './DraftBar';
import { DiscardDialog } from './DiscardDialog';
import { PublishDiff, type ModelFacts, type TestWarning } from './PublishDiff';
import { SetupLayout, type AreaFact, type SidePane } from './setup-layout';
import { areaLabelKeys, changeLabel, changeText, type ChangeNames } from './setup-change-text';
import { draftChecks } from './setup-checks';
import {
  advancedAreas,
  areaOfPath,
  draftChanges as diffDraft,
  setupAreas,
  type SetupArea,
} from './setup-diff';
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
import { DraftOutdated, type ConflictPick } from './DraftOutdated';
import { VersionsTab, type VersionItem } from './VersionsTab';
import { YamlTab } from './YamlTab';
import { ServiceChannels } from '../service/Channels';
import { ChannelsSection } from '../service/ChannelsSection';
import { VariantsList } from '../service/VariantsList';
import { ServicePageContext } from '../service/context';
import { DefinitionEditor } from '../service/DefinitionEditor';
import { GuardrailRules } from '../service/GuardrailRules';
import { LogSection } from '../service/LogSection';
import { OverviewSection } from '../service/OverviewSection';
import { QualitySection } from '../service/QualitySection';
import { BatchSection } from '../batch/BatchSection';
import {
  availableSections,
  servicePath,
  subSections,
  tabOf,
  type ServiceSection,
} from '../service/sections';
import { ServiceHeader } from '../service/ServiceHeader';
import { ArchivedBanner, ServiceLifecycle } from '../service/ServiceLifecycle';
import { lifecycleChanged, useServiceLifecycle } from '../service/lifecycle';
import { useDraftChanges } from '../service/draft-events';
import { ServiceNav, ServiceSubNav } from '../service/ServiceNav';
import { SettingsSection } from '../service/SettingsSection';
import { StrategyPanel } from '../service/StrategyPanel';
import { Versions } from '../service/Versions';
import { problemErrors } from '../service/definition';
import { describeProblem, publishDraft, type PublishProblem } from '../service/publish';
import { VersionsSection } from '../service/VersionsSection';
import { EnvironmentsSection } from '../service/EnvironmentsSection';
import { LanguageInstructionTabs } from './LanguageInstructionTabs';
import type { AssistantLayout } from '@genai/ui-blocks/builder';
import { InterfaceTab } from './blocks/InterfaceTab';
import { TryViewKeeper } from './blocks/TryViewKeeper';
import { UnmaskedInputConsent } from './UnmaskedInputConsent';
import {
  isUnmaskedReasonGiven,
  mediaKind,
  refusedUnmaskedInput,
  unmaskedTypes,
  withUnmaskedInput,
} from '../../data/unmasked-input';
import type { UnmaskedInputUse } from '../../types';
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

export const newDraftId = () => `utkast-${crypto.randomUUID().slice(0, 8)}`;

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

const archivedSections: ServiceSection[] = ['overview', 'quality', 'versions', 'log'];

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
  onPublished,
}: Props) => {
  const t = useT();
  const f = useFormat();
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
  const [frontends, setFrontends] = useState<string[]>();
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const [files, setFiles] = useState(init.files ?? {});
  const filesRef = useRef(files);
  filesRef.current = files;
  const serverDraft = live && (!isNew || id !== 'new');
  const setupLayout = !isNew || (serverDraft && init.draftRevision !== undefined);
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
  const readOnly = !rights.has('manage-services') || archived;
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
  const [publish, setPublish] = useState<'test' | 'prod' | null>(openPublish ? 'prod' : null);
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
  const [setupArea, setSetupArea] = useState<SetupArea>(() => areaShown(detail) ?? 'purpose');
  const [sidePane, setSidePane] = useState<SidePane>('assistant');

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
      section === 'channels'
        ? 'start'
        : section === 'setup' && setupSections.includes(detail as SectionId)
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
    go('setup');
    const section = c.section as SectionId;
    setSetupArea(areaOfSection[section] ?? 'purpose');
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
    }
    if (unsaved.current) await saveDraft();
  };

  useEffect(() => {
    if (!serverDraft || !unsaved.current) return;
    const timer = setTimeout(() => void saveDraft(), draftDelayMs);
    return () => clearTimeout(timer);
  }, [edits]);

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
  const fileKey = JSON.stringify([
    service.spec.input.accepts,
    service.spec.knowledge?.runtimeDocuments === true,
  ]);
  const onInputArea = setupArea === 'input';
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
  const hasDraft = draftRevision > 0 || changeList.length > 0;
  const [checks, retryChecks] = useAsync(
    (signal) =>
      draftBar && draftRevision > 0 ? draftChecks(api, tenant, id, signal) : Promise.resolve(null),
    [api, tenant, id, draftBar, draftRevision],
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
    if (draftBar && openPublish) go('setup', '/publish');
  }, []);

  useEffect(() => {
    const area = section === 'setup' ? areaShown(detail) : undefined;
    if (area) setSetupArea(area);
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
  const riskNote = riskLabel
    ? t(
        high
          ? 'services.riskNoteHigh'
          : service.spec.riskClass === 'limited'
            ? 'services.riskNoteLimited'
            : 'services.riskNoteOther',
        { label: riskLabel },
      )
    : t('services.riskNotSet');

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
  useEffect(() => {
    if (!publish) {
      setCheck(undefined);
      setUnmaskedRefused({ uses: [], messages: {} });
      return;
    }
    let active = true;
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
  }, [publish]);
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

  const doPublish = async ({ reason }: PublishInput) => {
    setProblems(undefined);
    setUnmaskedRefused({ uses: [], messages: {} });
    draftBlocked.current = true;
    const outcome = await publishDraft(
      api,
      publishable,
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
    if (isNew && serverDraft) window.location.replace(`#${servicePath(result.id)}`);
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

  const doPublishToTest = ({ reason }: PublishInput) => {
    record(current + 1, 'test', userName, reason);
  };

  const rollback = async (v: VersionItem) => {
    if (v.live && !isNew) {
      try {
        const old = await api.getVersion(tenant, 'Service', id, v.n);
        replaceWith(keepSharing(asServiceDefinition(old.definition), service));
      } catch {
        setFlash(tRef.current('services.rollbackFailed', { n: v.n }));
        return;
      }
    }
    setFlash(t('services.rolledBack', { n: v.n }));
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
  const modelFacts = (mid: string): ModelFacts => {
    const found =
      operationCatalog.status === 'ready'
        ? operationCatalog.data.find((m) => m.id === mid)
        : undefined;
    return { name: changeNames.model(mid), residency: found?.residency, price: found?.price };
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
  const missingAreas = new Set(areaProblems.keys());
  const changedAreas = new Set<string>(changeList.map((c) => c.area));
  const areaSummary = areaSummaries(t, service, modelCatalog, datasetNames);
  const optionalArea = (area: SetupArea) =>
    area === 'tools'
      ? toolRefsOf(service.spec).length === 0 && !service.spec.skills?.length
      : area === 'variants'
        ? variantsOf(service.spec).length <= 1
        : area === 'limits'
          ? Object.keys(service.spec.settings ?? {}).length === 0
          : false;
  const areaFacts = Object.fromEntries(
    setupAreas.map((area): [SetupArea, AreaFact] => [
      area,
      {
        status: missingAreas.has(area)
          ? 'missing'
          : changedAreas.has(area)
            ? 'changed'
            : advancedAreas.includes(area) && optionalArea(area)
              ? 'optional'
              : 'done',
        summary: areaSummary[area],
        problems: areaProblems.get(area) ?? [],
        fromAssistant: Object.keys(fromAi).some((key) => areaOfSection[key] === area),
      },
    ]),
  ) as Record<SetupArea, AreaFact>;
  const modelChange = changeList.find((c) => c.topic === 'model');
  const publishHref = `#${servicePath(routeId, 'setup', '/publish')}`;
  const playgroundHref = isNew
    ? `#${servicePath(routeId, 'test')}`
    : `#/playground?service=${encodeURIComponent(id)}`;
  const publishPage = draftBar && canPublish && section === 'setup' && detail === 'publish';
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
  const missingCount = checkProblems.length + (riskProblem ? 1 : 0);
  const onlyProblem = checkProblems[0];
  const onlyArea = onlyProblem ? areaOfPath(onlyProblem.path) : undefined;
  const missingText =
    missingCount === 0
      ? ''
      : missingCount > 1
        ? t('serviceDraft.missingMany', { count: missingCount })
        : riskProblem
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
    isNew && serverDraft && canPublish && section === 'setup' && detail === 'publish';
  useEffect(() => {
    if (!firstPublishPage) return;
    setPublish('prod');
    window.location.replace(`#${servicePath(routeId, 'setup')}`);
  }, [firstPublishPage, routeId]);
  const screenProps = { api, tenant, tenantName, route, live };
  const versionsView = section === 'definition' ? 'yaml' : 'history';
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
  const meta = live
    ? shown
      ? ''
      : t(serverDraft ? 'services.metaNotPublishedAuto' : 'services.metaNotPublished')
    : latest
      ? t('services.metaDraftBased', { n: latest.n })
      : t('services.metaNotPublishedAuto');

  const setup = (only: SectionId[], area?: SetupArea) => (
    <SetupTab
      area={area}
      {...(readOnly
        ? {}
        : {
            ask: (question: string) => {
              setSidePane('assistant');
              send(question);
            },
          })}
      modelNote={
        modelChange && liveVersion ? (
          <Paragraph data-size="sm" className="meta">
            {t('setupList.modelChanged', {
              n: liveVersion.version,
              model: changeNames.model(modelChange.before ?? ''),
            })}
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

  const sideAssistantPanel = (
    <AssistantPanel
      side
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
          {...(remoteLatest ? { published: remoteLatest } : {})}
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
    if (section === 'channels')
      return (
        <ChannelsSection
          live={
            isNew ? undefined : (
              <ServiceChannels
                api={api}
                tenant={tenant}
                service={id}
                publicName={variantsOf(service.spec)[0]?.publicName ?? ''}
                onFrontends={setFrontends}
                frontend={detail}
                listHref={`#${servicePath(routeId, 'channels')}`}
              />
            )
          }
          modes={
            detail ? null : isNew ? (
              <VariantsList
                service={serviceId}
                publicName={variantsOf(service.spec)[0]?.publicName ?? ''}
                variants={variantsOf(service.spec)}
              />
            ) : (
              <Paragraph data-size="sm">
                <Link href={`#${servicePath(routeId, 'setup', '/channels')}`}>
                  {t('serviceDev.channelsInSetup')}
                </Link>
              </Paragraph>
            )
          }
          editor={isNew ? setup(['start']) : null}
        />
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
          fullscreen={detail === 'preview'}
          backHref={`#${servicePath(routeId, 'interface')}`}
          adding={adding}
          onAdded={clearAdding}
          {...(readOnly ? {} : { assistant: assistantPanel })}
          onFullscreen={() => go('interface', '/preview')}
          onExitFullscreen={() => go('interface')}
        />
      );
    if (section === 'settings') return <SettingsSection {...screenProps} id={id} />;
    if (section === 'quality') return <QualitySection {...screenProps} id={id} />;
    if (section === 'batch')
      return <BatchSection api={api} tenant={tenant} id={id} runId={detail} />;
    if (section === 'log')
      return <LogSection api={api} tenant={tenant} id={id} runId={detail} live={live} />;
    if (section === 'environments')
      return <EnvironmentsSection api={api} tenant={tenant} serviceId={id} />;
    if (section === 'versions' || section === 'definition')
      return !isNew ? (
        <VersionsSection
          view={versionsView}
          onView={(v) => go(v === 'yaml' ? 'definition' : 'versions')}
          showHistory
          history={
            <Versions
              api={api}
              tenant={tenant}
              serviceId={id}
              {...(onPublished ? { onPublished } : {})}
            />
          }
          yaml={
            <DefinitionEditor
              api={api}
              tenant={tenant}
              serviceId={id}
              {...(onPublished ? { onPublished } : {})}
            />
          }
        />
      ) : (
        <VersionsSection
          view={versionsView}
          onView={(v) => go(v === 'yaml' ? 'definition' : 'versions')}
          showHistory={!isNew}
          history={<VersionsTab versions={versions} changes={changes} onRollback={rollback} />}
          yaml={
            <YamlTab
              api={api}
              generated={yaml}
              onApply={(d) => replaceWith(asServiceDefinition(d))}
            />
          }
        />
      );
    if (setupLayout)
      return (
        <SetupLayout
          current={setupArea}
          onPick={setSetupArea}
          facts={areaFacts}
          {...(readOnly ? {} : { assistant: sideAssistantPanel })}
          tryPane={
            <TryPane
              api={api}
              tenant={tenant}
              serviceId={serviceId}
              draft={definition}
              model={service.spec.model.primary}
              datasets={(service.spec.knowledge?.datasets ?? []).map((d) => d.dataset)}
              files={files}
              version={publishedVersion}
              playgroundHref={playgroundHref}
            />
          }
          pane={sidePane}
          onPane={setSidePane}
        >
          {setupArea === 'limits' && !isNew ? (
            <SettingsSection
              {...screenProps}
              id={id}
              readOnly={readOnly}
              limits={{
                logMasked: guardOn(service.spec, 'pii-out-of-log'),
                own: service.spec.settings ?? {},
                onLogging: () => setSetupArea('guards'),
              }}
            />
          ) : (
            setup(setupSections, setupArea)
          )}
          {isNew ? (
            <Paragraph data-size="sm" className="meta">
              {t('service.draftNote')}
            </Paragraph>
          ) : null}
        </SetupLayout>
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

  const publishNotes = (
    <>
      {hasTestSet ? null : (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">{t('services.noTestsetWarning')}</Paragraph>
          <Link href={`#${servicePath(routeId, 'quality')}`}>{t('services.makeTestSet')}</Link>
        </Alert>
      )}
      {invalid ? (
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
      ) : null}
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

  const page = (
    <ServicePageContext.Provider value>
      <div className="service-page">
        <ServiceHeader
          name={name}
          status={status}
          meta={meta}
          tag={
            draftBar && status === 'I bruk' && liveVersion
              ? t('serviceDraft.versionInUse', { n: liveVersion.version })
              : live && shown && status === 'I bruk'
                ? t('services.metaInUse', { n: shown.n })
                : undefined
          }
          flash={flash}
          actions={
            <>
              {canPublish && draftBar && !archived && missingText ? (
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
              {!archived && !(setupLayout && section === 'setup') ? (
                <Button asChild variant="secondary" data-size="sm">
                  <a href={playgroundHref}>{t('serviceLifecycle.tryService')}</a>
                </Button>
              ) : null}
              {live || !canPublish ? null : (
                <Button variant="secondary" data-size="sm" onClick={() => setPublish('test')}>
                  {t('services.publishToTest')}
                </Button>
              )}
              {canDelete ? (
                <Button
                  variant="secondary"
                  data-color="danger"
                  data-size="sm"
                  onClick={() => setDeleting('asking')}
                >
                  {t('services.deleteDraft')}
                </Button>
              ) : null}
              {archived ? null : canPublish &&
                !draftBar &&
                !isNew &&
                current > 0 &&
                !changes.length &&
                draftRevision === 0 &&
                !edited ? (
                <span className="meta">{t('services.nothingToPublish')}</span>
              ) : canPublish && draftBar ? (
                <>
                  <Button
                    variant="primary"
                    data-size="sm"
                    aria-disabled={!hasDraft || missingCount > 0 || undefined}
                    onClick={() => hasDraft && missingCount === 0 && go('setup', '/publish')}
                  >
                    {t('serviceDraft.publishOpen')}
                  </Button>
                </>
              ) : canPublish ? (
                <Button variant="primary" data-size="sm" onClick={() => setPublish('prod')}>
                  {t('services.publish')}
                </Button>
              ) : (
                <span className="meta">{needsRight('manage-services', t)}</span>
              )}
            </>
          }
        />
        {canDelete && deleting ? (
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
        ) : null}
        <ServiceNav
          id={routeId}
          name={service.metadata.name}
          sections={sections}
          current={section}
        />
        {draftBar && !archived ? (
          <DraftBar
            state={saveState}
            version={publishedVersion}
            changes={changeList.length}
            hasDraft={hasDraft}
            savedAt={savedAt ? dayAndTime(savedAt) : undefined}
            savedBy={saverOf(savedBy, self)}
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
        ) : readOnly ? (
          <Alert data-color="info" data-size="sm">
            <Heading level={2} data-size="2xs">
              {t('servicesScreen.readOnlyTitle')}
            </Heading>
            <Paragraph data-size="sm">
              {t('servicesScreen.readOnlyText', { right: rightLabel(t, 'manage-services') })}
            </Paragraph>
          </Alert>
        ) : null}
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
        {publish && canPublish && !draftBar ? (
          <Dialog
            open
            modal
            closeButton={t('services.close')}
            onClose={() => {
              setPublish(null);
              setProblems(undefined);
            }}
            aria-labelledby="pub-h"
            className="publish-dialog"
          >
            <div className="stack">
              <Heading level={2} data-size="sm" id="pub-h">
                {t('services.publishTitle', {
                  name: service.metadata.name || t('services.publishFallbackName'),
                })}
              </Heading>
              <Paragraph>
                {publish === 'test' ? t('services.publishTestInfo') : t('services.publishProdInfo')}
              </Paragraph>
              {publishNotes}
              <PublishSummary
                tenantName={tenantName}
                currentVersion={current}
                nextVersion={current + 1}
                changes={
                  changes.length
                    ? changes
                    : current === 0
                      ? [t('services.changeFirstVersion')]
                      : draftRevision > 0
                        ? [t('services.changeDraft')]
                        : edited
                          ? [t('services.changeForm')]
                          : [t('services.changeNone')]
                }
                inTest={publish === 'test'}
                blockedBy={blockedBy}
                updates={live ? [] : (exampleUpdates[id] ?? [])}
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
                  { label: t('services.factRisk'), value: riskNote },
                ]}
                gates={[
                  {
                    name: t('services.gateNoForbidden'),
                    value: forbidden ? t('services.gateChecked') : t('services.gateNone'),
                    passed: !forbidden,
                    explanation: t('services.gateForbiddenWhy'),
                  },
                  {
                    name: t('services.gateRiskConfirmed'),
                    value: !riskSet
                      ? t('services.unset')
                      : riskConfirmed
                        ? t('services.gateConfirmed')
                        : t('services.gateNotConfirmed'),
                    passed: riskPassed,
                    explanation: t('services.gateRiskWhy'),
                  },
                  ...(unmaskedTypeList.length
                    ? [
                        {
                          name: t('unmaskedInput.gate'),
                          value: unmaskedMissing
                            ? t('unmaskedInput.gateMissing', {
                                missing: unmaskedMissing,
                                count: unmaskedTypeList.length,
                              })
                            : t('services.gateConfirmed'),
                          passed: unmaskedMissing === 0,
                          explanation: t('unmaskedInput.gateWhy'),
                        },
                      ]
                    : []),
                ]}
                apiCall={{
                  action: t('services.publishAction'),
                  method: 'POST',
                  path: '/definitions',
                  body: { definition: publishable, files },
                  right: rightLabel(t, 'manage-services'),
                }}
                {...(riskPassed && !forbidden
                  ? {}
                  : {
                      fixAction: {
                        label: t('services.fixRisk'),
                        onClick: () => {
                          setPublish(null);
                          go('setup', isNew ? '/purpose' : '/risk');
                          showPane('tjeneste');
                          setOpen((o) => ({ ...o, purpose: true }));
                        },
                      },
                    })}
                headingLevel={3}
                onPublish={doPublish}
                {...(live ? {} : { onPublishToTest: doPublishToTest })}
                onCancel={() => {
                  setPublish(null);
                  setProblems(undefined);
                }}
              />
            </div>
          </Dialog>
        ) : null}
      </div>
    </ServicePageContext.Provider>
  );
  const publishView =
    publishPage && liveVersion && publishedDefinition ? (
      <ServicePageContext.Provider value>
        <div className="service-page">
          <PublishDiff
            name={name}
            current={liveVersion.version}
            published={withPromptFiles(publishedDefinition, liveVersion.files ?? {})}
            draft={withPromptFiles(service, files)}
            changes={changeList}
            names={changeNames}
            modelFacts={modelFacts}
            checks={checks}
            onRetryChecks={retryChecks}
            testWarning={testWarning}
            testHref={`#${servicePath(routeId, 'quality')}`}
            backHref={`#${servicePath(routeId, 'setup')}`}
            canPublish={canPublish}
            blocked={check?.status !== 'done' || invalid || missingCount > 0 || unmaskedMissing > 0}
            blockedReason={
              riskProblem ?? (check?.status === 'done' ? blockedBy : t('services.checkingDraft'))
            }
            onPublish={async (reason) => {
              await doPublish({ reason, include: [] });
              go('setup');
            }}
          >
            {publishNotes}
          </PublishDiff>
        </div>
      </ServicePageContext.Provider>
    ) : null;
  // The «Grensesnitt» tab's try view goes on while the reader is on another tab of the page.
  return <TryViewKeeper>{publishView ?? page}</TryViewKeeper>;
};
