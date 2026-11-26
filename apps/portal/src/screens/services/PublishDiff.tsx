import {
  Alert,
  Button,
  Checkbox,
  Field,
  Fieldset,
  Heading,
  Label,
  Link,
  Paragraph,
  Radio,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BackLink } from '../../components/BackLink';
import { BusyButton } from '../../components/BusyButton';
import { minimumReasonLength, reasonProblem } from '../../components/ReasonField';
import type { ServiceDefinition } from '../../data/service-definition';
import type { AsyncState } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { definitionYaml } from '../service/definition';
import { describeProblem } from '../service/publish';
import { changedLines, LineDiff } from '../service/VersionDiff';
import { changeLabel, changeText, type ChangeNames } from './setup-change-text';
import type { DraftChecks } from './setup-checks';
import type { DraftChange } from './setup-diff';
import type { NewVariant, VariantChoice } from './publish-choices';
import './setup-layout.css';

export type TestWarning = 'model' | 'draft' | undefined;

export type QualityState = 'met' | 'stale' | 'none' | 'unknown' | 'checking';

const riskKeys: Record<string, PlainKey> = {
  minimal: 'setup.riskMinimal',
  limited: 'setup.riskLimited',
  high: 'setup.riskHigh',
};

export interface EditionSummaries {
  before: Record<string, string>;
  after: Record<string, string>;
}

const instructionTopics = new Set(['instructions', 'examples', 'languages']);

const sides = (
  t: T,
  c: DraftChange,
  names: ChangeNames,
  summaries: EditionSummaries | undefined,
): [string, string] => {
  const key = instructionTopics.has(c.topic) ? 'instructions' : c.area;
  const before = summaries?.before[key];
  const after = summaries?.after[key];
  if (c.topic === 'model' || c.topic === 'fallback')
    return [c.before ? names.model(c.before) : '', c.after ? names.model(c.after) : ''];
  if (c.topic === 'name') return [c.before ?? '', c.after ?? ''];
  if (c.topic === 'riskClass') {
    const label = (v: string | undefined) => (v ? (riskKeys[v] ? t(riskKeys[v]) : v) : '');
    return [label(c.before), label(c.after)];
  }
  if (before !== undefined && after !== undefined && before !== after) return [before, after];
  if (c.topic === 'dataset' && c.kind === 'removed')
    return [names.dataset(c.subject ?? ''), changeText(t, c, names)];
  return ['', changeText(t, c, names)];
};

