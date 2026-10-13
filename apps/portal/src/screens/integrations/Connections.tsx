import {
  Alert,
  Button,
  Details,
  Heading,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import { reasonProblem } from '../../components/ReasonField';

const errorText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? (error.problem?.errors?.map((e) => e.message).join(' ') ?? error.message)
    : t('integConnections.wrong');

const emptyForm = { id: '', name: '', endpoint: '', secretName: '', secretValue: '' };

export const Connections = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.integrations(tenant, signal), [api, tenant]);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [form, setForm] = useState(emptyForm);

  const act = async (run: () => Promise<unknown>, done: string) => {
    setMessage(undefined);
    const reasonError = reasonProblem(reason, t);
    if (reasonError) {
      setMessage({ ok: false, text: reasonError });
      return;
    }
    try {
      await run();
      setMessage({ ok: true, text: done });
      retry();
    } catch (e) {
      setMessage({ ok: false, text: errorText(e, t) });
    }
  };

  const register = () =>
    act(async () => {
      const url = new URL(form.endpoint);
      if (form.secretName && form.secretValue)
        await api.setSecret(tenant, form.secretName, form.secretValue, reason.trim());
      await api.registerConnection(
        tenant,
        {
          id: form.id,
          name: form.name || form.id,
          endpoint: form.endpoint,
          version: '1.0',
          allow: [{ host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }],
          ...(form.secretName
            ? { auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/${form.secretName}` } }
            : {}),
        },
        reason.trim(),
      );
      setForm(emptyForm);
    }, t('integConnections.registered'));

  return (
    <section aria-labelledby="mcp-h" className="stack-md">
      <div className="stack-sm">
        <Heading level={2} data-size="xs" id="mcp-h">
          {t('integConnections.heading')}
        </Heading>
        <Paragraph data-size="sm" className="meta">
          {t('integConnections.intro')}
        </Paragraph>
      </div>
      <Textfield
        id="integrations-reason"
        className="int-field-md"
        label={t('common.reason')}
        description={t('integConnections.reasonHelp')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div aria-live="polite">
        {message ? (
          <Alert data-color={message.ok ? 'success' : 'danger'} data-size="sm">
            {message.text}
          </Alert>
        ) : null}
      </div>
      {state.status === 'loading' ? <Loading label={t('integConnections.loading')} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' ? (
        state.data.connections.length === 0 ? (
          <div className="int-empty">
            <span className="int-empty-title">{t('integConnections.none')}</span>
            <span className="meta">{t('integConnections.noneText')}</span>
          </div>
        ) : (
          <ul className="int-connections">
            {state.data.connections.map((c) => (
              <li key={c.id} role="region" aria-label={c.name}>
                <div className="row-wrap">
                  <span className="int-row-name">{c.name}</span>
                  <Tag data-size="sm" data-color={c.pending.length ? 'warning' : 'success'}>
                    {t(c.pending.length ? 'taskStatus.interrupted' : 'integrations.statusActive')}
                  </Tag>
                </div>
                <span className="meta int-wrap">
                  {t('integConnections.endpointVersion', {
                    endpoint: c.endpoint,
                    version: c.version,
                  })}
                  {c.auth ? ` · ${t('integConnections.secretStored')}` : ''}
                </span>
                {c.tools.length === 0 ? (
                  <Paragraph data-size="sm">{t('integConnections.noTools')}</Paragraph>
                ) : (
                  <ul
                    className="tag-row plain-list"
                    aria-label={t('integConnections.toolsFrom', { name: c.name })}
                  >
                    {c.tools.map((tool) => (
                      <li key={tool.name}>
                        <Tag data-size="sm" data-color="neutral" title={tool.description}>
                          {tool.name}
                        </Tag>
                      </li>
                    ))}
                  </ul>
                )}
                {c.pending.length > 0 ? (
                  <Alert data-color="warning" data-size="sm">
                    <Heading level={3} data-size="2xs">
                      {t('integConnections.pendingHeading')}
                    </Heading>
                    <Paragraph data-size="sm">{t('integConnections.pendingText')}</Paragraph>
                    <ul className="plain-list stack-sm">
                      {c.pending.map((tool) => (
                        <li key={tool.name} className="row-wrap">
                          <span>
                            {tool.name}: {tool.description}
                          </span>
                          <Button
                            data-size="sm"
                            variant="secondary"
                            onClick={() =>
                              void act(
                                () => api.approveTool(tenant, c.id, tool.name, reason.trim()),
                                t('integConnections.approved', { name: tool.name }),
                              )
                            }
                          >
                            {t('integConnections.approve', { name: tool.name })}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}
                <div className="actions">
                  <Button
                    data-size="sm"
                    variant="secondary"
                    onClick={() =>
                      void act(
                        () => api.syncConnection(tenant, c.id, reason.trim()),
                        t('integConnections.synced', { name: c.name }),
                      )
                    }
                  >
                    {t('integConnections.sync', { name: c.name })}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
      <Details>
        <Details.Summary>{t('integConnections.registerServer')}</Details.Summary>
        <Details.Content>
          <form
            className="stack-sm int-field-md"
            aria-label={t('integConnections.newConnection')}
            onSubmit={(e) => {
              e.preventDefault();
              void register();
            }}
          >
            <Textfield
              id="connection-id"
              label={t('integConnections.shortName')}
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
            />
            <Textfield
              id="connection-name"
              label={t('integConnections.displayName')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Textfield
              id="connection-endpoint"
              label={t('integConnections.address')}
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
            <Textfield
              id="connection-secret-name"
              label={t('integConnections.secretName')}
              value={form.secretName}
              onChange={(e) => setForm({ ...form, secretName: e.target.value })}
            />
            <Textfield
              id="connection-secret-value"
              type="password"
              autoComplete="off"
              label={t('integConnections.secret')}
              description={t('integConnections.secretHelp')}
              value={form.secretValue}
              onChange={(e) => setForm({ ...form, secretValue: e.target.value })}
            />
            <div>
              <Button type="submit">{t('integConnections.register')}</Button>
            </div>
          </form>
        </Details.Content>
      </Details>
    </section>
  );
};
