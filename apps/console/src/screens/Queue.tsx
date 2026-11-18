import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  ErrorSummary,
  Heading,
  Label,
  Paragraph,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient } from '../api';
import { ApiCall } from '../api-call';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import { minimumReasonLength } from '../reason';
import type { Residency } from '../types';
import { Flash, formatDay, formatWhen, NotDecided, PageHeader, SidePanel, useFlash } from '../ui';
import { formatOrgNumber } from './Tenants';
import {
  apiPath,
  decide,
  deciderOf,
  decisionLabel,
  kindLabel,
  laneOf,
  lanes,
  lineDiff,
  subOf,
  workingDaysSince,
  type Kind,
  type Lane,
  type Mode,
  type Row,
} from './queue/lanes';

export { pendingCount } from './queue/lanes';

type Loaded = Record<Kind, Row[] | { error: unknown } | undefined>;

const overdueDays = 5;
const decidedWindowDays = 90;
const draftKey = 'queue-decision';

interface Draft {
  kind: Kind;
  id: string;
  mode: Mode;
  reason: string;
  caseNo: string;
  expired?: boolean;
}

const readDraft = (): Draft | undefined => {
  try {
    const raw = window.sessionStorage.getItem(draftKey);
    return raw ? (JSON.parse(raw) as Draft) : undefined;
  } catch {
    return undefined;
  }
};

const writeDraft = (draft: Draft | undefined) => {
  try {
    if (draft) window.sessionStorage.setItem(draftKey, JSON.stringify(draft));
    else window.sessionStorage.removeItem(draftKey);
  } catch {
    return;
  }
};

const reasonError = (text: string, t: T) => {
  const n = text.trim().length;
  return n < minimumReasonLength
    ? t('queue.reasonShort', { min: minimumReasonLength, n })
    : undefined;
};

const location: Record<Residency, [PlainKey, 'success' | 'info' | 'danger']> = {
  norway: ['queue.locNorway', 'success'],
  eu: ['queue.locEu', 'info'],
  global: ['queue.locGlobal', 'danger'],
};

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="stack-sm">
    <Heading level={3} data-size="2xs">
      {title}
    </Heading>
    {children}
  </div>
);

const ContractTests = ({ api, id }: { api: ApiClient; id: string }) => {
  const t = useT();
  const [state] = useAsync((signal) => api.plugins(signal), [api]);
  if (state.status !== 'ready') return null;
  const tests = state.data.find((p) => p.id === id)?.contractTests;
  if (!tests) return null;
  const failed = tests.results.filter((r) => r.status === 'failed').length;
  return (
    <Section
      title={failed ? t('queue.contractFailed', { count: failed }) : t('queue.contractPassed')}
    >
      <ul className="plain check-list">
        {tests.results.map((r) => (
          <li key={r.name}>
            <span>{r.name}</span>
            <Tag
              data-size="sm"
              data-color={
                r.status === 'failed' ? 'danger' : r.status === 'skipped' ? 'neutral' : 'success'
              }
            >
              {r.status === 'failed'
                ? t('queue.testFailed')
                : r.status === 'skipped'
                  ? t('queue.testSkipped')
                  : t('queue.testPassed')}
            </Tag>
          </li>
        ))}
      </ul>
    </Section>
  );
};

const accessTag = (type: string): [PlainKey, 'warning' | 'info' | 'neutral'] =>
  type === 'network'
    ? ['queue.accessNetwork', 'warning']
    : type === 'data'
      ? ['queue.accessData', 'info']
      : type === 'secret'
        ? ['queue.accessSecret', 'neutral']
        : ['queue.accessModel', 'neutral'];

