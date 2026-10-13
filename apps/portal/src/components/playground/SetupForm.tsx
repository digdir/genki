import {
  Alert,
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Link,
  Paragraph,
  Radio,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import { useId } from 'react';
import type { PlaygroundOptions, PlaygroundSetup } from '../../api/playground';
import {
  modelOf,
  serviceSetup,
  shortModelName,
  versionLabel,
  versionOf,
} from '../../data/playground';
import { translator, useT, type PlainKey, type T } from '../../i18n';
import { DataLocationTag } from '../DataLocationTag';

type ListKey = 'datasets' | 'skills' | 'blocks';

const nbT = translator('nb');

const ruleTag = {
  requires_approval: 'playground.ruleRequiresApproval',
  not_allowed: 'playground.ruleNotAllowed',
} as const satisfies Record<string, PlainKey>;

const versionKey = (v: { version: number; draft: boolean }) =>
  v.draft ? 'draft' : String(v.version);

export const ruleAlertFor = (
  options: PlaygroundOptions,
  setup: PlaygroundSetup,
  tenantName: string,
  t: T = nbT,
) => {
  const model = modelOf(options, setup.model);
  if (model.status === 'allowed') return undefined;
  const name = shortModelName(model.name);
  return model.status === 'not_allowed'
    ? {
        color: 'danger' as const,
        title: t('playground.notAllowedTitle', { model: name, tenant: tenantName }),
        text: model.policy?.rule ?? t('playground.notAllowedText'),
        ownedBy: model.policy?.ownedBy,
        href: model.policy?.link ?? '#/settings',
        link: t('playground.seeSetting'),
      }
    : {
        color: 'warning' as const,
        title: t('playground.needsApprovalTitle', { model: name }),
        text: model.policy?.rule ?? t('playground.needsApprovalText'),
        ownedBy: model.policy?.ownedBy,
        href: model.policy?.link ?? '#/building-blocks',
        link: t('playground.askApproval'),
      };
};

export const SetupForm = ({
  options,
  draft,
  title,
  tenantName,
  onChange,
  onApply,
  onCancel,
}: {
  options: PlaygroundOptions;
  draft: PlaygroundSetup;
  title: string;
  tenantName: string;
  onChange: (next: PlaygroundSetup) => void;
  onApply: () => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const id = useId();
  const found = versionOf(options, draft);
  const isService = !!draft.service;
  const rule = ruleAlertFor(options, draft, tenantName, t);
  const toggle = (key: ListKey, value: string) =>
    onChange({
      ...draft,
      [key]: draft[key].includes(value)
        ? draft[key].filter((x) => x !== value)
        : [...draft[key], value],
    });
  const pickService = (serviceId: string) => {
    const next = serviceSetup(options, serviceId);
    if (next) onChange(next);
  };
  const pickVersion = (key: string) => {
    const version = found?.service.versions.find((v) => versionKey(v) === key);
    if (!found || !version) return;
    const next = serviceSetup(options, found.service.id, version);
    if (next) onChange({ ...next, model: draft.model });
  };
  const chipGroup = (key: ListKey, legend: string, list: { id: string; name: string }[]) => (
    <Fieldset>
      <Fieldset.Legend>{legend}</Fieldset.Legend>
      <div className="playground-chips">
        {list.map((item) => (
          <Chip.Checkbox
            key={item.id}
            data-size="sm"
            checked={draft[key].includes(item.id)}
            onChange={() => toggle(key, item.id)}
          >
            {item.name}
          </Chip.Checkbox>
        ))}
      </div>
    </Fieldset>
  );
  return (
    <div className="playground-form">
      <Heading level={3} data-size="2xs">
        {title}
      </Heading>
      <Fieldset>
        <Fieldset.Legend>{t('playground.whatToTry')}</Fieldset.Legend>
        <Radio
          name={`${id}-kind`}
          label={t('playground.kindService')}
          checked={isService}
          onChange={() => {
            const first = options.services[0];
            if (first) pickService(found?.service.id ?? first.id);
          }}
        />
        <Radio
          name={`${id}-kind`}
          label={t('playground.kindOwn')}
          checked={!isService}
          onChange={() => {
            onChange({
              model: draft.model,
              datasets: draft.datasets,
              skills: draft.skills,
              blocks: draft.blocks,
              output: draft.output,
            });
          }}
        />
      </Fieldset>
      {isService && found ? (
        <>
          <div className="playground-row">
            <Field className="playground-grow">
              <Label htmlFor={`${id}-svc`}>{t('playground.service')}</Label>
              <Select
                id={`${id}-svc`}
                value={found.service.id}
                onChange={(e) => pickService(e.target.value)}
              >
                {options.services.map((s) => (
                  <Select.Option key={s.id} value={s.id}>
                    {s.name}
                  </Select.Option>
                ))}
              </Select>
            </Field>
            <Field className="playground-grow-sm">
              <Label htmlFor={`${id}-ver`}>{t('playground.versionLabel')}</Label>
              <Select
                id={`${id}-ver`}
                value={versionKey(found.version)}
                onChange={(e) => pickVersion(e.target.value)}
              >
                {found.service.versions.map((v) => (
                  <Select.Option key={versionKey(v)} value={versionKey(v)}>
                    {versionLabel(v, t)}
                  </Select.Option>
                ))}
              </Select>
            </Field>
          </div>
          <Paragraph data-size="sm" className="playground-subtle">
            {t('playground.versionHelp', {
              version: versionLabel(found.version, t).toLowerCase(),
            })}
          </Paragraph>
        </>
      ) : null}
      <Fieldset>
        <Fieldset.Legend>{t('playground.model')}</Fieldset.Legend>
        {options.models.map((m) => (
          <Radio
            key={m.id}
            name={`${id}-model`}
            checked={draft.model === m.id}
            onChange={() => onChange({ ...draft, model: m.id })}
            label={
              <span className="playground-model">
                {m.name}
                <DataLocationTag location={m.dataLocation} />
                {m.status === 'allowed' ? null : (
                  <Tag
                    data-size="sm"
                    data-color={m.status === 'not_allowed' ? 'danger' : 'warning'}
                  >
                    {t(ruleTag[m.status])}
                  </Tag>
                )}
              </span>
            }
          />
        ))}
      </Fieldset>
      {rule ? (
        <Alert data-color={rule.color}>
          <Heading level={4} data-size="2xs">
            {rule.title}
          </Heading>
          <Paragraph>{rule.text}</Paragraph>
          {rule.ownedBy && !rule.text.includes(rule.ownedBy) ? (
            <Paragraph data-size="sm">
              {t('playground.ruleOwnedBy', { owner: rule.ownedBy })}
            </Paragraph>
          ) : null}
          <Link href={rule.href}>{rule.link}</Link>
        </Alert>
      ) : null}
      {isService ? null : (
        <>
          {chipGroup('datasets', t('playground.datasets'), options.datasets)}
          {chipGroup('skills', t('playground.skills'), options.skills)}
          {chipGroup('blocks', t('playground.blocks'), options.blocks)}
          <Fieldset>
            <Fieldset.Legend>{t('playground.outputLegend')}</Fieldset.Legend>
            <Radio
              name={`${id}-out`}
              label={t('playground.outputChat')}
              checked={draft.output === 'text'}
              onChange={() => onChange({ ...draft, output: 'text' })}
            />
            <Radio
              name={`${id}-out`}
              label={t('playground.outputFields')}
              checked={draft.output === 'fields'}
              onChange={() => onChange({ ...draft, output: 'fields' })}
            />
          </Fieldset>
        </>
      )}
      <div className="playground-actions">
        <Button
          variant="primary"
          data-size="sm"
          aria-disabled={rule ? true : undefined}
          onClick={() => {
            if (!rule) onApply();
          }}
        >
          {t('playground.applySetup')}
        </Button>
        <Button variant="secondary" data-size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
