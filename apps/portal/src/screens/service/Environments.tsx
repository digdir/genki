import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import {
  environmentNamePattern,
  productionEnvironment,
  type EnvironmentView,
  type ServiceEnvironments,
} from '../../api/environments';
import { reasonProblem } from '../../components/ReasonField';
import { useT } from '../../i18n';
import { problemErrors } from './definition';

type Action =
  | { kind: 'add' }
  | { kind: 'promote'; environment: EnvironmentView }
  | { kind: 'rollback'; environment: EnvironmentView }
  | { kind: 'remove'; environment: EnvironmentView };

export const Environments = ({
  api,
  tenant,
  serviceId,
  data,
  versions,
  canManage,
  onChanged,
  facts = {},
}: {
  facts?: Record<string, { runsToday?: number | undefined; keys?: number | undefined }>;
  api: ApiClient;
  tenant: string;
  serviceId: string;
  data: ServiceEnvironments;
  versions: number[];
  canManage: boolean;
  onChanged: () => void;
}) => {
  const t = useT();
  const [action, setAction] = useState<Action>();
  const [name, setName] = useState('');
  const [version, setVersion] = useState<number>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const { environments, latestVersion } = data;
  const prod = environments.find((e) => e.name === productionEnvironment);
  const onlyProd = environments.length === 1;
  const atLimit = environments.length >= 5;

  const open = (next: Action) => {
    setAction(next);
    setReason('');
    setError('');
    setMessage(undefined);
    if (next.kind === 'add') setName(environments.some((e) => e.name === 'test') ? '' : 'test');
    if (next.kind === 'rollback')
      setVersion(
        next.environment.previousVersion ??
          versions.find((v) => v !== next.environment.version) ??
          undefined,
      );
  };

  const nameProblem = (value: string) => {
    if (!environmentNamePattern.test(value) || value === productionEnvironment)
      return t('serviceEnvironments.nameInvalid');
    if (environments.some((e) => e.name === value))
      return t('serviceEnvironments.nameTaken', { name: value });
    return undefined;
  };

  const submit = async () => {
    if (!action) return;
    const trimmed = name.trim();
    if (action.kind === 'add') {
      const problem = nameProblem(trimmed);
      if (problem) return setError(problem);
    }
    const reasonError = reasonProblem(reason, t);
    if (reasonError) return setError(reasonError);
    setBusy(true);
    setError('');
    try {
      const why = reason.trim();
      if (action.kind === 'add') {
        await api.environments.add(tenant, serviceId, trimmed, why);
        setMessage(
          t('serviceEnvironments.added', {
            name: trimmed,
            version: prod?.followsPublishes ? latestVersion : (prod?.version ?? latestVersion),
          }),
        );
      } else if (action.kind === 'promote') {
        const after = await api.environments.promote(
          tenant,
          serviceId,
          productionEnvironment,
          action.environment.name,
          why,
        );
        const now = after.environments.find((e) => e.name === productionEnvironment)?.version;
        setMessage(t('serviceEnvironments.promoted', { version: now ?? '' }));
      } else if (action.kind === 'rollback') {
        if (version === undefined) return;
        await api.environments.rollback(tenant, serviceId, action.environment.name, version, why);
        setMessage(t('serviceEnvironments.rolledBack', { name: action.environment.name, version }));
      } else {
        await api.environments.remove(tenant, serviceId, action.environment.name, why);
        setMessage(t('serviceEnvironments.removed', { name: action.environment.name }));
      }
      setAction(undefined);
      onChanged();
    } catch (e) {
      setError(
        problemErrors(e, t)
          .map((p) => p.message)
          .join(' '),
      );
    } finally {
      setBusy(false);
    }
  };

  const reasonField = (
    <Textfield
      id="env-reason"
      className="fe-field-md"
      data-size="sm"
      label={t('serviceEnvironments.reason')}
      description={t('serviceEnvironments.reasonDescription')}
      value={reason}
      onChange={(e) => {
        setReason(e.target.value);
        setError('');
      }}
    />
  );

  const buttons = (submitLabel: string, danger = false) => (
    <div className="row-wrap">
      <Button
        variant="primary"
        data-size="sm"
        {...(danger ? { 'data-color': 'danger' } : {})}
        loading={busy}
        onClick={() => !busy && void submit()}
      >
        {submitLabel}
      </Button>
      <Button variant="secondary" data-size="sm" onClick={() => setAction(undefined)}>
        {t('serviceEnvironments.cancel')}
      </Button>
    </div>
  );

  const errorAlert = error ? (
    <Alert data-color="danger" data-size="sm">
      {error}
    </Alert>
  ) : null;

  const panelFor = (e: EnvironmentView) => {
    if (!action || action.kind === 'add' || action.environment.name !== e.name) return null;
    if (action.kind === 'promote')
      return (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t('serviceEnvironments.promoteConfirm', {
              name: e.name,
              from: prod?.version ?? '',
              to: e.version ?? '',
            })}
          </Paragraph>
          {errorAlert}
          {reasonField}
          {buttons(t('serviceEnvironments.promote'))}
        </Alert>
      );
    if (action.kind === 'rollback')
      return (
        <Alert data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            {t('serviceEnvironments.rollbackConfirm', { name: e.name, from: e.version ?? '' })}
          </Paragraph>
          {errorAlert}
          <Field className="fe-field-md" data-size="sm">
            <Label htmlFor="env-version">
              {t('serviceEnvironments.rollbackVersion', { name: e.name })}
            </Label>
            <Select
              id="env-version"
              value={version === undefined ? '' : String(version)}
              onChange={(ev) => setVersion(Number(ev.target.value))}
            >
              {versions
                .filter((v) => v !== e.version)
                .map((v) => (
                  <Select.Option key={v} value={String(v)}>
                    {v === e.previousVersion
                      ? t('serviceEnvironments.rollbackPrevious', { version: v })
                      : t('serviceEnvironments.rollbackOption', { version: v })}
                  </Select.Option>
                ))}
            </Select>
          </Field>
          {reasonField}
          {buttons(t('serviceEnvironments.rollbackSubmit', { name: e.name }))}
        </Alert>
      );
    return (
      <Alert data-color="danger" data-size="sm">
        <Paragraph data-size="sm">
          {t('serviceEnvironments.removeConfirm', { name: e.name })}
        </Paragraph>
        {errorAlert}
        {reasonField}
        {buttons(t('serviceEnvironments.removeSubmit', { name: e.name }), true)}
      </Alert>
    );
  };

  return (
    <section aria-labelledby="svc-env-h" className="stack-sm">
      <div className="fe-head">
        <div className="stack-xs">
          <Heading level={2} data-size="xs" id="svc-env-h">
            {t('serviceEnvironments.heading')}
          </Heading>
          <Paragraph data-size="sm" className="meta">
            {onlyProd
              ? t('serviceEnvironments.onlyProd', { version: latestVersion })
              : t('serviceEnvironments.intro')}
          </Paragraph>
        </div>
        {canManage && !atLimit && action?.kind !== 'add' ? (
          <Button variant="secondary" data-size="sm" onClick={() => open({ kind: 'add' })}>
            {t('serviceEnvironments.add')}
          </Button>
        ) : null}
      </div>
      <div aria-live="polite">
        {message ? (
          <Alert data-color="success" data-size="sm">
            {message}
          </Alert>
        ) : null}
      </div>
      {action?.kind === 'add' ? (
        <div className="fe-form stack-sm" role="group" aria-labelledby="env-add-h">
          <Heading level={3} data-size="2xs" id="env-add-h">
            {t('serviceEnvironments.addHeading')}
          </Heading>
          {errorAlert}
          <Textfield
            id="env-name"
            className="fe-field-md"
            data-size="sm"
            label={t('serviceEnvironments.name')}
            description={t('serviceEnvironments.nameDescription')}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
          />
          {reasonField}
          {buttons(t('serviceEnvironments.addSubmit'))}
        </div>
      ) : null}
      <ul className="plain-list env-cards" aria-label={t('serviceEnvironments.listLabel')}>
        {environments.map((e) => {
          const idle = canManage && !onlyProd && action === undefined;
          const fact = facts[e.name];
          return (
            <li key={e.name} className="env-card">
              <div className="row-between">
                <Heading level={3} data-size="2xs" id={`env-${e.name}-h`}>
                  {e.name}
                </Heading>
                <Tag data-size="sm" data-color={e.followsPublishes ? 'info' : 'neutral'}>
                  {e.followsPublishes
                    ? t('serviceEnvironments.follows')
                    : t('serviceEnvironments.pinned')}
                </Tag>
              </div>
              <strong>{t('serviceEnvironments.runs', { version: e.version ?? '' })}</strong>
              {fact && (fact.runsToday !== undefined || fact.keys !== undefined) ? (
                <span className="meta">
                  {[
                    fact.runsToday !== undefined
                      ? t('serviceDev.envRunsToday', { count: fact.runsToday })
                      : '',
                    fact.keys !== undefined ? t('serviceDev.envKeys', { count: fact.keys }) : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </span>
              ) : null}
              {idle ? (
                <div className="row-wrap">
                  {e.name !== productionEnvironment && e.version === prod?.version ? (
                    <span className="meta">
                      {t('serviceDev.prodAlready', { version: e.version ?? '' })}
                    </span>
                  ) : null}
                  {e.name !== productionEnvironment && e.version !== prod?.version ? (
                    <Button
                      variant="secondary"
                      data-size="sm"
                      aria-label={t('serviceEnvironments.promoteLabel', { name: e.name })}
                      onClick={() => open({ kind: 'promote', environment: e })}
                    >
                      {t('serviceEnvironments.promote')}
                    </Button>
                  ) : null}
                  {versions.some((v) => v !== e.version) ? (
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-label={t('serviceEnvironments.rollbackLabel', { name: e.name })}
                      onClick={() => open({ kind: 'rollback', environment: e })}
                    >
                      {t('serviceEnvironments.rollback')}
                    </Button>
                  ) : null}
                  {e.name !== productionEnvironment ? (
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      data-color="danger"
                      aria-label={t('serviceEnvironments.removeLabel', { name: e.name })}
                      onClick={() => open({ kind: 'remove', environment: e })}
                    >
                      {t('serviceEnvironments.remove')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {panelFor(e)}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