const BlockDetail = ({ api, row }: { api: ApiClient; row: Row }) => {
  const t = useT();
  const b = row.block?.block;
  if (!b) return null;
  const loc = b.dataLocation ? location[b.dataLocation] : undefined;
  return (
    <>
      <dl className="def-list">
        <dt>{t('queue.type')}</dt>
        <dd>{kindLabel(b.kind, t)}</dd>
        <dt>{t('queue.version')}</dt>
        <dd>{b.version}</dd>
        {b.publisher ? (
          <>
            <dt>{t('queue.publisher')}</dt>
            <dd>{b.publisher}</dd>
          </>
        ) : null}
        <dt>{t('queue.dataProcessed')}</dt>
        <dd>
          <Tag data-size="sm" data-color={loc?.[1] ?? 'neutral'}>
            {loc ? t(loc[0]) : t('queue.locUnknown')}
          </Tag>
        </dd>
      </dl>
      {b.rule ? (
        <Alert data-color="info" data-size="sm">
          <strong>{t('queue.whyApproval')}</strong> {b.rule.text}
        </Alert>
      ) : null}
      {b.access?.length ? (
        <Section title={t('queue.accessTitle')}>
          <Table data-size="sm">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('queue.accessWhat')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('queue.accessAccess')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {b.access.map((a) => {
                const [label, color] = accessTag(a.type);
                return (
                  <TableRow key={`${a.type}/${a.value}`}>
                    <TableCell>{a.note || a.value}</TableCell>
                    <TableCell>
                      <Tag data-size="sm" data-color={color}>
                        {a.type === 'network'
                          ? t('queue.accessNetworkTo', { value: a.value })
                          : t(label)}
                      </Tag>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      ) : null}
      <ContractTests api={api} id={b.id} />
      {b.scores?.length ? (
        <Section title={t('queue.matrixTitle')}>
          <Table data-size="sm">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('queue.testSet')}</TableHeaderCell>
                <TableHeaderCell scope="col" className="num">
                  {t('queue.points')}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {b.scores.map((s) => (
                <TableRow key={`${s.service}/${s.testSet}`}>
                  <TableCell>{s.testSet}</TableCell>
                  <TableCell className="num">{Math.round(s.score * 100)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
      {b.services?.length ? (
        <Section title={t('queue.servicesTitle', { org: row.orgName })}>
          <ul>
            {b.services.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Paragraph data-size="sm">
        <strong>{t('queue.whenApproving')}</strong>{' '}
        {t('queue.whenApprovingBlock', { org: row.orgName })}
      </Paragraph>
    </>
  );
};

const SkillDetail = ({ row }: { row: Row }) => {
  const t = useT();
  const s = row.skill;
  const d = s?.detail;
  const diff = d?.previous ? lineDiff(d.previous.instructions, d.instructions) : [];
  const test = d?.test;
  const met = test?.score != null && test.score >= test.threshold;
  return (
    <>
      <dl className="def-list">
        <dt>{t('queue.version')}</dt>
        <dd>{s?.version}</dd>
      </dl>
      {d ? (
        <>
          <Section title={t('queue.description')}>
            <p className="tinted-block">{d.description}</p>
          </Section>
          <Section title={t('queue.instructions')}>
            <p className="tinted-block pre" tabIndex={0}>
              {d.instructions}
            </p>
          </Section>
          {d.tools.length ? (
            <Section title={t('queue.tools')}>
              <ul className="plain chips">
                {d.tools.map((tool) => (
                  <li key={tool}>
                    <Tag data-size="sm" data-color="neutral">
                      {tool}
                    </Tag>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title={t('queue.testSet')}>
            <p className="tag-line">
              {test?.total
                ? t('queue.testSummary', {
                    passed: test.passed ?? 0,
                    total: test.total,
                    threshold: Math.round(test.threshold * 100),
                  })
                : t('queue.notRun')}
              {test?.score != null ? (
                <Tag data-size="sm" data-color={met ? 'success' : 'danger'}>
                  {met ? t('queue.meets') : t('queue.meetsNot')}
                </Tag>
              ) : null}
            </p>
          </Section>
        </>
      ) : null}
      <Checkbox
        checked
        disabled
        readOnly
        label={t('queue.skillConfirmed', { who: row.by || row.orgName })}
      />
      <Section
        title={
          d?.previous
            ? t('queue.changedSince', { version: d.previous.version })
            : t('queue.changes')
        }
      >
        {d?.previous ? (
          diff.length ? (
            <ul className="plain diff">
              {diff.map((l) => (
                <li key={`${l.sign}${l.text}`} className={l.sign === '-' ? 'removed' : 'added'}>
                  <span aria-hidden="true">{l.sign === '-' ? '−' : '+'}</span>
                  <span>
                    <span className="visually-hidden">
                      {l.sign === '-' ? t('queue.removed') : t('queue.added')}
                    </span>
                    {l.text}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Paragraph data-size="sm">{t('queue.unchanged')}</Paragraph>
          )
        ) : (
          <Paragraph data-size="sm" className="meta">
            {t('queue.firstShare')}
          </Paragraph>
        )}
      </Section>
      <Paragraph data-size="sm">
        <strong>{t('queue.whenApproving')}</strong>{' '}
        {t('queue.whenApprovingSkill', { org: row.orgName })}
      </Paragraph>
    </>
  );
};

const proposalSteps = ['sent', 'under_review', 'done'] as const;

const ProposalDetail = ({ row }: { row: Row }) => {
  const t = useT();
  const f = useFormat();
  const p = row.proposal;
  const status = p?.platformChange?.status ?? 'sent';
  const current = row.outcome ? 2 : status === 'under_review' ? 1 : 0;
  const caseId = p?.platformChange?.caseId ?? p?.caseId;
  const labels = [t('queue.stepSent'), t('queue.stepReview'), t('queue.stepDone')];
  const meta = [
    formatDay(row.at, f),
    current >= 1 ? (caseId ? t('queue.caseRef', { id: caseId }) : '') : '',
    row.outcome ? t(decisionLabel(row)[0]) : '',
  ];
  return (
    <>
      {p?.summary ? <Paragraph>{p.summary}</Paragraph> : null}
      {p?.ask ? (
        <Section title={t('queue.askTitle')}>
          <blockquote className="quote">{p.ask}</blockquote>
        </Section>
      ) : null}
      {p?.detail ? (
        <Section title={t('queue.whyNotEnough')}>
          <Paragraph data-size="sm">{p.detail}</Paragraph>
        </Section>
      ) : null}
      {p?.forService ? (
        <dl className="def-list">
          <dt>{t('queue.service')}</dt>
          <dd>{p.forService.name}</dd>
        </dl>
      ) : null}
      <Section title={t('queue.status')}>
        <ol className="steps-list">
          {proposalSteps.map((id, i) => (
            <li
              key={id}
              className={i < current ? 'done' : i === current ? 'current' : undefined}
              aria-current={i === current ? 'step' : undefined}
            >
              <span className="step-mark" aria-hidden="true">
                {String(i + 1)}
              </span>
              <span className="two-line">
                <span className="step-label">{labels[i]}</span>
                {meta[i] ? <span className="meta">{meta[i]}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        <Paragraph data-size="sm" className="meta">
          {t('queue.statusSeen', { org: row.orgName })}
        </Paragraph>
      </Section>
    </>
  );
};

const AccessDetail = ({ row }: { row: Row }) => {
  const t = useT();
  const f = useFormat();
  const r = row.access;
  if (!r) return null;
  return (
    <>
      <dl className="def-list">
        <dt>{t('queue.orgNumber')}</dt>
        <dd>{formatOrgNumber(r.org)}</dd>
        {r.contactName ? (
          <>
            <dt>{t('queue.contactPerson')}</dt>
            <dd>{r.contactName}</dd>
          </>
        ) : null}
        {r.contactEmail ? (
          <>
            <dt>{t('queue.email')}</dt>
            <dd className="break">{r.contactEmail}</dd>
          </>
        ) : null}
      </dl>
      <Section title={t('queue.purposeTitle')}>
        <Paragraph>{r.purpose || t('queue.notStated')}</Paragraph>
      </Section>
      <div className="stack-sm">
        <Heading level={3} data-size="2xs" className="tag-line">
          {t('queue.termsTitle')} <NotDecided />
        </Heading>
        <Paragraph data-size="sm">
          {r.terms
            ? t('queue.termsAccepted', {
                who: row.by || r.contactName || t('queue.termsRequester'),
                version:
                  r.terms.version && r.terms.version !== 'utkast'
                    ? t('queue.termsVersion', { version: r.terms.version })
                    : '',
                date: formatDay(r.terms.at, f),
              })
            : t('queue.termsNotAccepted')}
        </Paragraph>
      </div>
      <div className="dashed-box stack-sm">
        <span className="tag-line label-strong">
          {t('queue.registerCheckTitle')} <NotDecided />
        </span>
        <span>{t('queue.registerCheckText')}</span>
      </div>
      <Paragraph data-size="sm">
        <strong>{t('queue.whenApproving')}</strong> {t('queue.whenApprovingAccess')}
      </Paragraph>
    </>
  );
};

interface Conflict {
  who: string;
  label: PlainKey;
  at?: string | undefined;
  reason?: string | undefined;
}

const Panel = ({
  api,
  lane,
  row,
  conflict,
  onClose,
  onDecide,
}: {
  api: ApiClient;
  lane: Lane;
  row: Row;
  conflict: Conflict | undefined;
  onClose: () => void;
  onDecide: (mode: Mode) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const underReview = row.proposal?.platformChange?.status === 'under_review';
  return (
    <>
      <div className="panel-backdrop" aria-hidden="true" onClick={onClose} />
      <SidePanel labelledBy="queue-panel-h" onClose={onClose}>
        <div className="panel-head">
          <span className="eyebrow">{t(lane.label)}</span>
          <Heading level={2} data-size="sm" id="queue-panel-h" tabIndex={-1}>
            {row.title}
          </Heading>
        </div>
        <div className="panel-body">
          {conflict ? (
            <Alert data-color="warning">
              <Heading level={3} data-size="2xs">
                {t('queue.conflictTitle', { who: conflict.who })}
              </Heading>
              <Paragraph>
                {conflict.at
                  ? t('queue.conflictWithTime', {
                      who: conflict.who,
                      when: formatWhen(conflict.at, f, t).toLowerCase(),
                      decision: t(conflict.label).toLowerCase(),
                    })
                  : t('queue.conflictNoTime', {
                      who: conflict.who,
                      decision: t(conflict.label).toLowerCase(),
                    })}
              </Paragraph>
              {conflict.reason ? (
                <Paragraph>
                  <strong>{t('queue.reasonLabel')}</strong> {conflict.reason}
                </Paragraph>
              ) : null}
            </Alert>
          ) : null}
          <dl className="def-list">
            <dt>{t('queue.organisation')}</dt>
            <dd>{row.orgName}</dd>
            <dt>{t('queue.sentBy')}</dt>
            <dd>{byOf(row, t)}</dd>
            <dt>{t('queue.sent')}</dt>
            <dd>{formatDay(row.at, f)}</dd>
          </dl>
          {row.reason && row.kind !== 'access' && row.kind !== 'proposals' ? (
            <Section title={t('queue.reasonFrom', { org: row.orgName })}>
              <Paragraph>{row.reason}</Paragraph>
            </Section>
          ) : null}
          {row.kind === 'blocks' ? <BlockDetail api={api} row={row} /> : null}
          {row.kind === 'skills' ? <SkillDetail row={row} /> : null}
          {row.kind === 'proposals' ? <ProposalDetail row={row} /> : null}
          {row.kind === 'access' ? <AccessDetail row={row} /> : null}
        </div>
        <div className="panel-foot actions-row">
          {conflict || row.outcome ? (
            <Button variant="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
          ) : row.kind === 'proposals' ? (
            <>
              {underReview ? null : (
                <Button variant="secondary" onClick={() => onDecide('review')}>
                  {t('queue.setUnderReview')}
                </Button>
              )}
              <Button onClick={() => onDecide('plan')}>{t('queue.includeInPlan')}</Button>
              <Button variant="secondary" onClick={() => onDecide('reject')}>
                {t('queue.decline')}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => onDecide('approve')}>{t('queue.approve')}</Button>
              <Button variant="secondary" onClick={() => onDecide('reject')}>
                {t('queue.reject')}
              </Button>
            </>
          )}
        </div>
      </SidePanel>
    </>
  );
};

const titles: Record<Mode, (row: Row, t: T) => string> = {
  approve: (r, t) => t('queue.titleApprove', { title: r.title }),
  reject: (r, t) =>
    t(r.kind === 'proposals' ? 'queue.titleDecline' : 'queue.titleReject', { title: r.title }),
  review: (_, t) => t('queue.setUnderReview'),
  plan: (_, t) => t('queue.includeInPlan'),
};

const ctas: Record<Mode, (row: Row, t: T) => string> = {
  approve: (_, t) => t('queue.approve'),
  reject: (r, t) => t(r.kind === 'proposals' ? 'queue.decline' : 'queue.reject'),
  review: (_, t) => t('queue.setUnderReview'),
  plan: (_, t) => t('queue.includeInPlan'),
};

const leadOf = (row: Row, mode: Mode, t: T) => {
  if (mode === 'review') return t('queue.leadReview');
  if (mode === 'plan') return t('queue.leadPlan');
  if (mode === 'reject')
    return t(row.kind === 'proposals' ? 'queue.leadDeclined' : 'queue.leadRejected', {
      org: row.orgName,
    });
  return {
    blocks: t('queue.leadBlocks', { org: row.orgName }),
    skills: t('queue.leadSkills', { org: row.orgName }),
    proposals: '',
    access: t('queue.whenApprovingAccess'),
  }[row.kind];
};

const byOf = (row: Row, t: T) =>
  row.assistant
    ? row.by
      ? t('queue.assistantFor', { name: row.by })
      : t('queue.assistant')
    : row.by || t('queue.unknown');

const DecisionDialog = ({
  row,
  mode,
  initial,
  onClose,
  onSave,
}: {
  row: Row | undefined;
  mode: Mode | undefined;
  initial: Draft | undefined;
  onClose: () => void;
  onSave: (reason: string, caseNo: string) => Promise<void>;
}) => {
  const t = useT();
  const open = Boolean(row && mode);
  const [reason, setReason] = useState('');
  const [caseNo, setCaseNo] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const expired = Boolean(initial?.expired);

  useEffect(() => {
    if (!open) return;
    setReason(initial?.reason ?? '');
    setCaseNo(initial?.caseNo ?? '');
    setError(undefined);
    setFailed(undefined);
  }, [open, initial]);

  useEffect(() => {
    if (open && row && mode)
      writeDraft({ kind: row.kind, id: row.id, mode, reason, caseNo, expired: false });
  }, [open, row, mode, reason, caseNo]);

  if (!row || !mode)
    return <Dialog open={false} onClose={onClose} aria-labelledby="queue-dialog-h" />;
  const withCase = row.kind === 'proposals' && mode !== 'review';
  const caseId = caseNo.trim() || undefined;
  const body =
    mode === 'review'
      ? { status: 'under_review', reason: reason.trim() }
      : {
          approve: mode === 'approve' || mode === 'plan',
          reason: reason.trim(),
          ...(withCase && caseId ? { caseId } : {}),
        };
  const save = async () => {
    const problem = reasonError(reason, t);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await onSave(reason.trim(), caseNo.trim());
    } catch (e) {
      setFailed(
        e instanceof ApiError && e.problem?.title ? e.problem.title : t('queue.saveDecisionFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      closeButton={t('common.close')}
      aria-labelledby="queue-dialog-h"
      className="reason-dialog"
    >
      <div className="stack">
        <Heading level={2} data-size="xs" id="queue-dialog-h">
          {titles[mode](row, t)}
        </Heading>
        {expired ? (
          <Alert data-color="warning">
            <Heading level={3} data-size="2xs">
              {t('queue.expiredTitle')}
            </Heading>
            <Paragraph>{t('queue.expiredText')}</Paragraph>
          </Alert>
        ) : null}
        {error ? (
          <ErrorSummary>
            <ErrorSummary.Heading>{t('queue.beforeSaving')}</ErrorSummary.Heading>
            <ErrorSummary.List>
              <ErrorSummary.Item>
                <ErrorSummary.Link href="#queue-reason">{error}</ErrorSummary.Link>
              </ErrorSummary.Item>
            </ErrorSummary.List>
          </ErrorSummary>
        ) : null}
        {leadOf(row, mode, t) ? <Paragraph>{leadOf(row, mode, t)}</Paragraph> : null}
        {withCase ? (
          <Textfield
            className="narrow"
            label={t('queue.caseNumber')}
            description={t('queue.caseNumberHint')}
            value={caseNo}
            onChange={(e) => setCaseNo(e.target.value)}
          />
        ) : null}
        <div className="field">
          <Label htmlFor="queue-reason">{t('common.reason')}</Label>
          <Paragraph data-size="sm" className="meta" id="queue-reason-h">
            {t('queue.reasonHint', { min: minimumReasonLength })}
          </Paragraph>
          <Textarea
            id="queue-reason"
            rows={3}
            value={reason}
            aria-describedby="queue-reason-h"
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(reasonError(e.target.value, t));
            }}
          />
          {error ? <ValidationMessage>{error}</ValidationMessage> : null}
        </div>
        <p className="info-note">{t('queue.decisionSeen', { org: row.orgName })}</p>
        <span className="tag-line meta">
          <NotDecided />
          {t('queue.fourEyes')}
        </span>
        <ApiCall method="POST" path={apiPath(row, mode)} body={body} />
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        <div className="actions-row">
          <Button
            loading={busy}
            data-color={mode === 'reject' ? 'danger' : 'accent'}
            onClick={() => void save()}
          >
            {ctas[mode](row, t)}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

const WaitingTable = ({
  lane,
  rows,
  onOpen,
}: {
  lane: Lane;
  rows: Row[];
  onOpen: (row: Row) => void;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <div
      className="table-region"
      tabIndex={0}
      role="region"
      aria-labelledby={`venter-${lane.kind}`}
    >
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell scope="col">{t('queue.colRequest')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.organisation')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.sentBy')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.colSent')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.colStatus')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => {
            const days = workingDaysSince(r.at);
            return (
              <TableRow key={r.id}>
                <TableHeaderCell scope="row" className="row-head">
                  <span className="two-line">
                    <button type="button" className="link-button" onClick={() => onOpen(r)}>
                      {r.title}
                    </button>
                    <span className="meta">{subOf(r, t)}</span>
                  </span>
                </TableHeaderCell>
                <TableCell>{r.orgName}</TableCell>
                <TableCell>{byOf(r, t)}</TableCell>
                <TableCell className="nowrap">{formatDay(r.at, f)}</TableCell>
                <TableCell>
                  <span className="two-line">
                    <Tag data-size="sm" data-color="warning">
                      {t('queue.waitingForDigdir')}
                    </Tag>
                    {days > overdueDays ? (
                      <span className="overdue">{t('queue.waitedDays', { count: days })}</span>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
};

const DoneTable = ({ lane, rows }: { lane: Lane; rows: Row[] }) => {
  const t = useT();
  const f = useFormat();
  return (
    <div
      className="table-region"
      tabIndex={0}
      role="region"
      aria-labelledby={`behandlet-${lane.kind}`}
    >
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell scope="col">{t('queue.colRequest')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.organisation')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.colDecision')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.colDecidedBy')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('queue.colReason')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => {
            const [label, color] = decisionLabel(r);
            return (
              <TableRow key={r.id}>
                <TableHeaderCell scope="row">{r.title}</TableHeaderCell>
                <TableCell>{r.orgName}</TableCell>
                <TableCell>
                  <Tag data-size="sm" data-color={color}>
                    {t(label)}
                  </Tag>
                </TableCell>
                <TableCell>
                  <span className="two-line">
                    <span>{deciderOf(r.decision, t)}</span>
                    {r.decision?.at ? (
                      <span className="meta">{formatWhen(r.decision.at, f, t)}</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="sm">{r.decision?.reason ?? ''}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
};

const recent = (r: Row, now = Date.now()) => {
  const at = r.decision?.at ? new Date(r.decision.at).getTime() : now;
  return now - at <= decidedWindowDays * 86_400_000;
};

const LanePanel = ({
  lane,
  list,
  loading,
  onRetry,
  onOpen,
}: {
  lane: Lane;
  list: Row[] | { error: unknown } | undefined;
  loading: boolean;
  onRetry: () => void;
  onOpen: (row: Row) => void;
}) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'oldest' | 'newest'>('oldest');
  if (list && !Array.isArray(list))
    return (
      <Alert data-color="danger">
        <Heading level={2} data-size="2xs">
          {t('queue.loadFailedTitle', { lane: t(lane.lower) })}
        </Heading>
        <Paragraph>{t('queue.loadFailedText')}</Paragraph>
        <Button variant="secondary" data-size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </Alert>
    );
  const all = list ?? [];
  const waiting = all.filter((r) => !r.outcome);
  const q = query.trim().toLowerCase();
  const rows = waiting
    .filter((r) => !q || `${r.orgName} ${r.by} ${r.title}`.toLowerCase().includes(q))
    .sort((a, b) => (sort === 'oldest' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)));
  const done = all
    .filter((r) => r.outcome && recent(r))
    .sort((a, b) => (b.decision?.at ?? b.at).localeCompare(a.decision?.at ?? a.at));
  const busy = loading || !list;
  return (
    <div className="stack">
      <div className="filters">
        <Textfield
          className="search-field"
          label={t('queue.search')}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="field">
          <Label htmlFor={`sort-${lane.kind}`}>{t('queue.sort')}</Label>
          <Select
            id={`sort-${lane.kind}`}
            value={sort}
            onChange={(e) => setSort(e.target.value === 'newest' ? 'newest' : 'oldest')}
          >
            <Select.Option value="oldest">{t('queue.oldestFirst')}</Select.Option>
            <Select.Option value="newest">{t('queue.newestFirst')}</Select.Option>
          </Select>
        </div>
      </div>
      <section className="stack-sm" aria-labelledby={`venter-${lane.kind}`}>
        <Heading level={2} data-size="xs" id={`venter-${lane.kind}`}>
          {busy ? t('queue.waitingBusy') : t('queue.waitingHeading', { count: waiting.length })}
        </Heading>
        {busy ? (
          <div className="stack-sm" aria-busy="true" aria-label={t('queue.loadingRequests')}>
            <Skeleton variant="rectangle" height="52px" />
            <Skeleton variant="rectangle" height="52px" />
            <Skeleton variant="rectangle" height="52px" />
          </div>
        ) : waiting.length === 0 ? (
          <div className="state empty">
            <Heading level={3} data-size="2xs">
              {t('queue.nothingWaiting')}
            </Heading>
            <Paragraph>{t(lane.empty)}</Paragraph>
          </div>
        ) : rows.length === 0 ? (
          <Paragraph>{t('queue.noMatch', { query: query.trim() })}</Paragraph>
        ) : (
          <>
            <WaitingTable lane={lane} rows={rows} onOpen={onOpen} />
            <Paragraph data-size="sm" className="meta tag-line">
              {t('queue.overdueNote', { days: overdueDays })} <NotDecided />{' '}
              {t('queue.deadlineNotAdopted')}
            </Paragraph>
          </>
        )}
      </section>
      <section className="stack-sm" aria-labelledby={`behandlet-${lane.kind}`}>
        <Heading level={2} data-size="xs" id={`behandlet-${lane.kind}`}>
          {t('queue.handled')}
        </Heading>
        {busy ? null : done.length ? (
          <DoneTable lane={lane} rows={done} />
        ) : (
          <Paragraph className="meta">
            {t('queue.noneRecent', { days: decidedWindowDays })}
          </Paragraph>
        )}
      </section>
    </div>
  );
};

const flashFor = (row: Row, mode: Mode, caseNo: string, t: T) => {
  const title = row.title;
  if (mode === 'review') return t('queue.flashReview', { title, org: row.orgName });
  if (mode === 'plan')
    return caseNo
      ? t('queue.flashPlanCase', { title, case: caseNo })
      : t('queue.flashPlan', { title });
  if (mode === 'approve') return t('queue.flashApproved', { title });
  return t(row.kind === 'proposals' ? 'queue.flashDeclined' : 'queue.flashRejected', { title });
};

export const Queue = ({
  api,
  tab,
  onDecided,
}: {
  api: ApiClient;
  tab?: string | undefined;
  onDecided?: () => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const current = laneOf(tab);
  const [loaded, setLoaded] = useState<Loaded>({
    blocks: undefined,
    skills: undefined,
    proposals: undefined,
    access: undefined,
  });
  const [loading, setLoading] = useState<Kind[]>([]);
  const [openId, setOpenId] = useState<string | undefined>();
  const [conflict, setConflict] = useState<Conflict | undefined>();
  const [dialog, setDialog] = useState<{ mode: Mode; draft?: Draft } | undefined>();
  const flash = useFlash();

  const load = useCallback(
    async (kinds: Kind[], signal?: AbortSignal) => {
      setLoading((all) => [...new Set([...all, ...kinds])]);
      const settled = await Promise.allSettled(
        kinds.map((k) => laneOf(k).load(api, signal ?? new AbortController().signal, tRef.current)),
      );
      if (signal?.aborted) return undefined;
      const next = Object.fromEntries(
        kinds.map((k, i) => {
          const r = settled[i] as PromiseSettledResult<Row[]>;
          return [k, r.status === 'fulfilled' ? r.value : { error: r.reason as unknown }];
        }),
      ) as Partial<Loaded>;
      setLoaded((all) => ({ ...all, ...next }));
      setLoading((all) => all.filter((k) => !kinds.includes(k)));
      return next;
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(
      lanes.map((l) => l.kind),
      controller.signal,
    ).then((next) => {
      const draft = readDraft();
      if (!next || !draft?.expired) return;
      const list = next[draft.kind];
      if (!Array.isArray(list) || !list.some((r) => r.id === draft.id && !r.outcome)) return;
      navigate('/queue', { tab: draft.kind });
      setOpenId(draft.id);
      setDialog({ mode: draft.mode, draft });
    });
    return () => controller.abort();
  }, [load]);

  const rowsOf = (kind: Kind) => {
    const list = loaded[kind];
    return Array.isArray(list) ? list : [];
  };
  const row = useMemo(
    () => (openId ? rowsOf(current.kind).find((r) => r.id === openId) : undefined),
    [openId, loaded, current.kind],
  );
  const close = useCallback(() => {
    setOpenId(undefined);
    setConflict(undefined);
  }, []);

  const save = async (reason: string, caseNo: string) => {
    if (!row || !dialog) return;
    const { mode } = dialog;
    try {
      await decide(api, row, mode, reason, caseNo || undefined);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        writeDraft({ kind: row.kind, id: row.id, mode, reason, caseNo, expired: true });
        throw error;
      }
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
        const next = await load([row.kind]);
        const list = next?.[row.kind];
        const now = Array.isArray(list) ? list.find((r) => r.id === row.id) : undefined;
        if (now?.outcome) {
          writeDraft(undefined);
          setDialog(undefined);
          setConflict({
            who: deciderOf(now.decision, tRef.current),
            label: decisionLabel(now)[0],
            at: now.decision?.at,
            reason: now.decision?.reason,
          });
          return;
        }
      }
      throw error;
    }
    writeDraft(undefined);
    setDialog(undefined);
    flash.show(flashFor(row, mode, caseNo, tRef.current));
    if (mode !== 'review') setOpenId(undefined);
    await load([row.kind]);
    onDecided?.();
  };

  const count = (kind: Kind) => rowsOf(kind).filter((r) => !r.outcome).length;

  return (
    <>
      <PageHeader eyebrow={t('queue.eyebrow')} title={t('queue.title')} intro={t('queue.intro')} />
      <Flash message={flash.message} />
      <Tabs
        value={current.kind}
        onChange={(v) => {
          flash.clear();
          close();
          navigate('/queue', { tab: v });
        }}
      >
        <TabsList aria-label={t('queue.lanesLabel')}>
          {lanes.map((l) => {
            const list = loaded[l.kind];
            const failed = list !== undefined && !Array.isArray(list);
            const n = count(l.kind);
            return (
              <TabsTab key={l.kind} value={l.kind}>
                {t(l.label)}
                {list === undefined ? null : (
                  <Tag
                    data-size="sm"
                    data-color={failed ? 'danger' : n ? 'warning' : 'neutral'}
                    aria-label={failed ? t('queue.tabFailed') : t('queue.tabWaiting', { count: n })}
                  >
                    {failed ? '!' : String(n)}
                  </Tag>
                )}
              </TabsTab>
            );
          })}
        </TabsList>
        {lanes.map((l) => (
          <TabsPanel key={l.kind} value={l.kind}>
            {l.kind !== current.kind ? null : (
              <LanePanel
                lane={l}
                list={loaded[l.kind]}
                loading={loading.includes(l.kind)}
                onRetry={() => void load([l.kind])}
                onOpen={(r) => {
                  setConflict(undefined);
                  setOpenId(r.id);
                }}
              />
            )}
          </TabsPanel>
        ))}
      </Tabs>
      {row ? (
        <Panel
          api={api}
          lane={current}
          row={row}
          conflict={conflict}
          onClose={close}
          onDecide={(mode) => setDialog({ mode })}
        />
      ) : null}
      <DecisionDialog
        row={dialog ? row : undefined}
        mode={dialog?.mode}
        initial={dialog?.draft}
        onClose={() => {
          writeDraft(undefined);
          setDialog(undefined);
        }}
        onSave={save}
      />
    </>
  );
};
