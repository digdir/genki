import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Spinner,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { SkillCase, SkillCaseType, SkillFix, SkillTestRun } from '../../api/skills';
import { useT } from '../../i18n';
import { caseTypeLabels, caseTypeOptions } from '../../data/skills';
import { FixCard } from './FixCard';

export interface DatasetOption {
  id: string;
  name: string;
}

interface Props {
  cases: SkillCase[];
  run: SkillTestRun | undefined;
  fresh: boolean;
  running: boolean;
  canEdit: boolean;
  busy: boolean;
  hasExamples: boolean;
  previous: { passed: number; total: number } | undefined;
  datasets: DatasetOption[];
  fix: SkillFix | undefined;
  onRun: () => void;
  onFix: () => void;
  onApplyFix: () => void;
  onDiscardFix: () => void;
  onAdd: (testCase: SkillCase) => void;
  onDelete: (index: number) => void;
  onFromExamples: () => void;
}

interface Adding {
  input: string;
  expected: string;
  type: SkillCaseType;
  context: string;
  dataset: string;
  error: string;
}

export const TestSetTab = ({
  cases,
  run,
  fresh,
  running,
  canEdit,
  busy,
  hasExamples,
  previous,
  datasets,
  fix,
  onRun,
  onFix,
  onApplyFix,
  onDiscardFix,
  onAdd,
  onDelete,
  onFromExamples,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const [adding, setAdding] = useState<Adding | null>(null);
  const [ranHere, setRanHere] = useState(false);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setRanHere(true);
    if (running) setRanHere(false);
    wasRunning.current = running;
  }, [running]);
  const n = cases.length;
  const result = fresh ? run : undefined;
  const failures = result ? result.results.filter((r) => !r.passed).length : 0;
  const stale = !!run && !fresh && !running;
  const count = t('skills.testsetSummary', { count: n });

  const startAdding = () =>
    setAdding({ input: '', expected: '', type: 'criteria', context: '', dataset: '', error: '' });

  const save = () => {
    if (!adding) return;
    if (!adding.input.trim() || !adding.expected.trim()) {
      setAdding({ ...adding, error: t('skills.testFillBoth') });
      return;
    }
    onAdd({
      input: adding.input.trim(),
      expected: adding.expected.trim(),
      type: adding.type,
      ...(adding.context.trim() ? { context: adding.context.trim() } : {}),
      ...(adding.dataset ? { dataset: adding.dataset } : {}),
    });
    setAdding(null);
  };

  return (
    <div className="skill-tests">
      {n === 0 ? (
        <div className="skill-empty">
          <Heading level={2} data-size="xs">
            {t('skills.testsetEmptyTitle')}
          </Heading>
          <Paragraph>{t('skills.testsetEmptyText')}</Paragraph>
          {canEdit && !adding ? (
            <div className="actions">
              <Button variant="primary" onClick={startAdding}>
                {t('skills.testsetCreate')}
              </Button>
              {hasExamples ? (
                <Button variant="secondary" onClick={onFromExamples}>
                  {t('skills.testFromExamples')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <section aria-labelledby="skill-testset-h" className="skill-testset">
          <div className="skill-testset-head">
            <div className="skill-testset-title">
              <Heading level={2} data-size="xs" id="skill-testset-h">
                {t('skills.testsetTitle')}
              </Heading>
              <span className="skill-help">
                {run && !run.stale
                  ? t('skills.testsetLastRun', {
                      cases: count,
                      when: f.date(run.at),
                      passed: run.passed,
                      total: run.total,
                    })
                  : t('skills.testsetNeverRun', { cases: count })}
              </span>
            </div>
            {canEdit ? (
              <Button
                variant="secondary"
                aria-busy={running || undefined}
                onClick={() => !running && onRun()}
              >
                {running ? t('skills.testsetRunning') : t('skills.testRun')}
              </Button>
            ) : null}
          </div>
          <div aria-live="polite">
            {running ? (
              <span className="busy-note">
                <Spinner aria-hidden data-size="xs" />
                {t('skills.testsetRunningNote', { count: n })}
              </span>
            ) : null}
            {ranHere && result ? (
              <p className={failures ? 'skill-run-done failed' : 'skill-run-done'}>
                {previous
                  ? t('skills.testsetDonePrevious', {
                      passed: result.passed,
                      total: result.total,
                      before: previous.passed,
                      beforeTotal: previous.total,
                    })
                  : t('skills.testsetDone', { passed: result.passed, total: result.total })}
              </p>
            ) : null}
          </div>
          {stale ? (
            <Alert data-color="info" data-size="sm">
              {t('skills.testStale')}
            </Alert>
          ) : null}
          <ul className="plain-list skill-case-list" aria-label={t('skills.testCasesLabel')}>
            {cases.map((c, i) => {
              const r = result?.results.find((x) => x.case === i);
              const [label, color] = running
                ? ([t('skills.caseWaiting'), 'neutral'] as const)
                : r
                  ? r.passed
                    ? ([t('skills.testStatePassed'), 'success'] as const)
                    : ([t('skills.caseFailed'), 'danger'] as const)
                  : ([t('skills.testStateNotRun'), 'neutral'] as const);
              return (
                <li key={`${i}-${c.input}`}>
                  <span className="skill-case-name">
                    {c.input}
                    {c.type === 'criteria' ? null : (
                      <span className="case-source">{t(caseTypeLabels[c.type])}</span>
                    )}
                    {c.context ? (
                      <span className="case-source">{t('skills.testWithContext')}</span>
                    ) : null}
                    {c.dataset ? (
                      <span className="case-source">
                        {t('skills.testDataset', {
                          name: datasets.find((d) => d.id === c.dataset)?.name ?? c.dataset,
                        })}
                      </span>
                    ) : null}
                  </span>
                  <Tag data-size="sm" data-color={color}>
                    {label}
                  </Tag>
                  {canEdit ? (
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      className="skill-link-button"
                      aria-label={t('skills.testDeleteCase', { input: c.input })}
                      aria-disabled={busy || running || undefined}
                      onClick={() => !busy && !running && onDelete(i)}
                    >
                      {t('skills.delete')}
                    </Button>
                  ) : null}
                  {!running && r && !r.passed && r.reason ? (
                    <span className="skill-case-note">{r.reason}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {canEdit && failures > 0 && !running && !fix ? (
            <Button
              variant="secondary"
              data-size="sm"
              className="self-start"
              aria-disabled={busy || undefined}
              onClick={() => !busy && onFix()}
            >
              {t('skills.testFixAsk')}
            </Button>
          ) : null}
        </section>
      )}
      {fix ? <FixCard fix={fix} busy={busy} onApply={onApplyFix} onDiscard={onDiscardFix} /> : null}
      {canEdit && adding ? (
        <fieldset className="skill-new-case">
          <legend>{t('skills.testNew')}</legend>
          <Textfield
            label={t('skills.testNewIn')}
            data-size="sm"
            multiline
            rows={2}
            value={adding.input}
            onChange={(e) => setAdding({ ...adding, input: e.target.value, error: '' })}
          />
          <Textfield
            label={t('skills.testNewExpected')}
            data-size="sm"
            multiline
            rows={2}
            value={adding.expected}
            onChange={(e) => setAdding({ ...adding, expected: e.target.value, error: '' })}
          />
          <Field>
            <Label htmlFor="skill-case-type" data-size="sm">
              {t('skills.testColType')}
            </Label>
            <Select
              id="skill-case-type"
              data-size="sm"
              value={adding.type}
              onChange={(e) => setAdding({ ...adding, type: e.target.value as SkillCaseType })}
            >
              {caseTypeOptions.map(([value, label]) => (
                <Select.Option key={value} value={value}>
                  {t(label)}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <div className="full-row">
            <Textfield
              label={t('skills.testContext')}
              description={t('skills.testContextHelp')}
              data-size="sm"
              multiline
              rows={3}
              value={adding.context}
              onChange={(e) => setAdding({ ...adding, context: e.target.value })}
            />
          </div>
          <Field>
            <Label htmlFor="skill-case-dataset" data-size="sm">
              {t('skills.testDatasetOptional')}
            </Label>
            <Select
              id="skill-case-dataset"
              data-size="sm"
              value={adding.dataset}
              onChange={(e) => setAdding({ ...adding, dataset: e.target.value })}
            >
              <Select.Option value="">{t('skills.none')}</Select.Option>
              {datasets.map((d) => (
                <Select.Option key={d.id} value={d.id}>
                  {d.name}
                </Select.Option>
              ))}
            </Select>
          </Field>
          {adding.error ? (
            <ValidationMessage className="full-row">{adding.error}</ValidationMessage>
          ) : null}
          <div className="actions full-row">
            <Button variant="primary" data-size="sm" onClick={save}>
              {t('skills.add')}
            </Button>
            <Button variant="secondary" data-size="sm" onClick={() => setAdding(null)}>
              {t('skills.cancel')}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {canEdit && !adding && n > 0 ? (
        <Button variant="secondary" data-size="sm" className="self-start" onClick={startAdding}>
          {t('skills.testAdd')}
        </Button>
      ) : null}
    </div>
  );
};
