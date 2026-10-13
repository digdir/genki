import {
  Alert,
  Button,
  Checkbox,
  ErrorSummary,
  Fieldset,
  Heading,
  Radio,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { type ComponentRef, useRef, useState } from 'react';
import { useT, type T } from '../../i18n';
import type { ClientChannel, ClientSpec, ClientView, WebhookEvent } from '../../types';
import { channelKeys, channelOrder } from './snippets';
import { reasonProblem } from '../../components/ReasonField';

export interface ClientDraft {
  id: string;
  name: string;
  kind: ClientSpec['kind'];
  url: string;
  channels: ClientChannel[];
  origins: string;
  clientId: string;
  redirectUris: string;
  webhookUrl: string;
  webhookEvents: WebhookEvent[];
  webhookSecret: string;
  reason: string;
}

export const draftOf = (client?: ClientView, service = ''): ClientDraft => {
  const spec = client?.definition.spec;
  return {
    id: client?.definition.metadata.id ?? '',
    name: client?.definition.metadata.name ?? '',
    kind: spec?.kind ?? 'server',
    url: spec?.url ?? '',
    channels: spec?.channels ?? ['mcp'],
    origins: (spec?.allowedOrigins ?? []).join('\n'),
    clientId: spec?.oidc?.clientId ?? '',
    redirectUris: (spec?.oidc?.redirectUris ?? []).join('\n'),
    webhookUrl: spec?.webhook?.url ?? '',
    webhookEvents: spec?.webhook?.events ?? [],
    webhookSecret: spec?.webhook?.secret ?? (service ? `${service}-varsler` : ''),
    reason: '',
  };
};

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const webAddress = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))
    );
  } catch {
    return false;
  }
};

const originOnly = (value: string) => {
  try {
    return webAddress(value) && new URL(value).origin === value;
  } catch {
    return false;
  }
};

export const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

export const specOf = (draft: ClientDraft, service: string): ClientSpec => ({
  service,
  kind: draft.kind,
  ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
  channels: draft.channels,
  allowedOrigins: lines(draft.origins),
  ...(draft.clientId.trim()
    ? { oidc: { clientId: draft.clientId.trim(), redirectUris: lines(draft.redirectUris) } }
    : {}),
  ...(draft.webhookUrl.trim()
    ? {
        webhook: {
          url: draft.webhookUrl.trim(),
          events: draft.webhookEvents,
          secret: draft.webhookSecret.trim(),
        },
      }
    : {}),
});

export const draftErrors = (t: T, d: ClientDraft, isNew: boolean) => {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e['cf-name'] = t('serviceClient.nameRequired');
  if (isNew && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slugFrom(d.name)))
    e['cf-name'] = t('serviceClient.nameInvalid');
  if (d.url.trim() && !webAddress(d.url.trim())) e['cf-url'] = t('serviceClient.urlInvalid');
  if (!d.channels.length) e['cf-channels'] = t('serviceClient.channelRequired');
  const origins = lines(d.origins);
  if (origins.some((o) => !originOnly(o))) e['cf-origins'] = t('serviceClient.originsInvalid');
  if (d.kind === 'browser' && origins.length === 0)
    e['cf-origins'] = t('serviceClient.originsRequired');
  if (d.kind === 'browser' && !d.clientId.trim())
    e['cf-client-id'] = t('serviceClient.clientIdRequired');
  if (d.clientId.trim() && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(d.clientId.trim()))
    e['cf-client-id'] = t('serviceClient.clientIdInvalid');
  const redirects = lines(d.redirectUris);
  if (d.clientId.trim() && (redirects.length === 0 || redirects.some((r) => !webAddress(r))))
    e['cf-redirects'] = t('serviceClient.redirectsInvalid');
  if (d.webhookUrl.trim()) {
    if (!webAddress(d.webhookUrl.trim())) e['cf-webhook'] = t('serviceClient.webhookInvalid');
    if (!d.webhookEvents.length) e['cf-events'] = t('serviceClient.eventRequired');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(d.webhookSecret.trim()))
      e['cf-secret'] = t('serviceClient.secretInvalid');
  }
  const reasonError = reasonProblem(d.reason);
  if (reasonError) e['cf-reason'] = reasonError;
  return e;
};

const toggle = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

