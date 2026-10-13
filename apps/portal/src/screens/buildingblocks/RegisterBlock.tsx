import {
  Alert,
  Button,
  Checkbox,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Spinner,
  Tag,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type {
  AgentCardSummary,
  CatalogItem,
  ContractTest,
  ExtensionPoint,
  ManifestPreview,
  RegisteredTool,
  RegistrationAuth,
  RegistrationInput,
  RegistrationType,
  TenantSecretName,
} from '../../api/building-blocks';
import { Crumbs } from '../../components/Crumbs';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import {
  authOptions,
  authUnavailableKey,
  defaultAuthFor,
  extensionPoints,
  registrationTypes,
} from '../../data/building-blocks';
import { navigate } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import { rightLabel } from '../../Shell';
import { refusalOf } from '../../states';
import { ApiCallButton, PermissionList, useBlockRights, type Flash } from './common';

interface Form {
  type: RegistrationType;
  name: string;
  url: string;
  file?: { name: string; content: string } | undefined;
  extensionPoint: ExtensionPoint;
  auth: RegistrationAuth['kind'];
  secret: string;
  header: string;
  documentUrl: string;
  operations?: string[] | undefined;
  writes: boolean;
  tokenUrl: string;
  clientId: string;
  scope: string;
}

const emptyForm: Form = {
  type: 'mcp',
  name: '',
  url: '',
  extensionPoint: 'before_model',
  auth: defaultAuthFor('mcp'),
  secret: '',
  header: '',
  documentUrl: '',
  writes: false,
  tokenUrl: '',
  clientId: '',
  scope: '',
};

const needsUrl = (type: RegistrationType) =>
  ['mcp', 'a2a', 'openapi', 'extension_point'].includes(type);
const needsFile = (form: Form) =>
  form.type === 'skill_package' || (form.type === 'openapi' && !form.documentUrl.trim());
const usesSecret = (form: Form) =>
  form.type !== 'skill_package' &&
  (form.auth === 'api-key' || form.auth === 'oauth-client-credentials');
const httpsUrl = /^https:\/\/.+/;

const authOf = (form: Form): RegistrationAuth =>
  form.auth === 'api-key'
    ? {
        kind: 'api-key',
        ...(form.secret ? { secret: form.secret } : {}),
        ...(form.header.trim() ? { header: form.header.trim() } : {}),
      }
    : form.auth === 'oauth-client-credentials'
      ? {
          kind: 'oauth-client-credentials',
          ...(form.secret ? { secret: form.secret } : {}),
          ...(form.tokenUrl.trim() ? { tokenUrl: form.tokenUrl.trim() } : {}),
          ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
          ...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
        }
      : { kind: form.auth };

export const agentCardUrl = (address: string) => {
  const url = address.trim();
  return !url || /\.json(\?.*)?$/i.test(url)
    ? url
    : `${url.replace(/\/+$/, '')}/.well-known/agent-card.json`;
};

const toDraft = (form: Form): RegistrationInput => ({
  type: form.type,
  name: form.name.trim(),
  ...(needsUrl(form.type)
    ? { endpoint: form.type === 'a2a' ? agentCardUrl(form.url) : form.url.trim() }
    : {}),
  ...(form.type === 'extension_point' ? { extensionPoint: form.extensionPoint } : {}),
  ...(form.type === 'skill_package' ? {} : { auth: authOf(form) }),
  ...(form.type === 'openapi'
    ? {
        ...(form.documentUrl.trim()
          ? { documentUrl: form.documentUrl.trim() }
          : form.file
            ? { document: form.file.content }
            : {}),
        ...(form.operations ? { operations: form.operations } : {}),
        writes: form.writes,
      }
    : {}),
});

const urlLabels: Partial<Record<RegistrationType, PlainKey>> = {
  mcp: 'blocks.urlMcp',
  a2a: 'blocks.urlA2a',
  openapi: 'blocks.urlOpenapi',
  extension_point: 'blocks.urlExtensionPoint',
};

const OperationLabel = ({ tool }: { tool: RegisteredTool }) => (
  <span className="bb-operation">
    {tool.method ? (
      <Tag data-size="sm" data-color={tool.readOnly ? 'info' : 'warning'}>
        {tool.method}
      </Tag>
    ) : null}{' '}
    <code>{tool.path ?? tool.operation ?? tool.name}</code>
  </span>
);

const AgentCardPreview = ({ agent }: { agent: AgentCardSummary }) => {
  const t = useT();
  return (
    <div className="bb-agent-card">
      <div className="tag-row">
        <Heading level={3} data-size="2xs">
          {agent.name}
        </Heading>
        {agent.provider ? (
          <Tag data-size="sm" data-color="neutral">
            {agent.provider}
          </Tag>
        ) : null}
        {agent.version ? (
          <Tag data-size="sm" data-color="info">
            {t('blocks.versionCap', { version: agent.version })}
          </Tag>
        ) : null}
      </div>
      <Paragraph data-size="sm">{agent.description}</Paragraph>
      {agent.skills.length ? (
        <>
          <span className="bb-strong">{t('blocks.agentSkills')}</span>
          <ul className="bb-agent-skills">
            {agent.skills.map((k) => (
              <li key={k.name}>
                {k.name}
                {k.description ? `: ${k.description}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
};

const genericTitle = /^(Forbidden|Invalid request|Request failed|Not found|Conflict|Unauthorized)/;

const registerFailure = (t: T, error: unknown, showTests: (tests: ContractTest[]) => void) => {
  const refusal = refusalOf(error);
  if (refusal) return refusal;
  const problem = error instanceof ApiError ? error.problem : undefined;
  const tests = (problem as { contractTests?: ContractTest[] } | undefined)?.contractTests;
  if (error instanceof ApiError && error.status === 422 && tests?.length) {
    showTests(tests);
    return t('blocks.registerContractFailed');
  }
  return problem?.title && !genericTitle.test(problem.title)
    ? problem.title
    : t('blocks.registerFailed');
};

export const RegisterBlock = ({
  api,
  tenant,
  tenantName,
  onRegistered,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  onRegistered: (block: Pick<CatalogItem, 'kind' | 'id'>, flash: Flash) => void;
}) => {
  const t = useT();
  const ids = {
    name: useId(),
    url: useId(),
    urlHelp: useId(),
    file: useId(),
    point: useId(),
    auth: useId(),
    authHelp: useId(),
    secret: useId(),
    header: useId(),
    documentUrl: useId(),
    tokenUrl: useId(),
    clientId: useId(),
    scope: useId(),
    setup: useId(),
    access: useId(),
    manifest: useId(),
    register: useId(),
  };
  const { canRegister } = useBlockRights();
  const [form, setForm] = useState<Form>(emptyForm);
  const [tried, setTried] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ContractTest[] | null>(null);
  const [preview, setPreview] = useState<ManifestPreview | null>(null);
  const [reason, setReason] = useState('');
  const [reasonTried, setReasonTried] = useState(false);
  const [failed, setFailed] = useState('');
  const [secrets, setSecrets] = useState<TenantSecretName[] | null>(null);
  const [secretsFailed, setSecretsFailed] = useState(false);
  const [operations, setOperations] = useState<RegisteredTool[] | null>(null);
  const [agent, setAgent] = useState<AgentCardSummary | null>(null);

  useEffect(() => {
    if (!canRegister) return;
    const controller = new AbortController();
    api.buildingBlocks.secrets(tenant, controller.signal).then(
      (list) => setSecrets(list),
      () => !controller.signal.aborted && setSecretsFailed(true),
    );
    return () => controller.abort();
  }, [tenant, canRegister]);

  const draft = toDraft(form);
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.buildingBlocks.manifestPreview(tenant, draft).then(
        (p) => !controller.signal.aborted && setPreview(p),
        () => undefined,
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draftKey, tenant]);

  const change = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setResult(null);
    setFailed('');
    if ('type' in patch || 'url' in patch) setAgent(null);
    if ('type' in patch || 'file' in patch || 'documentUrl' in patch) {
      setOperations(null);
      setForm((f) => ({ ...f, operations: undefined }));
    }
  };

  const selected = (tool: RegisteredTool) =>
    form.operations ? form.operations.includes(tool.operation ?? '') : tool.status === 'enabled';

  const toggleOperation = (tool: RegisteredTool) => {
    if (!operations || !tool.operation) return;
    const current = operations.filter(selected).flatMap((o) => (o.operation ? [o.operation] : []));
    change({
      operations: current.includes(tool.operation)
        ? current.filter((id) => id !== tool.operation)
        : [...current, tool.operation],
    });
  };

  const nameError = tried && !form.name.trim() ? t('blocks.nameProblem') : undefined;
  const urlError =
    tried && needsUrl(form.type) && !httpsUrl.test(form.url.trim())
      ? t('blocks.httpsProblem')
      : undefined;
  const fileError =
    tried && needsFile(form) && !form.file
      ? form.type === 'openapi'
        ? t('blocks.openapiFileProblem')
        : t('blocks.skillPackageProblem')
      : undefined;
  const documentUrlError =
    tried && form.documentUrl.trim() && !httpsUrl.test(form.documentUrl.trim())
      ? t('blocks.httpsProblem')
      : undefined;
  const secretError =
    tried && usesSecret(form) && !form.secret ? t('blocks.secretProblem') : undefined;
  const oauth = form.type !== 'skill_package' && form.auth === 'oauth-client-credentials';
  const tokenUrlError =
    tried && oauth && !httpsUrl.test(form.tokenUrl.trim()) ? t('blocks.httpsProblem') : undefined;
  const clientIdError =
    tried && oauth && !form.clientId.trim() ? t('blocks.clientIdProblem') : undefined;
  const authNoteKey = authOptions
    .map((o) => authUnavailableKey(form.type, o.value))
    .find((reason) => reason !== undefined);
  const authNote = authNoteKey ? t(authNoteKey) : undefined;
  const passed = !!result && result.every((test) => test.passed);
  const failures = result?.filter((test) => !test.passed).length ?? 0;
  const typeInfo = registrationTypes.find((rt) => rt.type === form.type);

  const runTest = async () => {
    if (testing) return;
    setTried(true);
    const invalid =
      !form.name.trim() ||
      (needsUrl(form.type) && !httpsUrl.test(form.url.trim())) ||
      (needsFile(form) && !form.file) ||
      (form.documentUrl.trim() !== '' && !httpsUrl.test(form.documentUrl.trim())) ||
      (usesSecret(form) && !form.secret) ||
      (oauth && (!httpsUrl.test(form.tokenUrl.trim()) || !form.clientId.trim()));
    if (invalid) return;
    setTesting(true);
    setResult(null);
    try {
      const outcome = await api.buildingBlocks.contractTest(tenant, draft);
      setResult(outcome.results);
      setAgent(outcome.agent ?? null);
      if (form.type === 'openapi') {
        const listed = outcome.tools.filter((tool) => tool.operation);
        setOperations(listed.length ? listed : null);
      }
    } catch (error) {
      setResult([
        {
          name: t('blocks.testSetupValid'),
          passed: false,
          reason: error instanceof ApiError ? error.message : t('blocks.testCouldNotRun'),
        },
      ]);
    } finally {
      setTesting(false);
    }
  };

  const register = async () => {
    if (!passed) return;
    setReasonTried(true);
    if (reasonProblem(reason, t)) return;
    try {
      const registered = await api.buildingBlocks.register(tenant, draft, reason);
      onRegistered(registered, {
        kind: 'logged',
        text: registered.writesApproval
          ? t('blocks.registeredWrites', { name: draft.name })
          : t('blocks.registered', { name: draft.name, tenant: tenantName }),
        change: registered.changedBy,
      });
    } catch (error) {
      setFailed(registerFailure(t, error, setResult));
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) {
      change({ file: undefined });
      return;
    }
    const content = typeof file.text === 'function' ? await file.text() : '';
    change({ file: { name: file.name, content } });
  };

  const crumbs = (
    <Crumbs
      items={[
        { label: t('blocks.title'), href: '#/building-blocks' },
        { label: t('blocks.addOwn') },
      ]}
    />
  );

  if (!canRegister)
    return (
      <div className="stack">
        {crumbs}
        <Heading level={1} data-size="md">
          {t('blocks.addOwn')}
        </Heading>
        <Alert data-color="info">
          <Paragraph>
            {t('blocks.registerNeedsRight', { right: rightLabel(t, 'register-building-blocks') })}
          </Paragraph>
        </Alert>
      </div>
    );

  return (
    <div className="stack">
      {crumbs}
      <div className="bb-intro">
        <Heading level={1} data-size="md">
          {t('blocks.addOwn')}
        </Heading>
        <p className="lead">{t('blocks.registerLead', { tenant: tenantName })}</p>
      </div>

      <fieldset className="bb-fieldset">
        <legend className="ds-heading bb-legend" data-size="xs">
          {t('blocks.whatToAdd')}
        </legend>
        <div className="bb-types">
          {registrationTypes.map((rt) => (
            <label key={rt.type} className={`bb-type${form.type === rt.type ? ' selected' : ''}`}>
              <input
                className="ds-input"
                type="radio"
                name="bb-reg-type"
                checked={form.type === rt.type}
                onChange={() => {
                  change({
                    type: rt.type,
                    ...(authUnavailableKey(rt.type, form.auth)
                      ? { auth: defaultAuthFor(rt.type) }
                      : {}),
                  });
                  setTried(false);
                }}
              />
              <span className="bb-type-text">
                <span className="bb-strong">{t(rt.label)}</span>
                <span className="bb-meta">{t(rt.description)}</span>
                {rt.notDecided ? (
                  <Tag data-size="sm" data-color="warning" className="bb-start">
                    {t('blocks.apiNotDecided')}
                  </Tag>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="bb-reg-grid">
        <section aria-labelledby={ids.setup} className="stack-sm bb-setup">
          <Heading level={2} data-size="xs" id={ids.setup}>
            {t('blocks.setup')}
          </Heading>
          <Field>
            <Label htmlFor={ids.name}>{t('blocks.name')}</Label>
            <Input
              id={ids.name}
              type="text"
              value={form.name}
              aria-invalid={nameError ? true : undefined}
              onChange={(e) => change({ name: e.target.value })}
            />
            {nameError ? <ValidationMessage>{nameError}</ValidationMessage> : null}
          </Field>
          {form.type === 'extension_point' ? (
            <Field>
              <Label htmlFor={ids.point}>{t('blocks.whenRun')}</Label>
              <Select
                id={ids.point}
                value={form.extensionPoint}
                onChange={(e) => change({ extensionPoint: e.target.value as ExtensionPoint })}
              >
                {extensionPoints.map((p) => (
                  <Select.Option key={p.value} value={p.value}>
                    {t(p.label)}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          ) : null}
          {needsUrl(form.type) ? (
            <Field>
              <Label htmlFor={ids.url}>
                {urlLabels[form.type] ? t(urlLabels[form.type] as PlainKey) : ''}
              </Label>
              {form.type === 'a2a' ? (
                <span className="bb-help" id={ids.urlHelp}>
                  {t('blocks.agentCardHelp')}
                </span>
              ) : null}
              <div className="bb-url-row">
                <Input
                  id={ids.url}
                  type="url"
                  value={form.url}
                  aria-invalid={urlError ? true : undefined}
                  aria-describedby={form.type === 'a2a' ? ids.urlHelp : undefined}
                  onChange={(e) => change({ url: e.target.value })}
                />
                {form.type === 'a2a' ? (
                  <Button
                    variant="secondary"
                    aria-disabled={testing || undefined}
                    onClick={() => void runTest()}
                  >
                    {t('blocks.fetchAgentCard')}
                  </Button>
                ) : null}
              </div>
              {urlError ? <ValidationMessage>{urlError}</ValidationMessage> : null}
            </Field>
          ) : null}
          {form.type === 'a2a' && agent ? <AgentCardPreview agent={agent} /> : null}
          {form.type === 'skill_package' ||
          (form.type === 'openapi' && !form.documentUrl.trim()) ? (
            <Field>
              <Label htmlFor={ids.file}>
                {form.type === 'openapi' ? t('blocks.openapiFile') : t('blocks.skillPackageFile')}
              </Label>
              <Input
                id={ids.file}
                type="file"
                aria-invalid={fileError ? true : undefined}
                onChange={(e) => void pickFile(e.target.files?.[0])}
              />
              {form.file ? (
                <span className="bb-meta">{t('blocks.chosenFile', { name: form.file.name })}</span>
              ) : null}
              {fileError ? <ValidationMessage>{fileError}</ValidationMessage> : null}
            </Field>
          ) : null}
          {form.type === 'openapi' ? (
            <Field>
              <Label htmlFor={ids.documentUrl}>
                {form.file ? t('blocks.documentUrlOptional') : t('blocks.documentUrlOr')}
              </Label>
              <Input
                id={ids.documentUrl}
                type="url"
                value={form.documentUrl}
                aria-invalid={documentUrlError ? true : undefined}
                onChange={(e) => change({ documentUrl: e.target.value })}
              />
              {documentUrlError ? <ValidationMessage>{documentUrlError}</ValidationMessage> : null}
            </Field>
          ) : null}
          {form.type === 'skill_package' ? null : (
            <Field>
              <Label htmlFor={ids.auth}>{t('blocks.login')}</Label>
              <Select
                id={ids.auth}
                value={form.auth}
                aria-describedby={authNote ? ids.authHelp : undefined}
                onChange={(e) => change({ auth: e.target.value as Form['auth'] })}
              >
                {authOptions.map((o) => {
                  const unavailable = authUnavailableKey(form.type, o.value);
                  return (
                    <Select.Option key={o.value} value={o.value} disabled={!!unavailable}>
                      {unavailable ? t('blocks.authNotYet', { label: t(o.label) }) : t(o.label)}
                    </Select.Option>
                  );
                })}
              </Select>
              {authNote ? (
                <span id={ids.authHelp} className="bb-help">
                  {authNote}
                </span>
              ) : null}
            </Field>
          )}
          {oauth ? (
            <>
              <Field>
                <Label htmlFor={ids.tokenUrl}>{t('blocks.tokenUrl')}</Label>
                <Input
                  id={ids.tokenUrl}
                  type="url"
                  value={form.tokenUrl}
                  aria-invalid={tokenUrlError ? true : undefined}
                  onChange={(e) => change({ tokenUrl: e.target.value })}
                />
                {tokenUrlError ? <ValidationMessage>{tokenUrlError}</ValidationMessage> : null}
              </Field>
              <Field>
                <Label htmlFor={ids.clientId}>{t('blocks.clientId')}</Label>
                <Input
                  id={ids.clientId}
                  type="text"
                  value={form.clientId}
                  aria-invalid={clientIdError ? true : undefined}
                  onChange={(e) => change({ clientId: e.target.value })}
                />
                {clientIdError ? <ValidationMessage>{clientIdError}</ValidationMessage> : null}
              </Field>
              <Field>
                <Label htmlFor={ids.scope}>{t('blocks.scope')}</Label>
                <Input
                  id={ids.scope}
                  type="text"
                  value={form.scope}
                  onChange={(e) => change({ scope: e.target.value })}
                />
              </Field>
            </>
          ) : null}
          {usesSecret(form) ? (
            <>
              <Field>
                <Label htmlFor={ids.secret}>{t('blocks.secret')}</Label>
                <Select
                  id={ids.secret}
                  value={form.secret}
                  aria-invalid={secretError ? true : undefined}
                  onChange={(e) => change({ secret: e.target.value })}
                >
                  <Select.Option value="">{t('blocks.chooseSecret')}</Select.Option>
                  {(secrets ?? []).map((secret) => (
                    <Select.Option key={secret.ref} value={secret.ref}>
                      {secret.name}
                    </Select.Option>
                  ))}
                </Select>
                {secretsFailed ? (
                  <span className="bb-help">{t('blocks.secretsFailed')}</span>
                ) : secrets?.length === 0 ? (
                  <span className="bb-help">{t('blocks.noSecrets', { tenant: tenantName })}</span>
                ) : null}
                {secretError ? <ValidationMessage>{secretError}</ValidationMessage> : null}
              </Field>
              {form.auth === 'api-key' ? (
                <Field>
                  <Label htmlFor={ids.header}>{t('blocks.headerName')}</Label>
                  <Input
                    id={ids.header}
                    type="text"
                    placeholder="x-api-key"
                    value={form.header}
                    onChange={(e) => change({ header: e.target.value })}
                  />
                </Field>
              ) : null}
            </>
          ) : null}
          {form.type === 'openapi' && operations ? (
            <Fieldset>
              <Fieldset.Legend>{t('blocks.operationsLegend')}</Fieldset.Legend>
              <Fieldset.Description>{t('blocks.operationsHelp')}</Fieldset.Description>
              <Checkbox
                label={t('blocks.allowWrites')}
                description={t('blocks.allowWritesHelp')}
                checked={form.writes}
                onChange={() =>
                  change({
                    writes: !form.writes,
                    operations: operations
                      .filter((o) => selected(o) && (o.readOnly || !form.writes))
                      .flatMap((o) => (o.operation ? [o.operation] : [])),
                  })
                }
              />
              {operations.map((tool) => {
                const locked = !tool.readOnly && !form.writes;
                return (
                  <Checkbox
                    key={tool.operation}
                    label={<OperationLabel tool={tool} />}
                    description={
                      locked
                        ? `${tool.description ?? ''} ${t('blocks.changesDataFirst')}`.trim()
                        : tool.description
                    }
                    checked={selected(tool) && !locked}
                    aria-disabled={locked || undefined}
                    onChange={() => {
                      if (!locked) toggleOperation(tool);
                    }}
                  />
                );
              })}
            </Fieldset>
          ) : null}
          <div className="actions">
            <Button
              variant="secondary"
              aria-disabled={testing || undefined}
              onClick={() => void runTest()}
            >
              {result ? t('blocks.runContractAgain') : t('blocks.runContract')}
            </Button>
            <span role="status" className="bb-status">
              {testing ? (
                <>
                  <Spinner aria-hidden="true" data-size="xs" />
                  {t('blocks.runningContract')}
                </>
              ) : null}
            </span>
          </div>
          {result && !testing ? (
            <div className={`bb-result ${passed ? 'passed' : 'failed'}`}>
              <Tag data-color={passed ? 'success' : 'danger'} className="bb-start">
                {passed
                  ? t('blocks.contractPassed')
                  : t('blocks.contractFailedCount', { failed: failures, total: result.length })}
              </Tag>
              {passed ? null : <Paragraph data-size="sm">{t('blocks.fixFailures')}</Paragraph>}
              <ul className="bb-test-list">
                {result.map((test) => (
                  <li key={test.name}>
                    <Tag data-size="sm" data-color={test.passed ? 'success' : 'danger'}>
                      {test.passed ? t('blocks.passed') : t('blocks.failed')}
                    </Tag>
                    <span>
                      {test.name}
                      {test.reason ? <span className="bb-fail-reason">{test.reason}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <div className="stack-sm bb-preview">
          <section aria-labelledby={ids.access} className="stack-sm">
            <Heading level={2} data-size="xs" id={ids.access}>
              {t('blocks.requestedAccess')}
            </Heading>
            <div className="bb-boxed">
              <PermissionList permissions={preview?.permissions ?? []} />
            </div>
          </section>
          <section aria-labelledby={ids.manifest} className="stack-sm">
            <div className="bb-stack-xs">
              <Heading level={2} data-size="xs" id={ids.manifest}>
                {t('blocks.manifest')}
              </Heading>
              <span className="bb-meta">{t('blocks.manifestNote')}</span>
            </div>
            <pre className="bb-manifest" tabIndex={0} aria-label={t('blocks.manifest')}>
              <code>{preview?.manifest ?? ''}</code>
            </pre>
          </section>
        </div>
      </div>

      <section aria-labelledby={ids.register} className="bb-register">
        <Heading level={2} data-size="xs" id={ids.register}>
          {t('blocks.register')}
        </Heading>
        <div className="bb-reason">
          <ReasonField
            value={reason}
            onChange={setReason}
            showError={reasonTried}
            description={t('blocks.registerLogged')}
          />
        </div>
        {passed ? null : <p className="bb-meta">{t('blocks.runContractFirst')}</p>}
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            <Paragraph data-size="sm">{failed}</Paragraph>
          </Alert>
        ) : null}
        <div className="actions">
          <Button
            variant="primary"
            aria-disabled={!passed || undefined}
            onClick={() => void register()}
          >
            {t('blocks.registerBlock')}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/building-blocks')}>
            {t('common.cancel')}
          </Button>
          <ApiCallButton
            call={() => ({
              action: t('blocks.registerBlock'),
              method: 'POST',
              path: api.buildingBlocks.path(tenant),
              body: draft,
              right: rightLabel(t, 'register-building-blocks'),
              ...(typeInfo?.notDecided
                ? {
                    notDecided: {
                      what: t('blocks.notDecidedWhat', { type: t(typeInfo.label).toLowerCase() }),
                      note: t('blocks.notDecidedNote'),
                    },
                  }
                : {}),
            })}
          />
        </div>
      </section>
    </div>
  );
};
