import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { SkillCase, SkillCaseType, SkillFix, SkillTestRun } from '../../api/skills';
import type { ApiCallPreview } from '../../components/ApiCall';
import { ApiCallLink } from '../../components/ApiCall';
import { useT } from '../../i18n';
import { caseTypeLabels, caseTypeOptions, expectedText, percent } from '../../data/skills';
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
  threshold: number;
  canEdit: boolean;
  busy: boolean;
  hasExamples: boolean;
  runCall: ApiCallPreview;
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
  threshold,
  canEdit,
  busy,
  hasExamples,
  runCall,
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
  const [adding, setAdding] = useState<Adding | null>(null);
  const gate = Math.round(threshold * 100);
  const n = cases.length;
  const result = fresh ? run : undefined;
  const pct = result ? percent(result.passed, result.total) : 0;
  const failures = result
    ? result.results
        .filter((r) => !r.passed)
        .map((r) => ({ input: cases[r.case]?.input ?? '', reason: r.reason ?? '' }))
    : [];
  const stale = !!run && !fresh && !running;

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
    <div className="stack-md">
      <div className="skill-test-bar">
        {result && !running ? (
          <Tag data-color={pct >= gate ? 'success' : 'danger'}>
            {t('skills.testPassed', {
              passed: result.passed,
              total: result.total,
              percent: pct,
            })}
          </Tag>
        ) : null}
        <span className="subtle">{t('skills.testRequirement', { percent: gate })}</span>
        <span className="spacer" />
        {canEdit ? (
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={running || n === 0 || undefined}
            onClick={() => !running && n > 0 && onRun()}
          >
            {t('skills.testRun')}
          </Button>
        ) : null}
        <ApiCallLink call={runCall} />
      </div>
      <span role="status" className="busy-note">
        {running ? (
          <>
            <Spinner aria-hidden data-size="xs" />
            {t('skills.testRunning', { count: n })}
          </>
        ) : null}
      </span>
      {stale ? (
        <Alert data-color="info" data-size="sm">
          {t('skills.testStale')}
        </Alert>
      ) : null}
      {failures.length > 0 && !running ? (
        <Alert data-color="danger">
          <Heading level={2} data-size="2xs">
            {t('skills.testFailedHeading', { count: failures.length })}
          </Heading>
          <ul className="bullets skill-failures">
            {failures.map((f) => (
              <li key={f.input}>
                <strong>{f.input}:</strong> {f.reason}
              </li>
            ))}
          </ul>
          {canEdit && !fix ? (
            <Button
              variant="secondary"
              data-size="sm"
              aria-disabled={busy || undefined}
              onClick={() => !busy && onFix()}
            >
              {t('skills.testFixAsk')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {fix ? <FixCard fix={fix} busy={busy} onApply={onApplyFix} onDiscard={onDiscardFix} /> : null}
      {n === 0 ? (
        <div className="skill-empty">
          <span className="skill-empty-title">{t('skills.testEmptyTitle')}</span>
          <span className="subtle">{t('skills.testEmptyHelp')}</span>
          {canEdit ? (
            <Button
              variant="secondary"
              data-size="sm"
              aria-disabled={!hasExamples || undefined}
              onClick={() => hasExamples && onFromExamples()}
            >
              {t('skills.testFromExamples')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label={t('skills.testCasesLabel')}
        >
          <Table data-size="sm" className="skill-cases">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('skills.testColIn')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.testColExpected')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.testColType')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.testColLast')}</TableHeaderCell>
                {canEdit ? (
                  <TableHeaderCell scope="col">
                    <span className="visually-hidden">{t('skills.delete')}</span>
                  </TableHeaderCell>
                ) : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {cases.map((c, i) => {
                const r = result?.results.find((x) => x.case === i);
                const state = running
                  ? t('skills.testStateRunning')
                  : r
                    ? r.passed
                      ? t('skills.testStatePassed')
                      : t('skills.testStateFailed')
                    : t('skills.testStateNotRun');
                const failed = !running && r && !r.passed;
                return (
                  <TableRow key={`${i}-${c.input}`} className={failed ? 'case-failed' : undefined}>
                    <th scope="row" className="case-input">
                      {c.input}
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
                    </th>
                    <TableCell>{expectedText(c.expected)}</TableCell>
                    <TableCell>{t(caseTypeLabels[c.type])}</TableCell>
                    <TableCell>
                      <span className="case-state">
                        <Tag
                          data-size="sm"
                          data-color={!running && r ? (r.passed ? 'success' : 'danger') : 'neutral'}
                        >
                          {state}
                        </Tag>
                        {failed && r.reason ? <span className="case-why">{r.reason}</span> : null}
                      </span>
                    </TableCell>
                    {canEdit ? (
                      <TableCell>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('skills.testDeleteCase', { input: c.input })}
                          aria-disabled={busy || running || undefined}
                          onClick={() => !busy && !running && onDelete(i)}
                        >
                          {t('skills.delete')}
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
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
      {canEdit && !adding ? (
        <Button
          variant="secondary"
          data-size="sm"
          className="self-start"
          onClick={() =>
            setAdding({
              input: '',
              expected: '',
              type: 'criteria',
              context: '',
              dataset: '',
              error: '',
            })
          }
        >
          {t('skills.testAdd')}
        </Button>
      ) : null}
    </div>
  );
};
