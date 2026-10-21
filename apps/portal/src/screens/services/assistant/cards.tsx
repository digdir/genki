import {
  Alert,
  Button,
  Chip,
  Heading,
  Link,
  Paragraph,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { Fragment, useId, useState } from 'react';
import type {
  AssistantPolicy,
  AssistantProposal,
  AssistantRejected,
  ProposalDecision,
  ProposalMapping,
} from '../../../api/assistant';
import { ChangeLogged } from '../../../components/ChangeLogged';
import { ReasonField, reasonProblem } from '../../../components/ReasonField';
import { StepList } from '../../../components/StepList';
import { useFormat } from '@genai/i18n/react';
import { useT, type PlainKey, type T } from '../../../i18n';
import type { Availability, TurnEntry } from './useAssistant';

const otherKey = '__other';

const numberWords = [
  'assistant.n2',
  'assistant.n3',
  'assistant.n4',
  'assistant.n5',
  'assistant.n6',
  'assistant.n7',
  'assistant.n8',
  'assistant.n9',
  'assistant.n10',
] as const satisfies readonly PlainKey[];

const levelKeys = [
  'assistant.level1',
  'assistant.level2',
  'assistant.level3',
  'assistant.level4',
] as const satisfies readonly PlainKey[];

export const AssistantBanner = ({
  availability,
  tenantName,
  onRetry,
}: {
  availability: Availability;
  tenantName: string;
  onRetry: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  if (availability.kind === 'ready') return null;
  return (
    <div className="assistant-banner">
      {availability.kind === 'unavailable' ? (
        <Alert data-color="warning" data-size="sm">
          <Heading level={3} data-size="2xs">
            {availability.reason === 'api'
              ? t('assistant.bannerApiTitle')
              : t('assistant.bannerUnavailableTitle')}
          </Heading>
          <Paragraph data-size="sm">
            {availability.reason === 'not_published'
              ? t('assistant.bannerNotPublished')
              : availability.reason === 'no_model'
                ? t('assistant.bannerNoModel', { tenant: tenantName })
                : availability.reason === 'model_failed'
                  ? t('assistant.bannerModelFailed')
                  : availability.reason === 'empty_result'
                    ? t('assistant.bannerEmptyResult')
                    : availability.reason === 'api'
                      ? t('assistant.bannerApi')
                      : (availability.message ?? t('assistant.bannerUnavailable'))}
          </Paragraph>
          {availability.task && (
            <Paragraph data-size="sm">
              {t('assistant.bannerTask', { task: availability.task })}{' '}
              <Link href={`#/log/${encodeURIComponent(availability.task)}`}>
                {t('assistant.bannerTaskLink')}
              </Link>
            </Paragraph>
          )}
          {availability.reason === 'no_model' && (
            <Link href="#/settings">{t('assistant.bannerDisabledLink')}</Link>
          )}
          <Button variant="secondary" data-size="sm" onClick={onRetry}>
            {t('assistant.retry')}
          </Button>
        </Alert>
      ) : availability.kind === 'refused' ? (
        <Alert data-color="info" data-size="sm">
          <Heading level={3} data-size="2xs">
            {t('assistant.bannerRefusedTitle')}
          </Heading>
          <Paragraph data-size="sm">{availability.message}</Paragraph>
        </Alert>
      ) : availability.kind === 'disabled' ? (
        <Alert data-color="info" data-size="sm">
          <Heading level={3} data-size="2xs">
            {t('assistant.bannerDisabledTitle')}
          </Heading>
          <Paragraph data-size="sm">
            {t('assistant.bannerDisabled', { tenant: tenantName })}
          </Paragraph>
          <Link href="#/settings">{t('assistant.bannerDisabledLink')}</Link>
        </Alert>
      ) : (
        <Alert data-color="warning" data-size="sm">
          <Heading level={3} data-size="2xs">
            {t('assistant.bannerBudgetTitle')}
          </Heading>
          <Paragraph data-size="sm">
            {t('assistant.bannerBudget', {
              tokens: f.number(availability.usage.dailyBudget),
              tenant: tenantName,
            })}
          </Paragraph>
          <Link href="#/usage">{t('assistant.bannerBudgetLink')}</Link>
        </Alert>
      )}
    </div>
  );
};

export const Questions = ({
  entry,
  onSend,
}: {
  entry: TurnEntry;
  onSend: (answers: Record<string, string>) => void;
}) => {
  const t = useT();
  const id = useId();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const done = !!entry.answered;
  const answers = Object.fromEntries(
    entry.questions.map((q) => [
      q.id,
      picked[q.id] === otherKey ? (other[q.id] ?? '').trim() : (picked[q.id] ?? ''),
    ]),
  );
  const complete = entry.questions.every((q) => answers[q.id]);
  const count = entry.questions.length;
  const hint = complete
    ? ''
    : count === 1
      ? t('assistant.answerOne')
      : t('assistant.answerAll', {
          words: numberWords[count - 2] ? t(numberWords[count - 2] as PlainKey) : String(count),
        });
  return (
    <>
      <ol className="ax-questions">
        {entry.questions.map((q, i) => {
          const label = `${id}-q${i}`;
          return (
            <li key={q.id}>
              <span id={label} className="ax-question-label">
                {i + 1}. {q.label}
              </span>
              <div role="group" aria-labelledby={label} className="ax-chips">
                {[...q.options, ...(q.allowOther ? [otherKey] : [])].map((o) => (
                  <Chip.Button
                    key={o}
                    data-size="sm"
                    aria-pressed={picked[q.id] === o}
                    aria-disabled={done || undefined}
                    onClick={() => !done && setPicked((p) => ({ ...p, [q.id]: o }))}
                  >
                    {o === otherKey ? t('assistant.other') : o}
                  </Chip.Button>
                ))}
              </div>
              {picked[q.id] === otherKey ? (
                <Textfield
                  data-size="sm"
                  label={t('assistant.otherLabel')}
                  value={other[q.id] ?? ''}
                  readOnly={done}
                  onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {done ? null : (
        <div className="ax-row">
          <Button
            variant="primary"
            data-size="sm"
            aria-disabled={!complete || undefined}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onClick={() => complete && onSend(answers)}
          >
            {t('assistant.sendAnswers')}
          </Button>
          {hint ? (
            <span id={`${id}-hint`} className="meta">
              {hint}
            </span>
          ) : null}
        </div>
      )}
    </>
  );
};

export const RejectedCard = ({
  rejected,
  retrying,
}: {
  rejected: AssistantRejected;
  retrying: boolean;
}) => {
  const t = useT();
  return (
    <div className="ax-card" data-tone="danger">
      <Tag data-size="sm" data-color="danger">
        {t('assistant.rejectedTag')}
      </Tag>
      <dl className="ax-dl">
        <dt>{t('assistant.rejectedAttempted')}</dt>
        <dd>{rejected.attempted}</dd>
        <dt>{t('assistant.rejectedWhy')}</dt>
        <dd>{rejected.reason}</dd>
        <dt>{t('assistant.rejectedCode')}</dt>
        <dd>{rejected.code}</dd>
      </dl>
      {retrying ? (
        <span role="status" className="ax-spinner-line">
          <Spinner aria-hidden data-size="xs" />
          {t('assistant.rejectedRetrying')}
        </span>
      ) : null}
    </div>
  );
};

export const PolicyCard = ({
  policy,
  tenantName,
  alternativeDone,
  onAlternative,
}: {
  policy: AssistantPolicy;
  tenantName: string;
  alternativeDone: boolean;
  onAlternative: (text: string) => void;
}) => {
  const t = useT();
  return (
    <>
      <div className="ax-card" data-tone="warning">
        <Tag data-size="sm" data-color="warning">
          {t('assistant.policyTag', { tenant: tenantName })}
        </Tag>
        <dl className="ax-dl">
          <dt>{t('assistant.policyRule')}</dt>
          <dd>{policy.rule}</dd>
          <dt>{t('assistant.policyOwner')}</dt>
          <dd>{policy.ownedBy}</dd>
        </dl>
        {policy.link ? (
          <Link href={policy.link} data-size="sm">
            {t('assistant.policyLink')}
          </Link>
        ) : null}
      </div>
      {policy.alternative && !alternativeDone ? (
        <div className="ax-row">
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => onAlternative(policy.alternative ?? '')}
          >
            {policy.alternative.replace(/\.$/, '')}
          </Button>
        </div>
      ) : null}
    </>
  );
};

const levelColor = ['success', 'info', 'warning', 'danger'] as const;

const Ladder = ({ level }: { level: number }) => {
  const t = useT();
  const id = useId();
  return (
    <div className="stack-xs">
      <span id={id} className="ax-ladder-head">
        {t('assistant.ladderHead')}
      </span>
      <ol aria-labelledby={id} className="ax-ladder">
        {levelKeys.map((key, i) => (
          <li key={key} aria-current={i + 1 === level ? 'step' : undefined}>
            <span aria-hidden="true" className="ax-ladder-n">
              {i + 1}.
            </span>
            {t(key)}
          </li>
        ))}
      </ol>
    </div>
  );
};

const LevelTag = ({ level }: { level: number }) => {
  const t = useT();
  const key = levelKeys[level - 1];
  return (
    <Tag data-size="sm" data-color={levelColor[level - 1] ?? 'info'}>
      {t('assistant.levelTag', { level, name: key ? t(key) : '' })}
    </Tag>
  );
};

export const patchText = (proposal: AssistantProposal) =>
  (proposal.patch ?? []).map((op) => {
    const value = op.value === undefined ? '' : JSON.stringify(op.value);
    return `${op.op} ${op.path}${value ? ` = ${value.length > 160 ? `${value.slice(0, 160)}…` : value}` : ''}`;
  });

export const ChangeProposalCard = ({
  proposal,
  applied,
  undone,
  onShow,
  onUndo,
}: {
  proposal: AssistantProposal;
  applied: boolean;
  undone: boolean;
  onShow: () => void;
  onUndo: () => void;
}) => {
  const t = useT();
  const [details, setDetails] = useState(false);
  if (!proposal.validation.ok)
    return (
      <div className="ax-card" data-tone="danger">
        <Tag data-size="sm" data-color="danger">
          {t('assistant.rejectedTag')}
        </Tag>
        <span className="ax-card-title">{proposal.title}</span>
        <ul className="ax-patch">
          {(proposal.validation.errors ?? []).map((e) => (
            <li key={`${e.path}-${e.message}`}>
              {e.path ? <code>{e.path}</code> : null} {e.message}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="ax-card">
      <Ladder level={1} />
      <div className="ax-row">
        <LevelTag level={1} />
        <Tag data-size="sm" data-color={undone ? 'neutral' : 'accent'}>
          {undone ? t('assistant.undoneTag') : t('assistant.changeTag')}
        </Tag>
      </div>
      <span className={undone ? 'change-title undone' : 'change-title'}>{proposal.title}</span>
      <span className="meta">{proposal.detail}</span>
      {proposal.flows?.length ? (
        <span className="meta">
          {t('assistant.newFlows', {
            ids: proposal.flows
              .map((f) => String((f.metadata as { id?: unknown } | undefined)?.id ?? ''))
              .join(', '),
          })}
        </span>
      ) : null}
      {details ? (
        <ul className="ax-patch" aria-label={t('assistant.patchLabel', { title: proposal.title })}>
          {patchText(proposal).map((line) => (
            <li key={line}>
              <code>{line}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="change-actions">
        <Button
          variant="tertiary"
          data-size="sm"
          aria-label={t('assistant.showChangeLabel', { title: proposal.title })}
          {...(applied ? {} : { 'aria-expanded': details })}
          onClick={() => (applied ? onShow() : setDetails((d) => !d))}
        >
          {t('assistant.showChange')}
        </Button>
        {applied ? (
          <Button
            variant="tertiary"
            data-size="sm"
            aria-label={t(undone ? 'assistant.redoLabel' : 'assistant.undoLabel', {
              title: proposal.title,
            })}
            onClick={onUndo}
          >
            {t(undone ? 'assistant.redo' : 'assistant.undo')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const becomesText = {
  document: 'assistant.becomesDocument',
  field: 'assistant.becomesField',
  attachment: 'assistant.becomesAttachment',
  excluded: 'assistant.becomesExcluded',
} as const satisfies Record<ProposalMapping['becomes'], PlainKey>;

type Decision = { kind: 'approved' | 'sent' | 'rejected'; result: ProposalDecision } | undefined;

const platformSteps = (rejected: boolean, t: T) => [
  t('assistant.stepSent'),
  t('assistant.stepReview'),
  t(rejected ? 'assistant.stepRejected' : 'assistant.stepPlanned'),
];

const statusStep = { sent: 1, under_review: 2, planned: 3, rejected: 3 } as const;

export interface PlatformCardProps {
  proposal: AssistantProposal;
  tenantName: string;
  canApprove: boolean;
  alternative?: AssistantProposal | undefined;
  alternativeUsed: boolean;
  onAlternative: () => void;
  decide: (action: 'approve' | 'reject' | 'send', reason: string) => Promise<ProposalDecision>;
}

export const PlatformCard = ({
  proposal,
  tenantName,
  canApprove,
  alternative,
  alternativeUsed,
  onAlternative,
  decide,
}: PlatformCardProps) => {
  const t = useT();
  const [step, setStep] = useState<'idle' | 'approve' | 'reject'>('idle');
  const [reason, setReason] = useState('');
  const [showError, setShowError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [decision, setDecision] = useState<Decision>();
  const level = proposal.level;
  const building = level === 3;
  const approveLabel = t(canApprove ? 'assistant.approve' : 'assistant.sendForApproval');
  const confirmLabel =
    step === 'reject'
      ? t('assistant.confirmReject')
      : canApprove
        ? t('assistant.confirmApprove')
        : t('assistant.confirmSend');
  const confirm = async () => {
    if (reasonProblem(reason, t)) {
      setShowError(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    const action = step === 'reject' ? 'reject' : canApprove ? 'approve' : 'send';
    try {
      const result = await decide(action, reason.trim());
      setDecision({
        kind: action === 'approve' ? 'approved' : action === 'send' ? 'sent' : 'rejected',
        result,
      });
      setStep('idle');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const change = proposal.platformChange;
  return (
    <div className="ax-card">
      <Ladder level={level} />
      <LevelTag level={level} />
      <span className="ax-card-title">{proposal.title}</span>
      <span className="ax-card-text">{proposal.detail}</span>
      {proposal.mapping?.length ? (
        <div
          className="ax-table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t('assistant.mappingLabel')}
        >
          <Table data-size="sm">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('assistant.mappingTable')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('assistant.mappingBecomes')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('assistant.mappingFields')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {proposal.mapping.map((m) => (
                <TableRow key={m.table}>
                  <TableHeaderCell scope="row">{m.table}</TableHeaderCell>
                  <TableCell>{t(becomesText[m.becomes])}</TableCell>
                  <TableCell>
                    {m.becomes === 'excluded' ? (m.reason ?? '') : (m.fields ?? []).join(', ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {proposal.permissions?.length ? (
        <div className="stack-xs">
          <span className="ax-subhead">{t('assistant.permissions')}</span>
          <dl className="ax-dl">
            {proposal.permissions.map((p) => (
              <Fragment key={p.type}>
                <dt>{p.type}</dt>
                <dd>
                  {p.value}
                  {p.note ? ` (${p.note})` : ''}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      ) : null}
      {proposal.tests?.length || proposal.quality ? (
        <ul className="ax-tests" aria-label={t('assistant.testResults')}>
          {(proposal.tests ?? []).map((test) => (
            <li key={test.name}>
              <Tag data-size="sm" data-color={test.passed ? 'success' : 'danger'}>
                {test.passed ? t('assistant.passed') : t('assistant.notPassed')}
              </Tag>
              <span>
                {test.name}
                {test.reason ? ` ${test.reason}` : ''}
              </span>
            </li>
          ))}
          {proposal.quality ? (
            <li>
              <Tag data-size="sm" data-color="info">
                {t('assistant.quality')}
              </Tag>
              <span>{proposal.quality}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      {change ? (
        <div className="stack-xs">
          <span className="ax-subhead">{t('assistant.platformStatus')}</span>
          <StepList
            label={t('assistant.platformStatus')}
            steps={platformSteps(change.status === 'rejected', t)}
            current={statusStep[change.status]}
          />
          <span className="ax-card-text">
            {change.status === 'rejected'
              ? change.rejectionReason
                ? t('assistant.platformRejectedReason', {
                    reason: change.rejectionReason,
                    caseId: change.caseId,
                  })
                : t('assistant.platformRejected', { caseId: change.caseId })
              : change.status === 'planned'
                ? t('assistant.platformPlanned', { caseId: change.caseId })
                : t(
                    change.status === 'sent'
                      ? 'assistant.platformSent'
                      : 'assistant.platformReview',
                    { caseId: change.caseId },
                  )}
          </span>
        </div>
      ) : null}
      {alternative ? (
        <div className="ax-meanwhile">
          <span>
            <strong>{t('assistant.meanwhile')}</strong> {alternative.detail}
          </span>
          <Button
            variant="secondary"
            data-size="sm"
            aria-disabled={alternativeUsed || undefined}
            onClick={() => !alternativeUsed && onAlternative()}
          >
            {t(alternativeUsed ? 'assistant.alternativeUsed' : 'assistant.alternativeUse')}
          </Button>
        </div>
      ) : null}
      {level < 4 && !decision ? (
        <>
          {!canApprove ? (
            <span className="meta">
              {t(building ? 'assistant.noRightBlock' : 'assistant.noRightService')}
            </span>
          ) : null}
          {level === 2 && canApprove && step === 'idle' ? (
            <span className="meta">{t('assistant.connectionNote')}</span>
          ) : null}
          {step !== 'idle' ? (
            <ReasonField
              value={reason}
              onChange={(v) => {
                setReason(v);
                setShowError(false);
              }}
              showError={showError}
            />
          ) : null}
          {failed ? (
            <Alert data-color="danger" data-size="sm">
              {t('assistant.saveFailed')}
            </Alert>
          ) : null}
          <div className="ax-row">
            {step === 'idle' ? (
              <>
                {level === 2 && canApprove ? (
                  <Button asChild variant="primary" data-size="sm">
                    <a href="#/building-blocks">{t('assistant.fillConnection')}</a>
                  </Button>
                ) : (
                  <Button variant="primary" data-size="sm" onClick={() => setStep('approve')}>
                    {approveLabel}
                  </Button>
                )}
                <Button variant="secondary" data-size="sm" onClick={() => setStep('reject')}>
                  {t('assistant.reject')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  data-size="sm"
                  aria-disabled={busy || undefined}
                  onClick={() => !busy && void confirm()}
                >
                  {confirmLabel}
                </Button>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  onClick={() => {
                    setStep('idle');
                    setShowError(false);
                  }}
                >
                  {t('assistant.cancel')}
                </Button>
              </>
            )}
          </div>
        </>
      ) : null}
      {decision?.kind === 'approved' ? (
        <ChangeLogged
          by={decision.result.changedBy.by}
          at={decision.result.changedBy.at}
          reason={decision.result.changedBy.reason}
        >
          {building
            ? t('assistant.approvedBlock', { tenant: tenantName })
            : t('assistant.approvedConnection')}
        </ChangeLogged>
      ) : decision?.kind === 'sent' ? (
        <Alert data-color="info" data-size="sm" role="status">
          {t(building ? 'assistant.sentBlock' : 'assistant.sentConnection')}
        </Alert>
      ) : decision?.kind === 'rejected' ? (
        <Alert data-color="info" data-size="sm" role="status">
          {t('assistant.rejectedDecision')}
        </Alert>
      ) : null}
    </div>
  );
};
