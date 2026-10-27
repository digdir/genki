import {
  Alert,
  Button,
  Dialog,
  Heading,
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
import { DeveloperView } from '../../components/developer-view';
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
  renameService,
  riskConfirmationFor,
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
import { modelWord, SetupTab, type SectionId } from './SetupTab';
import { initialTestState, scoreText, testKind, type TestState } from './testState';
import { latestRunFact, type DraftConflict, type ServiceDraft } from '../../api/quality';
import { setAt } from '../../definition-path';
import { checkFlowInputs } from '../../data/flow-inputs';
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
import { servicePath, tabSections, type ServiceSection } from '../service/sections';
import { ServiceHeader } from '../service/ServiceHeader';
import { ServiceLifecycle } from '../service/ServiceLifecycle';
import { ServiceNav } from '../service/ServiceNav';
import { SettingsSection } from '../service/SettingsSection';
import { StrategyPanel } from '../service/StrategyPanel';
import { Versions } from '../service/Versions';
import { problemErrors } from '../service/definition';
import { describeProblem, publishDraft, type PublishProblem } from '../service/publish';
import { VersionsSection } from '../service/VersionsSection';
import { LanguageInstructionTabs } from './LanguageInstructionTabs';
import { BlocksFullscreen, BlocksStep, useBlocksState } from './blocks/BlocksStep';
import '../service/service.css';

const setupSections: SectionId[] = [
  'purpose',
  'io',
  'result',
  'instructions',
  'knowledge',
  'tools',
  'how',
  'model',
  'variants',
  'risk',
  'guards',
];

const developerSetupSections: SectionId[] = ['tools', 'how', 'model', 'variants'];

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
  autoSend?: string;
}

interface AssistedChange {
  title: string;
  section: string;
  before: SpecPatch;
  after: SpecPatch;
}

const draftDelayMs = 600;

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

