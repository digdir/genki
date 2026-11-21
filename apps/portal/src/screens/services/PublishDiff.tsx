import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState, type ReactNode } from 'react';
import { BackLink } from '../../components/BackLink';
import { BusyButton } from '../../components/BusyButton';
import { minimumReasonLength, reasonProblem } from '../../components/ReasonField';
import { useModelText } from '../../components/model-text';
import type { ServiceDefinition } from '../../data/service-definition';
import { datasetsOf } from '../../data/service-form';
import type { AsyncState } from '../../hooks';
import { useT } from '../../i18n';
import { perMillion } from '../../models';
import type { ModelPrice, Residency } from '../../types';
import { describeProblem } from '../service/publish';
import { changeLabel, changeText, guardName, type ChangeNames } from './setup-change-text';
import type { DraftChecks } from './setup-checks';
import { sentenceDiff, type DraftChange } from './setup-diff';
import './setup-layout.css';

export interface ModelFacts {
  name: string;
  residency?: Residency | undefined;
  price?: ModelPrice | null | undefined;
}

export type TestWarning = 'model' | 'draft' | undefined;

const KnownChecks = ({
  checks,
  onRetry,
}: {
  checks: AsyncState<DraftChecks | null>;
  onRetry: () => void;
}) => {
  const t = useT();
  if (checks.status === 'loading')
    return <Paragraph data-size="sm">{t('serviceDraft.checksRunning')}</Paragraph>;
  if (checks.status === 'error')
    return (
      <Alert data-color="danger" data-size="sm">
        <Paragraph data-size="sm">{t('serviceDraft.checksFailed')}</Paragraph>
        <Button variant="secondary" data-size="sm" onClick={onRetry}>
          {t('serviceDraft.checksRetry')}
        </Button>
      </Alert>
    );
  const found = checks.data;
  if (!found) return null;
  return (
    <>
      {found.problems.length ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Heading level={3} data-size="2xs">
            {t('serviceDraft.checksProblems')}
          </Heading>
          <ul className="bullets">
            {found.problems.map((p) => {
              const problem = describeProblem(p, t);
              return (
                <li key={`${p.path}-${p.message}`}>
                  <strong>{problem.section}:</strong> {problem.message}
                </li>
              );
            })}
          </ul>
        </Alert>
      ) : found.ready ? (
        <Alert data-color="success" data-size="sm">
          {t('serviceDraft.checksReady')}
        </Alert>
      ) : null}
      {found.hooksSkipped ? (
        <Alert data-color="info" data-size="sm">
          {t('serviceDraft.checksHooksSkipped')}
        </Alert>
      ) : null}
    </>
  );
};

