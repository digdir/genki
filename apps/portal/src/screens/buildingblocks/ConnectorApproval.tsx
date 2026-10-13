import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Spinner,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { CatalogProposal, ConnectionCheckFailure, HostReach } from '../../api/building-blocks';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import { useT, type T } from '../../i18n';
import { rightLabels } from '../../Shell';
import { ApiCallButton, type Flash } from './common';
import {
  blankConnection,
  connectionInput,
  connectionProblems,
  NetworkAlert,
  ReadsSummary,
  readOnlyRules,
  unencryptedWarning,
  type ConnectionForm,
  type TlsMode,
} from './Connectors';
import { approvalRight, MappingTable } from './ProposalSection';

export interface CheckError {
  title: string;
  text: string;
}

export const checkError = (
  failure: ConnectionCheckFailure,
  form: Pick<ConnectionForm, 'user' | 'database'>,
  table: string,
  t: T,
): CheckError => {
  if (failure.code === 'auth')
    return {
      title: t('connectorApproval.authTitle'),
      text: t('connectorApproval.authText', { user: form.user, database: form.database }),
    };
  if (failure.code === 'table')
    return {
      title: t('connectorApproval.tableTitle', { table }),
      text: t('connectorApproval.tableText', { user: form.user, table }),
    };
  if (failure.code === 'columns') {
    const missing = failure.missing ?? [];
    return {
      title: t('connectorApproval.columnsTitle', {
        count: missing.length,
        columns: missing.join(', '),
      }),
      text: [
        ...(failure.known?.length
          ? [t('connectorApproval.columnsKnown', { table, columns: failure.known.join(', ') })]
          : []),
        t('connectorApproval.columnsAdvice'),
      ].join(' '),
    };
  }
  return { title: t('connectorApproval.readFailed'), text: failure.message };
};

type Failure =
  | { kind: 'check'; error: CheckError }
  | { kind: 'network'; reach: Pick<HostReach, 'host' | 'network' | 'allowed' | 'message'> }
  | { kind: 'other'; text: string };

