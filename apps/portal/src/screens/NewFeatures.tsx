import { Alert, Button, Heading, Paragraph, Switch, Tag } from '@digdir/designsystemet-react';
import type { FlagState, SelfServiceFlag } from '@genai/contracts/flags';
import { useState } from 'react';
import type { ApiClient } from '../api';
import { reasonProblem, ReasonField } from '../components/ReasonField';
import { useFlags } from '../flags';
import { useT, type PlainKey } from '../i18n';
import { useRights } from '../Shell';

const flagTexts: Record<SelfServiceFlag, { name: PlainKey; text: PlainKey }> = {
  blockStudio: { name: 'profile.flagBlockStudio', text: 'profile.flagBlockStudioText' },
};

const statusOf = (state: FlagState): PlainKey => {
  if (state.source === 'person') return state.on ? 'profile.flagOnForYou' : 'profile.flagOffForYou';
  if (state.source === 'tenant' && state.on) return 'profile.flagOnForOrganisation';
  return state.on ? 'profile.flagOn' : 'profile.flagOff';
};

const Feature = ({
  api,
  tenant,
  tenantName,
  state,
  texts,
  onChanged,
}: {
  api: Pick<ApiClient, 'flags'>;
  tenant: string;
  tenantName: string;
  state: FlagState & { key: SelfServiceFlag };
  texts: { name: PlainKey; text: PlainKey };
  onChanged: () => void;
}) => {
  const t = useT();
  const { has } = useRights();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [organisation, setOrganisation] = useState<boolean | undefined>();
  const [reason, setReason] = useState('');
  const [showReasonError, setShowReasonError] = useState(false);
  const name = t(texts.name);
  const run = async (change: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await change();
      onChanged();
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveOrganisation = async () => {
    if (organisation === undefined) return;
    if (reasonProblem(reason, t)) {
      setShowReasonError(true);
      return;
    }
    const done = await run(() =>
      api.flags.setTenant(tenant, state.key, organisation, reason.trim()),
    );
    if (done) {
      setOrganisation(undefined);
      setReason('');
      setShowReasonError(false);
    }
  };
  return (
    <li className="new-feature stack-sm">
      <div className="tag-row">
        <Heading level={3} data-size="2xs">
          {name}
        </Heading>
        <Tag data-size="sm" data-color={state.on ? 'success' : 'neutral'}>
          {t(statusOf(state))}
        </Tag>
      </div>
      <Paragraph data-size="sm">{t(texts.text)}</Paragraph>
      <Switch
        label={t('profile.flagForYou', { name })}
        checked={state.on}
        aria-disabled={busy ? true : undefined}
        onChange={() => void run(() => api.flags.setMine(tenant, state.key, !state.on))}
      />
      {state.person !== null && state.tenant !== null ? (
        <Button
          variant="tertiary"
          data-size="sm"
          onClick={() => void run(() => api.flags.setMine(tenant, state.key, null))}
        >
          {t('profile.flagFollowOrganisation')}
        </Button>
      ) : null}
      {has('manage-services') ? (
        <div className="stack-sm">
          <Switch
            label={t('profile.flagForOrganisation', { name: tenantName })}
            checked={organisation ?? state.tenant === true}
            onChange={() => {
              const next = !(organisation ?? state.tenant === true);
              setOrganisation(next === (state.tenant === true) ? undefined : next);
            }}
          />
          {organisation !== undefined ? (
            <div className="stack-xs">
              <ReasonField
                value={reason}
                onChange={setReason}
                showError={showReasonError}
                rows={1}
              />
              <div className="actions">
                <Button
                  data-size="sm"
                  aria-disabled={busy ? true : undefined}
                  onClick={() => void saveOrganisation()}
                >
                  {t('common.save')}
                </Button>
                <Button
                  data-size="sm"
                  variant="tertiary"
                  onClick={() => {
                    setOrganisation(undefined);
                    setReason('');
                    setShowReasonError(false);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {failed ? (
        <Alert data-color="danger" data-size="sm">
          {t('profile.flagFailed')}
        </Alert>
      ) : null}
    </li>
  );
};

const isSelfService = (state: FlagState): state is FlagState & { key: SelfServiceFlag } =>
  state.selfService && Object.hasOwn(flagTexts, state.key);

export const NewFeatures = ({
  api,
  tenant,
  tenantName,
}: {
  api: Pick<ApiClient, 'flags'>;
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  const { states, reload } = useFlags();
  const offered = states.filter(isSelfService);
  if (offered.length === 0) return null;
  return (
    <section aria-labelledby="new-features-h" className="stack-sm">
      <Heading level={2} data-size="xs" id="new-features-h">
        {t('profile.newFeatures')}
      </Heading>
      <p className="meta">{t('profile.newFeaturesLead')}</p>
      <ul className="new-features">
        {offered.map((state) => (
          <Feature
            key={state.key}
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            state={state}
            texts={flagTexts[state.key]}
            onChanged={reload}
          />
        ))}
      </ul>
    </section>
  );
};
