import { CheckmarkIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Badge,
  Button,
  Field,
  Heading,
  Input,
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
import { needsRight, useRights } from '../../Shell';
import { useAsync } from '../../hooks';
import { isOperationStep } from '../../data/step-operations';
import type { PortalRight } from '../../types';
import { Icon } from '../../components/Icon';
import { blocks, serviceOfFlow, type Flow, type RunOverlay, type Step } from '../../data/stepflows';
import { useT, type PlainKey } from '../../i18n';
import { BlockPicker } from './BlockPicker';
import { parseYaml, toYaml } from '../../yaml';
import { Diagram } from './Diagram';
import { SearchField } from './fields';
import {
  allSteps,
  analyse,
  errorCount,
  findStep,
  flowName,
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
import { slug } from '../../data/service-form';

const runStatusKey = {
  Fullført: 'stepflows.runStatusDone',
  'Venter på godkjenning': 'stepflows.runStatusWaiting',
  Feilet: 'stepflows.runStatusFailed',
} as const satisfies Record<RunOverlay['status'], PlainKey>;

const rights: readonly PortalRight[] = [
  'use-services',
  'manage-services',
  'manage-datasets',
  'register-building-blocks',
  'view-usage',
];

export const missingRight = (error: unknown): PortalRight | undefined => {
  if (!(error instanceof ApiError) || error.status !== 403) return undefined;
  const named = error.problem?.errors?.find((e) => e.path === 'right')?.message;
  return rights.find((r) => r === named);
};

export type Flash = { text: string; color: 'success' | 'info' | 'warning' | 'danger' } | undefined;

interface Props {
  api: ApiClient;
  tenant: string;
  flows: Record<string, Flow>;
  flow: Flow;
  serviceName?: string;
  serviceId?: string;
  showPicker: boolean;
  initialTab: 'diagram' | 'yaml';
  initialOverlay: boolean;
  onPickFlow: (id: string) => void;
  onChange: (flow: Flow, previousId?: string) => void;
  onFlash: (flash: Flash) => void;
}

export const FlowEditor = ({
  api,
  tenant,
  flows,
  flow,
  serviceName,
  serviceId,
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

  const [purposeErr, setPurposeErr] = useState('');
  const [nameErr, setNameErr] = useState('');
  const savedId = flow.unsaved ? slug(flow.name) : flow.id;
  const canSave = useRights().has('manage-services');
  const [operations] = useAsync((signal) => api.stepOperations(tenant, signal), [api, tenant]);
  const [guardrails] = useAsync(
    async (signal) =>
      serviceId
        ? Object.keys(
            (
              (await api.getDefinition(tenant, 'Service', serviceId, signal)).latest.definition
                .spec as { guardrails?: Record<string, unknown> } | undefined
            )?.guardrails ?? {},
          )
        : undefined,
    [api, tenant, serviceId],
  );
  const ops = useMemo(
    () => ({
      operations: operations.status === 'ready' ? operations.data : undefined,
      failed: operations.status === 'error',
      masking:
        guardrails.status === 'ready' && guardrails.data
          ? guardrails.data.includes('pii-before-model')
          : undefined,
    }),
    [operations, guardrails],
  );
  const hasOperations = useMemo(() => allSteps(flow.steps).some(isOperationStep), [flow.steps]);
  const analysis = useMemo(
    () => analyse(flow, flows, subOpen, t, ops),
    [flow, flows, subOpen, t, ops],
  );
  const nextVersion = flow.draft ? flow.version : flow.version + 1;
  const count = errorCount(analysis);
  const run = flow.run;
  const overlayOn = overlay && !!run;
  const definition = useMemo(
    () => toDefinition({ ...flow, id: savedId || flow.id }, tenant, flows),
    [flow, savedId, tenant, flows],
  );
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
    if (!canSave) return;
    const reasonError = reasonProblem(reason, t);
    const noPurpose = !flow.desc.trim();
    const nameError = !flow.unsaved
      ? ''
      : !savedId
        ? t('stepflows.nameRequired')
        : flows[savedId] && savedId !== flow.id
          ? t('stepflows.nameTaken', { id: savedId })
          : '';
    if (noPurpose) setPurposeErr(t('stepflows.purposeRequired'));
    if (reasonError) setReasonErr(reasonError);
    if (nameError) setNameErr(nameError);
    if (reasonError || noPurpose || nameError) return;
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
      const next: Flow = {
        ...flow,
        id: savedId,
        version: saved.version,
        draft: false,
        changed: 'nå',
      };
      delete next.unsaved;
      onChange(next, flow.id);
      setDirty(false);
      setReason('');
      onFlash({
        text: tRef.current('stepflows.saved', { version: saved.version }),
        color: 'success',
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 422)
        setServerErrors(error.problem?.errors ?? []);
      const right = missingRight(error);
      onFlash({
        text: right ? needsRight(right, tRef.current) : tRef.current('stepflows.saveFailed'),
        color: 'danger',
      });
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
        ops,
      ).errors.get(draft.id) ?? [])
    : [];

  return (
    <div className="stack-md">
      {showPicker ? (
        <div className="flow-picker">
          <div className="flow-picker-select">
            <SearchField
              id="flyt"
              label={t('stepflows.flowLabel')}
              clearLabel={t('stepflows.clearFlowSearch')}
              value={flow.id}
              options={Object.values(flows).map((x) => ({
                value: x.id,
                label: x.sub ? t('stepflows.subSuffix', { name: flowName(x, t) }) : flowName(x, t),
              }))}
              onChange={(id) => {
                if (!id) return;
                setDraft(undefined);
                setYamlDraft(undefined);
                setYamlErr('');
                onPickFlow(id);
              }}
            />
          </div>
          <span className="flow-picker-text">
            {versionLabel(flow, t)} · {flow.desc || t('stepflows.newFlowDesc')}
            <span className="meta block">{shared}</span>
          </span>
        </div>
      ) : (
        <p className="flow-picker-text">
          {versionLabel(flow, t)} · {flow.desc || t('stepflows.newFlowDesc')}
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
              aria-describedby={hasOperations ? 'flow-test-note' : undefined}
              onClick={runTest}
            >
              {t('stepflows.runTest')}
            </Button>
          </div>
        </div>
        {hasOperations ? (
          <p id="flow-test-note" className="meta">
            {t('stepflows.operationTestNote')}
          </p>
        ) : null}

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
            <Icon icon={CheckmarkIcon} size={18} />
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
            {t('stepflows.saveAs', { version: nextVersion })}
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
          {flow.unsaved ? (
            <Field className="reason-field">
              <Label htmlFor="flow-name">{t('stepflows.nameLabel')}</Label>
              <Field.Description>
                {savedId ? t('stepflows.nameId', { id: savedId }) : t('stepflows.nameHelp')}
              </Field.Description>
              <Input
                id="flow-name"
                value={flow.name}
                aria-invalid={nameErr ? true : undefined}
                onChange={(e) => {
                  onChange({ ...flow, name: e.target.value });
                  setNameErr('');
                }}
              />
              {nameErr ? <ValidationMessage>{nameErr}</ValidationMessage> : null}
            </Field>
          ) : null}
          <Field className="reason-field">
            <Label htmlFor="flow-purpose">{t('stepflows.purposeLabel')}</Label>
            <Field.Description>{t('stepflows.purposeHelp')}</Field.Description>
            <Textarea
              id="flow-purpose"
              rows={2}
              value={flow.desc}
              aria-invalid={purposeErr ? true : undefined}
              onChange={(e) => {
                onChange({ ...flow, desc: e.target.value });
                setPurposeErr('');
              }}
            />
            {purposeErr ? <ValidationMessage>{purposeErr}</ValidationMessage> : null}
          </Field>
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
              aria-disabled={saving || !canSave || undefined}
              aria-describedby={canSave ? undefined : 'flow-save-right'}
              onClick={() => void save()}
            >
              {t('stepflows.saveAs', { version: nextVersion })}
            </Button>
            <ApiCallLink
              call={{
                action: t('stepflows.apiAction'),
                method: 'POST',
                path: '/definitions',
                body: { definition: { kind: 'StepFlow', metadata: { id: savedId || flow.id } } },
                right: 'Administrere tjenester',
              }}
            />
          </div>
          {canSave ? null : (
            <p id="flow-save-right" className="meta">
              {needsRight('manage-services', t)}
            </p>
          )}
        </section>
      ) : null}

      {draft ? (
        <StepPanel
          draft={draft}
          setDraft={setDraft}
          base={analysis}
          errors={draftErrors}
          flows={flows}
          ops={ops}
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
