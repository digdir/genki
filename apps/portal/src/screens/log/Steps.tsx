import {
  BulletListIcon,
  CheckmarkIcon,
  ChevronDownIcon,
  CpuIcon,
  ExclamationmarkTriangleIcon,
  FileCheckmarkIcon,
  FileTextIcon,
  InformationSquareIcon,
  LightningIcon,
  MagnifyingGlassCheckmarkIcon,
  MagnifyingGlassIcon,
  PersonCheckmarkIcon,
  QuestionmarkCircleIcon,
  ShieldIcon,
  TasklistIcon,
  WrenchIcon,
} from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Field,
  Label,
  Spinner,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { Icon, type IconComponent } from '../../components/Icon';
import { useFormat } from '@genai/i18n/react';
import { approvalDetails } from '../../data/log';
import { useT, type PlainKey } from '../../i18n';
import type { TimelineBlock, TimelineStep } from '../../types';
import { formatDuration, formatOffset } from './format';

export const stepIcons: Record<string, IconComponent> = {
  trigger: LightningIcon,
  plan: TasklistIcon,
  search: MagnifyingGlassIcon,
  read: FileTextIcon,
  tool: WrenchIcon,
  model: CpuIcon,
  guard: ShieldIcon,
  approval: PersonCheckmarkIcon,
  document: FileCheckmarkIcon,
  result: CheckmarkIcon,
  error: ExclamationmarkTriangleIcon,
  step: BulletListIcon,
  note: InformationSquareIcon,
  searchnote: MagnifyingGlassCheckmarkIcon,
};
const unknownIcon = QuestionmarkCircleIcon;

export const stepTypes: Record<string, PlainKey> = {
  trigger: 'steps.typeTrigger',
  plan: 'steps.typePlan',
  search: 'steps.typeSearch',
  read: 'steps.typeRead',
  tool: 'steps.typeTool',
  model: 'steps.typeModel',
  guard: 'steps.typeGuard',
  approval: 'steps.typeApproval',
  document: 'steps.typeDocument',
  result: 'steps.typeResult',
  error: 'steps.typeError',
  searchnote: 'steps.typeSearchnote',
  step: 'steps.typeStep',
  note: 'steps.typeNote',
};

const listRows = (block: TimelineBlock): [string, string][] =>
  block.rows ?? (block.items ?? []).map((x): [string, string] => (Array.isArray(x) ? x : [x, '']));

const stateTags = {
  waiting: ['steps.stateWaiting', 'warning'],
  pending: ['steps.statePending', 'neutral'],
  failed: ['steps.stateFailed', 'danger'],
  running: ['steps.stateRunning', 'info'],
  cancelled: ['steps.stateCancelled', 'neutral'],
  rejected: ['steps.stateRejected', 'danger'],
  skipped: ['steps.stateSkipped', 'neutral'],
  partial: ['steps.statePartial', 'warning'],
  retried: ['steps.stateRetried', 'info'],
} as const;

