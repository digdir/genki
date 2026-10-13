import {
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import type { Candidate, CandidateOrigin, CaseType, ServiceTestSet } from '../../api/quality';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { PlainKey, T } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { caseTypeKeys, problemTitle, type SetFlash } from './shared';

const originKeys: Record<string, PlainKey> = {
  feedback: 'quality.originFeedback',
  playground: 'quality.originPlayground',
  assistant: 'quality.originAssistant',
};

const originText = (t: T, o: CandidateOrigin) => t(originKeys[o] ?? 'quality.originOther');

interface Accepting {
  id: string;
  testSet: string;
  expected: string;
  type: CaseType;
  tried: boolean;
}

export const CandidateReview = ({
  api,
  tenant,
  serviceId,
  sets,
  setFlash,
  onAccepted,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  sets: ServiceTestSet[];
  setFlash: SetFlash;
  onAccepted: () => void;
}) => {
  const { t, dateTime } = usePortalFormat();
  const canManage = useRights().has('manage-services');
  const hintId = useId();
  const [round, setRound] = useState(0);
  const [accepting, setAccepting] = useState<Accepting>();
  const [busy, setBusy] = useState(false);
  const [state, retry] = useAsync(
    (signal) => api.quality.candidates(tenant, serviceId, signal),
    [api, tenant, serviceId, round],
  );

  const review = async (c: Candidate, accept: Accepting | undefined) => {
    if (busy || !canManage) return;
    setBusy(true);
    try {
      await api.quality.reviewCandidate(
        tenant,
        c.id,
        accept
          ? {
              decision: 'accept',
              testSet: accept.testSet,
              expected: accept.expected.trim(),
              type: accept.type,
            }
          : { decision: 'reject' },
        t(accept ? 'quality.acceptReason' : 'quality.rejectReason'),
      );
      setAccepting(undefined);
      setRound((r) => r + 1);
      if (accept) {
        const name = sets.find((s) => s.id === accept.testSet)?.name ?? accept.testSet;
        setFlash({ text: t('quality.caseAddedTo', { name }), color: 'success' });
        onAccepted();
      } else setFlash({ text: t('quality.proposalRejected'), color: 'info' });
    } catch (error) {
      setFlash({ text: problemTitle(error, t), color: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const pending =
    state.status === 'ready' ? state.data.filter((c) => c.status.startsWith('pending')) : [];

  return (
    <section aria-labelledby="cand-h" className="stack-sm">
      <Heading level={2} data-size="xs" id="cand-h">
        {t('quality.candidatesTitle')}
      </Heading>
      <Paragraph data-size="sm">{t('quality.candidatesLead')}</Paragraph>
      {state.status === 'loading' ? (
        <Loading label={t('quality.candidatesLoading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} headingLevel={3} />
      ) : pending.length === 0 ? (
        <Paragraph data-size="sm">{t('quality.noCandidates')}</Paragraph>
      ) : (
        <ul className="feedback-list">
          {pending.map((c) => {
            const a = accepting?.id === c.id ? accepting : undefined;
            const set = (p: Partial<Accepting>) => setAccepting((x) => (x ? { ...x, ...p } : x));
            const expectedError = a?.tried && !a.expected.trim() ? t('quality.describeGood') : '';
            return (
              <li key={c.id} className="feedback-item">
                <div className="row-wrap">
                  <Tag data-size="sm" data-color="info">
                    {originText(t, c.origin)}
                  </Tag>
                  <span className="meta">{dateTime(c.createdAt)}</span>
                </div>
                <span className="feedback-q">{c.input}</span>
                {c.expected && !a ? (
                  <span className="feedback-a">
                    {t('quality.goodAnswerIs', { text: c.expected })}
                  </span>
                ) : null}
                {a ? (
                  <div className="quality-panel">
                    {sets.length === 0 ? (
                      <Paragraph data-size="sm">{t('quality.makeSetFirst')}</Paragraph>
                    ) : (
                      <>
                        <Field>
                          <Label htmlFor={`cand-set-${c.id}`}>{t('quality.testSet')}</Label>
                          <Select
                            id={`cand-set-${c.id}`}
                            value={a.testSet}
                            onChange={(e) => set({ testSet: e.target.value })}
                          >
                            {sets.map((s) => (
                              <Select.Option key={s.id} value={s.id}>
                                {s.name}
                              </Select.Option>
                            ))}
                          </Select>
                        </Field>
                        <Field>
                          <Label htmlFor={`cand-exp-${c.id}`}>{t('quality.goodAnswer')}</Label>
                          <Textarea
                            id={`cand-exp-${c.id}`}
                            rows={2}
                            value={a.expected}
                            aria-invalid={expectedError ? true : undefined}
                            onChange={(e) => set({ expected: e.target.value })}
                          />
                          {expectedError ? (
                            <ValidationMessage>{expectedError}</ValidationMessage>
                          ) : null}
                        </Field>
                        <Field>
                          <Label htmlFor={`cand-type-${c.id}`}>{t('quality.type')}</Label>
                          <Select
                            id={`cand-type-${c.id}`}
                            value={a.type}
                            onChange={(e) => set({ type: e.target.value as CaseType })}
                          >
                            {(Object.keys(caseTypeKeys) as CaseType[]).map((type) => (
                              <Select.Option key={type} value={type}>
                                {t(caseTypeKeys[type])}
                              </Select.Option>
                            ))}
                          </Select>
                        </Field>
                      </>
                    )}
                    <div className="actions">
                      {sets.length > 0 ? (
                        <Button
                          variant="primary"
                          data-size="sm"
                          aria-disabled={busy || undefined}
                          onClick={() => {
                            if (!a.expected.trim()) {
                              set({ tried: true });
                              return;
                            }
                            void review(c, a);
                          }}
                        >
                          {t('quality.addToSet')}
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        data-size="sm"
                        onClick={() => setAccepting(undefined)}
                      >
                        {t('quality.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <Button
                      variant="secondary"
                      data-size="sm"
                      aria-disabled={canManage ? undefined : true}
                      aria-describedby={canManage ? undefined : `${hintId}-${c.id}`}
                      onClick={() =>
                        canManage &&
                        setAccepting({
                          id: c.id,
                          testSet: sets[0]?.id ?? '',
                          expected: c.expected ?? '',
                          type: 'criteria',
                          tried: false,
                        })
                      }
                    >
                      {t('quality.accept')}
                    </Button>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-disabled={busy || !canManage || undefined}
                      aria-describedby={canManage ? undefined : `${hintId}-${c.id}`}
                      onClick={() => void review(c, undefined)}
                    >
                      {t('quality.reject')}
                    </Button>
                    {canManage ? null : (
                      <span id={`${hintId}-${c.id}`} className="meta">
                        {needsRight('manage-services', t)}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
