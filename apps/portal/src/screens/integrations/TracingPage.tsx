import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Heading,
  Radio,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type {
  TraceConnection as Listed,
  TraceConnectionInput,
  TraceInstance,
} from '../../api/tracing';
import { reasonProblem } from '../../components/ReasonField';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { LiveTracing } from './LiveTracing';
import { PageError, PageLead } from './PageStates';

export const sampleRates = [100, 25, 10] as const;

type TraceConnection = Listed & { sampleRate?: number };

const problemText = (t: T, error: unknown) =>
  error instanceof ApiError && error.problem?.errors?.length
    ? error.problem.errors.map((e) => e.message).join('. ')
    : t('devTracing.saveFailed');

/** Text goes to Digdir's Langfuse only once operators allow it; one already sending can stop. */
const offersContent = (c: TraceConnection, instance: TraceInstance | undefined) =>
  !c.instance || instance?.content === true || c.content;

interface Draft {
  content: boolean;
  sampleRate?: number;
}

const Connection = ({
  api,
  tenant,
  connection: c,
  instance,
  many,
  onSaved,
}: {
  api: ApiClient;
  tenant: string;
  connection: TraceConnection;
  instance: TraceInstance | undefined;
  many: boolean;
  onSaved: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const canManage = useRights().has('manage-services');
  const saved: Draft = {
    content: c.content,
    ...(c.sampleRate === undefined ? {} : { sampleRate: c.sampleRate }),
  };
  const [draft, setDraft] = useState<Draft>(saved);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [savedAt, setSavedAt] = useState<Date>();
  const dirty =
    draft.content !== saved.content || (draft.sampleRate ?? 100) !== (saved.sampleRate ?? 100);
  const reasonError = tried ? reasonProblem(reason, t) : undefined;
  const headingId = `trace-${c.id}`;

  const save = async () => {
    setTried(true);
    if (reasonProblem(reason, t) || busy) return;
    setBusy(true);
    setFailed(undefined);
    try {
      const input: TraceConnectionInput & { sampleRate?: number } = {
        host: c.host,
        publicKey: c.publicKey,
        secretKey: c.secretKey,
        services: c.services,
        ...(c.residencySetBy === 'tenant' ? { residency: c.residency } : {}),
        content: draft.content,
        erasureDeclared: c.erasureDeclared,
        labels: c.labels === true,
        ...(draft.sampleRate === undefined ? {} : { sampleRate: draft.sampleRate }),
      };
      await api.tracing.save(tenant, c.id, input, reason.trim());
      setSavedAt(new Date());
      setReason('');
      setTried(false);
      onSaved();
    } catch (error) {
      setFailed(problemText(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack-md"
      aria-labelledby={`${headingId}-what`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section className="stack-sm dev-section" aria-labelledby={`${headingId}-what`}>
        <Heading level={3} data-size="xs" id={`${headingId}-what`}>
          {many ? t('devTracing.whatIsTracedIn', { id: c.id }) : t('devTracing.whatIsTraced')}
        </Heading>
        {draft.sampleRate === undefined ? null : (
          <Fieldset>
            <Fieldset.Legend>{t('devTracing.share')}</Fieldset.Legend>
            <Fieldset.Description>{t('devTracing.failedAlways')}</Fieldset.Description>
            {sampleRates.map((rate) => (
              <Radio
                key={rate}
                name={`${headingId}-rate`}
                label={t(
                  rate === 100
                    ? 'devTracing.rateAll'
                    : rate === 25
                      ? 'devTracing.rateQuarter'
                      : 'devTracing.rateTenth',
                )}
                value={String(rate)}
                checked={draft.sampleRate === rate}
                disabled={!canManage}
                onChange={() => setDraft({ ...draft, sampleRate: rate })}
              />
            ))}
          </Fieldset>
        )}
        {offersContent(c, instance) ? (
          <Checkbox
            label={t('devTracing.content')}
            description={t('devTracing.contentHelp')}
            checked={draft.content}
            disabled={!canManage}
            onChange={() => setDraft({ ...draft, content: !draft.content })}
          />
        ) : (
          <p className="meta">{t('devTracing.contentNotOffered')}</p>
        )}
      </section>
      {dirty ? (
        <div role="region" aria-label={t('devTracing.unsaved')} className="dev-save-bar">
          <div className="row-wrap">
            <strong className="dev-save-bar-title">{t('devTracing.unsaved')}</strong>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setDraft(saved);
                setTried(false);
                setFailed(undefined);
              }}
            >
              {t('devTracing.discard')}
            </Button>
            <Button type="submit" aria-busy={busy ? true : undefined}>
              {busy ? t('devTracing.saving') : t('devTracing.save')}
            </Button>
          </div>
          <Textfield
            className="int-field-md"
            label={t('devTracing.why')}
            description={t('integrations.reasonRequired')}
            value={reason}
            error={reasonError}
            onChange={(e) => setReason(e.target.value)}
          />
          {failed ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {failed}
            </Alert>
          ) : null}
        </div>
      ) : null}
      {savedAt && !dirty ? (
        <p role="status" className="dev-msg-ok">
          {t('devTracing.saved', { time: f.time(savedAt) })}
        </p>
      ) : null}
    </form>
  );
};

/** Sporing og evaluering: the tenant's Langfuse connections, and what each of them is sent. */
export const TracingPage = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const [round, setRound] = useState(0);
  const [flash, setFlash] = useState<{ text: string; color: 'success' | 'info' | 'danger' }>();
  const [state, retry] = useAsync(
    (signal) => api.tracing.listing(tenant, signal),
    [api, tenant, round],
    { keepPreviousFor: tenant },
  );
  return (
    <>
      <PageLead text={t('devTracing.lead')} />
      <div aria-live="polite">
        {flash ? (
          <Alert data-color={flash.color} data-size="sm">
            {flash.text}
          </Alert>
        ) : null}
      </div>
      {state.status === 'error' ? (
        <PageError
          error={state.error}
          title={t('devTracing.errorTitle')}
          text={t('devTracing.errorText')}
          onRetry={retry}
        />
      ) : (
        <LiveTracing
          api={api}
          tenant={tenant}
          round={round}
          onFlash={(text, color = 'success') => {
            setFlash({ text, color });
            setRound((r) => r + 1);
          }}
        />
      )}
      {state.status === 'ready'
        ? state.data.data
            .filter((c) => !c.removing)
            .map((c) => (
              <Connection
                key={c.id}
                api={api}
                tenant={tenant}
                connection={c}
                instance={state.data.instance}
                many={state.data.data.length > 1}
                onSaved={() => setRound((r) => r + 1)}
              />
            ))
        : null}
    </>
  );
};