export const Builder = ({
  api,
  tenant,
  tenantName,
  live = false,
  init,
  route,
  section,
  detail,
  pane: initialPane,
  openPublish,
  onPublished,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const narrow = useNarrow();
  const [catalog] = useAsync(
    (signal) => (live ? api.listModels({}, signal) : Promise.resolve([])),
    [api, live],
  );
  const modelCatalog =
    live && catalog.status === 'ready'
      ? catalog.data.map((m) => modelFor(m.id, m.residency, true))
      : live
        ? []
        : undefined;
  const [datasetOptions] = useAsync(
    async (signal) =>
      live
        ? (await api.catalog(tenant, 'dataset', signal)).map((d) => ({
            id: d.id,
            name: typeof d.spec.name === 'string' && d.spec.name ? d.spec.name : d.id,
            shared: d.scope !== tenant,
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
  const serverDraft = live && !isNew;
  const [draftRevision, setDraftRevision] = useState(init.draftRevision ?? 0);
  const revisionRef = useRef(draftRevision);
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
  const rights = useRights();
  const readOnly = !rights.has('manage-services');
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
  const riskConfirmed = !!service.spec.riskConfirmation;
  const [versions, setVersions] = useState(init.versions);
  const [published, setPublished] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState('');
  const [publish, setPublish] = useState<'test' | 'prod' | null>(openPublish ? 'prod' : null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const change = useCallback((next: (d: ServiceDefinition) => ServiceDefinition) => {
    if (readOnlyRef.current) return;
    unsaved.current = true;
    editsRef.current += 1;
    setEdits(editsRef.current);
    setService(next);
  }, []);
  const patch = useCallback((edit: SpecEdit) => change((d) => applySpec(d, edit)), [change]);
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
  const blocks = useBlocksState();
  const [resultWish, setResultWish] = useState('');
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

  const go = (target: ServiceSection, rest = '') =>
    navigate(servicePath(isNew ? 'new' : id, target, rest));
  const goTab = (t: ServiceSection) => {
    go(t);
    if (t !== 'setup') showPane('tjeneste');
  };

  useEffect(() => {
    if (!detail) window.scrollTo?.(0, 0);
  }, [section, detail]);

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

  const [remote] = useAsync(
    async (signal) => {
      if (!serverDraft) return undefined;
      const keep = unsaved.current;
      const [draft, opened, definition] = await Promise.all([
        keep ? api.quality.draft(tenant, id, signal) : undefined,
        keep ? undefined : api.quality.openDraft(tenant, id, tRef.current('services.rebaseReason')),
        api.getDefinition(tenant, 'Service', id, signal),
      ]);
      if (opened?.behind && readOnlyRef.current)
        return { draft: undefined, latest: definition.latest, conflicts: [] as DraftConflict[] };
      if (opened?.rebasedFrom !== undefined)
        return {
          draft: opened,
          latest: definition.latest,
          conflicts: [] as DraftConflict[],
          rebasedTo: opened.latestVersion ?? definition.latest.version,
        };
      return {
        draft: draft ?? opened,
        latest: definition.latest,
        conflicts: opened?.conflicts ?? [],
      };
    },
    [api, tenant, id, serverDraft, section],
  );
  const remoteDraft = remote.status === 'ready' ? remote.data?.draft : undefined;
  const remoteLatest = remote.status === 'ready' ? remote.data?.latest : undefined;
  const openConflicts = remote.status === 'ready' ? remote.data?.conflicts : undefined;
  const [rebasedNotice, setRebasedNotice] = useState(init.rebasedTo);
  const rebasedTo =
    remote.status === 'ready' && remote.data && 'rebasedTo' in remote.data
      ? remote.data.rebasedTo
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
    setService((d) =>
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
    const tick = editsRef.current;
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
      if (editsRef.current === tick) unsaved.current = false;
    } catch (error) {
      draftBlocked.current = error instanceof ApiError && error.status === 409;
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
    setService(asServiceDefinition(remoteDraft.definition));
    setFiles(remoteDraft.files);
  }, [remoteDraft]);

  const applyProposal = (entry: TurnEntry, proposal: AssistantProposal) => {
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
      draft={!sharedInstructionsOf(service.spec).trim()}
      needsPurpose={!sharedInstructionsOf(service.spec).trim() && !service.spec.purpose.trim()}
      onToggle={() =>
        void assistant.startImprove(
          sharedInstructionsOf(serviceRef.current.spec),
          serviceRef.current.spec.purpose,
        )
      }
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
    { status: 'checking' } | { status: 'done'; errors: PublishProblem[] } | undefined
  >();
  useEffect(() => {
    if (!publish) {
      setCheck(undefined);
      return;
    }
    let active = true;
    setCheck({ status: 'checking' });
    api
      .completeDefinition(definitionRef.current)
      .then((completed) => api.validate(completed, filesRef.current))
      .then(
        (result) => active && setCheck({ status: 'done', errors: result.errors }),
        (error: unknown) =>
          active && setCheck({ status: 'done', errors: problemErrors(error, tRef.current) }),
      );
    return () => {
      active = false;
    };
  }, [publish]);
  const validationErrors = check?.status === 'done' ? check.errors : [];
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
    draftBlocked.current = true;
    const outcome = await publishDraft(
      api,
      definition,
      files,
      reason,
      serverDraft && revisionRef.current > 0 ? revisionRef.current : undefined,
    );
    if (!outcome.ok) {
      draftBlocked.current = false;
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
    record(
      result.version,
      'prod',
      actorLabel(result.publishedBy, tRef.current, result.publishedByName),
      reason,
    );
  };

  const doPublishToTest = ({ reason }: PublishInput) => {
    record(current + 1, 'test', userName, reason);
  };

  const rollback = async (v: VersionItem) => {
    if (v.live && !isNew) {
      try {
        const old = await api.getVersion(tenant, 'Service', id, v.n);
        replaceWith(asServiceDefinition(old.definition));
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
      : [t('services.suggestCost'), t('services.suggestShorter'), t('services.suggestTest')];
  const name = service.metadata.name || t('services.newServiceName');
  const sections = tabSections({ isNew });
  const withAssistant = !readOnly && (section === 'setup' || section === 'test');
  const ownLayout = section === 'blocks';
  const screenProps = { api, tenant, tenantName, route, live };
  const versionsView = route.query.get('view') === 'yaml' ? 'yaml' : 'history';
  const latest = versions[0];
  const shown =
    remoteLatest && remoteLatest.version > (latest?.n ?? 0)
      ? {
          n: remoteLatest.version,
          when: remoteLatest.publishedAt ? formatDateTime(remoteLatest.publishedAt, f) : '',
        }
      : latest;
  const meta = live
    ? shown
      ? [
          shown.when
            ? t('services.metaPublishedAt', { n: shown.n, when: shown.when })
            : t('services.metaVersion', { n: shown.n }),
          ...(draftRevision > 0 ? [t('services.metaUnpublishedDraft')] : []),
        ].join(' · ')
      : t('services.metaNotPublished')
    : latest
      ? t('services.metaDraftBased', { n: latest.n })
      : t('services.metaNotPublishedAuto');

  const setup = (only: SectionId[]) => (
    <SetupTab
      serviceId={id}
      definition={service}
      patch={patch}
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
      {...(frontends ? { frontends } : {})}
      inputLockedIds={publishedFieldIds}
      inputLookup={inputLookup}
      tenant={tenant}
      flowCheck={flowCheck}
      api={api}
      strategy={<StrategyPanel api={api} tenant={tenant} definition={service} patch={patch} />}
      instructionsAssist={improveSlot}
      instructionsUnderPurpose={isNew}
      safetyTogether={isNew}
      sourcesTogether={isNew}
      resultWish={resultWish}
      onResultWish={setResultWish}
      {...(service.spec.strategy.id === 'remote-agent' || isNew
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

  const body = (() => {
    if (section === 'overview')
      return (
        <OverviewSection
          api={api}
          tenant={tenant}
          id={id}
          definition={service}
          versions={versions}
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
              />
            )
          }
          modes={
            <VariantsList
              service={serviceId}
              publicName={variantsOf(service.spec)[0]?.publicName ?? ''}
              variants={variantsOf(service.spec)}
            />
          }
          editor={setup(['start'])}
        />
      );
    if (section === 'settings') return <SettingsSection {...screenProps} id={id} />;
    if (section === 'quality') return <QualitySection {...screenProps} id={id} />;
    if (section === 'batch')
      return <BatchSection api={api} tenant={tenant} id={id} runId={detail} />;
    if (section === 'log')
      return (
        <LogSection
          api={api}
          tenant={tenant}
          tenantName={tenantName}
          id={id}
          runId={detail}
          live={live}
        />
      );
    if (section === 'versions')
      return live && !isNew ? (
        <VersionsSection
          view={versionsView}
          onView={(v) => go('versions', v === 'yaml' ? '?view=yaml' : '')}
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
          onView={(v) => go('versions', v === 'yaml' ? '?view=yaml' : '')}
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
    return (
      <div className="stack-sm">
        {setup(
          isNew
            ? setupSections.filter(
                (id) =>
                  !['io', 'instructions', 'guards'].includes(id) &&
                  !developerSetupSections.includes(id),
              )
            : setupSections.filter((id) => id !== 'result'),
        )}
      </div>
    );
  })();

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

  const previewChat = (
    <PlaygroundPanel
      key={blocks.conversation}
      layout="full"
      bare
      context="service"
      name={serviceId}
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      serviceDraft={{ definition, files }}
    />
  );
  const previewAddress = `${serviceId}.genki.no`;

  const content = <div className={`service-body service-${section}`}>{body}</div>;
  const blocksContent =
    detail === 'preview' ? (
      <BlocksFullscreen
        state={blocks}
        chat={previewChat}
        address={previewAddress}
        backHref={`#${servicePath(isNew ? 'new' : id, 'blocks')}`}
      />
    ) : (
      <BlocksStep
        state={blocks}
        narrow={!split}
        assistant={assistantPanel}
        chat={previewChat}
        address={previewAddress}
        onFullscreen={() => go('blocks', '/preview')}
        {...(route.query.get('klosser') === 'radio' ? { variant: 'radio' as const } : {})}
      />
    );

  return (
    <DeveloperView.Provider value={!isNew}>
      <ServicePageContext.Provider value>
        <div className="service-page">
          <ServiceHeader
            name={name}
            status={
              init.status === 'Utkast' && versions.some((v) => v.state === 'I bruk')
                ? 'I bruk'
                : init.status === 'Utkast' && versions.some((v) => v.state === 'I test')
                  ? 'I test'
                  : init.status
            }
            meta={meta}
            flash={flash}
            actions={
              <>
                {live && canPublish && !isNew ? (
                  <ServiceLifecycle
                    api={api}
                    tenant={tenant}
                    id={id}
                    name={service.metadata.name || id}
                    {...(onPublished ? { onChanged: onPublished } : {})}
                  />
                ) : null}
                {live || !canPublish ? null : (
                  <Button variant="secondary" data-size="sm" onClick={() => setPublish('test')}>
                    {t('services.publishToTest')}
                  </Button>
                )}
                {canPublish &&
                !isNew &&
                current > 0 &&
                !changes.length &&
                draftRevision === 0 &&
                !edited ? (
                  <span className="meta">{t('services.nothingToPublish')}</span>
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
          <ServiceNav id={isNew ? 'new' : id} sections={sections} current={section} />
          {readOnly ? (
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
          {ownLayout ? (
            blocksContent
          ) : !withAssistant ? (
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
              <TabsPanel value="assistent">
                {pane === 'assistent' ? assistantPanel : null}
              </TabsPanel>
              <TabsPanel value="tjeneste">{pane === 'tjeneste' ? content : null}</TabsPanel>
            </Tabs>
          )}
          {publish && canPublish ? (
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
                  {publish === 'test'
                    ? t('services.publishTestInfo')
                    : t('services.publishProdInfo')}
                </Paragraph>
                {hasTestSet ? null : (
                  <Alert data-color="warning" data-size="sm">
                    {t('services.noTestsetWarning')}
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
                  ]}
                  apiCall={{
                    action: t('services.publishAction'),
                    method: 'POST',
                    path: '/definitions',
                    body: { definition, files },
                    right: rightLabel(t, 'manage-services'),
                  }}
                  {...(riskPassed && !forbidden
                    ? {}
                    : {
                        fixAction: {
                          label: t('services.fixRisk'),
                          onClick: () => {
                            setPublish(null);
                            go('setup', '/risk');
                            showPane('tjeneste');
                            setOpen((o) => ({ ...o, risk: true }));
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
    </DeveloperView.Provider>
  );
};
