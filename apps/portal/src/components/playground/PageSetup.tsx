import { CodeIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Checkbox,
  Details,
  Field,
  Fieldset,
  Heading,
  Label,
  Link,
  Paragraph,
  Radio,
  Select,
  Textarea,
} from '@digdir/designsystemet-react';
import { useFormat, useLocale } from '@genai/i18n/react';
import { useId } from 'react';
import type { ApiClient } from '../../api';
import type { ServiceDraft } from '../../api/quality';
import type { CatalogModel } from '../../api/models';
import type { PlaygroundOptions, PlaygroundSetup } from '../../api/playground';
import {
  changesLine,
  modelFactsText,
  modelOf,
  setupFromStart,
  shortModelName,
  strategyOf,
  takesInstructions,
  workText,
  startChoices,
  startKeyOf,
  startLabel,
  variantLabel,
  variantOf,
  versionOf,
  withInstructions,
} from '../../data/playground';
import type { PlaygroundStrategy } from '../../api/playground';
import type { AnswerLanguage } from '../../data/service-languages';
import type { AsyncState } from '../../hooks';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { ModelPicker } from '../ModelPicker';
import { AnswerLanguagePicker } from './AnswerLanguagePicker';
import { SaveToDraft } from './SaveToDraft';
import { ruleAlertFor } from './SetupForm';

export const useWorkLanguage = () => (useLocale().locale === 'en' ? 'en' : 'nb');

type ListKey = 'datasets' | 'skills' | 'blocks';

export const StartPicker = ({
  options,
  setup,
  onChange,
  label,
}: {
  options: PlaygroundOptions;
  setup: PlaygroundSetup;
  onChange: (next: PlaygroundSetup) => void;
  label?: string;
}) => {
  const t = useT();
  const id = useId();
  return (
    <Field>
      <Label htmlFor={id}>{label ?? t('playground.startFrom')}</Label>
      <Select
        id={id}
        value={startKeyOf(setup)}
        onChange={(e) => onChange(setupFromStart(options, e.target.value, setup))}
      >
        {startChoices(options, t).map((c) => (
          <Select.Option key={c.key} value={c.key}>
            {c.label}
          </Select.Option>
        ))}
      </Select>
    </Field>
  );
};

export const SetupModel = ({
  options,
  setup,
  models,
  tenantName,
  onChange,
}: {
  options: PlaygroundOptions;
  setup: PlaygroundSetup;
  models: AsyncState<CatalogModel[]>;
  tenantName: string;
  onChange: (next: PlaygroundSetup) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const rule = ruleAlertFor(options, setup, tenantName, t);
  const model = modelOf(options, setup.model);
  return (
    <>
      <div className="playground-model-box">
        <span className="playground-model-text">
          <strong>{shortModelName(model.name)}</strong>
          <span className="playground-subtle">{modelFactsText(model, f, t)}</span>
        </span>
        <ModelPicker
          models={models}
          value={setup.model}
          service={startLabel(options, setup, t)}
          triggerLabel={t('playground.swapModel')}
          onChange={(model) => onChange({ ...setup, model })}
        />
      </div>
      {rule ? (
        <Alert data-color={rule.color} data-size="sm">
          <Heading level={3} data-size="2xs">
            {rule.title}
          </Heading>
          <Paragraph data-size="sm">{rule.text}</Paragraph>
          {rule.ownedBy && !rule.text.includes(rule.ownedBy) ? (
            <Paragraph data-size="sm">
              {t('playground.ruleOwnedBy', { owner: rule.ownedBy })}
            </Paragraph>
          ) : null}
          <Link href={rule.href}>{rule.link}</Link>
        </Alert>
      ) : null}
    </>
  );
};

export const datasetChoices = (options: PlaygroundOptions, setup: PlaygroundSetup) => [
  ...options.datasets,
  ...setup.datasets
    .filter((d) => !options.datasets.some((o) => o.id === d))
    .map((d) => ({ id: d, name: d })),
];

export const InstructionsField = ({
  setup,
  base,
  strategy,
  editable,
  label,
  rows,
  onChange,
}: {
  setup: PlaygroundSetup;
  base: string | undefined;
  strategy: PlaygroundStrategy | undefined;
  editable: boolean;
  label: string;
  rows: number;
  onChange: (next: PlaygroundSetup) => void;
}) => {
  const t = useT();
  const id = useId();
  const language = useWorkLanguage();
  const value = setup.instructions ?? base ?? '';
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      {editable ? null : (
        <Paragraph data-size="sm" id={`${id}-why`} className="playground-subtle">
          {t('playground.instructionsLocked', {
            work: strategy ? workText(strategy, language, t) : '',
          })}
        </Paragraph>
      )}
      <Textarea
        id={id}
        rows={rows}
        value={value}
        readOnly={!editable}
        {...(editable ? {} : { 'aria-describedby': `${id}-why` })}
        onChange={(e) => onChange(withInstructions(setup, e.target.value))}
      />
    </Field>
  );
};

