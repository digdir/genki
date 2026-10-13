import {
  Button,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import type { CaseSplit, CaseType, ServiceCase, ServiceTestSet } from '../../api/quality';
import { useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { CandidateReview } from './CandidateReview';
import { ImportCases } from './ImportCases';
import { RunHistory } from './RunHistory';
import { caseTypeKeys, problemTitle, splitKeys, testSetId, type SetFlash } from './shared';

const splitTag: Record<CaseSplit, PlainKey> = {
  locked: 'quality.splitLocked',
  open: 'quality.splitOpen',
};

interface CaseForm {
  input: string;
  expected: string;
  type: CaseType;
  split: CaseSplit;
  tried: boolean;
}

const blank = (): CaseForm => ({
  input: '',
  expected: '',
  type: 'criteria',
  split: 'open',
  tried: false,
});

const NewTestSet = ({ onCreate, busy }: { onCreate: (name: string) => void; busy: boolean }) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const hintId = useId();
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const error = tried && !name.trim() ? t('quality.nameProblem') : undefined;
  return (
    <div className="quality-panel">
      <Textfield
        label={t('quality.setName')}
        value={name}
        error={error}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="actions">
        <Button
          variant="primary"
          aria-disabled={busy || !canManage || undefined}
          aria-describedby={canManage ? undefined : hintId}
          onClick={() => {
            if (!canManage) return;
            setTried(true);
            if (name.trim() && !busy) onCreate(name.trim());
          }}
        >
          {t('quality.createSet')}
        </Button>
        {canManage ? null : (
          <span id={hintId} className="meta">
            {needsRight('manage-services', t)}
          </span>
        )}
      </div>
    </div>
  );
};

const CaseList = ({
  cases,
  busy,
  onDelete,
}: {
  cases: ServiceCase[];
  busy: boolean;
  onDelete: (c: ServiceCase) => void;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const hintId = useId();
  const [confirm, setConfirm] = useState<string>();
  if (cases.length === 0)
    return (
      <div className="state empty">
        <Heading level={3} data-size="2xs">
          {t('quality.noCases')}
        </Heading>
        <Paragraph>{t('quality.noCasesText')}</Paragraph>
      </div>
    );
  return (
    <ul className="live-case-list">
      {cases.map((c) => (
        <li key={c.id}>
          <div className="live-case">
            <span className="case-input">{c.input}</span>
            <span className="tag-row">
              <Tag data-size="sm" data-color={c.split === 'locked' ? 'accent' : 'info'}>
                {t(splitTag[c.split])}
              </Tag>
              <Tag data-size="sm" data-color="neutral">
                {t(caseTypeKeys[c.type])}
              </Tag>
            </span>
            <span className="meta">
              {t('quality.goodAnswerIs', { text: c.expected || t('quality.notDescribed') })}
            </span>
            {confirm === c.id ? (
              <span className="actions">
                <Button
                  variant="primary"
                  data-color="danger"
                  data-size="sm"
                  aria-disabled={busy || undefined}
                  onClick={() => {
                    if (busy) return;
                    setConfirm(undefined);
                    onDelete(c);
                  }}
                >
                  {t('quality.confirmDelete')}
                </Button>
                <Button variant="tertiary" data-size="sm" onClick={() => setConfirm(undefined)}>
                  {t('quality.cancel')}
                </Button>
              </span>
            ) : (
              <span className="actions align-start">
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('quality.deleteCaseLabel', { input: c.input })}
                  aria-disabled={canManage ? undefined : true}
                  aria-describedby={canManage ? undefined : `${hintId}-${c.id}`}
                  onClick={() => canManage && setConfirm(c.id)}
                >
                  {t('quality.delete')}
                </Button>
                {canManage ? null : (
                  <span id={`${hintId}-${c.id}`} className="meta">
                    {needsRight('manage-services', t)}
                  </span>
                )}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
};

export const LiveTestSets = ({
  api,
  tenant,
  serviceId,
  setFlash,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  setFlash: SetFlash;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const [setsRound, setSetsRound] = useState(0);
  const [casesRound, setCasesRound] = useState(0);
  const [chosen, setChosen] = useState<string>();
  const [form, setForm] = useState<CaseForm>();
  const [busy, setBusy] = useState(false);
  const [sets, retrySets] = useAsync(
    (signal) => api.quality.testSets(tenant, serviceId, signal),
    [api, tenant, serviceId, setsRound],
  );
  const list: ServiceTestSet[] = sets.status === 'ready' ? sets.data : [];
  const current = list.find((s) => s.id === chosen) ?? list[0];
  const [cases, retryCases] = useAsync(
    async (signal) => (current ? api.quality.cases(tenant, current.id, signal) : []),
    [api, tenant, current?.id, casesRound],
  );

  const changed = () => setCasesRound((r) => r + 1);

  const act = async (work: () => Promise<unknown>, done: string, reload = changed) => {
    if (busy) return false;
    setBusy(true);
    try {
      await work();
      setFlash({ text: done, color: 'success' });
      reload();
      return true;
    } catch (error) {
      setFlash({ text: problemTitle(error, t), color: 'danger' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (sets.status === 'loading') return <Loading label={t('quality.setsLoading')} />;
  if (sets.status === 'error') return <ErrorState error={sets.error} onRetry={retrySets} />;

  const createSet = (name: string) =>
    void act(
      async () => {
        const created = await api.quality.createTestSet(
          tenant,
          {
            id: testSetId(
              serviceId,
              name,
              list.map((s) => s.id),
            ),
            name,
            service: serviceId,
          },
          t('quality.newSetReason', { service: serviceId }),
        );
        setChosen(created.id);
      },
      t('quality.setCreated', { name }),
      () => setSetsRound((r) => r + 1),
    );

  if (!current)
    return (
      <div className="stack">
        <div className="state empty">
          <Heading level={2} data-size="2xs">
            {t('quality.noSets')}
          </Heading>
          <Paragraph>{t('quality.noSetsText')}</Paragraph>
        </div>
        <NewTestSet busy={busy} onCreate={createSet} />
        <CandidateReview
          api={api}
          tenant={tenant}
          serviceId={serviceId}
          sets={list}
          setFlash={setFlash}
          onAccepted={changed}
        />
      </div>
    );

  const all = cases.status === 'ready' ? cases.data : [];
  const count = (s: CaseSplit) => all.filter((c) => c.split === s).length;
  const set = (p: Partial<CaseForm>) => setForm((f) => (f ? { ...f, ...p } : f));
  const inputError = form?.tried && !form.input.trim() ? t('quality.inputProblem') : '';
  const expectedError = form?.tried && !form.expected.trim() ? t('quality.describeGood') : '';

  const save = async () => {
    if (!form) return;
    if (!form.input.trim() || !form.expected.trim()) {
      set({ tried: true });
      return;
    }
    const ok = await act(
      () =>
        api.quality.addCase(
          tenant,
          current.id,
          {
            input: form.input.trim(),
            expected: form.expected.trim(),
            type: form.type,
            split: form.split,
          },
          t('quality.newCaseReason', { name: current.name }),
        ),
      t('quality.caseAddedTo', { name: current.name }),
    );
    if (ok) setForm(undefined);
  };

  return (
    <div className="stack">
      <div className="quality-toolbar">
        {list.length > 1 ? (
          <Field>
            <Label htmlFor="ts-choose">{t('quality.testSet')}</Label>
            <Select
              id="ts-choose"
              value={current.id}
              onChange={(e) => {
                setChosen(e.target.value);
                setForm(undefined);
              }}
            >
              {list.map((s) => (
                <Select.Option key={s.id} value={s.id}>
                  {s.name}
                </Select.Option>
              ))}
            </Select>
          </Field>
        ) : (
          <Heading level={2} data-size="xs">
            {current.name}
          </Heading>
        )}
        <dl className="quality-counts">
          {(
            [
              [t('quality.cases'), all.length],
              [t('quality.open'), count('open')],
              [t('quality.locked'), count('locked')],
            ] as const
          ).map(([l, v]) => (
            <div key={l}>
              <dt>{l}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <Button
            variant="primary"
            aria-disabled={canManage ? undefined : true}
            aria-describedby={canManage ? undefined : 'nc-right'}
            onClick={() => canManage && setForm(blank())}
          >
            {t('quality.newCase')}
          </Button>
          {canManage ? null : (
            <span id="nc-right" className="meta">
              {needsRight('manage-services', t)}
            </span>
          )}
        </div>
      </div>
      <ImportCases
        api={api}
        tenant={tenant}
        testSet={current}
        existingIds={all.map((c) => c.id)}
        setFlash={setFlash}
        onImported={changed}
      />
      <p className="quality-splits">
        {t.rich('quality.liveSplits', { strong: (c) => <strong>{c}</strong> })}
      </p>

      {form ? (
        <section aria-labelledby="nc-h" className="quality-panel">
          <Heading level={2} data-size="xs" id="nc-h">
            {t('quality.newCase')}
          </Heading>
          <Field>
            <Label htmlFor="nc-in">{t('quality.input')}</Label>
            <Textarea
              id="nc-in"
              rows={2}
              value={form.input}
              aria-invalid={inputError ? true : undefined}
              onChange={(e) => set({ input: e.target.value })}
            />
            {inputError ? <ValidationMessage>{inputError}</ValidationMessage> : null}
          </Field>
          <Field>
            <Label htmlFor="nc-exp">{t('quality.goodAnswer')}</Label>
            <Textarea
              id="nc-exp"
              rows={2}
              value={form.expected}
              aria-invalid={expectedError ? true : undefined}
              onChange={(e) => set({ expected: e.target.value })}
            />
            {expectedError ? <ValidationMessage>{expectedError}</ValidationMessage> : null}
          </Field>
          <Fieldset>
            <Fieldset.Legend>{t('quality.type')}</Fieldset.Legend>
            {(Object.keys(caseTypeKeys) as CaseType[]).map((type) => (
              <Radio
                key={type}
                name="nc-type"
                label={t(caseTypeKeys[type])}
                checked={form.type === type}
                onChange={() => set({ type })}
              />
            ))}
          </Fieldset>
          <Fieldset>
            <Fieldset.Legend>{t('quality.part')}</Fieldset.Legend>
            {(['open', 'locked'] as CaseSplit[]).map((s) => (
              <Radio
                key={s}
                name="nc-split"
                label={t(splitKeys[s])}
                checked={form.split === s}
                onChange={() => set({ split: s })}
              />
            ))}
          </Fieldset>
          <div className="actions">
            <Button variant="primary" aria-disabled={busy || undefined} onClick={() => void save()}>
              {t('quality.saveCase')}
            </Button>
            <Button variant="secondary" onClick={() => setForm(undefined)}>
              {t('quality.cancel')}
            </Button>
          </div>
        </section>
      ) : null}

      <RunHistory
        api={api}
        tenant={tenant}
        serviceId={serviceId}
        testSet={current}
        cases={all.length}
        setFlash={setFlash}
      />

      <section aria-labelledby="cases-h" className="stack-sm">
        <Heading level={2} data-size="xs" id="cases-h">
          {t('quality.cases')}
        </Heading>
        {cases.status === 'loading' ? (
          <Loading label={t('quality.casesLoading')} />
        ) : cases.status === 'error' ? (
          <ErrorState error={cases.error} onRetry={retryCases} headingLevel={3} />
        ) : (
          <CaseList
            cases={all}
            busy={busy}
            onDelete={(c) =>
              void act(
                () =>
                  api.quality.deleteCase(
                    tenant,
                    current.id,
                    c.id,
                    t('quality.deleteReason', { name: current.name }),
                  ),
                t('quality.caseDeleted'),
              )
            }
          />
        )}
      </section>

      <CandidateReview
        api={api}
        tenant={tenant}
        serviceId={serviceId}
        sets={list}
        setFlash={setFlash}
        onAccepted={changed}
      />
    </div>
  );
};
