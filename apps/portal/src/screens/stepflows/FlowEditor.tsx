import {
  Alert,
  Badge,
  Button,
  Field,
  Heading,
  Label,
  Switch,
  Tabs,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { ApiCallLink } from '../../components/ApiCall';
import { Icon, icons } from '../../components/Icon';
import { blocks, serviceOfFlow, type Flow, type RunOverlay, type Step } from '../../data/stepflows';
import { useT, type PlainKey } from '../../i18n';
import { BlockPicker } from './BlockPicker';
import { parseYaml, toYaml } from '../../yaml';
import { Diagram } from './Diagram';
import { SelectField } from './fields';
import {
  analyse,
  errorCount,
  findStep,
  fromDefinition,
  insertAfter,
  newBlockStep,
  nextStepId,
  replaceStep,
  toDefinition,
  versionLabel,
} from './model';
import { StepPanel } from './StepPanel';
import { reasonProblem } from '../../components/ReasonField';

const runStatusKey = {
  Fullført: 'stepflows.runStatusDone',
  'Venter på godkjenning': 'stepflows.runStatusWaiting',
  Feilet: 'stepflows.runStatusFailed',
} as const satisfies Record<RunOverlay['status'], PlainKey>;

export type Flash = { text: string; color: 'success' | 'info' | 'warning' | 'danger' } | undefined;

interface Props {
  api: ApiClient;
  tenant: string;
  flows: Record<string, Flow>;
  flow: Flow;
  serviceName?: string;
  showPicker: boolean;
  initialTab: 'diagram' | 'yaml';
  initialOverlay: boolean;
  onPickFlow: (id: string) => void;
  onChange: (flow: Flow) => void;
  onFlash: (flash: Flash) => void;
}

export const FlowEditor = ({
  api,
  tenant,
  flows,
  flow,
  serviceName,
  showPicker,
  initialTab,
  initialOverlay,
  onPickFlow,
  onChange,
  onFlash,
}: Props) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [tab, setTab] = useState(initialTab);
  const [overlay, setOverlay] = useState(initialOverlay);
  const [running, setRunning] = useState(false);
  const [subOpen, setSubOpen] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState<Step | undefined>();
  const [picking, setPicking] = useState<{ after?: string } | undefined>();
  const [yamlDraft, setYamlDraft] = useState<string | undefined>();
  const [yamlErr, setYamlErr] = useState('');
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<{ path: string; message: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const analysis = useMemo(() => analyse(flow, flows, subOpen, t), [flow, flows, subOpen, t]);
  const count = errorCount(analysis);
  const run = flow.run;
  const overlayOn = overlay && !!run;
  const definition = useMemo(() => toDefinition(flow, tenant, flows), [flow, tenant, flows]);
  const generated = useMemo(() => toYaml(definition), [definition]);
  const yaml = yamlDraft ?? generated;
  const yamlClean = yamlDraft === undefined || yamlDraft === generated;

  const update = (next: Flow, message?: string) => {
    onChange(next);
    setDirty(true);
    setYamlDraft(undefined);
    setYamlErr('');
    onFlash(message ? { text: message, color: 'success' } : undefined);
  };

  const openEdit = (id: string, steps: Step[] = flow.steps) => {
    const s = findStep(steps, id);
    if (s) setDraft(structuredClone(s));
  };

  const addStep = (block: string) => {
    const after = picking?.after;
    setPicking(undefined);
    const id = nextStepId(flow);
    const name = blocks[block]?.name ?? block;
    const added = { ...newBlockStep(id, t), block, label: name };
    const steps = after ? insertAfter(flow.steps, after, added) : [...flow.steps, added];
    update(
      { ...flow, steps },
      after
        ? t('stepflows.addedAfter', { name, after: analysis.labels[after] ?? after })
        : t('stepflows.addedEnd', { name }),
    );
    openEdit(id, steps);
  };

  const runTest = () => {
    if (running) return;
    if (count) {
      onFlash({ text: t('stepflows.fixBeforeTest'), color: 'warning' });
      return;
    }
    if (!run) {
      onFlash({ text: t('stepflows.noTestData'), color: 'info' });
      return;
    }
    setRunning(true);
    onFlash({ text: t('stepflows.runningTest'), color: 'info' });
    timer.current = setTimeout(() => {
      setRunning(false);
      setOverlay(true);
      onFlash({ text: tRef.current('stepflows.testDone'), color: 'success' });
    }, 1200);
  };

  const applyYaml = () => {
    if (yamlClean || yamlDraft === undefined) return;
    try {
      const next = fromDefinition(parseYaml(yamlDraft), flow, t);
      update(
        { ...flow, name: next.name, input: next.input, steps: next.steps },
        t('stepflows.yamlApplied'),
      );
    } catch (error) {
      setYamlErr(error instanceof Error ? error.message : t('stepflows.yamlUnreadable'));
    }
  };

  const save = async () => {
    if (saving) return;
    if (count) {
      onFlash({ text: t('stepflows.fixBeforeSave'), color: 'warning' });
      return;
    }
    const reasonError = reasonProblem(reason, t);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    setSaving(true);
    setServerErrors([]);
    try {
      const check = await api.validate(definition);
      if (!check.valid) {
        setServerErrors(check.errors);
        onFlash({ text: tRef.current('stepflows.serverRejected'), color: 'danger' });
        return;
      }
      const saved = await api.publishDefinition(definition, {}, reason.trim());
      onChange({ ...flow, version: saved.version, draft: false, changed: 'nå' });
      setDirty(false);
      setReason('');
      onFlash({
        text: tRef.current('stepflows.saved', { version: saved.version }),
        color: 'success',
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 422)
        setServerErrors(error.problem?.errors ?? []);
      onFlash({ text: tRef.current('stepflows.saveFailed'), color: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  const others = flow.usedBy.filter((u) => u !== (serviceName ?? serviceOfFlow[flow.id]));
  const shared =
    flow.usedBy.length > 1
      ? t('stepflows.sharedWith', {
          others: others.join(', '),
          next: flow.version + 1,
          current: versionLabel(flow, t),
        })
      : t('stepflows.sharedNone');

  const draftErrors = draft
    ? (analyse(
        { ...flow, steps: replaceStep(flow.steps, draft.id, draft) },
        flows,
        {},
        t,
      ).errors.get(draft.id) ?? [])
    : [];

  return (
    <div className="stack-md">
      {showPicker ? (
        <div className="flow-picker">
          <div className="flow-picker-select">
            <SelectField
              id="flyt"
              label={t('stepflows.flowLabel')}
              value={flow.id}
              options={Object.values(flows).map((x) => ({
                value: x.id,
                label: x.sub ? t('stepflows.subSuffix', { name: x.name }) : x.name,
              }))}
              onChange={(id) => {
                setDraft(undefined);
                setYamlDraft(undefined);
                setYamlErr('');
                onPickFlow(id);
              }}
            />
          </div>
          <span className="flow-picker-text">
            {versionLabel(flow, t)} · {flow.desc}
            <span className="meta block">{shared}</span>
          </span>
        </div>
      ) : (
        <p className="flow-picker-text">
          {versionLabel(flow, t)} · {flow.desc}
          <span className="meta block">{shared}</span>
        </p>
      )}

      <Tabs value={tab} onChange={(v) => setTab(v as 'diagram' | 'yaml')}>
        <div className="flow-toolbar">
          <Tabs.List aria-label={t('stepflows.flowLabel')}>
            <Tabs.Tab value="diagram">
              {t('stepflows.tabDiagram')}
              {count ? (
                <Badge
                  data-color="danger"
                  count={count}
                  aria-label={t('stepflows.errorCount', { count })}
                />
              ) : null}
            </Tabs.Tab>
            <Tabs.Tab value="yaml">{t('stepflows.tabYaml')}</Tabs.Tab>
          </Tabs.List>
          <div className="actions">
            <Switch
              label={t('stepflows.showLastRun')}
              checked={overlayOn}
              disabled={!run}
              onChange={() => setOverlay((o) => !o)}
            />
            <Button
              variant="secondary"
              data-size="sm"
              aria-disabled={running || undefined}
              onClick={runTest}
            >
              {t('stepflows.runTest')}
            </Button>
          </div>
        </div>

        {count > 0 ? (
          <Alert data-color="danger">
            <Heading level={2} data-size="2xs">
              {t('stepflows.flowErrors', { count })}
            </Heading>
            <ul className="bullets error-links">
              {[...analysis.errors.entries()].flatMap(([id, list]) =>
                list.map((m, i) => (
                  <li key={`${id}-${i}`}>
                    <button type="button" className="link-button" onClick={() => openEdit(id)}>
                      <strong>{analysis.labels[id] ?? id}:</strong> {m}
                    </button>
                  </li>
                )),
              )}
            </ul>
          </Alert>
        ) : (
          <p role="status" className="flow-valid">
            <Icon d={icons.check} size={18} strokeWidth={2} />
            {t('stepflows.flowValid')}
          </p>
        )}

        {overlayOn && run ? (
          <div className="flow-overlay-bar">
            <Tag
              data-size="sm"
              data-color={
                run.status === 'Fullført'
                  ? 'success'
                  : run.status === 'Feilet'
                    ? 'danger'
                    : 'warning'
              }
            >
              {t(runStatusKey[run.status])}
            </Tag>
            <span>
              {t('stepflows.runSummary', { id: run.id, total: run.total, tokens: run.tokens })}
            </span>
            <a href={`#/log/${run.id}`}>{t('stepflows.openTimeline')}</a>
          </div>
        ) : null}

        <Tabs.Panel value="diagram">
          <Diagram
            flow={flow}
            analysis={analysis}
            overlay={overlayOn}
            subOpen={subOpen}
            onToggleSub={(id) => setSubOpen((o) => ({ ...o, [id]: !o[id] }))}
            onOpen={(id) => openEdit(id)}
            onAdd={() => setPicking({})}
          />
        </Tabs.Panel>
        <Tabs.Panel value="yaml">
          <div className="stack-sm">
            <p className="lead small-lead">{t('stepflows.yamlLead')}</p>
            <Field>
              <Label htmlFor="yaml">{t('stepflows.yamlLabel')}</Label>
              <Textarea
                id="yaml"
                className="yaml-input"
                rows={28}
                spellCheck={false}
                value={yaml}
                aria-invalid={yamlErr ? true : undefined}
                onChange={(e) => {
                  setYamlDraft(e.target.value);
                  setYamlErr('');
                }}
              />
              {yamlErr ? <ValidationMessage>{yamlErr}</ValidationMessage> : null}
            </Field>
            <div className="actions">
              <Button variant="primary" aria-disabled={yamlClean || undefined} onClick={applyYaml}>
                {t('stepflows.applyChanges')}
              </Button>
              <Button
                variant="secondary"
                aria-disabled={yamlClean || undefined}
                onClick={() => {
                  if (yamlClean) return;
                  setYamlDraft(undefined);
                  setYamlErr('');
                }}
              >
                {t('stepflows.discard')}
              </Button>
              <span className="meta">
                {yamlClean ? t('stepflows.inSync') : t('stepflows.unsaved')}
              </span>
            </div>
          </div>
        </Tabs.Panel>
      </Tabs>

      {dirty ? (
        <section className="flow-save" aria-labelledby="flow-save-h">
          <Heading level={2} data-size="2xs" id="flow-save-h">
            {t('stepflows.saveAs', { version: flow.version + 1 })}
          </Heading>
          {serverErrors.length ? (
            <Alert data-color="danger" data-size="sm">
              <ul className="bullets">
                {serverErrors.map((e) => (
                  <li key={`${e.path}-${e.message}`}>
                    {e.path ? <code>{e.path}</code> : null} {e.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <Field className="reason-field">
            <Label htmlFor="flow-reason">{t('stepflows.reasonLabel')}</Label>
            <Field.Description>{t('stepflows.reasonHelp')}</Field.Description>
            <Textarea
              id="flow-reason"
              rows={2}
              value={reason}
              aria-invalid={reasonErr ? true : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonErr('');
              }}
            />
            {reasonErr ? <ValidationMessage>{reasonErr}</ValidationMessage> : null}
          </Field>
          <div className="actions">
            <Button
              variant="primary"
              aria-disabled={saving || undefined}
              onClick={() => void save()}
            >
              {t('stepflows.saveAs', { version: flow.version + 1 })}
            </Button>
            <ApiCallLink
              call={{
                action: t('stepflows.apiAction'),
                method: 'POST',
                path: '/definitions',
                body: { definition: { kind: 'StepFlow', metadata: { id: flow.id } } },
                right: 'Administrere tjenester',
              }}
            />
          </div>
        </section>
      ) : null}

      {draft ? (
        <StepPanel
          draft={draft}
          setDraft={setDraft}
          base={analysis}
          errors={draftErrors}
          flows={flows}
          onClose={() => setDraft(undefined)}
          onApply={() => {
            update(
              { ...flow, steps: replaceStep(flow.steps, draft.id, draft) },
              draftErrors.length
                ? t('stepflows.stepUpdatedErrors', {
                    name: draft.label || draft.id,
                    count: draftErrors.length,
                  })
                : t('stepflows.stepUpdated', { name: draft.label || draft.id }),
            );
            setDraft(undefined);
          }}
          onAddAfter={() => {
            update({ ...flow, steps: replaceStep(flow.steps, draft.id, draft) });
            setDraft(undefined);
            setPicking({ after: draft.id });
          }}
          onRemove={() => {
            update(
              { ...flow, steps: replaceStep(flow.steps, draft.id, null) },
              t('stepflows.stepRemoved', { name: draft.label || draft.id }),
            );
            setDraft(undefined);
          }}
        />
      ) : null}
      {picking ? <BlockPicker onPick={addStep} onClose={() => setPicking(undefined)} /> : null}
    </div>
  );
};