const rowsOf = (
  t: T,
  changes: DraftChange[],
  names: ChangeNames,
  summaries: EditionSummaries | undefined,
) => {
  const seen = new Set<string>();
  return changes.flatMap((c) => {
    const label = changeLabel(t, c);
    const [before, after] = sides(t, c, names, summaries);
    const key = `${label}|${before}|${after}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, label, before, after }];
  });
};

const ProblemChecks = ({
  checks,
  onRetry,
}: {
  checks: AsyncState<DraftChecks | null>;
  onRetry: () => void;
}) => {
  const t = useT();
  if (checks.status === 'error')
    return (
      <Alert data-color="danger" data-size="sm">
        <Paragraph data-size="sm">{t('serviceDraft.checksFailed')}</Paragraph>
        <Button variant="secondary" data-size="sm" onClick={onRetry}>
          {t('serviceDraft.checksRetry')}
        </Button>
      </Alert>
    );
  const problems = checks.status === 'ready' ? (checks.data?.problems ?? []) : [];
  const skipped = checks.status === 'ready' && checks.data?.hooksSkipped;
  if (!problems.length)
    return skipped ? (
      <Paragraph data-size="sm" className="meta">
        {t('serviceDraft.checksHooksSkipped')}
      </Paragraph>
    ) : null;
  return (
    <Alert data-color="danger" data-size="sm" role="alert">
      <Heading level={2} data-size="2xs">
        {t('serviceDraft.checksProblems')}
      </Heading>
      <ul className="bullets">
        {problems.map((p) => {
          const problem = describeProblem(p, t);
          return (
            <li key={`${p.path}-${p.message}`}>
              <strong>{problem.section}:</strong> {problem.message}
            </li>
          );
        })}
      </ul>
    </Alert>
  );
};

export const PublishDiff = ({
  name,
  published,
  draft,
  changes,
  names,
  summaries,
  variants = [],
  choices = {},
  onChoose,
  variantName,
  standardName,
  checks,
  onRetryChecks,
  quality,
  qualityBelow,
  testHref,
  backHref,
  canPublish,
  blocked,
  blockedReason,
  riskLevel,
  risk,
  guards,
  children,
  onPublish,
}: {
  name: string;
  published: ServiceDefinition;
  draft: ServiceDefinition;
  changes: DraftChange[];
  names: ChangeNames;
  summaries?: EditionSummaries | undefined;
  variants?: NewVariant[];
  choices?: Record<string, VariantChoice>;
  onChoose?: (id: string, choice: VariantChoice) => void;
  variantName?: (variant: NewVariant) => string;
  standardName?: string;
  checks: AsyncState<DraftChecks | null>;
  onRetryChecks: () => void;
  quality: QualityState;
  qualityBelow?: string | undefined;
  testHref: string;
  backHref: string;
  canPublish: boolean;
  blocked: boolean;
  blockedReason?: string | undefined;
  riskLevel?: string | undefined;
  /** The risk level and the safety rules, set here as on the first publish page. */
  risk?: ReactNode;
  guards?: ReactNode;
  children?: ReactNode;
  onPublish: (reason: string, stampRisk: boolean) => Promise<void>;
}) => {
  const t = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState(false);
  const [riskTicked, setRiskTicked] = useState(false);
  const [riskError, setRiskError] = useState<string>();
  const diff = useMemo(
    () =>
      lines
        ? changedLines(
            definitionYaml(published as unknown as Record<string, unknown>),
            definitionYaml(draft as unknown as Record<string, unknown>),
          ).rows
        : [],
    [lines, published, draft],
  );
  const submit = async () => {
    const written = reason.trim();
    const problem = written ? reasonProblem(written, t, minimumReasonLength) : undefined;
    setError(problem);
    const riskMissing = riskLevel !== undefined && !riskTicked;
    setRiskError(riskMissing ? t('service.required') : undefined);
    if (problem || riskMissing) return;
    setBusy(true);
    try {
      await onPublish(written || t('edition.defaultReason'), riskLevel !== undefined);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="publish-diff stack">
      <header className="stack-xs">
        <BackLink label={t('edition.back')} href={backHref} />
        <Heading level={1} data-size="md">
          {t('edition.publishTitle', { name })}
        </Heading>
        <Paragraph className="meta">{t('edition.publishLead')}</Paragraph>
      </header>

      <section aria-labelledby="publish-changes" className="stack-xs">
        <div className="row-between">
          <Heading level={2} data-size="xs" id="publish-changes">
            {t('edition.changeCount', { count: changes.length })}
          </Heading>
          {changes.length ? (
            <Link asChild>
              <button
                type="button"
                className="link-button"
                aria-expanded={lines}
                onClick={() => setLines((open) => !open)}
              >
                {t('edition.showLines')}
              </button>
            </Link>
          ) : null}
        </div>
        {changes.length ? (
          <div className="diff-table-wrap">
            <table className="publish-table">
              <thead>
                <tr>
                  <td />
                  <th scope="col">{t('edition.colInUseNow')}</th>
                  <th scope="col">{t('edition.colAfter')}</th>
                </tr>
              </thead>
              <tbody>
                {rowsOf(t, changes, names, summaries).map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td className="meta">{row.before}</td>
                    <td>{row.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Paragraph>{t('edition.noChanges')}</Paragraph>
        )}
        {lines ? <LineDiff rows={diff} /> : null}
      </section>

      {variants.map((v) => (
        <Fieldset key={v.id} data-size="sm">
          <Fieldset.Legend>
            {t('edition.newVariant', { name: variantName?.(v) ?? v.id })}
          </Fieldset.Legend>
          {(['hidden', 'choosable', 'replaces'] as const).map((choice) => (
            <Radio
              key={choice}
              name={`variant-${v.id}`}
              value={choice}
              checked={choices[v.id] === choice}
              onChange={() => onChoose?.(v.id, choice)}
              label={
                choice === 'hidden'
                  ? t('edition.variantHidden')
                  : choice === 'choosable'
                    ? t('edition.variantChoosable')
                    : t('edition.variantReplaces', {
                        name: standardName ?? t('edition.variantStandard'),
                      })
              }
            />
          ))}
        </Fieldset>
      ))}

      <ProblemChecks checks={checks} onRetry={onRetryChecks} />

      <section aria-labelledby="publish-quality" className="stack-xs">
        <Heading level={2} data-size="xs" id="publish-quality">
          {t('edition.qualityHeading')}
        </Heading>
        {quality === 'stale' || qualityBelow ? (
          <div role="status" className="diff-warning publish-quality">
            <span>
              {[qualityBelow, quality === 'stale' ? t('edition.qualityStale') : '']
                .filter(Boolean)
                .join(' ')}
            </span>
            <Button asChild variant="secondary" data-size="sm">
              <a href={testHref}>{t('edition.runTestSet')}</a>
            </Button>
          </div>
        ) : quality === 'none' ? (
          <Paragraph>
            {t('edition.qualityNone')} <Link href={testHref}>{t('services.makeTestSet')}</Link>
          </Paragraph>
        ) : quality === 'unknown' ? (
          <Paragraph>{t('edition.qualityUnknown')}</Paragraph>
        ) : quality === 'met' ? (
          <Paragraph>{t('edition.qualityMet')}</Paragraph>
        ) : null}
      </section>

      {risk ? (
        <section aria-labelledby="publish-risk" className="stack-sm">
          <div className="stack-xs">
            <Heading level={2} data-size="xs" id="publish-risk">
              {t('setupList.areaRisk')}
            </Heading>
            <Paragraph>{t('setupList.helpRisk')}</Paragraph>
          </div>
          {risk}
        </section>
      ) : null}

      {guards ? (
        <section aria-labelledby="publish-guards" className="stack-sm">
          <div className="stack-xs">
            <Heading level={2} data-size="xs" id="publish-guards">
              {t('setupList.areaGuards')}
            </Heading>
            <Paragraph>{t('setupList.helpGuards')}</Paragraph>
          </div>
          {guards}
        </section>
      ) : null}

      {children}

      {canPublish ? (
        <>
          {riskLevel !== undefined ? (
            <Checkbox
              label={t('edition.riskConfirm', { level: riskLevel })}
              checked={riskTicked}
              onChange={(e) => {
                setRiskTicked(e.target.checked);
                setRiskError(undefined);
              }}
              error={riskError}
              aria-required
            />
          ) : null}
          <Field className="publish-diff-reason">
            <Label htmlFor="publish-reason">
              {t('edition.reasonLabel')} <span className="meta">{t('edition.reasonOptional')}</span>
            </Label>
            <Textarea
              id="publish-reason"
              rows={2}
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
              {t('edition.publish')}
            </BusyButton>
            <Button asChild variant="secondary">
              <a href={backHref}>{t('edition.cancel')}</a>
            </Button>
            <span className="meta">{t('edition.undoLater')}</span>
          </div>
        </>
      ) : null}
    </div>
  );
};