export const ClientForm = ({
  initial,
  isNew,
  saveError,
  onSave,
  onCancel,
}: {
  initial: ClientDraft;
  isNew: boolean;
  saveError: string;
  onSave: (draft: ClientDraft) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const [d, setD] = useState(initial);
  const [tried, setTried] = useState(false);
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const errors = draftErrors(t, d, isNew);
  const shown = tried ? errors : {};
  const set = (patch: Partial<ClientDraft>) => setD((x) => ({ ...x, ...patch }));

  return (
    <section aria-labelledby="cf-h" className="fe-form stack-sm">
      <Heading level={4} data-size="xs" id="cf-h">
        {isNew
          ? t('serviceClient.registerTitle')
          : t('serviceClient.editTitle', { name: initial.name })}
      </Heading>
      {Object.keys(shown).length ? (
        <ErrorSummary ref={summary} tabIndex={-1}>
          <ErrorSummary.Heading>{t('serviceClient.fixThese')}</ErrorSummary.Heading>
          <ErrorSummary.List>
            {Object.entries(shown).map(([href, text]) => (
              <ErrorSummary.Item key={href}>
                <ErrorSummary.Link href={`#${href}`}>{text}</ErrorSummary.Link>
              </ErrorSummary.Item>
            ))}
          </ErrorSummary.List>
        </ErrorSummary>
      ) : null}
      {saveError ? (
        <Alert data-color="danger" data-size="sm">
          {saveError}
        </Alert>
      ) : null}
      <Textfield
        id="cf-name"
        className="fe-field-md"
        label={t('serviceClient.name')}
        description={isNew ? t('serviceClient.nameDescription') : undefined}
        value={d.name}
        error={shown['cf-name']}
        onChange={(e) => set({ name: e.target.value })}
      />
      <Fieldset>
        <Fieldset.Legend>{t('serviceClient.howLegend')}</Fieldset.Legend>
        <Radio
          name="cf-kind"
          label={t('serviceClient.server')}
          description={t('serviceClient.serverDescription')}
          checked={d.kind === 'server'}
          onChange={() => set({ kind: 'server' })}
        />
        <Radio
          name="cf-kind"
          label={t('serviceClient.browser')}
          description={t('serviceClient.browserDescription')}
          checked={d.kind === 'browser'}
          onChange={() => set({ kind: 'browser' })}
        />
      </Fieldset>
      <Textfield
        id="cf-url"
        className="fe-field-md"
        label={t('serviceClient.url')}
        description={t('serviceClient.urlDescription')}
        value={d.url}
        error={shown['cf-url']}
        onChange={(e) => set({ url: e.target.value })}
      />
      <Fieldset id="cf-channels" tabIndex={-1} data-size="sm">
        <Fieldset.Legend>{t('serviceClient.channelsLegend')}</Fieldset.Legend>
        {channelOrder.map((c) => (
          <Checkbox
            key={c}
            label={t(channelKeys[c])}
            checked={d.channels.includes(c)}
            onChange={() => set({ channels: toggle(d.channels, c) })}
          />
        ))}
        {shown['cf-channels'] ? (
          <ValidationMessage>{shown['cf-channels']}</ValidationMessage>
        ) : null}
      </Fieldset>
      <Textfield
        multiline
        id="cf-origins"
        className="fe-field-md"
        label={t('serviceClient.origins')}
        description={t('serviceClient.originsDescription')}
        rows={2}
        value={d.origins}
        error={shown['cf-origins']}
        onChange={(e) => set({ origins: e.target.value })}
      />
      <Fieldset data-size="sm">
        <Fieldset.Legend>{t('serviceClient.loginLegend')}</Fieldset.Legend>
        <Fieldset.Description>
          {d.kind === 'browser'
            ? t('serviceClient.loginRequired')
            : t('serviceClient.loginOptional')}
        </Fieldset.Description>
        <Textfield
          id="cf-client-id"
          className="fe-field-md"
          label={t('serviceClient.clientId')}
          description={t('serviceClient.clientIdDescription')}
          value={d.clientId}
          error={shown['cf-client-id']}
          onChange={(e) => set({ clientId: e.target.value })}
        />
        <Textfield
          multiline
          id="cf-redirects"
          className="fe-field-md"
          label={t('serviceClient.redirects')}
          description={t('serviceClient.redirectsDescription')}
          rows={2}
          value={d.redirectUris}
          error={shown['cf-redirects']}
          onChange={(e) => set({ redirectUris: e.target.value })}
        />
      </Fieldset>
      <Fieldset data-size="sm">
        <Fieldset.Legend>{t('serviceClient.webhookLegend')}</Fieldset.Legend>
        <Fieldset.Description>{t('serviceClient.webhookDescription')}</Fieldset.Description>
        <Textfield
          id="cf-webhook"
          className="fe-field-md"
          label={t('serviceClient.webhookUrl')}
          value={d.webhookUrl}
          error={shown['cf-webhook']}
          onChange={(e) => set({ webhookUrl: e.target.value })}
        />
        {d.webhookUrl.trim() ? (
          <>
            <Fieldset id="cf-events" tabIndex={-1} data-size="sm">
              <Fieldset.Legend>{t('serviceClient.events')}</Fieldset.Legend>
              <Checkbox
                label={t('serviceClient.eventDone')}
                checked={d.webhookEvents.includes('task.completed')}
                onChange={() => set({ webhookEvents: toggle(d.webhookEvents, 'task.completed') })}
              />
              <Checkbox
                label={t('serviceClient.eventFeedback')}
                checked={d.webhookEvents.includes('feedback.received')}
                onChange={() =>
                  set({ webhookEvents: toggle(d.webhookEvents, 'feedback.received') })
                }
              />
              {shown['cf-events'] ? (
                <ValidationMessage>{shown['cf-events']}</ValidationMessage>
              ) : null}
            </Fieldset>
            <Textfield
              id="cf-secret"
              className="fe-field-md"
              label={t('serviceClient.secret')}
              description={t('serviceClient.secretDescription')}
              value={d.webhookSecret}
              error={shown['cf-secret']}
              onChange={(e) => set({ webhookSecret: e.target.value })}
            />
          </>
        ) : null}
      </Fieldset>
      <Textfield
        id="cf-reason"
        className="fe-field-md"
        label={t('serviceClient.reason')}
        description={t('serviceClient.reasonDescription')}
        value={d.reason}
        error={shown['cf-reason']}
        onChange={(e) => set({ reason: e.target.value })}
      />
      <div className="actions">
        <Button
          variant="primary"
          onClick={() => {
            if (Object.keys(errors).length) {
              setTried(true);
              setTimeout(() => summary.current?.focus(), 0);
              return;
            }
            onSave(d);
          }}
        >
          {isNew ? t('serviceClient.register') : t('serviceClient.save')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('serviceClient.cancel')}
        </Button>
      </div>
    </section>
  );
};
