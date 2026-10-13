import {
  Alert,
  Label,
  Paragraph,
  Select,
  SelectOption,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { useT, type PlainKey, type T } from '../../i18n';
import type { OperatorModel, ParameterRule, ParameterRules, TunableParameter } from '../../types';
import { DialogError, ReasonDialog } from '../../ui';

export const parameterNames: TunableParameter[] = ['temperature', 'reasoning', 'maxTokens'];

const nameLabel: Record<TunableParameter, PlainKey> = {
  temperature: 'modelParameters.temperature',
  reasoning: 'modelParameters.reasoning',
  maxTokens: 'modelParameters.maxTokens',
};

const reasoningLabel: Record<string, PlainKey> = {
  low: 'modelParameters.reasoningLow',
  medium: 'modelParameters.reasoningMedium',
  high: 'modelParameters.reasoningHigh',
};

export const parameterName = (t: T, name: TunableParameter) => t(nameLabel[name]);

export const ruleText = (t: T, name: TunableParameter, rule: ParameterRule) =>
  rule.mode === 'unsupported'
    ? t('modelParameters.ruleUnsupported', { name: parameterName(t, name) })
    : t('modelParameters.ruleFixed', {
        name: parameterName(t, name),
        value: String(rule.value),
      });

type Draft = { mode: 'send' | 'unsupported' | 'fixed'; value: string };

const draftOf = (rule: ParameterRule | undefined): Draft =>
  rule?.mode === 'fixed'
    ? { mode: 'fixed', value: String(rule.value) }
    : { mode: rule?.mode ?? 'send', value: '' };

const ruleOf = (name: TunableParameter, draft: Draft): ParameterRule | undefined | 'invalid' => {
  if (draft.mode === 'send') return undefined;
  if (draft.mode === 'unsupported') return { mode: 'unsupported' };
  if (name === 'reasoning')
    return ['low', 'medium', 'high'].includes(draft.value)
      ? { mode: 'fixed', value: draft.value }
      : 'invalid';
  const value = Number(draft.value.replace(',', '.'));
  const ok =
    draft.value.trim() !== '' &&
    Number.isFinite(value) &&
    (name === 'temperature' ? value >= 0 && value <= 2 : Number.isInteger(value) && value > 0);
  return ok ? { mode: 'fixed', value } : 'invalid';
};

const initial = (model: OperatorModel | undefined) =>
  Object.fromEntries(parameterNames.map((n) => [n, draftOf(model?.parameters?.[n])])) as Record<
    TunableParameter,
    Draft
  >;

export const RejectedHint = ({ model }: { model: OperatorModel }) => {
  const t = useT();
  const names = parameterNames.filter(
    (n) => model.rejectedParameters?.[n] && !model.parameters?.[n],
  );
  if (names.length === 0) return null;
  return (
    <>
      {names.map((n) => (
        <span key={n} className="muted">
          <br />
          {t('modelParameters.rejectedHint', { name: parameterName(t, n).toLowerCase() })}
        </span>
      ))}
    </>
  );
};

export const ParametersDialog = ({
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
  const [drafts, setDrafts] = useState(initial(model));
  const [shown, setShown] = useState<string | undefined>();
  if (model && shown !== model.id) {
    setShown(model.id);
    setDrafts(initial(model));
  }
  const set = (name: TunableParameter, change: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [name]: { ...d[name], ...change } }));
  const suggested = model
    ? parameterNames.filter((n) => model.rejectedParameters?.[n] && !model.parameters?.[n])
    : [];

  return (
    <ReasonDialog
      open={Boolean(model)}
      title={model ? t('modelParameters.title', { model: model.deployment }) : ''}
      text={t('modelParameters.text')}
      confirmLabel={t('modelParameters.save')}
      onClose={() => {
        setShown(undefined);
        onClose();
      }}
      onConfirm={async (reason) => {
        if (!model) return;
        const rules: ParameterRules = {};
        for (const name of parameterNames) {
          const rule = ruleOf(name, drafts[name]);
          if (rule === 'invalid')
            throw new DialogError(
              t('modelParameters.invalid', { name: parameterName(t, name).toLowerCase() }),
            );
          if (rule) rules[name] = rule;
        }
        const updated = await api.classifyModel(model.id, { parameters: rules }, reason);
        onSaved({ ...model, ...updated });
      }}
    >
      {suggested.map((n) => (
        <Alert key={n} data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            <strong>
              {t('modelParameters.rejectedTitle', { name: parameterName(t, n).toLowerCase() })}
            </strong>{' '}
            {t('modelParameters.rejectedText', {
              name: parameterName(t, n).toLowerCase(),
              when: f.dateTime(model?.rejectedParameters?.[n] ?? ''),
            })}
          </Paragraph>
        </Alert>
      ))}
      {parameterNames.map((name) => {
        const draft = drafts[name];
        const id = `parameter-${name}`;
        return (
          <div key={name} className="stack-sm">
            <Label htmlFor={id}>{parameterName(t, name)}</Label>
            <Select
              id={id}
              value={draft.mode}
              onChange={(e) => set(name, { mode: e.target.value as Draft['mode'] })}
            >
              <SelectOption value="send">{t('modelParameters.modeSend')}</SelectOption>
              <SelectOption value="unsupported">
                {t('modelParameters.modeUnsupported')}
              </SelectOption>
              <SelectOption value="fixed">{t('modelParameters.modeFixed')}</SelectOption>
            </Select>
            {draft.mode === 'fixed' && name === 'reasoning' ? (
              <>
                <Label htmlFor={`${id}-value`}>
                  {t('modelParameters.fixedValue', { name: parameterName(t, name).toLowerCase() })}
                </Label>
                <Select
                  id={`${id}-value`}
                  value={draft.value}
                  onChange={(e) => set(name, { value: e.target.value })}
                >
                  <SelectOption value="">{''}</SelectOption>
                  {Object.entries(reasoningLabel).map(([value, label]) => (
                    <SelectOption key={value} value={value}>
                      {t(label)}
                    </SelectOption>
                  ))}
                </Select>
              </>
            ) : null}
            {draft.mode === 'fixed' && name !== 'reasoning' ? (
              <Textfield
                label={t('modelParameters.fixedValue', {
                  name: parameterName(t, name).toLowerCase(),
                })}
                inputMode="decimal"
                value={draft.value}
                onChange={(e) => set(name, { value: e.target.value })}
              />
            ) : null}
          </div>
        );
      })}
    </ReasonDialog>
  );
};