export const PublishDiff = ({
  name,
  current,
  published,
  draft,
  changes,
  names,
  modelFacts,
  checks,
  onRetryChecks,
  testWarning,
  testHref,
  backHref,
  canPublish,
  blocked,
  blockedReason,
  children,
  onPublish,
}: {
  name: string;
  current: number;
  published: ServiceDefinition;
  draft: ServiceDefinition;
  changes: DraftChange[];
  names: ChangeNames;
  modelFacts: (id: string) => ModelFacts;
  checks: AsyncState<DraftChecks | null>;
  onRetryChecks: () => void;
  testWarning: TestWarning;
  testHref: string;
  backHref: string;
  canPublish: boolean;
  blocked: boolean;
  blockedReason?: string | undefined;
  children?: ReactNode;
  onPublish: (reason: string) => Promise<void>;
}) => {
  const t = useT();
  const f = useFormat();
  const text = useModelText();
  const next = current + 1;
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const labels = [...new Set(changes.map((c) => changeLabel(t, c)))];
  const instructions = changes.find((c) => c.topic === 'instructions');
  const modelChange = changes.find((c) => c.topic === 'model');
  const listed = changes.filter((c) => c.topic === 'dataset' || c.topic === 'guard');
  const others = changes.filter(
    (c) => !['instructions', 'model', 'dataset', 'guard'].includes(c.topic),
  );
  const parts = instructions
    ? sentenceDiff(instructions.before ?? '', instructions.after ?? '')
    : [];
  const added = parts.filter((p) => p.kind === 'added').length;
  const removed = parts.filter((p) => p.kind === 'removed').length;
  const kept = datasetsOf(draft.spec)
    .map((d) => d.dataset)
    .filter(
      (ref) =>
        datasetsOf(published.spec).some((d) => d.dataset === ref) &&
        !listed.some((c) => c.topic === 'dataset' && c.subject === ref),
    );
  const price = (p: ModelPrice | null | undefined, side: 'in' | 'out') =>
    p
      ? `${f.number(perMillion(p)[side === 'in' ? 'input' : 'output'], {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} kr`
      : t('common.notPriced');
  const where = (m: ModelFacts) =>
    m.residency ? text.where(m.residency) : t('setup.wordNotStated');
  const submit = async () => {
    const written = reason.trim();
    const problem = written ? reasonProblem(written, t, minimumReasonLength) : undefined;
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await onPublish(written || t('serviceDraft.defaultReason', { n: next }));
    } catch {
      setBusy(false);
    }
  };

  const tagFor = (kind: DraftChange['kind'] | 'same') =>
    kind === 'added' ? (
      <Tag data-size="sm" data-color="success">
        {t('serviceDraft.tagAdded')}
      </Tag>
    ) : kind === 'removed' ? (
      <Tag data-size="sm" data-color="danger">
        {t('serviceDraft.tagRemoved')}
      </Tag>
    ) : kind === 'changed' ? (
      <Tag data-size="sm" data-color="info">
        {t('serviceDraft.tagChanged')}
      </Tag>
    ) : (
      <Tag data-size="sm" data-color="neutral">
        {t('serviceDraft.tagUnchanged')}
      </Tag>
    );

  return (
    <div className="publish-diff stack">
      <header className="stack-xs">
        <BackLink label={t('serviceDraft.publishBack')} href={backHref} />
        <Heading level={1} data-size="md">
          {t('serviceDraft.publishHeading', { name, n: next })}
        </Heading>
        <Paragraph className="publish-diff-intro">
          {t('serviceDraft.publishIntro', { current })}
        </Paragraph>
      </header>

      <div className="tag-row">
        <Tag data-size="sm" data-color="info">
          {t('serviceDraft.changeCount', { count: changes.length })}
        </Tag>
        {labels.map((label) => (
          <Tag key={label} data-size="sm" data-color="neutral">
            {label}
          </Tag>
        ))}
      </div>
      {changes.length ? null : (
        <Paragraph>{t('serviceDraft.noChangesToPublish', { n: current })}</Paragraph>
      )}

      {instructions ? (
        <section aria-labelledby="diff-instructions" className="diff-block">
          <div className="diff-block-head">
            <Heading level={2} data-size="2xs" id="diff-instructions">
              {t('setupList.areaInstructions')}
            </Heading>
            <span className="meta">
              {[
                added ? t('serviceDraft.sentencesAdded', { count: added }) : '',
                removed ? t('serviceDraft.sentencesRemoved', { count: removed }) : '',
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
          </div>
          <div className="diff-block-body diff-sentences">
            {parts.map((part, i) =>
              part.kind === 'same' ? (
                <p key={i}>{part.text}</p>
              ) : part.kind === 'removed' ? (
                <p key={i} className="diff-removed">
                  <strong>{t('serviceDraft.removedLabel')}</strong> <del>{part.text}</del>
                </p>
              ) : (
                <p key={i} className="diff-added">
                  <strong>{t('serviceDraft.addedLabel')}</strong> <ins>{part.text}</ins>
                </p>
              ),
            )}
          </div>
        </section>
      ) : null}

      {modelChange ? (
        <section aria-labelledby="diff-model" className="diff-block">
          <div className="diff-block-head">
            <Heading level={2} data-size="2xs" id="diff-model">
              {t('setupList.areaModel')}
            </Heading>
          </div>
          <div className="diff-table-wrap">
            {(() => {
              const was = modelFacts(modelChange.before ?? '');
              const now = modelFacts(modelChange.after ?? '');
              const row = (label: string, a: string, b: string, strong = false) => (
                <tr>
                  <th scope="row">{label}</th>
                  <td>{strong ? <del>{a}</del> : a}</td>
                  <td>
                    {strong ? (
                      <ins>{b}</ins>
                    ) : a === b ? (
                      t('serviceDraft.unchanged', { value: b })
                    ) : (
                      b
                    )}
                  </td>
                </tr>
              );
              return (
                <table className="diff-table">
                  <thead>
                    <tr>
                      <td />
                      <th scope="col">{t('serviceDraft.versionLive', { n: current })}</th>
                      <th scope="col">{t('serviceDraft.versionDraft', { n: next })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row(t('serviceDraft.rowModel'), was.name, now.name, true)}
                    {row(t('serviceDraft.rowResidency'), where(was), where(now))}
                    {row(
                      t('serviceDraft.rowPriceIn'),
                      price(was.price, 'in'),
                      price(now.price, 'in'),
                    )}
                    {row(
                      t('serviceDraft.rowPriceOut'),
                      price(was.price, 'out'),
                      price(now.price, 'out'),
                    )}
                  </tbody>
                </table>
              );
            })()}
          </div>
        </section>
      ) : null}

      {listed.length ? (
        <section aria-labelledby="diff-lists" className="diff-block">
          <div className="diff-block-head">
            <Heading level={2} data-size="2xs" id="diff-lists">
              {t('serviceDraft.sourcesAndGuards')}
            </Heading>
          </div>
          <ul className="diff-list">
            {listed
              .filter((c) => c.topic === 'dataset')
              .map((c) => (
                <li key={`d-${c.subject}`}>
                  {tagFor(c.kind)}
                  <span>
                    {t('serviceDraft.datasetItem', { name: names.dataset(c.subject ?? '') })}
                  </span>
                </li>
              ))}
            {kept.map((ref) => (
              <li key={`k-${ref}`}>
                {tagFor('same')}
                <span>{t('serviceDraft.datasetItem', { name: names.dataset(ref) })}</span>
              </li>
            ))}
            {listed
              .filter((c) => c.topic === 'guard')
              .map((c) => (
                <li key={`g-${c.subject}`}>
                  {tagFor(c.kind)}
                  <span>
                    {t('serviceDraft.guardItem', { name: guardName(t, c.subject ?? '') })}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {others.length ? (
        <section aria-labelledby="diff-other" className="diff-block">
          <div className="diff-block-head">
            <Heading level={2} data-size="2xs" id="diff-other">
              {t('serviceDraft.otherChanges')}
            </Heading>
          </div>
          <ul className="diff-list">
            {others.map((c, i) => (
              <li key={`${c.topic}-${c.subject ?? ''}-${i}`}>
                {tagFor(c.kind)}
                <span>
                  <span className="meta">{changeLabel(t, c)}:</span> {changeText(t, c, names)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="diff-checks" className="stack-xs">
        <Heading level={2} data-size="2xs" id="diff-checks">
          {t('serviceDraft.checksHeading')}
        </Heading>
        <KnownChecks checks={checks} onRetry={onRetryChecks} />
      </section>

      {testWarning ? (
        <section aria-labelledby="diff-test" className="diff-warning">
          <div className="stack-xs">
            <Heading level={2} data-size="2xs" id="diff-test">
              {t('serviceDraft.testNotRun')}
            </Heading>
            <span>
              {testWarning === 'model'
                ? t('serviceDraft.testNotRunModel')
                : t('serviceDraft.testNotRunText')}
            </span>
          </div>
          <Button asChild variant="secondary" data-size="sm">
            <a href={testHref}>{t('serviceDraft.runTestSet')}</a>
          </Button>
        </section>
      ) : null}

      {children}

      {canPublish ? (
        <>
          <Field className="publish-diff-reason">
            <Label htmlFor="publish-reason">
              {t('serviceDraft.reasonLabel')}{' '}
              <span className="meta">{t('serviceDraft.reasonOptional')}</span>
            </Label>
            <Field.Description>{t('serviceDraft.reasonHelp', { n: next })}</Field.Description>
            <Textarea
              id="publish-reason"
              rows={3}
              value={reason}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            {error ? <ValidationMessage>{error}</ValidationMessage> : null}
          </Field>
          {blockedReason ? (
            <Paragraph data-size="sm" className="meta" role="status">
              {blockedReason}
            </Paragraph>
          ) : null}
          <div className="actions publish-diff-actions">
            <BusyButton
              variant="primary"
              busy={busy}
              busyLabel={t('serviceDraft.publishing')}
              aria-disabled={blocked || undefined}
              onClick={() => !blocked && void submit()}
            >
              {t('serviceDraft.publishVersion')}
            </BusyButton>
            <Button asChild variant="secondary">
              <a href={backHref}>{t('serviceDraft.keepEditing')}</a>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
};