export const ConnectorApproval = ({
  api,
  tenant,
  tenantName,
  proposal,
  onDone,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  proposal: CatalogProposal;
  onDone: (flash: Flash) => void;
}) => {
  const headingId = useId();
  const tlsId = useId();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [open, setOpen] = useState(true);
  const [form, setForm] = useState<ConnectionForm>(() => blankConnection(proposal.source));
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reach, setReach] = useState<HostReach>();
  const [failure, setFailure] = useState<Failure>();
  const service = proposal.forService.name;
  const name = proposal.item?.name ?? t('connectorApproval.defaultName', { service });
  const source = proposal.source;
  const table = source?.table ?? '';
  const errors = tried ? connectionProblems(form, t) : {};
  const shownReach =
    failure?.kind === 'network'
      ? failure.reach
      : reach && reach.host === form.host.trim() && reach.network !== 'public'
        ? reach
        : undefined;
  const hostRefused = !!shownReach && !shownReach.allowed && shownReach.network !== 'unknown';

  const set = (patch: Partial<ConnectionForm>) => {
    setForm({ ...form, ...patch });
    if (failure?.kind !== 'other' && ('password' in patch || 'host' in patch))
      setFailure(undefined);
  };

  const check = (host: string) => {
    if (!host.trim()) return setReach(undefined);
    api.buildingBlocks.connectorNetwork(tenant, host.trim()).then(setReach, () => undefined);
  };

  const decide = async (action: 'approve' | 'reject', text: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const t = tRef.current;
      const { changedBy } = await api.buildingBlocks.decideProposal(
        tenant,
        proposal.id,
        action,
        text,
        action === 'approve' ? connectionInput(form) : undefined,
      );
      onDone(
        action === 'approve'
          ? {
              kind: 'logged',
              text: t('connectorApproval.approved', { name, service }),
              change: changedBy,
            }
          : {
              kind: 'plain',
              text: t('connectorApproval.rejected'),
            },
      );
    } catch (error) {
      const t = tRef.current;
      const problem = error instanceof ApiError ? error.problem : undefined;
      const first = problem?.errors?.[0] as ConnectionCheckFailure | undefined;
      if (error instanceof ApiError && error.status === 422 && first?.path === 'connection.host') {
        setFailure({
          kind: 'network',
          reach: {
            host: form.host.trim(),
            network:
              problem?.title === t('connectorApproval.addressUnusable') ||
              problem?.title === 'Adressen kan ikke brukes'
                ? 'blocked'
                : 'private',
            allowed: false,
            message: first.message,
          },
        });
      } else if (
        error instanceof ApiError &&
        error.status === 422 &&
        first?.path === 'connection'
      ) {
        setFailure({ kind: 'check', error: checkError(first, form, table, t) });
        setForm((f) => ({ ...f, password: '' }));
      } else
        setFailure({
          kind: 'other',
          text:
            problem && (error as ApiError).status === 422
              ? [problem.title, ...(problem.errors ?? []).map((e) => e.message)].join(': ')
              : problem && (error as ApiError).status === 403
                ? problem.title
                : t('connectorApproval.notSaved'),
        });
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    if (busy) return;
    setTried(true);
    if (Object.keys(connectionProblems(form, t)).length || reasonProblem(reason)) return;
    if (hostRefused) return;
    void decide('approve', reason);
  };

  const reject = () => {
    if (busy) return;
    void decide('reject', reasonProblem(reason) ? t('connectorApproval.rejectedReason') : reason);
  };

  const call = () => ({
    action: t('connectorApproval.approveAction'),
    method: 'POST' as const,
    path: api.buildingBlocks.proposalsPath(tenant, `/${encodeURIComponent(proposal.id)}/approve`),
    body: {
      reason: reason.trim() || '…',
      connection: { ...connectionInput(form), password: '••••' },
    },
    right: rightLabels[approvalRight(proposal)],
  });

  if (!open)
    return (
      <section aria-labelledby={headingId} className="bb-proposal">
        <div className="bb-connector-head">
          <Heading level={2} data-size="xs" id={headingId}>
            {t('connectorApproval.newConnection', { name })}
          </Heading>
          <Tag data-color="neutral" data-size="sm">
            {t('connectorApproval.proposalTag')}
          </Tag>
        </div>
        <Paragraph data-size="sm">{t('connectorApproval.notActive')}</Paragraph>
        <div className="actions">
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t('connectorApproval.resume')}
          </Button>
        </div>
      </section>
    );

  return (
    <section aria-labelledby={headingId} className="bb-connect">
      <div className="bb-connector-head">
        <Heading level={2} data-size="sm" id={headingId}>
          {t('connectorApproval.approveHeading', { name })}
        </Heading>
        <Tag data-color="neutral" data-size="sm">
          {t('connectorApproval.proposalTag')}
        </Tag>
      </div>
      {source ? (
        <ReadsSummary source={source} dataset={name} />
      ) : proposal.mapping?.length ? (
        <MappingTable mapping={proposal.mapping} />
      ) : null}
      <div aria-live="polite" className="stack-sm">
        {failure?.kind === 'check' ? (
          <Alert data-color="danger">
            <Heading level={3} data-size="2xs">
              {failure.error.title}
            </Heading>
            <Paragraph>{failure.error.text}</Paragraph>
            <Paragraph>{t('connectorApproval.nothingSaved')}</Paragraph>
          </Alert>
        ) : null}
        {shownReach ? <NetworkAlert reach={shownReach} tenantName={tenantName} /> : null}
        {failure?.kind === 'other' ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            <Paragraph data-size="sm">{failure.text}</Paragraph>
          </Alert>
        ) : null}
      </div>
      <div className="bb-connect-host">
        <Textfield
          label={t('connectorApproval.host')}
          value={form.host}
          error={errors.host}
          aria-invalid={hostRefused || !!errors.host || undefined}
          onChange={(e) => set({ host: e.target.value })}
          onBlur={(e) => check(e.target.value)}
        />
        <Textfield
          label={t('connectorApproval.port')}
          inputMode="numeric"
          value={form.port}
          error={errors.port}
          onChange={(e) => set({ port: e.target.value })}
        />
      </div>
      <Textfield
        label={t('connectorApproval.database')}
        value={form.database}
        error={errors.database}
        onChange={(e) => set({ database: e.target.value })}
      />
      <Textfield
        label={t('connectorApproval.user')}
        description={t('connectorApproval.userHelp')}
        autoComplete="off"
        value={form.user}
        error={errors.user}
        onChange={(e) => set({ user: e.target.value })}
      />
      <Textfield
        label={t('connectorApproval.password')}
        description={t('connectorApproval.passwordHelp')}
        type="password"
        autoComplete="new-password"
        value={form.password}
        error={errors.password}
        aria-invalid={failure?.kind === 'check' || !!errors.password || undefined}
        onChange={(e) => set({ password: e.target.value })}
      />
      <Field className="bb-connect-tls">
        <Label htmlFor={tlsId}>{t('connectorApproval.tls')}</Label>
        <Select
          id={tlsId}
          value={form.tls}
          onChange={(e) => set({ tls: e.target.value as TlsMode })}
        >
          <Select.Option value="verify">{t('connectorApproval.tlsVerify')}</Select.Option>
          <Select.Option value="off">{t('connectorApproval.tlsOff')}</Select.Option>
        </Select>
      </Field>
      {form.tls === 'off' ? (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t('connectorApproval.tlsOffNote', { warning: unencryptedWarning(t) })}
          </Paragraph>
        </Alert>
      ) : null}
      <ul className="bb-connect-rules">
        {readOnlyRules(t).map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className="bb-reason">
        <ReasonField
          value={reason}
          onChange={setReason}
          showError={tried}
          description={t('connectorApproval.reasonHelp', { service })}
        />
      </div>
      {busy ? (
        <div role="status" className="bb-connect-testing">
          <Spinner aria-hidden="true" data-size="sm" />
          {table ? t('connectorApproval.testingTable', { table }) : t('connectorApproval.testing')}
        </div>
      ) : null}
      <div className="actions">
        <Button variant="primary" onClick={approve} aria-disabled={busy || undefined}>
          {t('connectorApproval.approveAction')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t('connectorApproval.cancel')}
        </Button>
        <Button variant="tertiary" onClick={reject} aria-disabled={busy || undefined}>
          {t('connectorApproval.reject')}
        </Button>
        <ApiCallButton call={call} />
      </div>
    </section>
  );
};
