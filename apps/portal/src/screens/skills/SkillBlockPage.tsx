import { DownloadIcon, MenuElipsisHorizontalIcon, PlayIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Dialog,
  Dropdown,
  Heading,
  Paragraph,
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
import { draftChanges, publisherName, type ProposalSection } from '../../data/skills';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { Icon } from '../../components/Icon';
import { PlaygroundPanel } from '../../components/playground/PlaygroundPanel';
import { ErrorState, Loading } from '../../states';
import { BackLink, LinkTabs } from '../buildingblocks/LinkTabs';
import { askMessage, failureNotice, intentFor, readTurn } from './assistant';
import { download } from './files';
import type { AskState } from './model';
import { PublishDialog } from './PublishDialog';
import { SetupTab } from './SetupTab';
import { SharingTab } from './SharingTab';
import { TestSetTab } from './TestSetTab';
import { VersionsTab } from './VersionsTab';
import { YamlTab } from './YamlTab';
import '../skills.css';

export type SkillTab = 'setup' | 'tests' | 'sharing' | 'versions' | 'yaml';

const tabPaths: Record<SkillTab, string> = {
  setup: '',
  tests: '/tests',
  sharing: '/sharing',
  versions: '/versions',
  yaml: '/yaml',
};

export const skillTabOf = (segment: string | undefined): SkillTab =>
  segment === 'tests' || segment === 'sharing' || segment === 'versions' || segment === 'yaml'
    ? segment
    : 'setup';

export const skillHref = (id: string, tab: SkillTab = 'setup', owner?: string) =>
  `#/building-blocks/skill/${encodeURIComponent(id)}${tabPaths[tab]}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`;

export const blocksBackHref = '#/building-blocks/in-use';

type Flash = { text: string; color: 'success' | 'danger' };

const same = (a: SkillDefinition, b: SkillDefinition) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

export const SkillBlockPage = (props: ScreenProps & { id: string; tab: string | undefined }) => {
  const { api, tenant, id, route } = props;
  const owner = route.query.get('owner') ?? undefined;
  const t = useT();
  const [state, retry] = useAsync(
    async (signal) => {
      const [found, tools] = await Promise.all([
        api.skills.get(tenant, id, owner, signal).then(
          (detail) => ({ detail, owner }),
          async (error: unknown) => {
            if (owner || !(error instanceof ApiError && error.status === 404)) throw error;
            const other = (await api.skills.list(tenant, signal)).find(
              (s) => s.id === id && s.owner !== tenant,
            );
            if (!other) throw error;
            return {
              detail: await api.skills.get(tenant, id, other.owner, signal),
              owner: other.owner,
            };
          },
        ),
        api.skills.tools(tenant, signal).catch(() => [] as SkillToolOption[]),
      ]);
      const versions = await api.skills
        .versions(tenant, id, found.owner, signal)
        .catch(() => [] as SkillVersion[]);
      return { detail: found.detail, owner: found.owner, tools, versions };
    },
    [api, tenant, id, owner],
  );
  if (state.status === 'loading') return <Loading label={t('skills.editorLoading')} />;
  if (state.status === 'error')
    return (
      <div className="stack skills skill-page">
        <header className="skill-header">
          <BackLink label={t('skills.crumbBlocks')} href={blocksBackHref} />
          <span className="skill-kicker">{t('skills.pageKind')}</span>
          <Heading level={1} data-size="lg">
            {id}
          </Heading>
        </header>
        <div role="alert" className="skill-load-failed">
          <Heading level={2} data-size="xs">
            {t('skills.loadFailedTitle')}
          </Heading>
          <Paragraph>{t('skills.loadFailedText')}</Paragraph>
          <Button variant="secondary" onClick={retry}>
            {t('skills.retry')}
          </Button>
        </div>
      </div>
    );
  return (
    <Editor
      key={`${state.data.detail.owner}/${state.data.detail.id}`}
      {...props}
      owner={state.data.owner}
      tab={skillTabOf(props.tab)}
      initial={state.data.detail}
      tools={state.data.tools}
      initialVersions={state.data.versions}
    />
  );
};

interface EditorProps extends ScreenProps {
  id: string;
  owner: string | undefined;
  tab: SkillTab;
  initial: SkillDetail;
  tools: SkillToolOption[];
  initialVersions: SkillVersion[];
}

const Editor = ({
  api,
  tenant,
  tenantName,
  id,
  owner,
  tab,
  initial,
  tools,
  initialVersions,
}: EditorProps) => {
  const rights = useRights();
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const [detail, setDetail] = useState(initial);
  const [versions, setVersions] = useState(initialVersions);
  const [saved, setSaved] = useState(initial.draft.definition);
  const [definition, setDefinition] = useState(initial.draft.definition);
  const [revision, setRevision] = useState(initial.draft.revision);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date>();
  const [conflict, setConflict] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [asks, setAsks] = useState<Partial<Record<ProposalSection, AskState>>>({});
  const [busy, setBusy] = useState<ProposalSection | 'fix' | ''>('');
  const [fixNotice, setFixNotice] = useState<{
    color: 'info' | 'warning' | 'danger';
    text: string;
  }>();
  const [run, setRun] = useState<SkillTestRun | undefined>(initial.lastTestRun);
  const [running, setRunning] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sizes, setSizes] = useState(initial.attachmentSizes);
  const [reloads, setReloads] = useState(0);
  const [fix, setFix] = useState<SkillFix>();
  const [flash, setFlash] = useState<Flash>();
  const [tryOpen, setTryOpen] = useState(false);
  const [leaving, setLeaving] = useState<string>();

  const latest = useRef(definition);
  const revisionRef = useRef(revision);
  const savedRef = useRef(saved);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const publishButton = useRef<HTMLButtonElement>(null);
  const notify = (text: string, color: Flash['color'] = 'success') => setFlash({ text, color });

  const readonly = !detail.editable;
  const canEdit = detail.editable && rights.has('manage-services');
  const dirty = canEdit && !same(definition, saved);
  const name = definition.metadata.name ?? '';
  const title = name || t('skills.untitled');
  const changes = draftChanges(saved, detail.published, tools, t);
  const nothing = detail.status === 'published' && changes.length === 0;
  const cases = definition.spec.testset.cases;
  const fresh =
    !!run &&
    !run.stale &&
    !dirty &&
    run.revision === revision &&
    run.total === cases.length &&
    !running;
  const threshold = definition.spec.testset.passThreshold ?? detail.passThreshold;
  const publisher = publisherName(detail.publisher, tenantName);
  const madeBy = [...versions].sort((a, b) => a.version - b.version)[0]?.by ?? publisher;
  const previous = versions.find((v) => v.current)?.score;
  const canTry = !!detail.version;

  const save = async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const sending = latest.current;
    if (same(sending, savedRef.current)) return true;
    setSaving(true);
    const attempt = api.skills
      .saveDraft(tenant, id, sending, revisionRef.current)
      .then(
        (result) => {
          savedRef.current = sending;
          revisionRef.current = result.revision;
          setSaved(sending);
          setRevision(result.revision);
          setSaveFailed(false);
          setSavedAt(new Date());
          return true;
        },
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 409) setConflict(true);
          else setSaveFailed(true);
          return false;
        },
      )
      .finally(() => {
        inFlight.current = null;
        setSaving(false);
      });
    inFlight.current = attempt;
    return attempt;
  };

  const flush = async () => ((await save()) ? revisionRef.current : undefined);

  const discard = () => {
    latest.current = savedRef.current;
    setDefinition(savedRef.current);
  };

  const apply = (next: SkillDefinition) => {
    if (!canEdit) return;
    latest.current = next;
    setDefinition(next);
    setSavedAt(undefined);
  };
  const updateSpec = (fn: (spec: SkillSpec) => SkillSpec) =>
    apply({ ...latest.current, spec: fn(latest.current.spec) });

  const refresh = async (resetDraft: boolean) => {
    const [loaded, history] = await Promise.all([
      api.skills.get(tenant, id, owner),
      api.skills.versions(tenant, id, owner).catch(() => undefined),
    ]);
    setDetail(loaded);
    if (history) setVersions(history);
    setSizes((s) => ({ ...s, ...loaded.attachmentSizes }));
    if (loaded.lastTestRun) setRun(loaded.lastTestRun);
    if (resetDraft) {
      latest.current = loaded.draft.definition;
      savedRef.current = loaded.draft.definition;
      revisionRef.current = loaded.draft.revision;
      setDefinition(loaded.draft.definition);
      setSaved(loaded.draft.definition);
      setRevision(loaded.draft.revision);
    }
    setReloads((n) => n + 1);
  };

  const ask = async (section: ProposalSection) => {
    const current = asks[section];
    if (current?.open) {
      setAsks((a) => ({ ...a, [section]: { ...current, open: false } }));
      return;
    }
    if (busy || !canEdit) return;
    setAsks((a) => ({ ...a, [section]: { open: true, applied: [], rejected: [] } }));
    setBusy(section);
    try {
      const turn = await api.skills.assistantTurn(tenant, id, {
        message: askMessage(t, section),
        draft: { definition: latest.current },
        intent: intentFor(section),
      });
      const result = readTurn(turn, latest.current.spec, section, tenantName, tRef.current, f);
      setAsks((a) => ({
        ...a,
        [section]: {
          open: true,
          applied: result.applied,
          rejected: result.rejected,
          ...(result.notice ? { notice: result.notice } : {}),
        },
      }));
    } catch (error) {
      setAsks((a) => ({
        ...a,
        [section]: {
          open: true,
          applied: [],
          rejected: [],
          notice: failureNotice(error, tRef.current),
        },
      }));
    } finally {
      setBusy('');
    }
  };

  const useSuggestion = (section: ProposalSection) => {
    const current = asks[section];
    if (!current) return;
    for (const { card, value } of current.applied)
      updateSpec((s) => ({ ...s, [card.section]: value }));
    setAsks((a) => ({ ...a, [section]: { open: false, applied: [], rejected: [] } }));
  };

  const askFix = async () => {
    if (busy || !canEdit) return;
    setBusy('fix');
    setFixNotice(undefined);
    try {
      if ((await flush()) === undefined) throw new Error('draft not saved');
      setFix(await api.skills.proposeFix(tenant, id));
    } catch (error) {
      setFixNotice(failureNotice(error, tRef.current));
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
      setFixNotice(failureNotice(error, tRef.current));
    } finally {
      setBusy('');
    }
  };

  const deleteCase = async (index: number) => {
    if (busy || !canEdit) return;
    setBusy('fix');
    try {
      const rev = await flush();
      if (rev === undefined) throw new Error('draft not saved');
      await api.skills.deleteCase(tenant, id, index, rev);
      await refresh(true);
      notify(tRef.current('skills.caseDeleted'));
    } catch {
      notify(tRef.current('skills.caseDeleteFailed'), 'danger');
    } finally {
      setBusy('');
    }
  };

  const runTests = async () => {
    if (running) return;
    setRunning(true);
    setRunFailed(false);
    try {
      if ((await flush()) === undefined) throw new Error('draft not saved');
      setRun(await api.skills.runTests(tenant, id));
    } catch {
      setRunFailed(true);
    } finally {
      setRunning(false);
    }
  };

  const copy = async () => {
    try {
      const created = await api.skills.copy(tenant, id, detail.owner);
      navigate(skillHref(created.id).slice(1));
    } catch {
      notify(tRef.current('skills.copyFailed'), 'danger');
    }
  };

  const exportPackage = async () => {
    try {
      const pkg = await api.skills.exportPackage(tenant, id, owner, detail.version);
      download(pkg.fileName, pkg.blob);
      notify(tRef.current('skills.exported', { file: pkg.fileName }));
    } catch {
      notify(tRef.current('skills.exportFailed'), 'danger');
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
      notify(tRef.current('skills.uploadFailed', { file: file.name }), 'danger');
    }
  };

  const [usage] = useAsync<SkillUsage>(
    (signal) =>
      tab === 'sharing'
        ? api.skills.usage(tenant, id, owner, signal)
        : Promise.resolve({ services: detail.usedBy, sharedWith: detail.sharedWith }),
    [api, tenant, id, owner, tab, reloads],
  );

  const [datasets] = useAsync(
    async (signal) =>
      tab === 'tests' && canEdit
        ? (await api.datasets.list(tenant, signal)).map((d) => ({ id: d.fullId, name: d.name }))
        : [],
    [api, tenant, tab, canEdit],
  );

  useEffect(() => {
    setFlash(undefined);
  }, [tab]);

  useEffect(() => {
    if (!dirty) return;
    const page = `#/building-blocks/skill/${encodeURIComponent(id)}`;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    const guard = (event: MouseEvent) => {
      const href = (event.target as Element | null)
        ?.closest?.('a[href^="#"]')
        ?.getAttribute('href');
      if (!href || event.defaultPrevented) return;
      if (href === page || href.startsWith(`${page}/`) || href.startsWith(`${page}?`)) return;
      event.preventDefault();
      setLeaving(href);
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', guard, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', guard, true);
    };
  }, [dirty, id]);

  const openPublish = () => {
    if (nothing && !dirty) {
      notify(t('skills.nothingToPublishNote'));
      return;
    }
    setFlash(undefined);
    setPublishing(true);
  };

  const tabs = (
    [
      ['setup', t('skills.tabSetup')],
      ['tests', t('skills.tabTests')],
      ['sharing', t('skills.tabSharing')],
      ['versions', t('skills.tabVersions')],
      ['yaml', t('skills.tabYaml')],
    ] as const
  ).map(([key, label]) => ({ key, label, href: skillHref(id, key, owner) }));

  return (
    <div className="stack skills skill-page">
      <header className="skill-header">
        <BackLink label={t('skills.crumbBlocks')} href={blocksBackHref} />
        <span className="skill-kicker">{t('skills.madeBy', { name: madeBy })}</span>
        <div className="skill-title-row">
          <div className="skill-title-tags">
            <Heading level={1} data-size="lg">
              {title}
            </Heading>
            {detail.version ? (
              <Tag data-size="sm" data-color="success">
                {t('skills.versionTag', { version: detail.version })}
              </Tag>
            ) : (
              <Tag data-size="sm" data-color="neutral">
                {t('skills.notPublishedTag')}
              </Tag>
            )}
            {detail.version && !nothing ? (
              <Tag data-size="sm" data-color="warning">
                {t('skills.unpublishedTag')}
              </Tag>
            ) : null}
          </div>
          <div className="skill-actions">
            <Button
              variant="secondary"
              aria-pressed={tryOpen}
              aria-disabled={!canTry || undefined}
              aria-describedby={canTry ? undefined : `${id}-try-hint`}
              onClick={() => canTry && setTryOpen((o) => !o)}
            >
              <Icon icon={PlayIcon} />
              {t('skills.try')}
            </Button>
            <Dropdown.TriggerContext>
              <Dropdown.Trigger
                variant="tertiary"
                icon
                aria-label={t('skills.moreActions')}
                title={t('skills.moreActions')}
              >
                <MenuElipsisHorizontalIcon aria-hidden />
              </Dropdown.Trigger>
              <Dropdown placement="bottom-end" data-size="sm">
                <Dropdown.List>
                  <Dropdown.Item>
                    <Dropdown.Button onClick={() => void exportPackage()}>
                      <Icon icon={DownloadIcon} />
                      {t('skills.exportPackage')}
                    </Dropdown.Button>
                  </Dropdown.Item>
                </Dropdown.List>
              </Dropdown>
            </Dropdown.TriggerContext>
            {canEdit ? (
              <Button ref={publishButton} variant="primary" onClick={openPublish}>
                {t('skills.publish')}
              </Button>
            ) : null}
            {readonly && rights.has('manage-services') ? (
              <Button variant="primary" onClick={() => void copy()}>
                {t('skills.makeCopy')}
              </Button>
            ) : null}
          </div>
        </div>
        {canTry ? null : (
          <p id={`${id}-try-hint`} className="skill-kicker">
            {t('skills.tryHint')}
          </p>
        )}
        <div aria-live="polite">
          {flash?.color === 'success' ? (
            <p role="status" className="skill-flash">
              {flash.text}
            </p>
          ) : null}
        </div>
        {flash?.color === 'danger' ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {flash.text}
          </Alert>
        ) : null}
      </header>

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
        <div className="skill-main stack">
          <LinkTabs label={title} tabs={tabs} current={tab} />
          <div role="tabpanel" aria-label={tabs.find((x) => x.key === tab)?.label}>
            {tab === 'setup' ? (
              <SetupTab
                definition={definition}
                canEdit={canEdit}
                tools={tools}
                asks={asks}
                busy={busy}
                sizes={sizes}
                onName={(value) =>
                  apply({
                    ...latest.current,
                    metadata: { ...latest.current.metadata, name: value },
                  })
                }
                onSpec={updateSpec}
                onAsk={(section) => void ask(section)}
                onUse={useSuggestion}
                onFile={(file) => void addFile(file)}
              />
            ) : null}
            {tab === 'tests' ? (
              <>
                {runFailed ? (
                  <Alert data-color="danger" data-size="sm" role="alert">
                    {t('skills.runFailed')}
                  </Alert>
                ) : null}
                {fixNotice ? (
                  <Alert data-color={fixNotice.color} data-size="sm" role="alert">
                    {fixNotice.text}
                  </Alert>
                ) : null}
                <TestSetTab
                  cases={cases}
                  run={run}
                  fresh={fresh}
                  running={running}
                  canEdit={canEdit}
                  busy={busy !== ''}
                  hasExamples={definition.spec.examples.length > 0}
                  previous={previous}
                  datasets={datasets.status === 'ready' ? datasets.data : []}
                  fix={fix}
                  onRun={() => void runTests()}
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
            {tab === 'sharing' ? (
              usage.status === 'error' ? (
                <ErrorState error={usage.error} />
              ) : (
                <SharingTab
                  detail={detail}
                  services={usage.status === 'ready' ? usage.data.services : detail.usedBy}
                  tenantName={tenantName}
                  canEdit={canEdit}
                  onShare={async (reason) => {
                    await api.skills.requestShare(tenant, id, reason);
                    await refresh(false);
                  }}
                  onWithdraw={async () => {
                    await api.skills.withdrawShare(tenant, id);
                    await refresh(false);
                  }}
                />
              )
            ) : null}
            {tab === 'versions' ? (
              <VersionsTab versions={versions} services={detail.usedBy} />
            ) : null}
            {tab === 'yaml' ? (
              <YamlTab definition={definition} canEdit={canEdit} onApply={apply} />
            ) : null}
          </div>
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

      {dirty ? (
        <div role="region" aria-label={t('skills.unsavedRegion')} className="skill-unsaved">
          <strong>{t('skills.unsavedTitle')}</strong>
          <div className="actions">
            <Button variant="secondary" onClick={discard}>
              {t('skills.discard')}
            </Button>
            <Button
              variant="primary"
              aria-busy={saving || undefined}
              onClick={() => !saving && void save()}
            >
              {saving ? t('skills.saving') : t('skills.saveChanges')}
            </Button>
          </div>
        </div>
      ) : null}
      {savedAt && !dirty ? (
        <p role="status" className="skill-flash">
          {t('skills.savedNote', { time: f.time(savedAt) })}
        </p>
      ) : null}

      {leaving ? (
        <Dialog open modal onClose={() => setLeaving(undefined)} aria-labelledby="skill-leave-h">
          <div className="stack-sm">
            <Heading level={2} data-size="xs" id="skill-leave-h">
              {t('skills.leaveQuestion')}
            </Heading>
            <Paragraph>{t('skills.leaveText')}</Paragraph>
            <div className="actions">
              <Button
                variant="secondary"
                data-color="danger"
                onClick={() => {
                  const target = leaving;
                  setLeaving(undefined);
                  discard();
                  window.location.hash = target;
                }}
              >
                {t('skills.leaveWithoutSaving')}
              </Button>
              <Button variant="primary" autoFocus onClick={() => setLeaving(undefined)}>
                {t('skills.stay')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {publishing ? (
        <PublishDialog
          api={api}
          tenant={tenant}
          id={id}
          name={title}
          draftVersion={detail.draftVersion}
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
            navigate(skillHref(id, 'tests', owner).slice(1));
          }}
          onPublished={(version) => {
            setPublishing(false);
            setSavedAt(undefined);
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
