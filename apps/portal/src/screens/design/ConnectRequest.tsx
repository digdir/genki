import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useLocale } from '@genai/i18n/react';
import { useState } from 'react';
import { BusyButton } from '../../components/BusyButton';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import type { ScreenProps } from '../../screen';
import { ErrorState, Loading } from '../../states';
import { Crumbs } from './parts';
import { Problems } from './Problems';

const loopback = ['localhost', '127.0.0.1', '[::1]'];

const allowedNext = (url: string, pending: string) => {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  const secure =
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && loopback.includes(parsed.hostname));
  return (
    (secure && parsed.pathname === `/oauth/design/finish/${encodeURIComponent(pending)}`) ||
    (parsed.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(parsed.hostname)) ||
    (parsed.protocol === 'http:' && loopback.includes(parsed.hostname))
  );
};

/** Where Claude sends a person to approve a connection: allow or deny, then back to Claude. */
export const ConnectRequest = ({
  api,
  tenant,
  tenantName,
  pending,
  leave = (url: string) => window.location.assign(url),
}: ScreenProps & { pending: string; leave?: (url: string) => void }) => {
  const t = useT();
  const { locale } = useLocale();
  const [state, retry] = useAsync(
    (signal) => api.design.connectRequest(tenant, pending, signal),
    [api, tenant, pending],
  );
  const [busy, setBusy] = useState<'allow' | 'deny' | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const decide = async (decision: 'allow' | 'deny') => {
    if (busy) return;
    setBusy(decision);
    setError(undefined);
    try {
      const { redirect } = await api.design.decideConnect(
        tenant,
        pending,
        decision,
        t('design.connectReason'),
      );
      if (!allowedNext(redirect, pending)) throw new Error(t('design.connectBadRedirect'));
      leave(redirect);
    } catch (e) {
      setError(e);
      setBusy(undefined);
    }
  };
  const head = (
    <div className="stack-xs">
      <Crumbs
        items={[
          { label: t('design.title'), href: '#/design' },
          { label: t('design.connectClaude') },
        ]}
      />
      <Heading level={1} data-size="lg">
        {t('design.connectRequestTitle')}
      </Heading>
    </div>
  );
  if (state.status !== 'ready')
    return (
      <div className="design-page">
        {head}
        {state.status === 'loading' ? (
          <Loading label={t('design.connectRequestTitle')} onRetry={retry} />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );
  const where =
    state.data.redirect === 'loopback' ? t('design.connectLoopback') : state.data.redirect;
  return (
    <div className="design-page">
      {head}
      <div className="stack design-connect">
        <Paragraph>
          {t('design.connectRequestLead', { client: state.data.client, org: tenantName })}
        </Paragraph>
        <ul className="design-connect-steps">
          <li>{t('design.connectCan')}</li>
          <li>{t('design.connectCannot')}</li>
          <li>{t('design.connectLasts')}</li>
        </ul>
        <Paragraph data-size="sm" className="meta">
          {t('design.connectStarted', {
            time: new Date(state.data.startedAt).toLocaleTimeString(locale, {
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}{' '}
          {t('design.connectBackTo', { host: where })}
        </Paragraph>
        <div className="design-actions">
          <BusyButton
            busy={busy === 'allow'}
            busyLabel={t('design.connecting')}
            aria-disabled={busy !== undefined || undefined}
            onClick={() => void decide('allow')}
          >
            {t('design.allow')}
          </BusyButton>
          <Button
            variant="secondary"
            aria-disabled={busy !== undefined || undefined}
            onClick={() => void decide('deny')}
          >
            {t('design.deny')}
          </Button>
        </div>
        {error ? <Problems error={error} /> : null}
      </div>
    </div>
  );
};
