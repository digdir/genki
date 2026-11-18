import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Link,
  Paragraph,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { Improvement, ImprovementStatus } from '../../api/quality';
import { answerLanguages, type AnswerLanguage } from '../../data/service-languages';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { rightLabel, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { servicePath } from '../service/sections';
import { draftChanged } from '../service/draft-events';
import { DiffLines } from './DiffLines';
import { problemTitle, type SetFlash } from './shared';

const pollMs = 2000;

const refusedByService = (error: unknown) =>
  error instanceof ApiError &&
  error.status === 409 &&
  (error.problem?.errors ?? []).some((e) => e.path === 'spec.improve.allow');

const statusTag: Record<
  ImprovementStatus,
  [PlainKey, 'info' | 'success' | 'danger' | 'neutral' | 'warning']
> = {
  running: ['quality.impRunning', 'info'],
  ready: ['quality.impReady', 'warning'],
  failed: ['quality.impFailed', 'danger'],
  approved: ['quality.impApproved', 'success'],
  rejected: ['quality.impRejected', 'neutral'],
};

const languageTabKeys: Record<AnswerLanguage, PlainKey> = {
  nb: 'languageTabs.tabNb',
  nn: 'languageTabs.tabNn',
  en: 'languageTabs.tabEn',
};

const fieldName = (t: T, path: string, language?: string) =>
  language && language in languageTabKeys
    ? t('quality.fieldLanguageText', { language: t(languageTabKeys[language as AnswerLanguage]) })
    : /instructions/.test(path)
      ? t('quality.fieldInstructions')
      : /description/.test(path)
        ? t('quality.fieldDescription')
        : path;

const reasonsOf = (r: Improvement['reasons']) =>
  Array.isArray(r) ? r : typeof r === 'string' && r.trim() ? [r] : [];

const ProposalCard = ({
  p,
  serviceId,
  busy,
  canDecide,
  onDecide,
}: {
  p: Improvement;
  serviceId: string;
  busy: 'approve' | 'reject' | undefined;
  canDecide: boolean;
  onDecide: (approve: boolean) => void;
}) => {
  const { t, f, dateTime } = usePortalFormat();
  const pct = (n: number) => f.percent(n);
  const [labelKey, color] = statusTag[p.status] ?? [undefined, 'neutral'];
  const label = labelKey ? t(labelKey) : p.status;
  const heading = `proposal-${p.id}`;
  const reasons = reasonsOf(p.reasons);
  const s = p.scores;
  const decidedAt = p.decision?.at ? dateTime(p.decision.at) : undefined;
  return (
    <section aria-labelledby={heading} className="proposal-detail">
      <div className="row-wrap">
        <Heading level={3} data-size="2xs" id={heading}>
          {t('quality.impFrom', { when: dateTime(p.createdAt) })}
        </Heading>
        <Tag data-size="sm" data-color={color}>
          {label}
        </Tag>
      </div>
      {p.status === 'running' ? (
        <Paragraph data-size="sm">{t('quality.impRunningText')}</Paragraph>
      ) : null}
      {p.status === 'failed' ? (
        <Paragraph data-size="sm">{t('quality.impFailedText')}</Paragraph>
      ) : null}
      {p.change ? (
        <DiffLines
          title={fieldName(t, p.change.path, p.language)}
          before={p.change.before}
          after={p.change.after}
        />
      ) : null}
      {reasons.length ? (
        <Paragraph data-size="sm" className="meta">
          {reasons.join(' ')}
        </Paragraph>
      ) : null}
      {s ? (
        <dl className="proposal-facts">
          <div className={s.after >= s.before ? 'locked up' : 'locked down'}>
            <dt>{t('quality.setScore')}</dt>
            <dd className="big">
              {pct(s.before)} → {pct(s.after)}
            </dd>
            <dd className="small">
              {t('quality.passedCounts', {
                before: s.passedBefore,
                total: s.total,
                after: s.passedAfter,
              })}
            </dd>
            <dd className="small">{t('quality.lockedNeverUsed')}</dd>
          </div>
        </dl>
      ) : null}
      {p.examples?.length ? (
        <details>
          <summary>{t('quality.examples')}</summary>
          <div className="stack-sm">
            {p.examples.slice(0, 3).map((e) => (
              <div key={e.input} className="example good">
                <strong>{e.input}</strong>
                <div className="example-pair">
                  <div>
                    <span className="diff-label">{t('quality.now')}</span>
                    <span>{e.before}</span>
                  </div>
                  <div>
                    <span className="diff-label">{t('quality.withProposal')}</span>
                    <span>{e.after}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {p.status === 'ready' && canDecide ? (
        <div className="actions">
          <Button
            variant="primary"
            aria-busy={busy === 'approve' || undefined}
            aria-disabled={busy ? true : undefined}
            onClick={() => !busy && onDecide(true)}
          >
            {busy === 'approve' ? t('qualityPage.saving') : t('qualityPage.approve')}
          </Button>
          <Button
            variant="secondary"
            aria-busy={busy === 'reject' || undefined}
            aria-disabled={busy ? true : undefined}
            onClick={() => !busy && onDecide(false)}
          >
            {busy === 'reject' ? t('qualityPage.saving') : t('quality.reject')}
          </Button>
        </div>
      ) : null}
      <div role="status">
        {p.status === 'approved' ? (
          <Paragraph data-size="sm" className="success-text">
            {t.rich(decidedAt ? 'qualityPage.approvedAt' : 'qualityPage.approved', {
              when: decidedAt ?? '',
              link: (c) => <Link href={`#${servicePath(serviceId, 'setup')}`}>{c}</Link>,
            })}
          </Paragraph>
        ) : p.status === 'rejected' ? (
          <Paragraph data-size="sm">
            {decidedAt
              ? t('qualityPage.rejectedAt', { when: decidedAt })
              : t('qualityPage.rejected')}
          </Paragraph>
        ) : null}
      </div>
    </section>
  );
};

export const Improvements = ({
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
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<{ id: string; approve: boolean }>();
  const [state, retry] = useAsync(
    (signal) => api.quality.improvements(tenant, serviceId, signal),
    [api, tenant, serviceId, round],
  );
  const seen = useRef<Improvement[] | undefined>(undefined);
  if (state.status === 'ready') seen.current = state.data;
  const list = seen.current ?? [];
  const running = list.some((p) => p.status === 'running');

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setRound((r) => r + 1), pollMs);
    return () => clearTimeout(timer);
  }, [running, round]);

  const [notAllowed, setNotAllowed] = useState<string>();
  const [language, setLanguage] = useState<AnswerLanguage | ''>('');
  const languageId = useId();

  const start = async () => {
    if (busy || running) return;
    setBusy(true);
    setNotAllowed(undefined);
    try {
      await api.quality.startImprovement(
        tenant,
        serviceId,
        t('quality.impStartReason'),
        language || undefined,
      );
      setFlash({ text: t('quality.impStarted'), color: 'info' });
      setRound((r) => r + 1);
    } catch (error) {
      if (refusedByService(error)) {
        setFlash(undefined);
        setNotAllowed(problemTitle(error, t));
      } else setFlash({ text: problemTitle(error, t), color: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const decide = async (p: Improvement, approve: boolean) => {
    if (deciding) return;
    setDeciding({ id: p.id, approve });
    try {
      const decided = await api.quality.decideImprovement(
        tenant,
        serviceId,
        p.id,
        approve,
        t(approve ? 'quality.impApproveReason' : 'quality.impRejectReason'),
      );
      seen.current = list.map((x) => (x.id === p.id ? { ...x, ...decided } : x));
      setRound((r) => r + 1);
      if (approve) draftChanged(tenant, serviceId);
    } catch (error) {
      setFlash({ text: problemTitle(error, t), color: 'danger' });
    } finally {
      setDeciding(undefined);
    }
  };

  return (
    <section aria-labelledby="quality-proposals-h" className="quality-section">
      <div className="stack-xs">
        <Heading level={2} data-size="sm" id="quality-proposals-h">
          {t('qualityPage.proposalsTitle')}
        </Heading>
        <Paragraph>{t('qualityPage.proposalsLead')}</Paragraph>
      </div>
      {canManage ? null : (
        <Paragraph className="quality-note">
          {t('qualityPage.proposalsNoRight', { right: rightLabel(t, 'manage-services') })}
        </Paragraph>
      )}
      {notAllowed ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">{notAllowed}</Paragraph>
          <Link href={`#${servicePath(serviceId, 'setup', '/how')}`}>
            {t('quality.impGoSetting')}
          </Link>
        </Alert>
      ) : null}
      {state.status === 'loading' && !seen.current ? (
        <Loading label={t('quality.impLoading')} shape="list" headingLevel={3} onRetry={retry} />
      ) : state.status === 'error' && !seen.current ? (
        <ErrorState error={state.error} onRetry={retry} headingLevel={3} />
      ) : list.length === 0 ? (
        <div className="state empty">
          <Heading level={3} data-size="2xs">
            {t('quality.impNone')}
          </Heading>
          <Paragraph>{t('quality.impNoneText')}</Paragraph>
        </div>
      ) : (
        <ul className="quality-rows proposal-list">
          {list.map((p) => (
            <li key={p.id}>
              <ProposalCard
                p={p}
                serviceId={serviceId}
                busy={deciding?.id === p.id ? (deciding.approve ? 'approve' : 'reject') : undefined}
                canDecide={canManage}
                onDecide={(approve) => void decide(p, approve)}
              />
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="filter-row align-end">
          <Field className="narrow-field" data-size="sm">
            <Label htmlFor={languageId}>{t('quality.impScope')}</Label>
            <Select
              id={languageId}
              value={language}
              onChange={(e) => setLanguage(e.target.value as AnswerLanguage | '')}
            >
              <Select.Option value="">{t('quality.impScopeShared')}</Select.Option>
              {answerLanguages.map((l) => (
                <Select.Option key={l} value={l}>
                  {t('quality.impScopeLanguage', { language: t(languageTabKeys[l]) })}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            aria-disabled={busy || running || undefined}
            onClick={() => void start()}
          >
            {t('quality.impPropose')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
