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
import { Icon, icons } from '../../components/Icon';
import { useFormat } from '@genai/i18n/react';
import { approvalDetails } from '../../data/log';
import { useT, type PlainKey } from '../../i18n';
import type { TimelineBlock, TimelineStep } from '../../types';
import { formatDuration, formatOffset } from './format';

export const stepIcons: Record<string, string> = {
  trigger: 'M13 3L5 14h6l-1 7 8-11h-6z',
  plan: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z M15.5 15.5L20 20',
  read: 'M6 3h9l3 3v15H6z M9 10h6 M9 14h6 M9 18h4',
  tool: 'M9 3v5 M15 3v5 M7 8h10v4a5 5 0 0 1-10 0z M12 17v4',
  model: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  guard: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  approval: 'M9 11a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M3 20a6 6 0 0 1 12 0 M15 12l2 2 4-4',
  document: 'M6 3h9l3 3v15H6z M14 3v4h4 M9 13l2 2 4-4',
  result: 'M5 12l5 5 9-10',
  error: 'M12 4l9 16H3z M12 10v4 M12 17h.01',
  step: 'M4 6h16 M4 12h10 M4 18h6',
  note: 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M12 11v5 M12 8h.01',
  searchnote:
    'M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z M15.5 15.5L20 20 M10.5 8v3 M10.5 13.5h.01',
};
const unknownIcon = 'M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18z M8 12h.01 M12 12h.01 M16 12h.01';

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
                <Icon d={stepIcons[step.type] ?? unknownIcon} size={18} strokeWidth={1.6} />
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
                      <Icon d={icons.chevronDown} size={18} />
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
