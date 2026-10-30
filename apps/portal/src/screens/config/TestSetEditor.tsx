import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Tag,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import type { TestCaseSummary, TestSet } from '../../types';
import { minimumReasonLength } from '../../components/ReasonField';

const splits = ['train', 'validation', 'holdout'] as const;
const splitLabel: Record<string, PlainKey> = {
  train: 'config.splitTrain',
  validation: 'config.splitValidation',
  holdout: 'config.splitHoldout',
};

const reasonProblem = (t: T, reason: string) =>
  reason.trim().length < minimumReasonLength
    ? t('config.reasonShort', { min: minimumReasonLength })
    : undefined;

const inputText = (input: TestCaseSummary['input']) =>
  typeof input === 'string' ? input : JSON.stringify(input);

const problemText = (t: T, error: unknown) =>
  error instanceof ApiError && error.problem?.errors?.length
    ? error.problem.errors.map((e) => `${e.path}: ${e.message}`).join('. ')
    : t('config.noResponse');

interface CaseDraft {
  id: string;
  split: string;
  input: string;
  referenceAnswer: string;
  /** The case as stored: a save replaces the whole case, so it keeps what the form does not edit. */
  stored?: TestCaseSummary;
}

/** The field holds a criteria case's criteria, otherwise the reference answer. */
const judgedOnCriteria = (stored?: TestCaseSummary) =>
  stored?.type === 'criteria' || stored?.expected.criteria !== undefined;

/** Criteria fields other than the one the form edits, which a save keeps. */
const otherCriteria = (stored?: TestCaseSummary) =>
  Object.keys(stored?.expected.criteria ?? {}).filter((k) => k !== 'criteria');

