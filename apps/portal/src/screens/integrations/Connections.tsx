import {
  Alert,
  Button,
  Dialog,
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
import { hostsToStore, SecretHostsProblem } from '../../secret-hosts';
import { SyncAttention, SyncLine } from './SyncStatus';

const errorText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? error.problem?.errors?.map((e) => e.message).join(' ') || error.message
    : error instanceof SecretHostsProblem
      ? error.message
      : t('integConnections.wrong');

const emptyForm = { id: '', name: '', endpoint: '', secretName: '', secretValue: '' };

interface Pending {
  title: string;
  button: string;
  done: string;
  run: (reason: string) => Promise<unknown>;
}

const DialogHead = ({ id, title, onClose }: { id: string; title: string; onClose: () => void }) => {
  const t = useT();
  return (
    <div className="int-dialog-head">
      <Heading level={2} data-size="xs" id={id}>
        {title}
      </Heading>
      <Button variant="tertiary" data-size="sm" onClick={onClose}>
        {t('common.close')}
      </Button>
    </div>
  );
};

export const Connections = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const [state, retryList] = useAsync((signal) => api.integrations(tenant, signal), [api, tenant]);
  const [syncs, retrySyncs] = useAsync(
    (signal) => api.toolConnections(tenant, signal),
    [api, tenant],
  );
  const retry = () => {
    retryList();
    retrySyncs();
  };
  const lastSyncs = new Map(
    (syncs.status === 'ready' ? syncs.data : []).map((c) => [c.id, c.lastSync]),
  );
  const failing =
    state.status === 'ready'
      ? state.data.connections.filter((c) => lastSyncs.get(c.id)?.ok === false)
      : [];
  const [message, setMessage] = useState<string>();
  const [form, setForm] = useState<typeof emptyForm>();
  const [askDiscard, setAskDiscard] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const [reason, setReason] = useState('');
  const [reasonShown, setReasonShown] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reasonError = reasonShown ? reasonProblem(reason, t) : undefined;

  const reset = () => {
    setReason('');
    setReasonShown(false);
    setError('');
    setAskDiscard(false);
  };

  const run = async (work: (reason: string) => Promise<unknown>, done: string) => {
    if (busy) return false;
    if (reasonProblem(reason, t)) {
      setReasonShown(true);
      return false;
    }
    setBusy(true);
    setError('');
    try {
      await work(reason.trim());
      setMessage(done);
      retry();
      reset();
      return true;
    } catch (e) {
      setError(errorText(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const register = async (draft: typeof emptyForm) => {
    const ok = await run(async (why) => {
      const url = new URL(draft.endpoint);
      if (draft.secretName && draft.secretValue) {
        const allowedHosts = await hostsToStore(api, tenant, draft.secretName, url.origin, t);
        await api.setSecret(tenant, draft.secretName, draft.secretValue, why, allowedHosts);
      }
      await api.registerConnection(
        tenant,
        {
          id: draft.id,
          name: draft.name || draft.id,
          endpoint: draft.endpoint,
          version: '1.0',
          allow: [{ host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }],
          ...(draft.secretName
            ? { auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/${draft.secretName}` } }
            : {}),
        },
        why,
      );
    }, t('integConnections.registered'));
    if (ok) setForm(undefined);
  };

  const formDirty = (draft: typeof emptyForm) =>
    Object.values(draft).some((v) => v.trim() !== '') || reason.trim() !== '';

  const tryCloseForm = () => {
    if (form && formDirty(form) && !askDiscard) setAskDiscard(true);
    else {
      setForm(undefined);
      reset();
    }
  };

  const reasonField = (
    <Textfield
      id="integrations-reason"
      label={t('common.reason')}
      description={t('integConnections.reasonHelp')}
      value={reason}
      error={reasonError}
      onChange={(e) => setReason(e.target.value)}
    />
  );

  return (
    <section aria-labelledby="mcp-h" className="stack-md">
      <div className="int-intro">
        <div className="stack-sm int-intro-text">
          <Heading level={3} data-size="xs" id="mcp-h">
            {t('integConnections.heading')}
          </Heading>
          <Paragraph data-size="sm" className="meta">
            {t('integConnections.intro')}
          </Paragraph>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            reset();
            setMessage(undefined);
            setForm(emptyForm);
          }}
        >
          {t('integConnections.registerServer')}
        </Button>
      </div>
      <div aria-live="polite">
        {message ? (
          <Alert data-color="success" data-size="sm">
            {message}
          </Alert>
        ) : null}
      </div>
      {failing.map((c) => (
        <SyncAttention key={c.id} name={c.name} sync={lastSyncs.get(c.id)} panel={`conn-${c.id}`} />
      ))}
      {state.status === 'loading' ? <Loading label={t('integConnections.loading')} /> : null}
      {state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} headingLevel={4} />
      ) : null}
      {state.status === 'ready' ? (
        state.data.connections.length === 0 ? (
          <div className="int-empty">
            <span className="int-empty-title">{t('integConnections.none')}</span>
            <span className="meta">{t('integConnections.noneText')}</span>
          </div>
        ) : (
          <ul className="int-connections">
            {state.data.connections.map((c) => (
              <li key={c.id} id={`conn-${c.id}`} role="region" aria-label={c.name} tabIndex={-1}>
                <div className="row-wrap">
                  <span className="int-row-name">{c.name}</span>
                  {lastSyncs.get(c.id)?.ok === false ? (
                    <Tag data-size="sm" data-color="danger">
                      {t('connectionSync.tagFailed')}
                    </Tag>
                  ) : (
                    <Tag data-size="sm" data-color={c.pending.length ? 'warning' : 'success'}>
                      {t(c.pending.length ? 'taskStatus.interrupted' : 'integrations.statusActive')}
                    </Tag>
                  )}
                </div>
                {syncs.status === 'ready' ? <SyncLine sync={lastSyncs.get(c.id)} /> : null}
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
                    <Heading level={4} data-size="2xs">
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
                            onClick={() => {
                              reset();
                              setMessage(undefined);
                              setPending({
                                title: t('integConnections.approve', { name: tool.name }),
                                button: t('integConnections.approve', { name: tool.name }),
                                done: t('integConnections.approved', { name: tool.name }),
                                run: (why) => api.approveTool(tenant, c.id, tool.name, why),
                              });
                            }}
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
                    onClick={() => {
                      reset();
                      setMessage(undefined);
                      setPending({
                        title: t('integConnections.sync', { name: c.name }),
                        button: t('integConnections.syncButton'),
                        done: t('integConnections.synced', { name: c.name }),
                        run: (why) => api.syncConnection(tenant, c.id, why),
                      });
                    }}
                  >
                    {t('integConnections.sync', { name: c.name })}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {pending ? (
        <Dialog
          open
          modal
          closeButton={false}
          onCancel={(e) => {
            e.preventDefault();
            setPending(undefined);
          }}
          aria-labelledby="conn-confirm-h"
          className="int-dialog"
        >
          <div className="stack-dialog stack-sm">
            <DialogHead
              id="conn-confirm-h"
              title={pending.title}
              onClose={() => setPending(undefined)}
            />
            {reasonField}
            {error ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {error}
              </Alert>
            ) : null}
            <div className="actions">
              <Button
                variant="primary"
                loading={busy}
                onClick={() =>
                  void run(pending.run, pending.done).then((ok) => ok && setPending(undefined))
                }
              >
                {pending.button}
              </Button>
              <Button variant="secondary" onClick={() => setPending(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {form ? (
        <Dialog
          open
          modal
          closeButton={false}
          onCancel={(e) => {
            e.preventDefault();
            tryCloseForm();
          }}
          aria-labelledby="conn-new-h"
          className="int-dialog"
        >
          <form
            className="stack-dialog stack-sm"
            aria-label={t('integConnections.newConnection')}
            onSubmit={(e) => {
              e.preventDefault();
              void register(form);
            }}
          >
            <DialogHead
              id="conn-new-h"
              title={t('integConnections.newConnection')}
              onClose={tryCloseForm}
            />
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
            {reasonField}
            {error ? (
              <Alert data-color="danger" data-size="sm" role="alert">
                {error}
              </Alert>
            ) : null}
            {askDiscard ? (
              <Alert data-color="warning" data-size="sm" role="alert">
                {t('integKeys.discardAsk')}
                <div className="actions">
                  <Button data-size="sm" variant="secondary" onClick={() => setAskDiscard(false)}>
                    {t('integKeys.goBack')}
                  </Button>
                  <Button data-size="sm" variant="primary" onClick={tryCloseForm}>
                    {t('integKeys.discard')}
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="actions">
                <Button type="submit" loading={busy}>
                  {t('integConnections.register')}
                </Button>
                <Button variant="secondary" onClick={tryCloseForm}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
          </form>
        </Dialog>
      ) : null}
    </section>
  );
};
