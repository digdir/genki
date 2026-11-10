import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  SelectOption,
  Switch,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useT, type PlainKey } from '../../i18n';
import { operationName, rebind } from '../../model-operations';
import type {
  ApiBindings,
  Capability,
  ConfigEntry,
  DiscoveryRule,
  ModelApi,
  ModelEndpointInput,
  ModelPrice,
  OperatorModel,
  Residency,
} from '../../types';
import { DialogError, ReasonDialog, SidePanel } from '../../ui';
import { apisFor, familiesOf } from './area-data';
import { reasonError, ReasonField } from './reason-field';

export const residencyLabel: Record<Residency, PlainKey> = {
  norway: 'endpoints.residencyNorway',
  eu: 'endpoints.residencyEu',
  global: 'endpoints.residencyGlobal',
};

export const capabilityLabel: Record<Capability, PlainKey> = {
  stream: 'endpoints.capStream',
  tools: 'endpoints.capTools',
  'json-schema': 'endpoints.capJsonSchema',
  reasoning: 'endpoints.capReasoning',
};

const modelSlug = (deployment: string) =>
  deployment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '');

const secretPrefix = 'secret://platform/';

const problemText = (error: unknown, fallback: string) => {
  if (!(error instanceof ApiError)) return fallback;
  const details = (error.problem?.errors ?? []).map((e) => e.message).join('. ');
  return [error.problem?.title, details].filter(Boolean).join(': ') || fallback;
};

interface EndpointSpec {
  baseURL?: string;
  families?: Record<string, string>;
  discovery?: DiscoveryRule[];
  auth?: { kind?: string; secret?: string; header?: string };
  settings?: Record<string, string>;
  keys?: Record<string, string>;
}

interface PairRow {
  name: string;
  value: string;
}

const settingNamePattern = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const settingValuePattern = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
const rowsOf = (pairs: Record<string, string> | undefined, strip = '') =>
  Object.entries(pairs ?? {}).map(([name, value]) => ({
    name,
    value: value.startsWith(strip) ? value.slice(strip.length) : value,
  }));

interface FamilyRow {
  family: string;
  base: string;
}

const familyBasePattern = /^((\/[A-Za-z0-9._~-]+)*\/?|https:\/\/\S+)$/;

interface RuleDraft {
  rule: DiscoveryRule;
  include: string;
  exclude: string;
}

const patterns = (text: string) =>
  text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

const draftOf = (rule: DiscoveryRule): RuleDraft => ({
  rule,
  include: (rule.include ?? []).join(', '),
  exclude: (rule.exclude ?? []).join(', '),
});

export const ruleOf = ({ rule, include, exclude }: RuleDraft): DiscoveryRule => {
  const rest = { ...rule };
  delete rest.include;
  delete rest.exclude;
  return {
    ...rest,
    ...(patterns(include).length ? { include: patterns(include) } : {}),
    ...(patterns(exclude).length ? { exclude: patterns(exclude) } : {}),
  };
};

const PairFields = ({
  kind,
  rows,
  setRows,
  labels,
  error,
}: {
  kind: string;
  rows: PairRow[];
  setRows: Dispatch<SetStateAction<PairRow[]>>;
  labels: Record<'title' | 'description' | 'name' | 'value' | 'add', PlainKey> & {
    remove: 'endpoints.removeSetting' | 'endpoints.removeKey';
  };
  error: string | undefined;
}) => {
  const t = useT();
  const set = (index: number, change: Partial<PairRow>) =>
    setRows((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));
  return (
    <Fieldset>
      <FieldsetLegend>{t(labels.title)}</FieldsetLegend>
      <Paragraph data-size="sm">{t(labels.description)}</Paragraph>
      {rows.map((row, index) => (
        <div className="actions-row" key={index}>
          <Textfield
            id={`endpoint-${kind}-name-${index}`}
            label={t(labels.name)}
            value={row.name}
            onChange={(e) => set(index, { name: e.target.value.trim() })}
          />
          <Textfield
            id={`endpoint-${kind}-value-${index}`}
            label={t(labels.value)}
            value={row.value}
            onChange={(e) => set(index, { value: e.target.value })}
          />
          <Button
            variant="tertiary"
            data-size="sm"
            aria-label={t(labels.remove, { name: row.name })}
            onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
          >
            {t('endpoints.remove')}
          </Button>
        </div>
      ))}
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      <div className="actions-row">
        <Button
          variant="secondary"
          data-size="sm"
          onClick={() => setRows((all) => [...all, { name: '', value: '' }])}
        >
          {t(labels.add)}
        </Button>
      </div>
    </Fieldset>
  );
};

