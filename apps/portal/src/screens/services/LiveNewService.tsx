import {
  Alert,
  Button,
  Checkbox,
  Details,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
  Select,
  Field,
  Label,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import { Icon } from '../../components/Icon';
import { slug } from '../../data/services';
import { navigate, useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { toYaml } from '../../yaml';
import { problemErrors } from '../service/definition';
import { TestRun } from '../service/TestRun';
import { reasonProblem } from '../../components/ReasonField';

type Risk = 'minimal' | 'limited' | 'high';

const riskChoices: [Risk, PlainKey, PlainKey][] = [
  ['minimal', 'services.liveRiskMinimal', 'services.liveRiskMinimalHelp'],
  ['limited', 'services.liveRiskLimited', 'services.liveRiskLimitedHelp'],
  ['high', 'services.liveRiskHigh', 'services.liveRiskHighHelp'],
];

const residencyKeys: Record<string, PlainKey> = {
  norway: 'services.residencyNorway',
  eu: 'services.residencyEu',
  global: 'services.residencyGlobal',
};

export const buildServiceDefinition = (
  tenant: string,
  input: {
    name: string;
    purpose: string;
    instructions: string;
    model: string;
    residency: string;
    risk: Risk;
    exposure: { openai: boolean; mcp: boolean };
  },
) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: slug(input.name), name: input.name.trim() },
  spec: {
    purpose: input.purpose.trim(),
    riskClass: input.risk,
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: {
      id: 'single-call',
      version: 1,
      config: { instructions: input.instructions.trim() },
    },
    model: { primary: input.model, residency: input.residency },
    exposure: input.exposure,
  },
});

