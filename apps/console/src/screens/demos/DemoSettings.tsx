import { Alert, Button, Heading, Paragraph, Textfield } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient, type DemoSettings, type DemoSettingsView } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { DialogError, Flash, PageHeader, ReasonDialog, useFlash } from '../../ui';
import { actorName, Crumbs, useFileUrl } from './shared';
import { VoiceSelect } from './VoiceSelect';

const recorderText = {
  job: 'demos.settingsRecorderJob',
  scheduled: 'demos.settingsRecorderScheduled',
  workflow: 'demos.settingsRecorderWorkflow',
} as const;

const settingsOf = (view: DemoSettingsView): DemoSettings => ({
  voice: view.voice,
  viewport: view.viewport,
  tenant: view.tenant,
  login: view.login,
  retentionDays: view.retentionDays,
  writerDailyTokens: view.writerDailyTokens,
});

const Sample = ({ api, view }: { api: ApiClient; view: DemoSettingsView }) => {
  const t = useT();
  const sample = useFileUrl(api, view.sample?.recording, view.sample?.file);
  return (
    <section aria-labelledby="demo-voice-sample" className="card stack">
      <Heading level={2} data-size="xs" id="demo-voice-sample">
        {t('demos.sampleHeading')}
      </Heading>
      {sample.status === 'missing' ? (
        <Paragraph data-size="sm">{t('demos.sampleMissing', { voice: view.voice })}</Paragraph>
      ) : sample.status === 'error' ? (
        <Alert data-color="danger">{t('demos.sampleFailed')}</Alert>
      ) : sample.status === 'ready' ? (
        <audio
          controls
          src={sample.url}
          aria-label={t('demos.sampleLabel', { voice: view.voice })}
        />
      ) : null}
    </section>
  );
};

const Form = ({
  api,
  view,
  onSaved,
}: {
  api: ApiClient;
  view: DemoSettingsView;
  onSaved: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [draft, setDraft] = useState(() => settingsOf(view));
  const [saving, setSaving] = useState(false);
  const set = (change: Partial<DemoSettings>) => setDraft((d) => ({ ...d, ...change }));
  const number = (value: string) => (value === '' ? 0 : Number(value));
  const tenantInvalid = draft.tenant !== null && !/^\d{9}$/.test(draft.tenant);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settingsOf(view));
  return (
    <>
      <Paragraph data-size="sm" className="muted">
        {view.version > 0 && view.updatedAt
          ? t('demos.settingsChanged', {
              who: actorName(view.updatedBy),
              when: f.dateTime(new Date(view.updatedAt), 'medium'),
            })
          : t('demos.settingsDefaults')}{' '}
        {t(recorderText[view.recorder])}
      </Paragraph>
      <div className="demo-detail">
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
          }}
        >
          <VoiceSelect
            label={t('demos.settingsVoice')}
            description={t('demos.settingsVoiceHelp')}
            value={draft.voice}
            onChange={(voice) => set({ voice })}
          />
          <fieldset className="demo-viewport">
            <legend>{t('demos.settingsViewport')}</legend>
            <Textfield
              label={t('demos.settingsWidth')}
              type="number"
              min={320}
              max={3840}
              value={draft.viewport[0]}
              onChange={(e) => set({ viewport: [number(e.target.value), draft.viewport[1]] })}
            />
            <Textfield
              label={t('demos.settingsHeight')}
              type="number"
              min={320}
              max={3840}
              value={draft.viewport[1]}
              onChange={(e) => set({ viewport: [draft.viewport[0], number(e.target.value)] })}
            />
          </fieldset>
          <Textfield
            label={t('demos.settingsTenant')}
            description={t('demos.settingsTenantHelp')}
            inputMode="numeric"
            value={draft.tenant ?? ''}
            error={tenantInvalid ? t('demos.settingsTenantHelp') : undefined}
            onChange={(e) => set({ tenant: e.target.value.trim() || null })}
          />
          <Textfield
            label={t('demos.settingsLogin')}
            description={t('demos.settingsLoginHelp')}
            value={draft.login}
            onChange={(e) => set({ login: e.target.value })}
          />
          <Textfield
            label={t('demos.settingsRetention')}
            description={
              view.recorder === 'job'
                ? t('demos.settingsRetentionHelp')
                : `${t('demos.settingsRetentionHelp')} ${t('demos.settingsRetentionWorkflow')}`
            }
            type="number"
            min={7}
            max={365}
            value={draft.retentionDays}
            onChange={(e) => set({ retentionDays: number(e.target.value) })}
          />
          <div className="actions-row">
            <Button type="submit" data-size="sm" disabled={!dirty || tenantInvalid}>
              {t('demos.settingsSave')}
            </Button>
          </div>
        </form>
        <aside className="stack">
          <Sample api={api} view={view} />
        </aside>
      </div>
      <ReasonDialog
        open={saving}
        title={t('demos.settingsSaveTitle')}
        confirmLabel={t('demos.settingsSave')}
        onClose={() => setSaving(false)}
        onConfirm={async (reason) => {
          try {
            await api.saveDemoSettings(draft, reason, view.version);
          } catch (error) {
            if (error instanceof ApiError && error.status === 409)
              throw new DialogError(t('demos.saveMoved'));
            if (error instanceof ApiError && error.problem?.errors?.length)
              throw new DialogError(
                `${t('demos.saveRefused')} ${error.problem.errors.map((e) => `${e.path ?? ''}: ${e.message}`).join('; ')}`,
              );
            throw error;
          }
          onSaved();
        }}
      />
    </>
  );
};

export const DemoSettingsScreen = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const flash = useFlash();
  const [state, retry] = useAsync((signal) => api.demoSettings(signal), [api]);
  return (
    <>
      <Crumbs title={t('demos.settingsTitle')} />
      <PageHeader
        eyebrow={t('shell.groupPlatform')}
        title={t('demos.settingsTitle')}
        intro={t('demos.settingsIntro')}
      />
      <Flash message={flash.message} />
      {state.status === 'loading' ? (
        <Loading label={t('demos.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : (
        <Form
          key={state.data.version}
          api={api}
          view={state.data}
          onSaved={() => {
            flash.show(t('demos.settingsSaved'));
            retry();
          }}
        />
      )}
    </>
  );
};