export const PageSetup = ({
  options,
  setup,
  models,
  tenantName,
  answerLanguage,
  sessionText,
  onChange,
  onAnswerLanguage,
  onShowCall,
  api,
  tenant,
  base,
  onSaved,
}: {
  api?: ApiClient | undefined;
  onSaved?: ((service: string, saved: ServiceDraft) => void) | undefined;
  tenant?: string | undefined;
  base?: string | undefined;
  options: PlaygroundOptions;
  setup: PlaygroundSetup;
  models: AsyncState<CatalogModel[]>;
  tenantName: string;
  answerLanguage: AnswerLanguage | '';
  sessionText: string;
  onChange: (next: PlaygroundSetup) => void;
  onAnswerLanguage: (value: AnswerLanguage | '') => void;
  onShowCall: () => void;
}) => {
  const t = useT();
  const id = useId();
  const language = useWorkLanguage();
  const found = versionOf(options, setup);
  const variant = variantOf(options, setup);
  const variants = found?.version.variants ?? [];
  const own = !setup.service;
  const changes = changesLine(options, setup, base, t);
  const strategy = strategyOf(options, setup);
  const toggle = (key: ListKey, value: string) =>
    onChange({
      ...setup,
      [key]: setup[key].includes(value)
        ? setup[key].filter((x) => x !== value)
        : [...setup[key], value],
    });
  const pickVariant = (variantId: string) => {
    const picked = variants.find((v) => v.id === variantId);
    if (!found || !setup.service || !picked) return;
    const service = { ...setup.service };
    delete service.variant;
    onChange({
      ...setup,
      service: picked === variants[0] ? service : { ...service, variant: picked.id },
      model: picked.model ?? found.version.setup.model,
    });
  };
  const checkboxes = (key: ListKey, list: { id: string; name: string }[]) =>
    list.map((item) => (
      <Checkbox
        key={item.id}
        data-size="sm"
        label={item.name}
        checked={setup[key].includes(item.id)}
        onChange={() => toggle(key, item.id)}
      />
    ));
  return (
    <aside aria-labelledby={`${id}-title`} className="playground-setup">
      <div className="playground-setup-title">
        <Heading level={2} data-size="xs" id={`${id}-title`}>
          {t('playground.setupTitle')}
        </Heading>
        <span className="playground-subtle">{t('playground.setupAppliesNext')}</span>
      </div>
      <StartPicker options={options} setup={setup} onChange={onChange} />
      {variant && variants.length ? (
        <Field>
          <Label htmlFor={`${id}-variant`}>{t('playground.variantLabel')}</Label>
          <Select
            id={`${id}-variant`}
            value={variant.id}
            onChange={(e) => pickVariant(e.target.value)}
          >
            {variants.map((v) => (
              <Select.Option key={v.id} value={v.id}>
                {variantLabel(v, t)}
              </Select.Option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="playground-setup-field" role="group" aria-labelledby={`${id}-model`}>
        <span className="ds-label" id={`${id}-model`}>
          {t('playground.model')}
        </span>
        <SetupModel
          options={options}
          setup={setup}
          models={models}
          tenantName={tenantName}
          onChange={onChange}
        />
      </div>
      <InstructionsField
        setup={setup}
        base={base}
        strategy={strategy}
        editable={own || takesInstructions(options, setup)}
        label={t('playground.instructions')}
        rows={5}
        onChange={onChange}
      />
      <Fieldset data-size="sm">
        <Fieldset.Legend>{t('playground.knowledge')}</Fieldset.Legend>
        {datasetChoices(options, setup).length ? (
          checkboxes('datasets', datasetChoices(options, setup))
        ) : (
          <span>{t('playground.knowledgeNone')}</span>
        )}
      </Fieldset>
      {strategy ? (
        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('playground.work')}</Fieldset.Legend>
          <span>{workText(strategy, language, t)}</span>
        </Fieldset>
      ) : null}
      <Details data-size="sm">
        <Details.Summary>{t('playground.moreChoices')}</Details.Summary>
        <Details.Content className="playground-setup-more">
          <AnswerLanguagePicker value={answerLanguage} onChange={onAnswerLanguage} />
          {own ? (
            <>
              <Fieldset data-size="sm">
                <Fieldset.Legend>{t('playground.skills')}</Fieldset.Legend>
                {checkboxes('skills', options.skills)}
              </Fieldset>
              <Fieldset data-size="sm">
                <Fieldset.Legend>{t('playground.blocks')}</Fieldset.Legend>
                {checkboxes('blocks', options.blocks)}
              </Fieldset>
              <Fieldset data-size="sm">
                <Fieldset.Legend>{t('playground.outputLegend')}</Fieldset.Legend>
                <Radio
                  name={`${id}-out`}
                  label={t('playground.outputChat')}
                  checked={setup.output === 'text'}
                  onChange={() => onChange({ ...setup, output: 'text' })}
                />
                <Radio
                  name={`${id}-out`}
                  label={t('playground.outputFields')}
                  checked={setup.output === 'fields'}
                  onChange={() => onChange({ ...setup, output: 'fields' })}
                />
              </Fieldset>
            </>
          ) : null}
        </Details.Content>
      </Details>
      <div className="playground-setup-summary">
        {changes ? <span>{changes}</span> : null}
        {found ? (
          <SaveToDraft
            api={api}
            tenant={tenant}
            options={options}
            setup={setup}
            base={base}
            label={t('playground.saveToDraft', { name: found.service.name })}
            {...(onSaved ? { onSaved } : {})}
          />
        ) : null}
        <span>{sessionText}</span>
        <Button variant="tertiary" data-size="sm" onClick={onShowCall}>
          <Icon icon={CodeIcon} size={18} />
          {t('common.apiCall')}
        </Button>
      </div>
    </aside>
  );
};
