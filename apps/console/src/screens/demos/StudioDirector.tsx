import { Alert, Button, Checkbox, Textarea, Textfield } from '@digdir/designsystemet-react';
import { approvalUsd, editCostUsd } from '@genai/contracts';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient, DemoDetail, DemoRecording } from '../../api';
import { navigate } from '../../hooks';
import { useT } from '../../i18n';
import { minimumReasonLength } from '../../reason';
import { DialogError } from '../../ui';
import { canRecord, queueing, type Edition } from './shared';
import { hasEditList } from './useFilm';

const suggestions = [
  'studio.suggestCalmer',
  'studio.suggestShorterStart',
  'studio.suggestMusic',
] as const;

export const StudioDirector = ({
  api,
  demo,
  editions,
  recording,
}: {
  api: ApiClient;
  demo: DemoDetail;
  editions: Edition[];
  recording: DemoRecording | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const [ask, setAsk] = useState('');
  const [planned, setPlanned] = useState<string | undefined>();
  const [approved, setApproved] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const usd = (value: number) => f.decimal(value, 2);
  const number = (id: string) => editions.find((e) => e.recording.id === id)?.n;
  const past = demo.recordings.filter((r) => r.editOf && r.instruction && r.status === 'recorded');
  const editable = recording && hasEditList(recording) && canRecord(demo.recorder);
  const next = editions.length + 1;
  const estimate = recording ? editCostUsd(recording.steps) : 0;
  const cap = approvalUsd(estimate);

  const send = () => {
    const text = ask.trim();
    if (!text) return;
    setPlanned(text);
    setAsk('');
    setApproved(false);
    setError(undefined);
  };

  const make = async () => {
    if (!recording || !planned || !approved) return;
    if (reason.trim().length < minimumReasonLength) {
      setError(t('studio.reasonShort', { min: minimumReasonLength }));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const queued = await queueing(t, () =>
        api.requestEdit(demo.id, reason.trim(), recording.id, planned, cap),
      );
      navigate('/demos', { recording: queued.id });
    } catch (failure) {
      setError(failure instanceof DialogError ? failure.message : t('studio.editFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="director">
      <div className="chat">
        {past.map((r) => (
          <div key={r.id} className="chat-past">
            {t('studio.pastEdit', { n: number(r.id) ?? '', instruction: r.instruction ?? '' })}
            {r.costUsd !== undefined ? ` · ${usd(r.costUsd)} USD` : ''}
          </div>
        ))}
        <div className="chat-director">
          <span className="chat-avatar" aria-hidden="true">
            R
          </span>
          <div className="chat-bubble">
            {editable
              ? t('studio.directorHello')
              : !canRecord(demo.recorder)
                ? t('demos.recordingNotSetUp')
                : t('studio.directorNoEditList')}
          </div>
        </div>
        {planned ? (
          <>
            <div className="chat-me">{planned}</div>
            <div className="chat-director is-wide">
              <span className="chat-avatar" aria-hidden="true">
                R
              </span>
              <section className="plan" aria-label={t('studio.planFor', { n: next })}>
                <div className="plan-head">{t('studio.planFor', { n: next })}</div>
                <ul>
                  <li>{t('studio.planInstruction', { instruction: planned })}</li>
                  <li>{t('studio.planSameCapture')}</li>
                </ul>
                <dl className="plan-cost">
                  <dt>{t('studio.estimated')}</dt>
                  <dd>{usd(estimate)} USD</dd>
                  {recording?.costCapUsd !== undefined ? (
                    <>
                      <dt>{t('studio.spentOnFilm')}</dt>
                      <dd>
                        {t('studio.spentOf', {
                          spent: usd(recording.costUsd ?? 0),
                          cap: recording.costCapUsd,
                        })}
                      </dd>
                    </>
                  ) : null}
                </dl>
                <div className="plan-ok">
                  <Checkbox
                    label={t('demos.costApprove', { usd: cap })}
                    checked={approved}
                    onChange={(e) => setApproved(e.target.checked)}
                  />
                  <Textfield
                    label={t('studio.reason')}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  {error ? (
                    <Alert data-color="danger" data-size="sm">
                      {error}
                    </Alert>
                  ) : null}
                  <Button data-size="sm" disabled={!approved || busy} onClick={() => void make()}>
                    {t('studio.makeEdition', { n: next })}
                  </Button>
                </div>
              </section>
            </div>
          </>
        ) : null}
      </div>
      {editable ? (
        <>
          <div className="chat-suggest">
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => setAsk(t(s))}>
                {t(s)}
              </button>
            ))}
          </div>
          <form
            className="chat-ask"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <Textarea
              aria-label={t('studio.askLabel')}
              placeholder={t('studio.askLabel')}
              rows={1}
              maxLength={2000}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
            />
            <Button type="submit" data-size="sm" disabled={!ask.trim()}>
              {t('studio.send')}
            </Button>
          </form>
        </>
      ) : null}
    </div>
  );
};
