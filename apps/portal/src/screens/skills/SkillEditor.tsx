import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import type {
  SkillDefinition,
  SkillDetail,
  SkillFix,
  SkillSpec,
  SkillTestRun,
  SkillToolOption,
  SkillUsage,
  SkillVersion,
} from '../../api/skills';
import { Crumbs } from '../../components/Crumbs';
import { Icon } from '../../components/Icon';
import { PlaygroundPanel } from '../../components/playground/PlaygroundPanel';
import {
  draftChanges,
  publisherName,
  scoreText,
  statusLabel,
  type ProposalSection,
} from '../../data/skills';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { askMessage, failureNotice, intentFor, readTurn } from './assistant';
import { download } from './files';
import type { AssistantNotice, EditorCard, EditorTab, RejectedEditorCard } from './model';
import { PublishDialog } from './PublishDialog';
import { SetupTab } from './SetupTab';
import { TestSetTab } from './TestSetTab';
import { UsageTab } from './UsageTab';
import { VersionsTab } from './VersionsTab';
import { YamlTab } from './YamlTab';

const playIcon = 'M7 5l12 7-12 7z';
const exportIcon = 'M12 4v11M8 11l4 4 4-4M5 15v4h14v-4';
const saveDelay = 400;

type Notify = (text: string, at?: string | null, color?: 'success' | 'danger') => void;

interface EditorProps extends ScreenProps {
  id: string;
  owner: string | undefined;
  notify: Notify;
}

