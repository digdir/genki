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
import { useState } from 'react';
import { currentUser, proposals, type Proposal } from '../../data/quality';
import { usePortalFormat } from '../../format';
import type { T } from '../../i18n';
import { langOf, type Decision, type SetFlash } from './shared';
import './diff.css';

type Color = 'info' | 'danger' | 'warning' | 'success' | 'neutral';

const statusOf = (t: T, p: Proposal, d: Decision | undefined): [string, Color] => {
  if (!d || d.state === 'pending')
    return d && d.approvers.length
      ? [t('qualityProposals.oneOfTwo'), 'warning']
      : [p.status, p.status === 'Ikke anbefalt' ? 'danger' : 'info'];
  if (d.state === 'approved') return [t('qualityProposals.approvedInTest'), 'success'];
  if (d.state === 'rejected') return [t('qualityProposals.rejected'), 'neutral'];
  return [t('qualityProposals.tryingInTest'), 'info'];
};

const scale = (v: number) => `${Math.max(0, Math.min(100, (v - 0.5) * 200))}%`;

export const ProposalsTab = ({
  high,
  selected,
  onSelect,
  decisions,
  onDecide,
  setFlash,
}: {
  high: boolean;
  selected: string;
  onSelect: (id: string) => void;
  decisions: Record<string, Decision>;
  onDecide: (id: string, d: Decision) => void;
  setFlash: SetFlash;
}) => {
  const { t, f } = usePortalFormat();
  const f2 = (n: number) => f.decimal(n, 2);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const p = proposals.find((x) => x.id === selected) ?? (proposals[0] as Proposal);
  const dec = decisions[p.id] ?? { state: 'pending', approvers: [] };
  const need = high ? 2 : 1;
  const [status, color] = statusOf(t, p, decisions[p.id]);
  const lockedUp = p.locked[1] >= p.locked[0];
  const meApproved = dec.approvers.includes(currentUser);

  const approve = () => {
    if (meApproved) return;
    const approvers = [...dec.approvers, currentUser];
    const done = approvers.length >= need;
    onDecide(p.id, { state: done ? 'approved' : 'pending', approvers, comment });
    setComment('');
    setFlash({
      text: t(done ? 'qualityProposals.approvedFlash' : 'qualityProposals.yourApproval'),
      color: 'success',
    });
  };
  const reject = () => {
    if (!comment.trim()) {
      setError(t('qualityProposals.whyReject'));
      return;
    }
    onDecide(p.id, { state: 'rejected', approvers: dec.approvers, comment: comment.trim() });
    setComment('');
    setFlash({ text: t('qualityProposals.rejectedFlash'), color: 'info' });
  };
  const tryIt = () => {
    onDecide(p.id, { state: 'testing', approvers: dec.approvers });
    setFlash({ text: t('qualityProposals.testingFlash'), color: 'info' });
  };

  const done =
    dec.state === 'approved'
      ? t('qualityProposals.doneApproved', { who: f.list(dec.approvers) })
      : dec.state === 'rejected'
        ? t('qualityProposals.doneRejected', { who: currentUser, comment: dec.comment ?? '' })
        : dec.state === 'testing'
          ? t('qualityProposals.doneTesting')
          : '';

  const examples = [
    ...p.better.map(([q, before, after]) => ({
      kind: t('qualityProposals.gotBetter'),
      good: true,
      q,
      before,
      after,
      note: '',
    })),
    ...p.worse.map(([q, before, after, note]) => ({
      kind: t('qualityProposals.gotWorse'),
      good: false,
      q,
      before,
      after,
      note,
    })),
  ];

  return (
    <div className="stack">
      <Alert data-color="info">
        <Paragraph>
          {t.rich('qualityProposals.nothingChanges', { strong: (c) => <strong>{c}</strong> })}
          {high ? ` ${t('qualityProposals.highRisk')}` : ''}
        </Paragraph>
      </Alert>
      <div className="proposal-cards">
        {proposals.map((x) => {
          const on = x.id === p.id;
          const [st, col] = statusOf(t, x, decisions[x.id]);
          return (
            <button
              type="button"
              key={x.id}
              aria-pressed={on}
              className={on ? 'proposal-card selected' : 'proposal-card'}
              onClick={() => {
                onSelect(x.id);
                setComment('');
                setError('');
              }}
            >
              <span className="tag-row">
                <span className="meta-xs">{x.id}</span>
                <Tag data-size="sm" data-color={col}>
                  {st}
                </Tag>
              </span>
              <span className="proposal-title">{x.title}</span>
              <span className="meta">
                {t('qualityProposals.from', { cluster: x.cluster, failures: x.failures })}
              </span>
            </button>
          );
        })}
      </div>

      <section aria-labelledby="fs-h" className="proposal-detail">
        <div className="stack-sm">
          <div className="row-wrap">
            <Heading level={2} data-size="sm" id="fs-h">
              {p.title}
            </Heading>
            <Tag data-size="sm" data-color={color}>
              {status}
            </Tag>
          </div>
          <Paragraph className="measure">{p.summary}</Paragraph>
        </div>

        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('qualityProposals.whatChanges')}
          </Heading>
          {p.diffs.map((d) => (
            <div key={d.what} className="diff-box">
              <div className="diff-head">{d.what}</div>
              <ol
                aria-label={t('quality.changesIn', { title: d.what.toLowerCase() })}
                className="diff-lines"
              >
                {d.lines.map(([op, text], i) => (
                  <li key={i} className={op === '+' ? 'add' : op === '-' ? 'remove' : undefined}>
                    <span className="diff-op">
                      {t(
                        op === '+'
                          ? 'quality.opAdd'
                          : op === '-'
                            ? 'quality.opRemove'
                            : 'quality.opSame',
                      )}
                    </span>
                    {op === '-' ? <del>{text}</del> : <span>{text}</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        <div className="proposal-grid">
          <div className="stack-sm">
            <Heading level={3} data-size="2xs">
              {t('qualityProposals.scoresPerTopic')}
            </Heading>
            <ul className="plain-list score-bars">
              {p.tags.map(([tag, before, after, u]) => {
                const d = after - before;
                const sig = Math.abs(d) > u;
                const worse = d < -0.001;
                const label =
                  Math.abs(d) < 0.001
                    ? t('qualityProposals.noChange')
                    : sig
                      ? d > 0
                        ? t('qualityProposals.betterSure')
                        : t('qualityProposals.worseSure')
                      : d > 0
                        ? t('qualityProposals.betterSlight')
                        : t('qualityProposals.worseSlight');
                return (
                  <li key={tag}>
                    <span className="score-line">
                      <span>{tag}</span>
                      <span
                        className={
                          worse
                            ? 'numeric strong danger-text'
                            : d > 0.001
                              ? 'numeric strong success-text'
                              : 'numeric strong'
                        }
                      >
                        {f2(before)} → {f2(after)}
                        {u ? ` (±${f2(u)})` : ''}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={worse ? 'score-track worse' : 'score-track'}
                    >
                      <span className="now" style={{ width: scale(before) }} />
                      <span
                        className="range"
                        style={{ left: scale(after - u), width: `${Math.max(0.5, u * 200)}%` }}
                      />
                      <span className="mark" style={{ left: scale(after) }} />
                    </span>
                    <span className="meta-xs">{label}</span>
                  </li>
                );
              })}
            </ul>
            <span className="meta-xs">{t('qualityProposals.scoreLegend')}</span>
          </div>
          <dl className="proposal-facts">
            <div className={lockedUp ? 'locked up' : 'locked down'}>
              <dt>{t('qualityProposals.lockedSet')}</dt>
              <dd className="big">
                {f2(p.locked[0])} → {f2(p.locked[1])} (±{f2(p.locked[2])})
              </dd>
              <dd className="small">
                {t(lockedUp ? 'qualityProposals.lockedUp' : 'qualityProposals.lockedDown')}
              </dd>
            </div>
            <div>
              <dt>{t('qualityProposals.costPer1000')}</dt>
              <dd>
                {p.cost[0]} → {p.cost[1]}
              </dd>
            </div>
            <div>
              <dt>{t('qualityProposals.casesUsed')}</dt>
              <dd>{t('qualityProposals.casesUsedValue')}</dd>
            </div>
          </dl>
        </div>

        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('qualityProposals.examples')}
          </Heading>
          {examples.length === 0 ? (
            <Paragraph data-size="sm">{t('qualityProposals.noExamples')}</Paragraph>
          ) : null}
          {examples.map((e) => (
            <div key={e.q} className={e.good ? 'example good' : 'example bad'}>
              <div className="row-wrap">
                <Tag data-size="sm" data-color={e.good ? 'success' : 'danger'}>
                  {e.kind}
                </Tag>
                <strong lang={langOf(e.q)}>{e.q}</strong>
              </div>
              <div className="example-pair">
                <div>
                  <span className="diff-label">{t('qualityProposals.nowV7')}</span>
                  <span lang={langOf(e.before)}>{e.before}</span>
                </div>
                <div>
                  <span className="diff-label">{t('quality.withProposal')}</span>
                  <span lang={langOf(e.after)}>{e.after}</span>
                </div>
              </div>
              {e.note ? <span className="small danger-text">{e.note}</span> : null}
            </div>
          ))}
        </div>

        <div className="proposal-actions">
          {high ? (
            <div className="stack-sm">
              <span className="strong">
                {t('qualityProposals.approvals', { count: dec.approvers.length })}
              </span>
              <ul className="plain-list approvals">
                {[0, 1].map((i) => (
                  <li key={i}>
                    <Tag data-size="sm" data-color={dec.approvers[i] ? 'success' : 'neutral'}>
                      {t(
                        dec.approvers[i] ? 'qualityProposals.approved' : 'qualityProposals.missing',
                      )}
                    </Tag>
                    {dec.approvers[i] ??
                      t(i === 0 ? 'qualityProposals.waiting' : 'qualityProposals.waitingOther')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {done ? (
            <Alert data-color={dec.state === 'approved' ? 'success' : 'info'} data-size="sm">
              {done}
            </Alert>
          ) : null}
          {dec.state === 'pending' ? (
            <div className="stack-sm">
              <Field className="reason-field">
                <Label htmlFor="fs-kom">{t('quality.comment')}</Label>
                <Field.Description>{t('quality.requiredIfReject')}</Field.Description>
                <Textarea
                  id="fs-kom"
                  rows={2}
                  value={comment}
                  aria-invalid={error ? true : undefined}
                  onChange={(e) => {
                    setComment(e.target.value);
                    setError('');
                  }}
                />
                {error ? <ValidationMessage>{error}</ValidationMessage> : null}
              </Field>
              <div className="actions">
                <Button
                  variant="primary"
                  aria-disabled={meApproved || undefined}
                  aria-describedby={meApproved ? 'fs-hint' : undefined}
                  onClick={approve}
                >
                  {t('qualityProposals.approve')}
                </Button>
                <Button variant="secondary" onClick={reject}>
                  {t('quality.reject')}
                </Button>
                <Button variant="tertiary" onClick={tryIt}>
                  {t('qualityProposals.tryInTest')}
                </Button>
                {meApproved ? (
                  <span id="fs-hint" className="small">
                    {t('qualityProposals.youApproved')}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
};