const Block = ({ block }: { block: TimelineBlock }) => {
  const t = useT();
  const body = (() => {
    switch (block.kind) {
      case 'quote':
        return <blockquote className="log-quote">«{block.text}»</blockquote>;
      case 'kv':
        return (
          <dl className="log-kv">
            {(block.rows ?? []).map(([k, v]) => (
              <div key={k} className="log-kv-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        );
      case 'tags':
        return (
          <div className="tag-row">
            {(block.items ?? [])
              .map((x) => (Array.isArray(x) ? x.join(' · ') : x))
              .map((x) => (
                <Tag key={x} data-size="sm" data-color="neutral">
                  {x}
                </Tag>
              ))}
          </div>
        );
      case 'list':
        return (
          <ol className="log-list">
            {listRows(block).map(([title, meta], i) => (
              <li key={`${title}-${i}`}>
                <span className="log-list-title">{title}</span>
                {meta ? <span className="meta"> · {meta}</span> : null}
              </li>
            ))}
          </ol>
        );
      case 'fields':
        return (
          <dl className="log-fields">
            {(block.rows ?? []).map(([k, v]) => (
              <div key={k} className="log-kv-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        );
      case 'answer':
        return (
          <div className="log-answer">
            <span className="log-answer-text">{block.text}</span>
            {block.sources?.length ? (
              <>
                <span className="log-block-label">{t('logSteps.sources')}</span>
                <ol>
                  {block.sources.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ol>
              </>
            ) : null}
          </div>
        );
      case 'doc':
        return (
          <div className="stack-sm">
            <div className="log-doc">
              <span className="log-doc-title">{block.title}</span>
              <span className="log-doc-body">{block.body}</span>
            </div>
            <div className="tag-row">
              <Button variant="secondary" data-size="sm">
                {t('logSteps.openDraft')}
              </Button>
              <Button variant="tertiary" data-size="sm">
                {t('logSteps.download')}
              </Button>
            </div>
          </div>
        );
      case 'reasoning':
        return <p className="log-reasoning">{block.text}</p>;
      case 'error':
        return (
          <Alert data-color="danger" data-size="sm">
            {block.text}
          </Alert>
        );
      default:
        return <p className="log-note">{block.text}</p>;
    }
  })();
  return (
    <div className="log-block">
      {block.label ? <span className="log-block-label">{block.label}</span> : null}
      {body}
    </div>
  );
};

export interface ApprovalProps {
  decision: { ok: boolean; comment: string; by: string; at: string } | undefined;
  comment: string;
  error: string;
  onComment: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  details?: [string, string][];
}

const RawData = ({ id, raw }: { id: string; raw: unknown }) => {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="log-block">
      <Button
        variant="tertiary"
        data-size="sm"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? t('logSteps.hideRaw') : t('logSteps.showRaw')}
      </Button>
      {shown ? (
        <pre id={id} className="log-raw-data">
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : null}
    </div>
  );
};

const noApproval: ApprovalProps = {
  decision: undefined,
  comment: '',
  error: '',
  onComment: () => undefined,
  onApprove: () => undefined,
  onReject: () => undefined,
};

export const Steps = ({
  steps,
  isOpen,
  onToggle,
  approval = noApproval,
  label,
  idPrefix = '',
}: {
  steps: TimelineStep[];
  isOpen: (step: TimelineStep, index: number) => boolean;
  onToggle: (index: number) => void;
  approval?: ApprovalProps;
  label?: string;
  idPrefix?: string;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <ol aria-label={label ?? t('logSteps.label')} className="log-steps">
      {steps.map((step, i) => {
        const known = step.type in stepTypes;
        const tag = step.state && step.state !== 'ok' ? stateTags[step.state] : undefined;
        const tone =
          step.state === 'failed' || step.state === 'rejected'
            ? 'danger'
            : step.state === 'waiting' || step.state === 'partial' || step.warning
              ? 'warning'
              : step.state === 'running'
                ? 'accent'
                : undefined;
        const dashed =
          step.state === 'pending' ||
          step.state === 'cancelled' ||
          step.state === 'skipped' ||
          !known;
        const open = isOpen(step, i);
        const bodyId = `${idPrefix}${step.id}-body`;
        const isApproval = step.type === 'approval';
        return (
          <li
            key={step.id}
            className={
              step.depth ? `log-step log-step-nested depth-${Math.min(step.depth, 3)}` : 'log-step'
            }
          >
            <div aria-hidden="true" className="log-step-rail">
              <span
                className={[
                  'log-step-icon',
                  tone ? `tone-${tone}` : known ? 'known' : 'unknown',
                  dashed ? 'dashed' : '',
                ].join(' ')}
              >
                <Icon icon={stepIcons[step.type] ?? unknownIcon} size={18} />
              </span>
              {i < steps.length - 1 ? <span className="log-step-line" /> : null}
            </div>
            <div className="log-step-main">
              <div
                className={`log-step-card${tone === 'danger' || tone === 'warning' ? ` border-${tone}` : ''}`}
              >
                <button
                  type="button"
                  className="log-step-toggle"
                  aria-expanded={open}
                  aria-controls={open ? bodyId : undefined}
                  onClick={() => onToggle(i)}
                >
                  <span className="log-step-heading">
                    <span className="row-wrap log-step-titles">
                      <span className="log-step-type">
                        {known
                          ? t(stepTypes[step.type] as PlainKey)
                          : t('logSteps.unknown', { type: step.type })}
                      </span>
                      <span className="log-step-title">{step.title}</span>
                      {tag ? (
                        <Tag data-size="sm" data-color={tag[1]}>
                          {step.state === 'running' ? (
                            <Spinner aria-hidden="true" data-size="2xs" />
                          ) : null}
                          {t(tag[0])}
                        </Tag>
                      ) : null}
                    </span>
                    <span className="meta">{step.summary}</span>
                  </span>
                  <span className="log-step-times">
                    <span>{formatOffset(step.at, f)}</span>
                    {step.durationSeconds !== undefined ? (
                      <span>{formatDuration(step.durationSeconds, f)}</span>
                    ) : null}
                    {step.tokens ? (
                      <span>{t('logSteps.tokens', { count: step.tokens })}</span>
                    ) : null}
                    <span className={open ? 'chevron open' : 'chevron'}>
                      <Icon icon={ChevronDownIcon} size={18} />
                    </span>
                  </span>
                </button>
                {open ? (
                  <div className="log-step-body" id={bodyId}>
                    {known ? null : (
                      <p className="log-raw">{step.description ?? t('logSteps.unknownText')}</p>
                    )}
                    {step.blocks.map((b, k) => (
                      <Block key={`${b.kind}-${k}`} block={b} />
                    ))}
                    {step.raw === undefined ? null : (
                      <RawData id={`${idPrefix}${step.id}-raw`} raw={step.raw} />
                    )}
                    {isApproval && step.state === 'waiting' && !approval.decision ? (
                      <div className="log-approval">
                        <dl className="log-kv">
                          {(approval.details ?? approvalDetails).map(([k, v]) => (
                            <div key={k} className="log-kv-row">
                              <dt>{k}</dt>
                              <dd>{v}</dd>
                            </div>
                          ))}
                        </dl>
                        <Field>
                          <Label htmlFor="godkjenning-kommentar">{t('logSteps.comment')}</Label>
                          <Field.Description>{t('logSteps.commentHelp')}</Field.Description>
                          <Textarea
                            id="godkjenning-kommentar"
                            rows={3}
                            value={approval.comment}
                            aria-invalid={approval.error ? true : undefined}
                            onChange={(e) => approval.onComment(e.target.value)}
                          />
                          {approval.error ? (
                            <ValidationMessage>{approval.error}</ValidationMessage>
                          ) : null}
                        </Field>
                        <div className="actions">
                          <Button variant="primary" onClick={approval.onApprove}>
                            {t('logSteps.approve')}
                          </Button>
                          <Button variant="secondary" onClick={approval.onReject}>
                            {t('logSteps.reject')}
                          </Button>
                        </div>
                        <span className="small">{t('logSteps.approvalHelp')}</span>
                      </div>
                    ) : null}
                    {isApproval && approval.decision ? (
                      <dl className="log-kv">
                        {(
                          [
                            [
                              t('logSteps.decision'),
                              approval.decision.ok
                                ? t('logSteps.approved')
                                : t('logSteps.rejected'),
                            ],
                            [t('logSteps.by'), approval.decision.by],
                            [t('logSteps.at'), approval.decision.at],
                            [
                              t('logSteps.comment'),
                              approval.decision.comment || t('logSteps.noComment'),
                            ],
                          ] as const
                        ).map(([k, v]) => (
                          <div key={k} className="log-kv-row">
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
};
