import {
  Alert,
  Button,
  Details,
  Dialog,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { useRights } from '../../Shell';
import type { ConnectionView, ToolConnectionView } from '../../types';
import { Loading } from '../../states';
import { reasonProblem } from '../../components/ReasonField';
import { hostsToStore, SecretHostsProblem } from '../../secret-hosts';
import { PageEmpty, PageError, PageLead } from './PageStates';
import { SyncAttention, SyncLine } from './SyncStatus';

type Protocol = 'mcp' | 'openapi' | 'a2a';

/** What the API lists for a connection beyond the view in types.ts. */
type ListedConnection = Omit<ToolConnectionView, 'lastSync'> & {
  protocol?: Protocol;
  lastSync?: NonNullable<ToolConnectionView['lastSync']> & {
    status?: number;
    attempts?: number;
    failingSince?: string;
  };
};

const kindLabel = (protocol: Protocol | undefined): PlainKey =>
  protocol === 'openapi'
    ? 'devSystems.kindOpenapi'
    : protocol === 'a2a'
      ? 'devSystems.kindA2a'
      : 'devSystems.kindMcp';

const httpsAddress = (value: string) => /^https:\/\/[^\s.]+\.\S+/.test(value.trim());

export const connectionId = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const errorText = (error: unknown, t: T) =>
  error instanceof ApiError
    ? error.problem?.errors?.map((e) => e.message).join(' ') || error.message
    : error instanceof SecretHostsProblem
      ? error.message
      : t('integConnections.wrong');

const emptyForm = {
  protocol: 'mcp' as Protocol,
  name: '',
  endpoint: '',
  secretName: '',
  secretValue: '',
};

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

export const Connections = ({
  api,
  tenant,
  initialOpen,
}: {
  api: ApiClient;
  tenant: string;
  initialOpen?: string;
}) => {
  const t = useT();
  const f = useFormat();
  const canManage = useRights().has('manage-services');
  const [state, retryList] = useAsync((signal) => api.integrations(tenant, signal), [api, tenant]);
  const [syncs, retrySyncs] = useAsync(
    async (signal): Promise<ListedConnection[]> => api.toolConnections(tenant, signal),
    [api, tenant],
  );
  const [blocks] = useAsync(
    async (signal) =>
      (await api.buildingBlocks.list(tenant, { kind: 'tool' }, signal).catch(() => undefined))
        ?.data ?? [],
    [api, tenant],
  );
  const [chosen, setOpen] = useState<string | null | undefined>(initialOpen);
  const [retrying, setRetrying] = useState<string>();
  const [retryMessage, setRetryMessage] = useState<Record<string, string>>({});
  const protocols = new Map(
    (syncs.status === 'ready' ? syncs.data : []).map((c) => [c.id, c.protocol]),
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
  const open = chosen === undefined ? failing[0]?.id : chosen;
  const [message, setMessage] = useState<string>();
  const [form, setForm] = useState<typeof emptyForm>();
  const [askDiscard, setAskDiscard] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const [reason, setReason] = useState('');
  const [reasonShown, setReasonShown] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  const reasonError = reasonShown ? reasonProblem(reason, t) : undefined;

  const reset = () => {
    setTried(false);
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
    setTried(true);
    if (!connectionId(draft.name) || !httpsAddress(draft.endpoint)) return;
    const ok = await run(async (why) => {
      const url = new URL(draft.endpoint);
      if (draft.secretName && draft.secretValue) {
        const allowedHosts = await hostsToStore(api, tenant, draft.secretName, url.origin, t);
        await api.setSecret(tenant, draft.secretName, draft.secretValue, why, allowedHosts);
      }
      await api.registerConnection(
        tenant,
        {
          id: connectionId(draft.name),
          name: draft.name.trim(),
          protocol: draft.protocol,
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
    [draft.name, draft.endpoint, draft.secretName, draft.secretValue, reason].some(
      (v) => v.trim() !== '',
    );

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

  const openForm = () => {
    reset();
    setMessage(undefined);
    setForm(emptyForm);
  };

  const retrySync = async (c: ConnectionView) => {
    if (retrying) return;
    setRetrying(c.id);
    setRetryMessage((m) => ({ ...m, [c.id]: '' }));
    try {
      await api.syncConnection(tenant, c.id, t('devSystems.retryReason', { name: c.name }));
      setMessage(t('devSystems.answersAgain', { name: c.name }));
      retry();
    } catch (e) {
      setRetryMessage((m) => ({ ...m, [c.id]: errorText(e, t) }));
      retrySyncs();
    } finally {
      setRetrying(undefined);
    }
  };

  const usersOf = (id: string) =>
    (blocks.status === 'ready' ? blocks.data : []).find((b) => b.id === id)?.usedBy ?? [];

  return (
    <section aria-label={t('devTools.systems')} className="stack-md">
      <PageLead text={t('devSystems.lead')}>
        {canManage ? <Button onClick={openForm}>{t('devSystems.connect')}</Button> : null}
      </PageLead>
      <div aria-live="polite">
        {message ? (
          <Alert data-color="success" data-size="sm">
            {message}
          </Alert>
        ) : null}
      </div>
      {failing.map((c) => (
        <SyncAttention
          key={c.id}
          name={c.name}
          sync={lastSyncs.get(c.id)}
          panel={`conn-${c.id}`}
          onShow={() => setOpen(c.id)}
        />
      ))}
      {state.status === 'loading' ? <Loading label={t('integConnections.loading')} /> : null}
      {state.status === 'error' ? (
        <PageError
          error={state.error}
          title={t('devSystems.errorTitle')}
          text={t('devSystems.errorText')}
          onRetry={retry}
        />
      ) : null}
      {state.status === 'ready' ? (
        state.data.connections.length === 0 ? (
          <PageEmpty title={t('devSystems.emptyTitle')} text={t('devSystems.emptyText')}>
            {canManage ? (
              <div>
                <Button onClick={openForm}>{t('devSystems.connect')}</Button>
              </div>
            ) : null}
          </PageEmpty>
        ) : (
          <ul className="plain-list dev-rows">
            {state.data.connections.map((c) => {
              const sync = lastSyncs.get(c.id);
              const failed = sync?.ok === false;
              const isOpen = open === c.id;
              const users = usersOf(c.id);
              const panel = `conn-${c.id}`;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    className="dev-row"
                    aria-expanded={isOpen}
                    aria-controls={panel}
                    onClick={() => setOpen(isOpen ? null : c.id)}
                  >
                    <span className="dev-row-main">
                      <span className="int-row-name">{c.name}</span>
                      <span className="meta">{t(kindLabel(protocols.get(c.id)))}</span>
                    </span>
                    <Tag
                      data-size="sm"
                      data-color={failed ? 'danger' : c.pending.length ? 'warning' : 'success'}
                    >
                      {t(
                        failed
                          ? 'connectionSync.tagFailed'
                          : c.pending.length
                            ? 'devSystems.pending'
                            : 'devSystems.inUse',
                      )}
                    </Tag>
                    <span className="dev-row-meta">
                      <span>{t('devSystems.tools', { count: c.tools.length })}</span>
                      {syncs.status === 'ready' ? <SyncLine sync={sync} /> : null}
                    </span>
                    <span className="dev-row-chevron" aria-hidden="true">
                      {t(isOpen ? 'devSystems.hide' : 'devSystems.show')}
                    </span>
                  </button>
                  <div
                    id={panel}
                    role="region"
                    aria-label={c.name}
                    tabIndex={-1}
                    hidden={!isOpen}
                    className="dev-row-panel stack-sm"
                  >
                    {failed ? (
                      <Alert data-color="danger" data-size="sm">
                        <Paragraph data-size="sm">
                          {sync?.message ?? t('devSystems.rejected')}
                        </Paragraph>
                        <Paragraph data-size="sm" className="meta">
                          {[
                            t('devSystems.lastAttempt', { when: f.dateTime(sync?.at ?? '') }),
                            ...(sync?.status
                              ? [t('devSystems.status', { code: sync.status })]
                              : []),
                            ...(sync?.attempts && sync.failingSince
                              ? [
                                  t('devSystems.attempts', {
                                    count: sync.attempts,
                                    since: f.dateTime(sync.failingSince),
                                  }),
                                ]
                              : []),
                          ].join(' · ')}
                        </Paragraph>
                        {canManage ? (
                          <div className="actions">
                            <Button
                              data-size="sm"
                              variant="secondary"
                              aria-busy={retrying === c.id ? true : undefined}
                              onClick={() => void retrySync(c)}
                            >
                              {retrying === c.id ? t('devSystems.retrying') : t('common.tryAgain')}
                            </Button>
                            <span role="status" className="dev-msg-bad">
                              {retryMessage[c.id]}
                            </span>
                          </div>
                        ) : null}
                      </Alert>
                    ) : null}
                    <Paragraph data-size="sm">
                      {t('devSystems.address', { address: c.endpoint })}
                      {c.auth ? ` · ${t('integConnections.secretStored')}` : ''}
                    </Paragraph>
                    <Paragraph data-size="sm">
                      {users.length
                        ? t('devSystems.usedBy', { names: users.map((u) => u.name).join(', ') })
                        : t('devSystems.notUsed')}{' '}
                      <a href={`#/building-blocks/tool/${encodeURIComponent(c.id)}`}>
                        {t('devSystems.seeTools')}
                      </a>
                    </Paragraph>
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
                              {canManage ? (
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
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </Alert>
                    ) : null}
                    {canManage && !failed ? (
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
                    ) : null}
                  </div>
                </li>
              );
            })}
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
            aria-label={t('devSystems.connect')}
            onSubmit={(e) => {
              e.preventDefault();
              void register(form);
            }}
          >
            <DialogHead id="conn-new-h" title={t('devSystems.connect')} onClose={tryCloseForm} />
            <Fieldset>
              <Fieldset.Legend>{t('devSystems.howLegend')}</Fieldset.Legend>
              {(['mcp', 'openapi', 'a2a'] as const).map((p) => (
                <Radio
                  key={p}
                  name="connection-protocol"
                  label={t(kindLabel(p))}
                  value={p}
                  checked={form.protocol === p}
                  onChange={() => setForm({ ...form, protocol: p })}
                />
              ))}
            </Fieldset>
            <Textfield
              id="connection-name"
              label={t('devSystems.name')}
              description={t('devSystems.nameHelp')}
              value={form.name}
              error={tried && !connectionId(form.name) ? t('devSystems.nameProblem') : undefined}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Textfield
              id="connection-endpoint"
              type="url"
              label={t('devSystems.addressLabel')}
              description={t('devSystems.addressHelp')}
              value={form.endpoint}
              error={
                tried && !httpsAddress(form.endpoint) ? t('devSystems.addressProblem') : undefined
              }
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
            />
            <Details>
              <Details.Summary>{t('devSystems.loginOptional')}</Details.Summary>
              <Details.Content>
                <div className="stack-sm">
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
                </div>
              </Details.Content>
            </Details>
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
                  {busy ? t('devSystems.connecting') : t('devSystems.connectButton')}
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
