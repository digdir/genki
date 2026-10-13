import {
  Alert,
  Button,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useId, useRef, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { ApiCallLink } from '../../components/ApiCall';
import { reasonProblem } from '../../components/ReasonField';
import { useT, type PlainKey } from '../../i18n';
import type { SettingRow } from '../../data/settings';
import { useRights } from '../../Shell';

export const writtenStandardKey = 'answers.writtenStandard';

type Standard = 'user' | 'bokmal' | 'nynorsk';
type Choice = Standard | 'inherit';

const labelKeys: Record<Choice, PlainKey> = {
  user: 'settings.wsUser',
  bokmal: 'settings.wsBokmal',
  nynorsk: 'settings.wsNynorsk',
  inherit: 'settings.wsInherit',
};

const standards: Standard[] = ['user', 'bokmal', 'nynorsk'];

export const writtenStandardRow = (rows: SettingRow[]) =>
  rows.find((r) => r.apiKey === writtenStandardKey && r.scope.includes('virksomhet'));

const standardOf = (value: unknown): Standard | undefined => standards.find((s) => s === value);

export interface WrittenStandardProps {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  live: boolean;
  row: SettingRow;
  service?: { id: string; name: string };
  onSaved: (row: SettingRow, flash: string) => void;
}

const Level = ({
  level,
  help,
  options,
  saved,
  inherited,
  reasonRequired,
  canEdit,
  call,
  onSave,
}: {
  level: string;
  help: string;
  options: Choice[];
  saved: Choice;
  inherited?: Standard;
  reasonRequired: boolean;
  canEdit: boolean;
  call: (choice: Choice) => Parameters<typeof ApiCallLink>[0]['call'];
  onSave: (choice: Choice, reason: string) => Promise<string | undefined>;
}) => {
  const t = useT();
  const labels = (c: Choice) => t(labelKeys[c]);
  const name = useId();
  const [choice, setChoice] = useState<Choice>(saved);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = choice !== saved;
  const save = async () => {
    const problem = reasonRequired ? reasonProblem(reason, t) : undefined;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setFailed('');
    const result = await onSave(choice, reason.trim());
    setBusy(false);
    if (result) setFailed(result);
    else setReason('');
  };
  return (
    <section className="written-standard-card stack-sm" aria-labelledby={`${name}-h`}>
      <div className="tag-row">
        <Tag data-size="sm" data-color="neutral">
          {level}
        </Tag>
        <Heading level={2} data-size="2xs" id={`${name}-h`}>
          {t('settings.wsTitle')}
        </Heading>
      </div>
      <Paragraph data-size="sm" className="subtle">
        {help}
      </Paragraph>
      <Fieldset>
        <Fieldset.Legend className="visually-hidden">
          {t('settings.wsLegend', { level })}
        </Fieldset.Legend>
        {options.map((o) => (
          <Radio
            key={o}
            name={name}
            label={labels(o)}
            checked={choice === o}
            disabled={!canEdit}
            onChange={() => {
              setChoice(o);
              setFailed('');
            }}
          />
        ))}
      </Fieldset>
      {choice === 'inherit' && inherited ? (
        <Paragraph data-size="sm">{t('settings.wsNow', { value: labels(inherited) })}</Paragraph>
      ) : null}
      {changed ? (
        <div className="written-standard-change stack-xs">
          <span>
            <strong>{t('settings.wsChange')}</strong> {labels(saved)} → {labels(choice)}
          </span>
          <Textfield
            data-size="sm"
            label={t('common.reason')}
            value={reason}
            error={error || undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setError('');
            }}
          />
          {failed ? (
            <Alert data-color="danger" data-size="sm">
              {failed}
            </Alert>
          ) : null}
          <div className="actions">
            <Button
              variant="primary"
              data-size="sm"
              aria-disabled={busy ? true : undefined}
              onClick={() => !busy && void save()}
            >
              {t('common.save')}
            </Button>
            <ApiCallLink call={call(choice)} />
          </div>
        </div>
      ) : null}
    </section>
  );
};

export const WrittenStandard = ({
  api,
  tenant,
  tenantName,
  live,
  row,
  service,
  onSaved,
}: WrittenStandardProps) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const { has } = useRights();
  const canEdit = has('manage-services');
  const key = writtenStandardKey;
  const tenantValue = standardOf(row.V) ?? standardOf(row.P) ?? 'user';
  const serviceValue = service ? standardOf(row.svc[service.name]) : undefined;
  const settingPath = `/tenants/${encodeURIComponent(tenant)}/settings/${encodeURIComponent(key)}`;
  const failedText = (error: unknown) =>
    error instanceof ApiError && error.problem?.title
      ? tRef.current('settings.wsFailedWith', { title: error.problem.title })
      : tRef.current('settings.panelSaveFailed');

  const saveTenant = async (choice: Choice, reason: string) => {
    if (choice === 'inherit') return undefined;
    const value = choice;
    try {
      if (live) await api.setTenantSetting(tenant, key, value, reason);
    } catch (error) {
      return failedText(error);
    }
    onSaved({ ...row, V: value }, tRef.current('settings.wsTenantSaved', { name: tenantName }));
    return undefined;
  };

  const saveService = async (choice: Choice, reason: string) => {
    if (!service) return undefined;
    const value = choice === 'inherit' ? null : choice;
    try {
      if (live)
        await api.saveServiceSetting(
          tenant,
          service.id,
          key,
          value,
          reason ||
            tRef.current('settings.wsServiceReason', { value: tRef.current(labelKeys[choice]) }),
        );
    } catch (error) {
      return failedText(error);
    }
    const rest = Object.fromEntries(Object.entries(row.svc).filter(([k]) => k !== service.name));
    onSaved(
      { ...row, svc: value === null ? rest : { ...rest, [service.name]: value } },
      tRef.current('settings.wsServiceSaved', { name: service.name }),
    );
    return undefined;
  };

  return (
    <div className="written-standard stack-sm">
      <div className="written-standard-grid">
        <Level
          key={`tenant-${tenantValue}`}
          level={t('settings.wsLevelTenant')}
          help={t('settings.wsTenantHelp', { name: tenantName })}
          options={['user', 'bokmal', 'nynorsk']}
          saved={tenantValue}
          reasonRequired
          canEdit={canEdit}
          call={(choice) => ({
            action: t('settings.wsTenantCall'),
            method: 'PUT',
            path: settingPath,
            body: { value: choice === 'inherit' ? null : choice },
            needsReason: true,
            right: t('rights.manageServices'),
          })}
          onSave={saveTenant}
        />
        {service && row.scope.includes('tjeneste') ? (
          <Level
            key={`service-${serviceValue ?? 'inherit'}`}
            level={t('settings.wsLevelService', { name: service.name })}
            help={t('settings.wsServiceHelp')}
            options={['inherit', 'user', 'bokmal', 'nynorsk']}
            saved={serviceValue ?? 'inherit'}
            inherited={tenantValue}
            reasonRequired={false}
            canEdit={canEdit}
            call={(choice) => ({
              action: t('settings.wsServiceCall', { name: service.name }),
              method: 'POST',
              path: '/definitions',
              body: {
                definition: {
                  spec: { settings: choice === 'inherit' ? {} : { [writtenStandardKey]: choice } },
                },
              },
              needsReason: true,
              right: t('rights.manageServices'),
            })}
            onSave={saveService}
          />
        ) : null}
      </div>
      <Paragraph data-size="sm">{t('settings.wsOrder')}</Paragraph>
    </div>
  );
};