export const LiveNewService = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [models] = useAsync((signal) => api.listModels({}, signal), [api]);
  const [template] = useAsync(
    (signal) => api.definitionTemplate(tenant, 'Service', signal).catch(() => undefined),
    [api, tenant],
  );
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [instructions, setInstructions] = useState('');
  const [model, setModel] = useState('');
  const [risk, setRisk] = useState<Risk>('minimal');
  const [exposure, setExposure] = useState({ openai: true, mcp: false });
  const [reason, setReason] = useState(t('services.liveReasonDefault'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<{ path: string; message: string }[]>();
  const [busy, setBusy] = useState(false);

  const options = models.status === 'ready' && template.status !== 'loading' ? models.data : [];
  const defaultModel =
    template.status === 'ready'
      ? (template.data?.spec as { model?: { primary?: unknown } } | undefined)?.model?.primary
      : undefined;
  const chosen =
    options.find((m) => m.id === model) ?? options.find((m) => m.id === defaultModel) ?? options[0];
  const definition = useMemo(
    () =>
      buildServiceDefinition(tenant, {
        name,
        purpose,
        instructions,
        model: chosen?.id ?? '',
        residency: chosen?.residency ?? 'norway',
        risk,
        exposure,
      }),
    [tenant, name, purpose, instructions, chosen, risk, exposure],
  );

  const check = () => {
    const next: Record<string, string> = {};
    if (!slug(name)) next.name = t('services.liveNeedName');
    if (!purpose.trim()) next.purpose = t('services.liveNeedPurpose');
    if (!instructions.trim()) next.instructions = t('services.liveNeedInstructions');
    if (!chosen) next.model = t('services.liveNeedModel');
    const reasonError = reasonProblem(reason, t);
    if (reasonError) next.reason = reasonError;
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const publish = async () => {
    setFailed(undefined);
    if (!check()) return;
    setBusy(true);
    try {
      const valid = await api.validate(definition);
      if (!valid.valid) {
        setFailed(valid.errors);
        return;
      }
      const published = await api.publishDefinition(definition, {}, reason.trim());
      navigate(`/services/${encodeURIComponent(published.id)}`);
    } catch (error) {
      setFailed(problemErrors(error, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="new-service">
      <div className="stack-sm">
        <a href="#/services" className="back-link">
          <Icon d="M15 6l-6 6 6 6" size={18} />
          {t('services.back')}
        </a>
        <Heading level={1} data-size="lg">
          {t('services.newTitle')}
        </Heading>
        <p className="lead new-service-lead">{t('services.liveLead')}</p>
      </div>
      <div className="stack">
        <Textfield
          label={t('services.liveName')}
          description={
            slug(name) ? t('services.liveId', { id: slug(name) }) : t('services.liveIdFromName')
          }
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <Textfield
          label={t('services.livePurpose')}
          description={t('services.livePurposeHelp')}
          value={purpose}
          error={errors.purpose}
          onChange={(e) => setPurpose(e.target.value)}
        />
        <Field>
          <Label htmlFor="ny-instruksjoner">{t('services.liveInstructions')}</Label>
          <Textarea
            id="ny-instruksjoner"
            rows={6}
            value={instructions}
            aria-invalid={errors.instructions ? true : undefined}
            onChange={(e) => setInstructions(e.target.value)}
          />
          {errors.instructions ? (
            <Field.Description role="alert">{errors.instructions}</Field.Description>
          ) : null}
        </Field>
        <Field>
          <Label htmlFor="ny-modell">{t('services.liveModel')}</Label>
          {models.status === 'loading' ? (
            <Paragraph data-size="sm">{t('services.liveLoadingModels')}</Paragraph>
          ) : models.status === 'error' ? (
            <Alert data-color="danger" data-size="sm">
              {t('services.liveModelsFailed')}
            </Alert>
          ) : options.length === 0 ? (
            <Alert data-color="warning" data-size="sm">
              {t('services.liveNoModels')}
            </Alert>
          ) : (
            <Select
              id="ny-modell"
              value={chosen?.id ?? ''}
              onChange={(e) => setModel(e.target.value)}
            >
              {options.map((m) => (
                <Select.Option key={m.id} value={m.id}>
                  {m.id} (
                  {residencyKeys[m.residency]
                    ? t(residencyKeys[m.residency] as PlainKey)
                    : m.residency}
                  )
                </Select.Option>
              ))}
            </Select>
          )}
          {errors.model ? <Field.Description role="alert">{errors.model}</Field.Description> : null}
        </Field>
        <Fieldset>
          <Fieldset.Legend>{t('services.liveRisk')}</Fieldset.Legend>
          {riskChoices.map(([value, label, description]) => (
            <Radio
              key={value}
              name="ny-risiko"
              value={value}
              label={t(label)}
              description={t(description)}
              checked={risk === value}
              onChange={() => setRisk(value)}
            />
          ))}
        </Fieldset>
        <Fieldset>
          <Fieldset.Legend>{t('services.liveChannels')}</Fieldset.Legend>
          <Checkbox
            label={t('services.liveChannelOpenai')}
            checked={exposure.openai}
            onChange={() => setExposure((x) => ({ ...x, openai: !x.openai }))}
          />
          <Checkbox
            label="MCP"
            checked={exposure.mcp}
            onChange={() => setExposure((x) => ({ ...x, mcp: !x.mcp }))}
          />
        </Fieldset>
        <Details>
          <Details.Summary>{t('services.liveTryFirst')}</Details.Summary>
          <Details.Content>
            <TestRun api={api} tenant={tenant} serviceId={slug(name)} draft={definition} />
          </Details.Content>
        </Details>
        <Details>
          <Details.Summary>{t('services.liveSeeYaml')}</Details.Summary>
          <Details.Content>
            <pre tabIndex={0} className="version-yaml" aria-label={t('services.liveYamlLabel')}>
              <code>{toYaml(definition)}</code>
            </pre>
          </Details.Content>
        </Details>
        <Textfield
          label={t('services.liveReason')}
          description={t('services.liveReasonHelp')}
          value={reason}
          error={errors.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div aria-live="polite">
          {failed ? (
            <Alert data-color="danger" data-size="sm">
              <Paragraph data-size="sm">{t('services.liveCouldNotPublish')}</Paragraph>
              <ul className="bullets">
                {failed.map((e) => (
                  <li key={`${e.path}${e.message}`}>
                    {e.path ? <code>{e.path}</code> : null}
                    {e.path ? ': ' : ''}
                    {e.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </div>
        <Button
          variant="primary"
          className="align-start"
          loading={busy}
          onClick={() => !busy && void publish()}
        >
          {t('services.liveCreate')}
        </Button>
      </div>
    </div>
  );
};