export const SkillEditor = (props: EditorProps) => {
  const { api, tenant, id, owner } = props;
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [detail, tools] = await Promise.all([
        api.skills.get(tenant, id, owner, signal),
        api.skills.tools(tenant, signal).catch(() => [] as SkillToolOption[]),
      ]);
      return { detail, tools };
    },
    [api, tenant, id, owner],
  );
  if (state.status === 'loading') return <Loading label={t('skills.editorLoading')} />;
  if (state.status === 'error')
    return (
      <div className="stack">
        <Crumbs
          items={[
            { label: t('skills.crumbBlocks'), href: '#/building-blocks' },
            { label: t('skills.title'), href: '#/skills' },
          ]}
        />
        <Heading level={1} data-size="md">
          {t('skills.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  return <Editor {...props} initial={state.data.detail} tools={state.data.tools} />;
};

const Editor = ({
  api,
  tenant,
  tenantName,
  id,
  owner,
  notify,
  initial,
  tools,
}: EditorProps & { initial: SkillDetail; tools: SkillToolOption[] }) => {
  const rights = useRights();
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [detail, setDetail] = useState(initial);
  const [definition, setDefinition] = useState(initial.draft.definition);
  const [revision, setRevision] = useState(initial.draft.revision);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [tab, setTab] = useState<EditorTab>('setup');
  const [cards, setCards] = useState<EditorCard[]>([]);
  const [rejected, setRejected] = useState<RejectedEditorCard[]>([]);
  const [notice, setNotice] = useState<AssistantNotice | null>(null);
  const [busy, setBusy] = useState<ProposalSection | 'fix' | ''>('');
  const [tryOpen, setTryOpen] = useState(false);
  const [run, setRun] = useState<SkillTestRun | undefined>(initial.lastTestRun);
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sizes, setSizes] = useState(initial.attachmentSizes);
  const [reloads, setReloads] = useState(0);
  const [fix, setFix] = useState<SkillFix>();

  const latest = useRef(definition);
  const sent = useRef(definition);
  const revisionRef = useRef(revision);
  const inFlight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const publishButton = useRef<HTMLButtonElement>(null);
  const fail = (text: string) => notify(text, undefined, 'danger');

  const readonly = !detail.editable;
  const canEdit = detail.editable && rights.has('manage-services');
  const name = definition.metadata.name ?? '';
  const title = name || t('skills.untitled');
  const changes = draftChanges(definition, detail.published, tools, t);
  const nothing = detail.status === 'published' && changes.length === 0;
  const cases = definition.spec.testset.cases;
  const fresh =
    !!run && !pending && run.revision === revision && run.total === cases.length && !running;
  const threshold = definition.spec.testset.passThreshold ?? detail.passThreshold;
  const failures = fresh && run ? run.total - run.passed : 0;
  const publisher = publisherName(detail.publisher, tenantName);
  const [statusText, statusColor] = statusLabel(detail);
  const canTry = !!detail.version;

  const save = async (): Promise<void> => {
    if (inFlight.current) await inFlight.current;
    if (latest.current === sent.current) return;
    const sending = latest.current;
    const attempt = api.skills
      .saveDraft(tenant, id, sending, revisionRef.current)
      .then(
        (saved) => {
          sent.current = sending;
          revisionRef.current = saved.revision;
          setRevision(saved.revision);
          setSaveFailed(false);
          if (latest.current === sending) setPending(false);
        },
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 409) setConflict(true);
          else setSaveFailed(true);
        },
      )
      .finally(() => {
        inFlight.current = null;
      });
    inFlight.current = attempt;
    await attempt;
  };

  const flush = async () => {
    clearTimeout(timer.current);
    await save();
    return latest.current === sent.current ? revisionRef.current : undefined;
  };

  useEffect(() => {
    if (!pending || conflict) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), saveDelay);
    return () => clearTimeout(timer.current);
  }, [definition, pending, conflict]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (latest.current !== sent.current) void save();
    },
    [],
  );

  const apply = (next: SkillDefinition) => {
    if (!canEdit) return;
    latest.current = next;
    setDefinition(next);
    setPending(true);
  };
  const updateSpec = (fn: (spec: SkillSpec) => SkillSpec) =>
    apply({ ...latest.current, spec: fn(latest.current.spec) });

  const refresh = async (resetDraft: boolean) => {
    const loaded = await api.skills.get(tenant, id, owner);
    setDetail(loaded);
    setSizes((s) => ({ ...s, ...loaded.attachmentSizes }));
    if (loaded.lastTestRun) setRun(loaded.lastTestRun);
    if (resetDraft) {
      latest.current = loaded.draft.definition;
      sent.current = loaded.draft.definition;
      revisionRef.current = loaded.draft.revision;
      setDefinition(loaded.draft.definition);
      setRevision(loaded.draft.revision);
      setPending(false);
    }
    setReloads((n) => n + 1);
  };

  const propose = async (section: ProposalSection) => {
    if (busy || !canEdit) return;
    setBusy(section);
    setNotice(null);
    try {
      const turn = await api.skills.assistantTurn(tenant, id, {
        message: askMessage(t, section),
        draft: { definition: latest.current },
        intent: intentFor(section),
      });
      const result = readTurn(turn, latest.current.spec, section, tenantName, tRef.current, f);
      if (result.notice) setNotice({ section, ...result.notice });
      for (const { card, value } of result.applied)
        updateSpec((s) => ({ ...s, [card.section]: value }));
      setCards((c) => [...c, ...result.applied.map((a) => a.card)]);
      setRejected((r) => [...r, ...result.rejected]);
    } catch (error) {
      setNotice({ section, ...failureNotice(error, tRef.current) });
    } finally {
      setBusy('');
    }
  };

  const askFix = async () => {
    if (busy || !canEdit) return;
    setBusy('fix');
    setNotice(null);
    try {
      if ((await flush()) === undefined) throw new Error('draft not saved');
      setFix(await api.skills.proposeFix(tenant, id));
    } catch (error) {
      setNotice({ section: 'fix', ...failureNotice(error, tRef.current) });
    } finally {
      setBusy('');
    }
  };

  const applyFix = async () => {
    if (!fix || busy) return;
    setBusy('fix');
    try {
      await api.skills.applyFix(tenant, id, fix.fixId);
      setFix(undefined);
      await refresh(true);
      notify(tRef.current('skills.fixApplied'));
    } catch (error) {
      setNotice({ section: 'fix', ...failureNotice(error, tRef.current) });
    } finally {
      setBusy('');
    }
  };

  const deleteCase = async (index: number) => {
    if (busy || !canEdit) return;
    setBusy('fix');
    try {
      const saved = await flush();
      if (saved === undefined) throw new Error('draft not saved');
      await api.skills.deleteCase(tenant, id, index, saved);
      await refresh(true);
      notify(tRef.current('skills.caseDeleted'));
    } catch {
      fail(tRef.current('skills.caseDeleteFailed'));
    } finally {
      setBusy('');
    }
  };

  const undo = (card: EditorCard) => {
    const field = card.section;
    updateSpec((s) => ({ ...s, [field]: card.previous[field] }));
    setCards((c) => c.map((x) => (x.id === card.id ? { ...x, undone: true } : x)));
  };

  const runTests = async () => {
    if (running) return;
    setRunning(true);
    setRunFailed(false);
    try {
      const saved = await flush();
      if (saved === undefined) throw new Error('draft not saved');
      setRun(await api.skills.runTests(tenant, id));
    } catch {
      setRunFailed(true);
    } finally {
      setRunning(false);
    }
  };

  const exportPackage = async () => {
    try {
      const pkg = await api.skills.exportPackage(tenant, id, owner, detail.version);
      download(pkg.fileName, pkg.blob);
      notify(tRef.current('skills.exported', { file: pkg.fileName }));
    } catch {
      fail(tRef.current('skills.exportFailed'));
    }
  };

  const copy = async () => {
    try {
      const created = await api.skills.copy(tenant, id, detail.owner);
      notify(tRef.current('skills.copied', { tenant: tenantName }), created.id);
      navigate(`/skills?id=${encodeURIComponent(created.id)}`);
    } catch {
      fail(tRef.current('skills.copyFailed'));
    }
  };

  const addFile = async (file: File) => {
    try {
      const uploaded = await api.skills.addAttachment(tenant, id, file);
      setSizes((s) => ({ ...s, [uploaded.blob]: uploaded.size }));
      updateSpec((s) => ({
        ...s,
        attachments: [...s.attachments, { name: uploaded.name, blob: uploaded.blob }],
      }));
    } catch {
      fail(tRef.current('skills.uploadFailed', { file: file.name }));
    }
  };

  const [usage] = useAsync<SkillUsage>(
    (signal) =>
      tab === 'usage'
        ? api.skills.usage(tenant, id, owner, signal)
        : Promise.resolve({ services: detail.usedBy, sharedWith: detail.sharedWith }),
    [api, tenant, id, owner, tab, reloads],
  );
  const [versions] = useAsync<SkillVersion[]>(
    async (signal) =>
      tab === 'versions'
        ? (await api.skills.versions(tenant, id, owner, signal)).map((v) => ({
            ...v,
            shared: v.current && detail.share === 'shared',
            ...(readonly && !v.score ? { testedBy: publisher } : {}),
          }))
        : [],
    [api, tenant, id, owner, tab, reloads],
  );

  const [datasets] = useAsync(
    async (signal) =>
      tab === 'tests' && canEdit
        ? (await api.datasets.list(tenant, signal)).map((d) => ({ id: d.fullId, name: d.name }))
        : [],
    [api, tenant, tab, canEdit],
  );

  const runCall = {
    action: t('skills.runTestsAction'),
    method: 'POST' as const,
    path: `${api.skills.skillPath(tenant, id)}/test-runs`,
    body: {},
    needsReason: false,
    right: t('skills.rightManage'),
  };

  const meta = [
    detail.version
      ? t('skills.metaInUse', { version: detail.version })
      : t('skills.metaNotPublished'),
    ...(readonly
      ? []
      : [
          nothing
            ? t('skills.metaNoChanges')
            : t('skills.metaDraft', { version: detail.draftVersion }),
        ]),
    t('skills.metaPublisher', { publisher }),
  ].join(' · ');

  return (
    <div className="stack-md">
      <Crumbs
        items={[
          { label: t('skills.crumbBlocks'), href: '#/building-blocks' },
          { label: t('skills.title'), href: '#/skills' },
          { label: title },
        ]}
      />
      <div className="skills-head">
        <div className="skill-title">
          <div className="row-wrap">
            <Heading level={1} data-size="md">
              {title}
            </Heading>
            <Tag data-color={statusColor}>{t(statusText)}</Tag>
          </div>
          <span className="skill-meta">{meta}</span>
          {canTry ? null : (
            <span id={`${id}-try-hint`} className="skill-meta">
              {t('skills.tryHint')}
            </span>
          )}
        </div>
        <div className="actions">
          <Button
            variant="secondary"
            aria-pressed={tryOpen}
            aria-disabled={!canTry || undefined}
            aria-describedby={canTry ? undefined : `${id}-try-hint`}
            onClick={() => canTry && setTryOpen((o) => !o)}
          >
            <Icon d={playIcon} />
            {t('skills.try')}
          </Button>
          <Button variant="secondary" onClick={() => void exportPackage()}>
            <Icon d={exportIcon} />
            {t('skills.exportPackage')}
          </Button>
          {canEdit ? (
            <Button
              ref={publishButton}
              variant="primary"
              aria-disabled={nothing || undefined}
              onClick={() => !nothing && setPublishing(true)}
            >
              {nothing
                ? t('skills.nothingToPublish')
                : t('skills.publishVersion', { version: detail.draftVersion })}
            </Button>
          ) : null}
          {readonly && rights.has('manage-services') ? (
            <Button variant="primary" onClick={() => void copy()}>
              {t('skills.makeCopy')}
            </Button>
          ) : null}
        </div>
      </div>
      {readonly ? (
        <Alert data-color="info">
          <Paragraph>{t('skills.readonlyNote', { publisher })}</Paragraph>
        </Alert>
      ) : null}
      {!readonly && !canEdit ? (
        <Alert data-color="info">
          <Paragraph>{t('skills.noRightNote')}</Paragraph>
        </Alert>
      ) : null}
      {conflict ? (
        <Alert data-color="danger" role="alert">
          <Paragraph>{t('skills.conflict')}</Paragraph>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              setConflict(false);
              void refresh(true);
            }}
          >
            {t('skills.reload')}
          </Button>
        </Alert>
      ) : null}
      {saveFailed && !conflict ? (
        <Alert data-color="warning" data-size="sm" role="alert">
          {t('skills.saveFailed')}
        </Alert>
      ) : null}

      <div className="skill-layout">
        <div className="skill-main">
          <Tabs value={tab} onChange={(v) => setTab(v as EditorTab)}>
            <TabsList aria-label={t('skills.tabsLabel')}>
              <TabsTab value="setup">{t('skills.tabSetup')}</TabsTab>
              <TabsTab value="tests">
                {t('skills.tabTests')}
                {failures > 0 ? (
                  <Tag data-size="sm" data-color="danger">
                    {t('skills.failedCount', { count: failures })}
                  </Tag>
                ) : null}
              </TabsTab>
              <TabsTab value="usage">{t('skills.tabUsage')}</TabsTab>
              <TabsTab value="yaml">YAML</TabsTab>
              <TabsTab value="versions">{t('skills.tabVersions')}</TabsTab>
            </TabsList>
            <TabsPanel value="setup">
              {tab === 'setup' ? (
                <SetupTab
                  definition={definition}
                  canEdit={canEdit}
                  tools={tools}
                  cards={cards}
                  rejected={rejected}
                  notice={notice}
                  busy={busy}
                  sizes={sizes}
                  onName={(value) =>
                    apply({
                      ...latest.current,
                      metadata: { ...latest.current.metadata, name: value },
                    })
                  }
                  onSpec={updateSpec}
                  onAsk={(section) => void propose(section)}
                  onUndo={undo}
                  onFile={(file) => void addFile(file)}
                />
              ) : null}
            </TabsPanel>
            <TabsPanel value="tests">
              {tab === 'tests' ? (
                <>
                  {runFailed ? (
                    <Alert data-color="danger" data-size="sm" role="alert">
                      {t('skills.runFailed')}
                    </Alert>
                  ) : null}
                  {notice?.section === 'fix' ? (
                    <Alert data-color={notice.color} data-size="sm" role="alert">
                      {notice.text}
                    </Alert>
                  ) : null}
                  <TestSetTab
                    cases={cases}
                    run={run}
                    fresh={fresh}
                    running={running}
                    threshold={threshold}
                    canEdit={canEdit}
                    busy={busy !== ''}
                    hasExamples={definition.spec.examples.length > 0}
                    runCall={runCall}
                    onRun={() => void runTests()}
                    datasets={datasets.status === 'ready' ? datasets.data : []}
                    fix={fix}
                    onFix={() => void askFix()}
                    onApplyFix={() => void applyFix()}
                    onDiscardFix={() => setFix(undefined)}
                    onDelete={(index) => void deleteCase(index)}
                    onAdd={(testCase) =>
                      updateSpec((s) => ({
                        ...s,
                        testset: { ...s.testset, cases: [...s.testset.cases, testCase] },
                      }))
                    }
                    onFromExamples={() =>
                      updateSpec((s) => ({
                        ...s,
                        testset: {
                          ...s.testset,
                          cases: s.examples.map((x) => ({
                            input: x.input,
                            expected: x.expectedOutput,
                            type: 'criteria',
                          })),
                        },
                      }))
                    }
                  />
                </>
              ) : null}
            </TabsPanel>
            <TabsPanel value="usage">
              {tab === 'usage' ? (
                <UsageTab
                  detail={detail}
                  services={usage.status === 'ready' ? usage.data.services : detail.usedBy}
                  sharedWith={usage.status === 'ready' ? usage.data.sharedWith : detail.sharedWith}
                  tenantName={tenantName}
                  canEdit={canEdit}
                  shareCall={(reason) => ({
                    action: t('skills.shareAction'),
                    method: 'POST',
                    path: `${api.skills.skillPath(tenant, id)}/share`,
                    body: { confirm: true, reason: reason || '…' },
                    right: t('skills.rightManage'),
                  })}
                  onShare={async (reason) => {
                    await api.skills.requestShare(tenant, id, reason);
                    await refresh(false);
                    notify(tRef.current('skills.shareSent'));
                  }}
                  onWithdraw={async () => {
                    await api.skills.withdrawShare(tenant, id);
                    await refresh(false);
                    notify(tRef.current('skills.shareWithdrawn'));
                  }}
                />
              ) : null}
            </TabsPanel>
            <TabsPanel value="yaml">
              {tab === 'yaml' ? (
                <YamlTab definition={definition} canEdit={canEdit} onApply={apply} />
              ) : null}
            </TabsPanel>
            <TabsPanel value="versions">
              {tab === 'versions' ? (
                versions.status === 'ready' ? (
                  <VersionsTab
                    draft={
                      readonly || nothing
                        ? undefined
                        : {
                            version: detail.draftVersion,
                            changes,
                            score:
                              fresh && run
                                ? scoreText(t, run.passed, run.total)
                                : t('skills.notTested'),
                          }
                    }
                    versions={versions.data}
                    inUse={detail.usedBy.length > 0}
                  />
                ) : versions.status === 'error' ? (
                  <ErrorState error={versions.error} />
                ) : (
                  <Loading label={t('skills.versionsLoading')} />
                )
              ) : null}
            </TabsPanel>
          </Tabs>
        </div>
        {tryOpen ? (
          <div className="skill-try">
            <PlaygroundPanel
              layout="side"
              context="skill"
              name={id}
              title={detail.published?.metadata.name || title}
              api={api}
              tenant={tenant}
              tenantName={tenantName}
              onClose={() => setTryOpen(false)}
            />
          </div>
        ) : null}
      </div>

      {publishing ? (
        <PublishDialog
          api={api}
          tenant={tenant}
          id={id}
          name={name}
          draftVersion={detail.draftVersion}
          publishedVersion={detail.version}
          changes={changes}
          testFact={
            fresh && run
              ? scoreText(t, run.passed, run.total)
              : cases.length
                ? t('skills.notRunOnDraft')
                : t('skills.noCases')
          }
          threshold={threshold}
          services={detail.usedBy}
          shared={detail.share === 'shared'}
          prepare={flush}
          onClose={() => {
            setPublishing(false);
            setTimeout(() => publishButton.current?.focus(), 0);
          }}
          onGoToTests={() => {
            setPublishing(false);
            setTab('tests');
          }}
          onPublished={(version) => {
            setPublishing(false);
            const tr = tRef.current;
            notify(
              tr('skills.published', { version }) +
                (detail.usedBy.length
                  ? ` ${tr('skills.publishedUpdate', { services: detail.usedBy.map((u) => u.name).join(', ') })}`
                  : ''),
            );
            void refresh(true);
          }}
        />
      ) : null}
    </div>
  );
};
