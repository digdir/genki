import {
  Alert,
  Button,
  Checkbox,
  Field,
  Fieldset,
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
import type { TraceConnection, TraceInstance, Residency } from '../../api/tracing';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';

/** Digdir's Langfuse, or one the agency runs itself. */
type Kind = 'instance' | 'own';

interface Draft {
  id: string;
  /** The person typed the id; until then it follows the Langfuse chosen. */
  idTyped: boolean;
  kind: Kind;
  /** The address of the agency's own Langfuse, as typed. */
  host: string;
  /** The host the stored secret is set for; empty for a new connection. */
  storedHost: string;
  publicKey: string;
  /** The stored secret's reference, kept while no new key is entered. */
  secretKey: string;
  /** A new secret key: stored for the host before the connection is saved, never shown again. */
  secret: string;
  services: string[];
  /** The services the saved connection covers, which stay offered while unticked. */
  servicesWas: string[];
  /** The residency the agency declares for its own Langfuse. */
  residency: Residency;
  /** The residency an operator set on Digdir's Langfuse; a new connection there starts global. */
  instanceResidency: Residency;
  content: boolean;
  /** A connection to Digdir's Langfuse that already sends text, so it can be switched off. */
  contentWas: boolean;
  erasureDeclared: boolean;
  labels: boolean;
}

/** A free id for a new connection, named after the Langfuse chosen. */
const suggestedId = (kind: Kind, taken: string[]) => {
  const base = kind === 'instance' ? 'digdir-langfuse' : 'egen-langfuse';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};

const blank = (instance: TraceInstance | undefined, taken: string[]): Draft => {
  const kind: Kind = instance ? 'instance' : 'own';
  return {
    id: suggestedId(kind, taken),
    idTyped: false,
    kind,
    host: '',
    storedHost: '',
    publicKey: '',
    secretKey: '',
    secret: '',
    services: [],
    servicesWas: [],
    residency: 'global',
    instanceResidency: 'global',
    content: false,
    contentWas: false,
    erasureDeclared: false,
    labels: false,
  };
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

/** Digdir's address as the connection was saved with it, so an edit does not move it. */
const hostOf = (d: Draft, instance: TraceInstance | undefined) =>
  d.kind === 'instance' && instance
    ? originOf(d.storedHost) === originOf(instance.host)
      ? d.storedHost
      : instance.host
    : d.host;

/** A key must be entered for a new connection, and again when the address changes. */
const needsKey = (d: Draft, instance: TraceInstance | undefined) => {
  const host = originOf(hostOf(d, instance));
  return !d.secretKey || host === undefined || host !== originOf(d.storedHost);
};

/** Text goes to Digdir's Langfuse only once operators allow it; one already sending can stop. */
const offersContent = (d: Draft, instance: TraceInstance | undefined) =>
  d.kind === 'own' || instance?.content === true || d.contentWas;

const draftOf = (c: TraceConnection, instance: TraceInstance | undefined): Draft => {
  const kind: Kind = c.instance && instance ? 'instance' : 'own';
  return {
    id: c.id,
    idTyped: true,
    kind,
    host: kind === 'own' ? c.host : '',
    storedHost: c.host,
    publicKey: c.publicKey,
    secretKey: c.secretKey,
    secret: '',
    services: c.services,
    servicesWas: c.services,
    residency: kind === 'own' ? c.residency : 'global',
    instanceResidency: c.instance ? c.residency : 'global',
    content: c.content,
    contentWas: c.instance && c.content,
    erasureDeclared: c.erasureDeclared,
    labels: c.labels === true,
  };
};

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
    async (signal) => {
      const [listing, services] = await Promise.all([
        api.tracing.listing(tenant, signal),
        // Without the services the connections still show; the form keeps the ones saved.
        api.services(tenant, signal).then(
          (r) => r.data,
          () => undefined,
        ),
      ]);
      return { connections: listing.data, instance: listing.instance, services };
    },
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

  const instance = state.status === 'ready' ? state.data.instance : undefined;

  const save = async () => {
    if (!draft) return;
    setTried(true);
    const address = hostOf(draft, instance);
    const host = originOf(address);
    if (
      !idPattern.test(draft.id.trim()) ||
      !host ||
      !draft.publicKey ||
      (needsKey(draft, instance) && !draft.secret) ||
      reasonProblem(reason, t)
    )
      return;
    // Saving under a name that exists would replace that connection; only Endre does that.
    if (
      !editing &&
      state.status === 'ready' &&
      state.data.connections.some((c) => c.id === draft.id.trim())
    ) {
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
          host: address.trim(),
          publicKey: draft.publicKey.trim(),
          secretKey,
          services: draft.services,
          // On Digdir's Langfuse an operator sets the residency, and the API keeps it.
          ...(draft.kind === 'own' ? { residency: draft.residency } : {}),
          content: offersContent(draft, instance) && draft.content,
          // Digdir's operators answer for erasure there, not the agency.
          erasureDeclared: draft.kind === 'own' && draft.erasureDeclared,
          labels: draft.labels,
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
      const removed = (await api.tracing.remove(tenant, id, reason)) as { removing?: string };
      onFlash(
        t(removed.removing ? 'integLangfuse.removingFlash' : 'integLangfuse.removed', { id }),
      );
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
  const { connections, services } = state.data;

  /** The connection that covers a service, other than the one being edited. */
  const coveredBy = (service: string) =>
    connections.find(
      (c) => !c.removing && !(editing && c.id === draft?.id) && c.services.includes(service),
    )?.id;

  const choose = (d: Draft, kind: Kind) =>
    setDraft({
      ...d,
      kind,
      id:
        editing || d.idTyped
          ? d.id
          : suggestedId(
              kind,
              connections.map((c) => c.id),
            ),
    });

  const toggle = (d: Draft, service: string) =>
    setDraft({
      ...d,
      services: d.services.includes(service)
        ? d.services.filter((s) => s !== service)
        : [...d.services, service],
    });

  return (
    <section aria-labelledby="tracing-h" className="stack-md">
      <Heading level={3} data-size="xs" id="tracing-h">
        {t('integLangfuse.heading')}
      </Heading>
      <Paragraph data-size="sm">{t('integLangfuse.intro')}</Paragraph>
      {connections.length === 0 ? (
        <Paragraph data-size="sm">{t('integLangfuse.none')}</Paragraph>
      ) : (
        <ul className="plain-list stack-sm">
          {connections.map((c) => (
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
              {c.removing ? (
                <Tag data-size="sm" data-color="danger">
                  {t('integLangfuse.removing')}
                </Tag>
              ) : null}
              <Tag data-size="sm" data-color={c.content ? 'warning' : 'neutral'}>
                {t(c.content ? 'integLangfuse.contentOn' : 'integLangfuse.contentOff')}
              </Tag>
              {c.labels ? (
                <Tag data-size="sm" data-color="info">
                  {t('integLangfuse.labelsOn')}
                </Tag>
              ) : null}
              {c.datasets?.length ? (
                <>
                  <Heading level={5} data-size="2xs" id={`datasets-${c.id}`}>
                    {t('integLangfuse.datasets')}
                  </Heading>
                  <Paragraph data-size="sm">{t('integLangfuse.datasetsHelp')}</Paragraph>
                  <ul className="plain-list" aria-labelledby={`datasets-${c.id}`}>
                    {c.datasets.map((d) => (
                      <li key={d.id}>
                        <code>{d.name}</code>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {checked[c.id] ? <Paragraph data-size="sm">{checked[c.id]}</Paragraph> : null}
              <div className="row-gap">
                <Button variant="secondary" data-size="sm" onClick={() => void check(c.id)}>
                  {t('integLangfuse.check')}
                </Button>
                {canManage && !c.removing ? (
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    onClick={() => {
                      setEditing(true);
                      setDraft(draftOf(c, instance));
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
            setDraft(
              blank(
                instance,
                connections.map((c) => c.id),
              ),
            );
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
          {instance ? (
            <Field>
              <Label>{t('integLangfuse.which')}</Label>
              <Field.Description>
                {t('integLangfuse.whichHelp', { host: instance.host })}
              </Field.Description>
              <Select value={draft.kind} onChange={(e) => choose(draft, e.target.value as Kind)}>
                <Select.Option value="instance">{t('integLangfuse.instanceOption')}</Select.Option>
                <Select.Option value="own">{t('integLangfuse.ownOption')}</Select.Option>
              </Select>
            </Field>
          ) : null}
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
            onChange={(e) => setDraft({ ...draft, id: e.target.value, idTyped: true })}
          />
          {draft.kind === 'own' ? (
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
          ) : null}
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
              tried && needsKey(draft, instance) && !draft.secret
                ? t(draft.secretKey ? 'integLangfuse.secretAgain' : 'integLangfuse.required')
                : undefined
            }
            onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
          />
          <Fieldset>
            <Fieldset.Legend>{t('integLangfuse.servicesLabel')}</Fieldset.Legend>
            <Fieldset.Description>{t('integLangfuse.servicesHelp')}</Fieldset.Description>
            {services === undefined ? (
              <Paragraph data-size="sm">{t('integLangfuse.servicesFailed')}</Paragraph>
            ) : services.length === 0 ? (
              <Paragraph data-size="sm">{t('integLangfuse.noServices')}</Paragraph>
            ) : null}
            {(services ?? [])
              // An archived service is offered only to a connection that already covers it.
              .filter((s) => s.lifecycle !== 'archived' || draft.servicesWas.includes(s.id))
              .map((s) => {
                const taken = coveredBy(s.id);
                const ticked = draft.services.includes(s.id);
                return (
                  <Checkbox
                    key={s.id}
                    label={s.name}
                    description={taken ? t('integLangfuse.coveredBy', { id: taken }) : undefined}
                    // One this connection covers stays free, even if another connection covers it too.
                    disabled={taken !== undefined && !draft.servicesWas.includes(s.id)}
                    checked={ticked}
                    onChange={() => toggle(draft, s.id)}
                  />
                );
              })}
            {/* An id saved before services were picked from this list, so it can be unticked. */}
            {[...new Set([...draft.servicesWas, ...draft.services])]
              .filter((id) => !services?.some((s) => s.id === id))
              .map((id) => (
                <Checkbox
                  key={id}
                  label={services ? t('integLangfuse.unknownService', { id }) : id}
                  checked={draft.services.includes(id)}
                  onChange={() => toggle(draft, id)}
                />
              ))}
          </Fieldset>
          {draft.kind === 'own' ? (
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
          ) : (
            <Paragraph data-size="sm">
              {t('integLangfuse.residencyByDigdir', {
                residency: residencyText(t, draft.instanceResidency),
              })}
            </Paragraph>
          )}
          {offersContent(draft, instance) ? (
            <Switch
              label={t('integLangfuse.content')}
              description={t('integLangfuse.contentHelp')}
              checked={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.checked })}
            />
          ) : null}
          {draft.kind === 'own' && draft.content ? (
            <Checkbox
              label={t('integLangfuse.declaration')}
              checked={draft.erasureDeclared}
              onChange={(e) => setDraft({ ...draft, erasureDeclared: e.target.checked })}
            />
          ) : null}
          <Switch
            label={t('integLangfuse.labels')}
            description={t('integLangfuse.labelsHelp')}
            checked={draft.labels}
            onChange={(e) => setDraft({ ...draft, labels: e.target.checked })}
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
