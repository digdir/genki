import { Button, Heading, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import { demoVoiceProviders, demoVoices, silentVoice, type DemoVoice } from '@genai/contracts';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient, type DemoDetail } from '../../api';
import { navigate, useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { EmptyState, ErrorState, Loading } from '../../states';
import { DialogError, ReasonDialog } from '../../ui';
import { specOnly } from './Editor';
import { demoHref, editionsOf } from './shared';

type Language = 'nb' | 'en';

const languageOf = (voice: DemoVoice): Language => (voice.language === 'nb-NO' ? 'nb' : 'en');

const languageKey = {
  'nb-NO': 'demos.voiceNbNo',
  'en-GB': 'demos.voiceEnGb',
  'en-US': 'demos.voiceEnUs',
} as const;

const genderKey = { female: 'demos.voiceFemale', male: 'demos.voiceMale' } as const;

export const loudnessTargets = { voice: -15, music: -37, peak: -1 };

const floor = -60;
const percentOf = (db: number) => Math.max(0, Math.min(100, (100 * (db - floor)) / -floor));

const Meter = ({
  label,
  value,
  target,
  unit,
}: {
  label: string;
  value: number;
  target: number;
  unit: string;
}) => {
  const t = useT();
  const f = useFormat();
  const shown = `${f.decimal(value, 1)} ${unit}`;
  return (
    <div className="loud-row">
      <span>{label}</span>
      <span
        className="loud-scale"
        role="img"
        aria-label={t('studio.meterLabel', { what: label, value: shown, target: f.number(target) })}
      >
        <span className="loud-fill" style={{ width: `${percentOf(value)}%` }} />
        <span className="loud-target" style={{ left: `${percentOf(target)}%` }} />
      </span>
      <span className="num small">{shown}</span>
    </div>
  );
};

const SoundForm = ({ api, demo }: { api: ApiClient; demo: DemoDetail }) => {
  const t = useT();
  const [voice, setVoice] = useState(demo.voice);
  const chosen = demoVoices.find((v) => v.id === voice);
  const [language, setLanguage] = useState<Language>(
    chosen ? languageOf(chosen) : demo.language.startsWith('nb') ? 'nb' : 'en',
  );
  const [music, setMusic] = useState(demo.music);
  const [saving, setSaving] = useState(false);
  const changed = voice !== demo.voice || music !== demo.music;
  const latest = editionsOf(demo.recordings).at(-1);
  const sound = latest?.recording.sound;

  return (
    <>
      <nav aria-label={t('demos.breadcrumb')} className="demo-crumbs">
        <Link href="#/demos">{t('demos.back')}</Link>
        <span aria-hidden="true">›</span>
        <Link href={demoHref(demo.id)}>{demo.title}</Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{t('studio.voiceAndSound')}</span>
      </nav>
      <div className="film-head">
        <Heading level={1} data-size="md">
          {t('studio.voiceAndSound')}
        </Heading>
        <div className="actions-row">
          <Button asChild variant="secondary" data-size="sm">
            <a href={demoHref(demo.id)}>{t('studio.backToStudio')}</a>
          </Button>
          <Button data-size="sm" disabled={!changed} onClick={() => setSaving(true)}>
            {t('demos.save')}
          </Button>
        </div>
      </div>
      <ReasonDialog
        open={saving}
        title={t('studio.saveVoiceTitle')}
        text={t('demos.saveText')}
        confirmLabel={t('demos.save')}
        onClose={() => setSaving(false)}
        onConfirm={async (reason) => {
          try {
            await api.saveDemo(
              demo.id,
              specOnly({
                ...(({ music: _, ...rest }) => rest)(demo),
                voice,
                language: chosen?.language ?? demo.language,
                ...(music ? { music } : {}),
              }),
              reason,
              demo.version,
            );
          } catch (error) {
            if (error instanceof ApiError && error.status === 409)
              throw new DialogError(t('demos.saveMoved'));
            throw error;
          }
          navigate('/demos', { demo: demo.id });
        }}
      />
      <div className="vs-grid">
        <section className="dp" aria-labelledby="sound-voice">
          <div className="dp-head">
            <Heading level={2} data-size="xs" id="sound-voice">
              {t('demos.voice')}
            </Heading>
            <span className="grow" />
            <div className="seg" role="group" aria-label={t('studio.language')}>
              <button
                type="button"
                aria-pressed={language === 'nb'}
                onClick={() => setLanguage('nb')}
              >
                {t('studio.bokmal')}
              </button>
              <button
                type="button"
                aria-pressed={language === 'en'}
                onClick={() => setLanguage('en')}
              >
                {t('studio.english')}
              </button>
            </div>
          </div>
          {demoVoiceProviders.map((provider) => {
            const voices = demoVoices.filter(
              (v) => v.provider === provider.id && languageOf(v) === language,
            );
            if (provider.available && voices.length === 0) return null;
            return (
              <fieldset key={provider.id} className="provider">
                <legend className="provider-head">
                  <span>{provider.name}</span>
                  {!provider.available ? (
                    <Tag data-color="neutral" data-size="sm">
                      {t('studio.notBuilt')}
                    </Tag>
                  ) : provider.needsApproval ? (
                    <Tag data-color="warning" data-size="sm">
                      {t('studio.needsApproval')}
                    </Tag>
                  ) : null}
                </legend>
                <ul className="voices">
                  {(provider.available ? voices : []).map((v) => (
                    <li key={v.id} className={`voice${voice === v.id ? ' is-on' : ''}`}>
                      <input
                        type="radio"
                        name="studio-voice"
                        id={`voice-${v.id}`}
                        checked={voice === v.id}
                        onChange={() => setVoice(v.id)}
                      />
                      <label htmlFor={`voice-${v.id}`}>
                        <span className="voice-name">{v.name}</span>
                        <span className="muted small">
                          {t(languageKey[v.language])} · {t(genderKey[v.gender])}
                        </span>
                      </label>
                      <span className="muted small">
                        {voice === v.id ? t('studio.chosen') : ''}
                      </span>
                      <Button
                        variant="secondary"
                        data-size="sm"
                        disabled
                        aria-label={t('studio.listenTo', { name: v.name })}
                      >
                        {t('studio.listen')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </fieldset>
            );
          })}
          <ul className="voices provider">
            <li className={`voice${voice === silentVoice ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="studio-voice"
                id="voice-none"
                checked={voice === silentVoice}
                onChange={() => setVoice(silentVoice)}
              />
              <label htmlFor="voice-none">
                <span className="voice-name">{t('demos.voiceNone')}</span>
                <span className="muted small">{t('demos.voiceNoneHelp')}</span>
              </label>
              <span className="muted small">{voice === silentVoice ? t('studio.chosen') : ''}</span>
            </li>
          </ul>
          <Paragraph data-size="sm" className="muted dp-body dp-foot">
            {t('studio.listenLater')}
          </Paragraph>
        </section>
        <div className="stack">
          <section className="dp" aria-labelledby="sound-music">
            <div className="dp-head">
              <Heading level={2} data-size="xs" id="sound-music">
                {t('studio.music')}
              </Heading>
            </div>
            <div className="dp-body">
              <div className="beds" role="radiogroup" aria-labelledby="sound-music">
                <button
                  type="button"
                  className={`bed${music ? '' : ' is-on'}`}
                  role="radio"
                  aria-checked={!music}
                  onClick={() => setMusic(undefined)}
                >
                  <b>{t('studio.musicNone')}</b>
                  <span className="muted xs">{t('studio.musicNoneHelp')}</span>
                </button>
                <button
                  type="button"
                  className={`bed${music === 'pulse' ? ' is-on' : ''}`}
                  role="radio"
                  aria-checked={music === 'pulse'}
                  onClick={() => setMusic('pulse')}
                >
                  <b>{t('studio.musicPulse')}</b>
                  <span className="muted xs">{t('studio.musicDucked')}</span>
                </button>
              </div>
            </div>
          </section>
          {sound && latest ? (
            <section className="dp" aria-labelledby="sound-level">
              <div className="dp-head">
                <Heading level={2} data-size="xs" id="sound-level">
                  {t('studio.loudness')}
                </Heading>
                <span className="muted small">{t('studio.measuredIn', { n: latest.n })}</span>
              </div>
              <div className="dp-body stack-sm">
                {sound.voice !== undefined ? (
                  <Meter
                    label={t('studio.meterVoice')}
                    value={sound.voice}
                    target={loudnessTargets.voice}
                    unit="LUFS"
                  />
                ) : null}
                {sound.music !== undefined ? (
                  <Meter
                    label={t('studio.meterMusic')}
                    value={sound.music}
                    target={loudnessTargets.music}
                    unit="LUFS"
                  />
                ) : null}
                <Meter
                  label={t('studio.meterPeak')}
                  value={sound.peak}
                  target={loudnessTargets.peak}
                  unit="dBFS"
                />
                <Paragraph data-size="sm" className="muted">
                  {t('studio.loudnessHelp', {
                    voice: loudnessTargets.voice,
                    music: loudnessTargets.music,
                  })}
                </Paragraph>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
};

export const SoundScreen = ({ api, id }: { api: ApiClient; id: string }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.demo(id, signal), [api, id]);
  if (state.status === 'loading') return <Loading label={t('demos.loading')} />;
  if (state.status === 'error')
    return (state.error as { status?: number }).status === 404 ? (
      <EmptyState title={t('demos.notFoundTitle')} />
    ) : (
      <ErrorState error={state.error} onRetry={retry} />
    );
  return <SoundForm key={state.data.version} api={api} demo={state.data} />;
};