export const EndpointForm = ({
  api,
  apis,
  existing,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  apis: ModelApi[] | undefined;
  existing?: ConfigEntry | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const spec = (existing?.spec ?? {}) as EndpointSpec;
  const storedSecret = spec.auth?.secret?.startsWith(secretPrefix)
    ? spec.auth.secret.slice(secretPrefix.length)
    : '';
  const known = apis ? [...new Set(apis.map((a) => a.family))].sort() : undefined;
  const [rules, setRules] = useState<RuleDraft[]>(
    Array.isArray(spec.discovery) ? spec.discovery.map(draftOf) : [],
  );
  const setRule = (index: number, change: Partial<RuleDraft>) =>
    setRules((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));
  const bindRule = (index: number, bindings: ApiBindings) =>
    setRules((all) =>
      all.map((r, i) => (i === index ? { ...r, rule: { ...r.rule, apis: bindings } } : r)),
    );
  const [id, setId] = useState(existing?.id ?? '');
  const [rows, setRows] = useState<FamilyRow[]>(
    spec.families
      ? Object.entries(spec.families).map(([family, base]) => ({ family, base }))
      : [{ family: 'openai', base: '' }],
  );
  const offered = (apis ?? []).filter((a) => rows.some((r) => r.family === a.family));
  const [baseURL, setBaseURL] = useState(spec.baseURL ?? '');
  const [settingRows, setSettingRows] = useState<PairRow[]>(rowsOf(spec.settings));
  const [keyRows, setKeyRows] = useState<PairRow[]>(rowsOf(spec.keys, secretPrefix));
  const [authKind, setAuthKind] = useState<'api-key' | 'bearer'>(
    spec.auth?.kind === 'bearer' ? 'bearer' : 'api-key',
  );
  const [secretName, setSecretName] = useState(storedSecret);
  const [secretValue, setSecretValue] = useState('');
  const [secretSaved, setSecretSaved] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const familyOptions = (current: string) =>
    [...new Set([...(known ?? []), current, ...rows.map((r) => r.family)])].filter(Boolean).sort();
  const setRow = (index: number, change: Partial<FamilyRow>) =>
    setRows((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const check = (fields: string[]) => {
    const names = rows.map((r) => r.family);
    const all: Record<string, string | undefined> = {
      id: /^[a-z0-9][a-z0-9-]*$/.test(id) ? undefined : t('endpoints.idHint'),
      baseURL: /^https:\/\/\S+$/.test(baseURL) ? undefined : t('endpoints.urlHint'),
      families:
        rows.length === 0
          ? t('endpoints.familiesRequired')
          : names.some((n, i) => !n || names.indexOf(n) !== i)
            ? t('endpoints.familyHint')
            : rows.some((r) => !familyBasePattern.test(r.base.trim()))
              ? t('endpoints.familyBaseHint')
              : undefined,
      settings: settingRows.some(
        (r, i, all) =>
          !settingNamePattern.test(r.name) || all.findIndex((o) => o.name === r.name) !== i,
      )
        ? t('endpoints.settingNameHint')
        : settingRows.some(
              (r) => !settingValuePattern.test(r.value) || r.value.startsWith('secret://'),
            )
          ? t('endpoints.settingValueHint')
          : undefined,
      keys: keyRows.some(
        (r, i, all) =>
          !settingNamePattern.test(r.name) ||
          all.findIndex((o) => o.name === r.name) !== i ||
          settingRows.some((o) => o.name === r.name),
      )
        ? t('endpoints.keyNameHint')
        : keyRows.some((r) => !/^[a-z0-9][a-z0-9-]*$/.test(r.value))
          ? t('endpoints.secretNameHint')
          : undefined,
      secretName: /^[a-z0-9][a-z0-9-]*$/.test(secretName)
        ? undefined
        : t('endpoints.secretNameHint'),
      secretValue: secretValue ? undefined : t('endpoints.secretValueHint'),
      reason: reasonError(reason, t),
    };
    const found = Object.fromEntries(
      fields.flatMap((f) => (all[f] ? [[f, all[f] as string]] : [])),
    );
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const saveSecret = async () => {
    setFailed(undefined);
    if (!check(['secretName', 'secretValue', 'reason'])) return;
    setBusy(true);
    try {
      await api.saveSecret(secretName, secretValue, reason.trim());
      setSecretValue('');
      setSecretSaved(secretName);
    } catch (error) {
      setFailed(problemText(error, tRef.current('endpoints.secretSaveFailed')));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setFailed(undefined);
    if (!check(['id', 'baseURL', 'families', 'settings', 'keys', 'secretName', 'reason'])) return;
    setBusy(true);
    const header = authKind === 'api-key' ? spec.auth?.header : undefined;
    const input: ModelEndpointInput = {
      baseURL,
      auth: {
        kind: authKind,
        secret: `${secretPrefix}${secretName}`,
        ...(header ? { header } : {}),
      },
      families: Object.fromEntries(rows.map((r) => [r.family, r.base.trim()])),
      ...(rules.length || spec.discovery ? { discovery: rules.map(ruleOf) } : {}),
      ...(settingRows.length || spec.settings
        ? { settings: Object.fromEntries(settingRows.map((r) => [r.name, r.value])) }
        : {}),
      ...(keyRows.length || spec.keys
        ? { keys: Object.fromEntries(keyRows.map((r) => [r.name, `${secretPrefix}${r.value}`])) }
        : {}),
    };
    try {
      if (existing) await api.updateModelEndpoint(id, input, reason.trim());
      else await api.addModelEndpoint(id, input, reason.trim());
      onSaved(id);
    } catch (error) {
      setFailed(
        problemText(error, tRef.current(existing ? 'endpoints.saveFailed' : 'endpoints.addFailed')),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel labelledBy="endpoint-panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">{t('endpoints.panelEyebrow')}</span>
        <Heading level={2} data-size="xs" id="endpoint-panel-h" tabIndex={-1}>
          {existing
            ? t('endpoints.editEndpointTitle', { id: existing.id })
            : t('endpoints.addEndpointTitle')}
        </Heading>
      </div>
      <div className="panel-body">
        <Textfield
          label={t('endpoints.name')}
          description={t('endpoints.nameDescription')}
          value={id}
          readOnly={Boolean(existing)}
          onChange={(e) => setId(e.target.value.trim())}
          error={errors.id}
        />
        <Textfield
          label={t('endpoints.baseUrl')}
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value.trim())}
          error={errors.baseURL}
        />
        <Fieldset>
          <FieldsetLegend>{t('endpoints.families')}</FieldsetLegend>
          <Paragraph data-size="sm">{t('endpoints.familiesDescription')}</Paragraph>
          {rows.map((row, index) => (
            <div className="actions-row" key={index}>
              <div className="field">
                <Label htmlFor={`endpoint-family-${index}`}>{t('endpoints.familyName')}</Label>
                <Select
                  id={`endpoint-family-${index}`}
                  value={row.family}
                  onChange={(e) => setRow(index, { family: e.target.value })}
                >
                  {familyOptions(row.family).map((f) => (
                    <SelectOption key={f} value={f}>
                      {f}
                    </SelectOption>
                  ))}
                </Select>
              </div>
              <Textfield
                id={`endpoint-family-base-${index}`}
                label={t('endpoints.familyBase')}
                description={index === 0 ? t('endpoints.familyBaseDescription') : undefined}
                value={row.base}
                onChange={(e) => setRow(index, { base: e.target.value })}
              />
              <Button
                variant="tertiary"
                data-size="sm"
                aria-label={t('endpoints.removeFamily', { family: row.family })}
                disabled={rows.length === 1}
                onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
              >
                {t('endpoints.remove')}
              </Button>
            </div>
          ))}
          {errors.families ? <ValidationMessage>{errors.families}</ValidationMessage> : null}
          <div className="actions-row">
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() =>
                setRows((all) => [
                  ...all,
                  {
                    family: (known ?? []).find((f) => !all.some((r) => r.family === f)) ?? '',
                    base: '',
                  },
                ])
              }
            >
              {t('endpoints.addFamily')}
            </Button>
          </div>
        </Fieldset>
        <Fieldset>
          <FieldsetLegend>{t('connections.discovery')}</FieldsetLegend>
          <Paragraph data-size="sm">{t('connections.discoveryIntro')}</Paragraph>
          {rules.map((draft, index) => {
            const bound = draft.rule.apis ?? {};
            const n = index + 1;
            return (
              <div className="stack-sm rule-box" key={index}>
                <span className="label-strong">{t('connections.ruleN', { n })}</span>
                <Textfield
                  label={t('connections.ruleInclude', { n })}
                  description={index === 0 ? t('connections.rulePatternsHint') : undefined}
                  value={draft.include}
                  onChange={(e) => setRule(index, { include: e.target.value })}
                />
                <Textfield
                  label={t('connections.ruleExclude', { n })}
                  value={draft.exclude}
                  onChange={(e) => setRule(index, { exclude: e.target.value })}
                />
                <ul className="plain stack-sm">
                  {Object.entries(bound).map(([kind, id]) => (
                    <li key={kind} className="actions-row">
                      <span>
                        {operationName(kind, t)}: <code>{id}</code>
                      </span>
                      <Button
                        variant="tertiary"
                        data-size="sm"
                        onClick={() => bindRule(index, rebind(bound, kind, ''))}
                      >
                        {t('connections.ruleUnbind', { kind: operationName(kind, t), n })}
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="field">
                  <Label htmlFor={`rule-api-${index}`}>{t('connections.ruleBind', { n })}</Label>
                  <Select
                    id={`rule-api-${index}`}
                    value=""
                    onChange={(e) => {
                      const chosen = offered.find((a) => a.id === e.target.value);
                      if (chosen) bindRule(index, rebind(bound, chosen.kind, chosen.id));
                    }}
                  >
                    <SelectOption value="">{t('connections.ruleBindChoose')}</SelectOption>
                    {offered
                      .filter((a) => !bound[a.kind])
                      .map((a) => (
                        <SelectOption key={a.id} value={a.id}>
                          {operationName(a.kind, t)}: {a.id}
                        </SelectOption>
                      ))}
                  </Select>
                </div>
                <div className="actions-row">
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    onClick={() => setRules((all) => all.filter((_, i) => i !== index))}
                  >
                    {t('connections.ruleRemove', { n })}
                  </Button>
                </div>
              </div>
            );
          })}
          <div className="actions-row">
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() =>
                setRules((all) => [...all, draftOf({ source: 'azure-deployments', apis: {} })])
              }
            >
              {t('connections.ruleAdd')}
            </Button>
          </div>
        </Fieldset>
        <div className="field">
          <Label htmlFor="endpoint-auth">{t('endpoints.login')}</Label>
          <Select
            id="endpoint-auth"
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as 'api-key' | 'bearer')}
          >
            <SelectOption value="api-key">{t('endpoints.apiKey')}</SelectOption>
            <SelectOption value="bearer">{t('endpoints.bearer')}</SelectOption>
          </Select>
        </div>
        <Fieldset>
          <FieldsetLegend>{t('endpoints.secret')}</FieldsetLegend>
          <Textfield
            label={t('endpoints.secretName')}
            description={t('endpoints.secretStoredAs', {
              name: `${secretPrefix}${secretName || `<${t('endpoints.secretNamePlaceholder')}>`}`,
            })}
            value={secretName}
            onChange={(e) => {
              setSecretName(e.target.value.trim());
              setSecretSaved(undefined);
            }}
            error={errors.secretName}
          />
          <Textfield
            label={t('endpoints.value')}
            description={t('endpoints.valueDescription')}
            type="password"
            autoComplete="off"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            error={errors.secretValue}
          />
          <div className="actions-row">
            <Button
              variant="secondary"
              data-size="sm"
              loading={busy}
              onClick={() => void saveSecret()}
            >
              {t('endpoints.saveSecret')}
            </Button>
          </div>
          {secretSaved ? (
            <Alert data-color="success" data-size="sm" role="status">
              {t('endpoints.secretSaved', { name: secretSaved })}
            </Alert>
          ) : null}
        </Fieldset>
        <PairFields
          kind="setting"
          rows={settingRows}
          setRows={setSettingRows}
          labels={{
            title: 'endpoints.settings',
            description: 'endpoints.settingsDescription',
            name: 'endpoints.settingName',
            value: 'endpoints.settingValue',
            add: 'endpoints.addSetting',
            remove: 'endpoints.removeSetting',
          }}
          error={errors.settings}
        />
        <PairFields
          kind="key"
          rows={keyRows}
          setRows={setKeyRows}
          labels={{
            title: 'endpoints.keys',
            description: 'endpoints.keysDescription',
            name: 'endpoints.keyName',
            value: 'endpoints.keySecret',
            add: 'endpoints.addKey',
            remove: 'endpoints.removeKey',
          }}
          error={errors.keys}
        />
        <ReasonField value={reason} error={errors.reason} onChange={setReason} />
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        <div className="actions-row">
          <Button loading={busy} onClick={() => void save()}>
            {existing ? t('endpoints.saveEndpoint') : t('endpoints.addEndpoint')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </SidePanel>
  );
};

export const ModelForm = ({
  api,
  endpoints,
  apis,
  endpoint,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  endpoints: ConfigEntry[];
  apis: ModelApi[] | undefined;
  endpoint?: string | undefined;
  onClose: () => void;
  onSaved: (model: OperatorModel) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [target, setTarget] = useState(endpoint ?? endpoints[0]?.id ?? '');
  const [deployment, setDeployment] = useState('');
  const [family, setFamily] = useState('');
  const [residency, setResidency] = useState<Residency>('global');
  const [capabilities, setCapabilities] = useState<Capability[]>(['stream']);
  const [chat, setChat] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const families = familiesOf(endpoints.find((e) => e.id === target));
  const chatApis = apisFor(apis ?? [], families, 'chat');

  const save = async () => {
    const found = {
      ...(deployment.trim()
        ? modelSlug(deployment)
          ? {}
          : { deployment: t('endpoints.deploymentNeedsLetterOrDigit') }
        : { deployment: t('endpoints.deploymentRequired') }),
      ...(target ? {} : { target: t('endpoints.chooseEndpoint') }),
      ...(reasonError(reason, t) ? { reason: reasonError(reason, t) as string } : {}),
    };
    setErrors(found);
    setFailed(undefined);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const saved = await api.saveModel(
        `${target}/${modelSlug(deployment)}`,
        {
          endpoint: target,
          deployment: deployment.trim(),
          ...(family.trim() ? { family: family.trim() } : {}),
          residency,
          capabilities,
          ...(chat ? { apis: { chat } } : {}),
          enabled,
        },
        reason.trim(),
      );
      onSaved(saved);
    } catch (error) {
      setFailed(problemText(error, tRef.current('endpoints.saveModelFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel labelledBy="model-panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">{t('endpoints.panelEyebrow')}</span>
        <Heading level={2} data-size="xs" id="model-panel-h" tabIndex={-1}>
          {t('endpoints.addModel')}
        </Heading>
      </div>
      <div className="panel-body">
        <div className="field">
          <Label htmlFor="model-endpoint">{t('endpoints.endpoint')}</Label>
          <Select
            id="model-endpoint"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setChat('');
            }}
          >
            {endpoints.map((e) => (
              <SelectOption key={e.id} value={e.id}>
                {e.id}
              </SelectOption>
            ))}
          </Select>
          {errors.target ? <ValidationMessage>{errors.target}</ValidationMessage> : null}
        </div>
        <Textfield
          label={t('endpoints.deployment')}
          description={t('endpoints.deploymentDescription')}
          value={deployment}
          onChange={(e) => setDeployment(e.target.value)}
          error={errors.deployment}
        />
        <Textfield
          label={t('endpoints.family')}
          description={t('endpoints.familyDescription')}
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        />
        <div className="field">
          <Label htmlFor="model-residency">{t('endpoints.residency')}</Label>
          <Select
            id="model-residency"
            value={residency}
            onChange={(e) => setResidency(e.target.value as Residency)}
          >
            {(Object.keys(residencyLabel) as Residency[]).map((r) => (
              <SelectOption key={r} value={r}>
                {t(residencyLabel[r])}
              </SelectOption>
            ))}
          </Select>
        </div>
        <Fieldset>
          <FieldsetLegend>{t('endpoints.can')}</FieldsetLegend>
          {(Object.keys(capabilityLabel) as Capability[]).map((c) => (
            <Checkbox
              key={c}
              label={t(capabilityLabel[c])}
              checked={capabilities.includes(c)}
              onChange={(e) =>
                setCapabilities((all) =>
                  e.target.checked ? [...all, c] : all.filter((x) => x !== c),
                )
              }
            />
          ))}
        </Fieldset>
        <div className="field">
          <Label htmlFor="model-chat-api">{t('endpoints.chatApi')}</Label>
          <Select id="model-chat-api" value={chat} onChange={(e) => setChat(e.target.value)}>
            <SelectOption value="">{t('endpoints.chatApiDefault')}</SelectOption>
            {chatApis.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </Select>
        </div>
        <Switch
          label={t('endpoints.inUse')}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <ReasonField value={reason} error={errors.reason} onChange={setReason} />
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        <div className="actions-row">
          <Button loading={busy} onClick={() => void save()}>
            {t('endpoints.saveModel')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </SidePanel>
  );
};

const parsePrice = (value: string) => {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export const PriceDialog = ({
  api,
  model,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  model: OperatorModel | undefined;
  onClose: () => void;
  onSaved: (model: OperatorModel) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [shown, setShown] = useState<string | undefined>();
  if (model && shown !== model.id) {
    setShown(model.id);
    setInput(
      model.price ? f.number(model.price.inputPerThousand, { maximumFractionDigits: 6 }) : '',
    );
    setOutput(
      model.price ? f.number(model.price.outputPerThousand, { maximumFractionDigits: 6 }) : '',
    );
  }
  return (
    <ReasonDialog
      open={Boolean(model)}
      title={model ? t('endpoints.priceTitle', { model: model.deployment }) : ''}
      text={t('endpoints.priceText')}
      confirmLabel={t('endpoints.savePrice')}
      onClose={() => {
        setShown(undefined);
        onClose();
      }}
      onConfirm={async (reason) => {
        if (!model) return;
        const price = {
          inputPerThousand: parsePrice(input),
          outputPerThousand: parsePrice(output),
        };
        if (price.inputPerThousand === undefined || price.outputPerThousand === undefined)
          throw new DialogError(t('endpoints.priceInvalid'));
        await api.setModelPrice(model.id, price as ModelPrice, reason);
        onSaved({ ...model, price: price as ModelPrice });
      }}
    >
      <Textfield
        label={t('endpoints.priceIn')}
        inputMode="decimal"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <Textfield
        label={t('endpoints.priceOut')}
        inputMode="decimal"
        value={output}
        onChange={(e) => setOutput(e.target.value)}
      />
    </ReasonDialog>
  );
};
