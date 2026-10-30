import {
  Alert,
  Button,
  Checkbox,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Switch,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { TraceConnection, Residency } from '../../api/tracing';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';

interface Draft {
  id: string;
  host: string;
  /** The host the stored secret is set for; empty for a new connection. */
  storedHost: string;
  publicKey: string;
  /** The stored secret's reference, kept while no new key is entered. */
  secretKey: string;
  /** A new secret key: stored for the host before the connection is saved, never shown again. */
  secret: string;
  services: string;
  residency: Residency;
  content: boolean;
  erasureDeclared: boolean;
}

const blank: Draft = {
  id: '',
  host: '',
  storedHost: '',
  publicKey: '',
  secretKey: '',
  secret: '',
  services: '',
  residency: 'global',
  content: false,
  erasureDeclared: false,
};

const secretPrefix = (tenant: string) => `secret://tenant/${tenant}/`;

/** The API's pattern for a connection's id. */
const idPattern = /^[a-z0-9][a-z0-9-]*$/;

const originOf = (host: string) => {
  try {
    return new URL(host.trim()).origin;
  } catch {
    return undefined;
  }
};

/** A key must be entered for a new connection, and again when the address changes. */
const needsKey = (d: Draft) =>
  !d.secretKey || originOf(d.host) === undefined || originOf(d.host) !== originOf(d.storedHost);

const draftOf = (c: TraceConnection): Draft => ({
  id: c.id,
  host: c.host,
  storedHost: c.host,
  publicKey: c.publicKey,
  secretKey: c.secretKey,
  secret: '',
  services: c.services.join(', '),
  residency: c.residency,
  content: c.content,
  erasureDeclared: c.erasureDeclared,
});

const residencyText = (t: T, r: Residency) =>
  t(
    r === 'norway'
      ? 'integLangfuse.inNorway'
      : r === 'eu'
        ? 'integLangfuse.inEu'
        : 'integLangfuse.global',
  );

const problemText = (t: T, error: unknown) =>
  error instanceof ApiError && error.problem?.errors?.length
    ? error.problem.errors.map((e) => e.message).join('. ')
    : t('integLangfuse.failed');

export const LiveTracing = ({
  api,
  tenant,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  onFlash: (text: string, color?: 'success' | 'info' | 'danger') => void;
}) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const [round, setRound] = useState(0);
  const [state, retry] = useAsync(
    (signal) => api.tracing.list(tenant, signal),
    [api, tenant, round],
  );
  const [draft, setDraft] = useState<Draft>();
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [checked, setChecked] = useState<Record<string, string>>({});

  const close = () => {
    setDraft(undefined);
    setReason('');
    setTried(false);
    setFailed(undefined);
  };

  const save = async () => {
    if (!draft) return;
    setTried(true);
    const host = originOf(draft.host);
    if (
      !idPattern.test(draft.id.trim()) ||
      !host ||
      !draft.publicKey ||
      (needsKey(draft) && !draft.secret) ||
      reasonProblem(reason, t)
    )
      return;
    // Saving under a name that exists would replace that connection; only Endre does that.
    if (!editing && state.status === 'ready' && state.data.some((c) => c.id === draft.id.trim())) {
      setFailed(t('integLangfuse.nameTaken', { id: draft.id.trim() }));
      return;
    }
    setBusy(true);
    setFailed(undefined);
    // A new key is stored for this host alone, under the tenant's own name; the connection only
    // names it. Without a new key the reference stays as it is.
    const secretKey =
      draft.secret && !draft.secretKey.startsWith(secretPrefix(tenant))
        ? `${secretPrefix(tenant)}langfuse-${draft.id.trim()}`
        : draft.secretKey;
    try {
      if (draft.secret)
        await api.setSecret(
          tenant,
          secretKey.slice(secretPrefix(tenant).length),
          draft.secret,
          reason,
          [host],
        );
      await api.tracing.save(
        tenant,
        draft.id.trim(),
        {
          host: draft.host.trim(),
          publicKey: draft.publicKey.trim(),
          secretKey,
          services: draft.services
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          residency: draft.residency,
          content: draft.content,
          erasureDeclared: draft.erasureDeclared,
        },
        reason,
      );
      onFlash(t('integLangfuse.saved', { id: draft.id }));
      close();
      setRound((r) => r + 1);
    } catch (error) {
      setFailed(problemText(t, error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (reasonProblem(reason, t)) {
      setTried(true);
      return;
    }
    try {
      await api.tracing.remove(tenant, id, reason);
      onFlash(t('integLangfuse.removed', { id }));
      close();
      setRound((r) => r + 1);
    } catch (error) {
      setFailed(problemText(t, error));
    }
  };

  const check = async (id: string) => {
    try {
      const result = await api.tracing.check(tenant, id);
      setChecked((c) => ({
        ...c,
        [id]: t('integLangfuse.checkedOk', { project: result.project.name }),
      }));
    } catch (error) {
      setChecked((c) => ({ ...c, [id]: problemText(t, error) }));
    }
  };

  if (state.status === 'loading') return <Loading label={t('integLangfuse.loading')} />;
  if (state.status === 'error')
    return <ErrorState error={state.error} onRetry={retry} headingLevel={3} />;

  return (
    <section aria-labelledby="tracing-h" className="stack-md">
      <Heading level={3} data-size="xs" id="tracing-h">
        {t('integLangfuse.heading')}
      </Heading>
      <Paragraph data-size="sm">{t('integLangfuse.intro')}</Paragraph>
      {state.data.length === 0 ? (
        <Paragraph data-size="sm">{t('integLangfuse.none')}</Paragraph>
      ) : (
        <ul className="plain-list stack-sm">
          {state.data.map((c) => (
            <li key={c.id} className="quality-panel">
              <Heading level={4} data-size="2xs">
                {c.id}
              </Heading>
              <Paragraph data-size="sm">{c.host}</Paragraph>
              <Paragraph data-size="sm">
                {t('integLangfuse.services', { services: c.services.join(', ') || '–' })}
              </Paragraph>
              <Paragraph data-size="sm">
                {t(
                  c.residencySetBy === 'operator'
                    ? 'integLangfuse.residencyByDigdir'
                    : 'integLangfuse.residencyByYou',
                  {
                    residency: residencyText(t, c.residency),
                  },
                )}
              </Paragraph>
              <Tag data-size="sm" data-color={c.content ? 'warning' : 'neutral'}>
                {t(c.content ? 'integLangfuse.contentOn' : 'integLangfuse.contentOff')}
              </Tag>
              {checked[c.id] ? <Paragraph data-size="sm">{checked[c.id]}</Paragraph> : null}
              <div className="row-gap">
                <Button variant="secondary" data-size="sm" onClick={() => void check(c.id)}>
                  {t('integLangfuse.check')}
                </Button>
                {canManage ? (
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    onClick={() => {
                      setEditing(true);
                      setDraft(draftOf(c));
                    }}
                  >
                    {t('integLangfuse.edit')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && !draft ? (
        <Button
          variant="primary"
          onClick={() => {
            setEditing(false);
            setDraft(blank);
          }}
        >
          {t('integLangfuse.add')}
        </Button>
      ) : null}
      {draft ? (
        <form
          className="stack-sm quality-panel"
          aria-label={t(editing ? 'integLangfuse.editHeading' : 'integLangfuse.addHeading')}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Heading level={4} data-size="2xs">
            {t(editing ? 'integLangfuse.editHeading' : 'integLangfuse.addHeading')}
          </Heading>
          {failed ? <Alert data-color="danger">{failed}</Alert> : null}
          <Textfield
            label={t('integLangfuse.id')}
            description={editing ? undefined : t('integLangfuse.idHelp')}
            value={draft.id}
            readOnly={editing}
            error={
              !tried
                ? undefined
                : !draft.id.trim()
                  ? t('integLangfuse.required')
                  : !idPattern.test(draft.id.trim())
                    ? t('integLangfuse.idInvalid')
                    : undefined
            }
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
          <Textfield
            label={t('integLangfuse.host')}
            description={t('integLangfuse.hostHelp')}
            value={draft.host}
            error={
              !tried
                ? undefined
                : !draft.host.trim()
                  ? t('integLangfuse.required')
                  : !originOf(draft.host)
                    ? t('integLangfuse.hostInvalid')
                    : undefined
            }
            onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          />
          <Textfield
            label={t('integLangfuse.publicKey')}
            value={draft.publicKey}
            error={tried && !draft.publicKey ? t('integLangfuse.required') : undefined}
            onChange={(e) => setDraft({ ...draft, publicKey: e.target.value })}
          />
          <Textfield
            label={t('integLangfuse.secret')}
            description={t(
              draft.secretKey ? 'integLangfuse.secretKeepHelp' : 'integLangfuse.secretHelp',
            )}
            type="password"
            autoComplete="new-password"
            value={draft.secret}
            error={
              tried && needsKey(draft) && !draft.secret
                ? t(draft.secretKey ? 'integLangfuse.secretAgain' : 'integLangfuse.required')
                : undefined
            }
            onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
          />
          <Textfield
            label={t('integLangfuse.servicesLabel')}
            description={t('integLangfuse.servicesHelp')}
            value={draft.services}
            onChange={(e) => setDraft({ ...draft, services: e.target.value })}
          />
          <Field>
            <Label>{t('integLangfuse.residency')}</Label>
            <Field.Description>{t('integLangfuse.residencyHelp')}</Field.Description>
            <Select
              value={draft.residency}
              onChange={(e) => setDraft({ ...draft, residency: e.target.value as Residency })}
            >
              {(['norway', 'eu', 'global'] as const).map((r) => (
                <Select.Option key={r} value={r}>
                  {residencyText(t, r)}
                </Select.Option>
              ))}
            </Select>
          </Field>
          <Switch
            label={t('integLangfuse.content')}
            description={t('integLangfuse.contentHelp')}
            checked={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.checked })}
          />
          <Checkbox
            label={t('integLangfuse.declaration')}
            checked={draft.erasureDeclared}
            onChange={(e) => setDraft({ ...draft, erasureDeclared: e.target.checked })}
          />
          <ReasonField value={reason} onChange={setReason} showError={tried} />
          <div className="row-gap">
            <Button type="submit" variant="primary" disabled={busy}>
              {t('integLangfuse.save')}
            </Button>
            {editing ? (
              <Button variant="secondary" data-color="danger" onClick={() => void remove(draft.id)}>
                {t('integLangfuse.remove')}
              </Button>
            ) : null}
            <Button variant="tertiary" onClick={close}>
              {t('integLangfuse.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
};