const CaseForm = ({
  initial,
  fixedId,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: CaseDraft;
  fixedId: boolean;
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: CaseDraft, reason: string) => void;
  onCancel?: () => void;
}) => {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = () => {
    const next: Record<string, string> = {};
    if (!/^[a-z0-9][a-z0-9-]*$/.test(draft.id)) next.id = t('config.caseIdInvalid');
    if (!draft.input.trim()) next.input = t('config.caseInputMissing');
    // A criteria case without criteria would have its reference answer read as its criteria.
    if (
      judgedOnCriteria(draft.stored) &&
      !draft.referenceAnswer.trim() &&
      otherCriteria(draft.stored).length === 0
    )
      next.expected = t('config.caseCriteriaMissing');
    const reasonError = reasonProblem(t, reason);
    if (reasonError) next.reason = reasonError;
    setErrors(next);
    if (Object.keys(next).length === 0) onSubmit(draft, reason.trim());
  };
  return (
    <div className="config-editor stack-sm">
      <Textfield
        label={t('config.caseIdLabel')}
        value={draft.id}
        readOnly={fixedId}
        error={errors.id}
        onChange={(e) => setDraft({ ...draft, id: e.target.value })}
      />
      <Field>
        <Label htmlFor={`input-${initial.id || 'ny'}`}>{t('config.caseInputLabel')}</Label>
        <Textarea
          id={`input-${initial.id || 'ny'}`}
          rows={3}
          value={draft.input}
          aria-invalid={errors.input ? true : undefined}
          onChange={(e) => setDraft({ ...draft, input: e.target.value })}
        />
        {errors.input ? <Field.Description role="alert">{errors.input}</Field.Description> : null}
      </Field>
      <Field>
        <Label htmlFor={`svar-${initial.id || 'ny'}`}>
          {t(
            judgedOnCriteria(draft.stored)
              ? 'config.caseCriteriaLabel'
              : 'config.caseExpectedLabel',
          )}
        </Label>
        <Textarea
          id={`svar-${initial.id || 'ny'}`}
          rows={3}
          value={draft.referenceAnswer}
          onChange={(e) => setDraft({ ...draft, referenceAnswer: e.target.value })}
        />
        {errors.expected ? (
          <Field.Description role="alert">{errors.expected}</Field.Description>
        ) : null}
      </Field>
      <Field>
        <Label htmlFor={`del-${initial.id || 'ny'}`}>{t('config.caseSplitLabel')}</Label>
        <Select
          id={`del-${initial.id || 'ny'}`}
          value={draft.split}
          onChange={(e) => setDraft({ ...draft, split: e.target.value })}
        >
          {splits.map((s) => (
            <Select.Option key={s} value={s}>
              {t(splitLabel[s] as PlainKey)}
            </Select.Option>
          ))}
        </Select>
      </Field>
      <Textfield
        label={t('config.reasonLabel')}
        value={reason}
        error={errors.reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="row-wrap">
        <Button data-size="sm" loading={busy} onClick={() => !busy && submit()}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="secondary" data-size="sm" onClick={onCancel}>
            {t('config.cancel')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const caseBody = (draft: CaseDraft) => {
  const text = draft.referenceAnswer.trim();
  const without = (o: object, keys: string[]) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const stored = draft.stored?.expected ?? {};
  const storedCriteria = judgedOnCriteria(draft.stored) ? (stored.criteria ?? {}) : undefined;
  const rest = draft.stored ? without(draft.stored, ['id', 'expected']) : {};
  const others = without(stored, ['criteria', 'referenceAnswer']);
  // The field holds a criteria case's criteria, otherwise the reference answer.
  const criteria = storedCriteria
    ? {
        ...Object.fromEntries(Object.entries(storedCriteria).filter(([k]) => k !== 'criteria')),
        ...(text ? { criteria: text } : {}),
      }
    : undefined;
  const reference = storedCriteria ? stored.referenceAnswer : text || undefined;
  const expected = {
    ...others,
    ...(reference ? { referenceAnswer: reference } : {}),
    ...(criteria && Object.keys(criteria).length > 0 ? { criteria } : {}),
  };
  return {
    ...rest,
    split: draft.split,
    input: draft.input.trim(),
    ...(Object.keys(expected).length > 0 ? { expected } : {}),
  };
};

const emptyCase = (id = ''): CaseDraft => ({
  id,
  split: 'validation',
  input: '',
  referenceAnswer: '',
});

const SetCases = ({
  api,
  tenant,
  set,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  set: TestSet;
  onChanged: (message: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [editing, setEditing] = useState<string | 'new'>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [removeReason, setRemoveReason] = useState('');
  const base = `/tenants/${encodeURIComponent(tenant)}/test-sets/${encodeURIComponent(set.metadata.id)}/cases`;

  const save = async (draft: CaseDraft, reason: string) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await api.configSave(`${base}/${encodeURIComponent(draft.id)}`, caseBody(draft), { reason });
      setEditing(undefined);
      onChanged(tRef.current('config.caseSaved', { id: draft.id, set: set.metadata.name }));
    } catch (error) {
      setFailed(problemText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const removeError = reasonProblem(t, removeReason);
    if (removeError) {
      setFailed(removeError);
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await api.configDelete(`${base}/${encodeURIComponent(id)}`, removeReason.trim());
      onChanged(tRef.current('config.caseRemoved', { id, set: set.metadata.name }));
    } catch (error) {
      setFailed(problemText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
      <ul className="plain-list stack-sm">
        {set.spec.cases.map((c) => (
          <li key={c.id} className="stack-xs">
            <div className="row-wrap">
              <span className="strong">{c.id}</span>
              <Tag data-size="sm" data-color="neutral">
                {splitLabel[c.split] ? t(splitLabel[c.split] as PlainKey) : c.split}
              </Tag>
              <span className="meta">{inputText(c.input).slice(0, 120)}</span>
            </div>
            {editing === c.id ? (
              <CaseForm
                initial={{
                  id: c.id,
                  split: c.split,
                  input: inputText(c.input),
                  referenceAnswer:
                    c.expected.criteria?.criteria ?? c.expected.referenceAnswer ?? '',
                  stored: c,
                }}
                fixedId
                busy={busy}
                submitLabel={t('config.saveCase')}
                onSubmit={(d, r) => void save(d, r)}
                onCancel={() => setEditing(undefined)}
              />
            ) : (
              <div className="row-wrap">
                <Button variant="tertiary" data-size="sm" onClick={() => setEditing(c.id)}>
                  {t('config.edit')}
                  <span className="visually-hidden"> {c.id}</span>
                </Button>
                {set.spec.cases.length > 1 ? (
                  <Button
                    variant="tertiary"
                    data-color="danger"
                    data-size="sm"
                    onClick={() => void remove(c.id)}
                  >
                    {t('config.removeCase')}
                    <span className="visually-hidden"> {c.id}</span>
                  </Button>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      {set.spec.cases.length > 1 ? (
        <Textfield
          label={t('config.removeReasonLabel')}
          value={removeReason}
          onChange={(e) => setRemoveReason(e.target.value)}
        />
      ) : null}
      {editing === 'new' ? (
        <CaseForm
          initial={emptyCase()}
          fixedId={false}
          busy={busy}
          submitLabel={t('config.addCase')}
          onSubmit={(d, r) => void save(d, r)}
          onCancel={() => setEditing(undefined)}
        />
      ) : (
        <Button
          variant="secondary"
          data-size="sm"
          className="align-start"
          onClick={() => setEditing('new')}
        >
          {t('config.newCase')}
        </Button>
      )}
    </div>
  );
};

export const TestSetEditor = ({
  api,
  tenant,
  serviceId,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [round, setRound] = useState(0);
  const [state, retry] = useAsync(
    (signal) => api.listTestSets(tenant, serviceId, signal),
    [api, tenant, serviceId, round],
  );
  const [open, setOpen] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [setId, setSetId] = useState('');
  const [setName, setSetName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [flash, setFlash] = useState('');

  if (state.status === 'loading') return <Loading label={t('config.testSetsLoading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const changed = (message: string) => {
    setFlash(message);
    setRound((r) => r + 1);
  };

  const create = async (first: CaseDraft, reason: string) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(setId) || !setName.trim()) {
      setFailed(t('config.setInvalid'));
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await api.configSave(
        `/tenants/${encodeURIComponent(tenant)}/test-sets`,
        {
          id: setId,
          name: setName.trim(),
          service: serviceId,
          cases: [{ id: first.id, ...caseBody(first) }],
        },
        { reason, method: 'POST' },
      );
      setCreating(false);
      setOpen(setId);
      changed(tRef.current('config.setCreated', { name: setName.trim() }));
    } catch (error) {
      setFailed(problemText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div aria-live="polite">
        {flash ? (
          <Alert data-color="success" data-size="sm">
            {flash}
          </Alert>
        ) : null}
      </div>
      {state.data.length === 0 && !creating ? (
        <Paragraph>{t('config.noTestSets')}</Paragraph>
      ) : null}
      <ul className="plain-list stack-sm">
        {state.data.map((s) => (
          <li key={s.metadata.id} className="stack-sm">
            <div className="row-wrap">
              <Heading level={3} data-size="2xs">
                {s.metadata.name}
              </Heading>
              <span className="meta">
                {t('config.setSummary', {
                  count: s.spec.cases.length,
                  version: s.metadata.version,
                })}
              </span>
              <Button
                variant="tertiary"
                data-size="sm"
                aria-expanded={open === s.metadata.id}
                onClick={() => setOpen(open === s.metadata.id ? undefined : s.metadata.id)}
              >
                {open === s.metadata.id ? t('config.close') : t('config.editToggle')}
                <span className="visually-hidden"> {s.metadata.name}</span>
              </Button>
            </div>
            {open === s.metadata.id ? (
              <SetCases api={api} tenant={tenant} set={s} onChanged={changed} />
            ) : null}
          </li>
        ))}
      </ul>
      {creating ? (
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('config.newTestSet')}
          </Heading>
          <Textfield
            label={t('config.setIdLabel')}
            value={setId}
            onChange={(e) => setSetId(e.target.value)}
          />
          <Textfield
            label={t('config.nameLabel')}
            value={setName}
            onChange={(e) => setSetName(e.target.value)}
          />
          {failed ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {failed}
            </Alert>
          ) : null}
          <Paragraph data-size="sm">{t('config.firstCase')}</Paragraph>
          <CaseForm
            initial={emptyCase('t1')}
            fixedId={false}
            busy={busy}
            submitLabel={t('config.createTestSet')}
            onSubmit={(d, r) => void create(d, r)}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          data-size="sm"
          className="align-start"
          onClick={() => setCreating(true)}
        >
          {t('config.newTestSet')}
        </Button>
      )}
    </div>
  );
};
