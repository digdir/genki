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
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { Improvement, ImprovementStatus } from '../../api/quality';
import { answerLanguages, type AnswerLanguage } from '../../data/service-languages';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { servicePath } from '../service/sections';
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
  onDecide,
}: {
  p: Improvement;
  serviceId: string;
  busy: boolean;
  onDecide: (approve: boolean, comment: string) => void;
}) => {
  const { t, f, dateTime } = usePortalFormat();
  const pct = (n: number) => f.percent(n);
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [labelKey, color] = statusTag[p.status] ?? [undefined, 'neutral'];
  const label = labelKey ? t(labelKey) : p.status;
  const heading = `proposal-${p.id}`;
  const reasons = reasonsOf(p.reasons);
  const s = p.scores;
  return (
    <section aria-labelledby={heading} className="proposal-detail">
      <div className="row-wrap">
        <Heading level={2} data-size="xs" id={heading}>
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
      {reasons.length ? (
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('quality.why')}
          </Heading>
          <ul className="bullets">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.change ? (
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('quality.whatChanges')}
          </Heading>
          <DiffLines
            title={fieldName(t, p.change.path, p.language)}
            before={p.change.before}
            after={p.change.after}
          />
        </div>
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
        <div className="stack-sm">
          <Heading level={3} data-size="2xs">
            {t('quality.examples')}
          </Heading>
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
      ) : null}
      {p.status === 'approved' ? (
        <Alert data-color="success" data-size="sm">
          <Paragraph data-size="sm">
            {t.rich('quality.impApprovedText', {
              link: (c) => <Link href={`#${servicePath(serviceId, 'setup')}`}>{c}</Link>,
            })}
          </Paragraph>
        </Alert>
      ) : null}
      {p.status === 'ready' ? (
        <div className="proposal-actions stack-sm">
          <Field className="reason-field">
            <Label htmlFor={`imp-com-${p.id}`}>{t('quality.comment')}</Label>
            <Field.Description>{t('quality.requiredIfReject')}</Field.Description>
            <Textarea
              id={`imp-com-${p.id}`}
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
              aria-disabled={busy || undefined}
              onClick={() => !busy && onDecide(true, comment.trim())}
            >
              {t('quality.acceptInDraft')}
            </Button>
            <Button
              variant="secondary"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                if (!comment.trim()) {
                  setError(t('quality.whyReject'));
                  return;
                }
                onDecide(false, comment.trim());
              }}
            >
              {t('quality.reject')}
            </Button>
          </div>
        </div>
      ) : null}
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
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
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

  const act = async (work: () => Promise<unknown>, done: string, color: 'success' | 'info') => {
    if (busy) return;
    setBusy(true);
    setNotAllowed(undefined);
    try {
      await work();
      setFlash({ text: done, color });
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

  return (
    <div className="stack">
      <Alert data-color="info">
        <Paragraph>
          {t.rich('quality.impNothingChanges', { strong: (c) => <strong>{c}</strong> })}
        </Paragraph>
      </Alert>
      <div className="row-between">
        <Paragraph data-size="sm">{t('quality.impLead')}</Paragraph>
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
          variant="primary"
          aria-disabled={busy || running || undefined}
          onClick={() =>
            !running &&
            void act(
              () =>
                api.quality.startImprovement(
                  tenant,
                  serviceId,
                  t('quality.impStartReason'),
                  language || undefined,
                ),
              t('quality.impStarted'),
              'info',
            )
          }
        >
          {t('quality.impPropose')}
        </Button>
      </div>
      {notAllowed ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">{notAllowed}</Paragraph>
          <Link href={`#${servicePath(serviceId, 'setup', '/how')}`}>
            {t('quality.impGoSetting')}
          </Link>
        </Alert>
      ) : null}
      {state.status === 'loading' && !seen.current ? (
        <Loading label={t('quality.impLoading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : list.length === 0 ? (
        <div className="state empty">
          <Heading level={2} data-size="2xs">
            {t('quality.impNone')}
          </Heading>
          <Paragraph>{t('quality.impNoneText')}</Paragraph>
        </div>
      ) : (
        list.map((p) => (
          <ProposalCard
            key={p.id}
            p={p}
            serviceId={serviceId}
            busy={busy}
            onDecide={(approve, comment) =>
              void act(
                () =>
                  api.quality.decideImprovement(
                    tenant,
                    serviceId,
                    p.id,
                    approve,
                    comment || t(approve ? 'quality.impApproveReason' : 'quality.impRejectReason'),
                  ),
                t(approve ? 'quality.impApprovedFlash' : 'quality.proposalRejected'),
                approve ? 'success' : 'info',
              )
            }
          />
        ))
      )}
    </div>
  );
};
