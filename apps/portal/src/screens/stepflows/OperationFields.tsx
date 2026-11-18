import { Fieldset, Paragraph, Tag } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import type { BlockStep } from '../../data/stepflows';
import {
  checkText,
  descriptorOf,
  fieldTypeKey,
  kindName,
  operationChecks,
  operationKindOf,
  stepModelOf,
  type CheckState,
  type OperationContext,
  type StepOperation,
} from '../../data/step-operations';
import { useT, type PlainKey } from '../../i18n';
import type { Residency } from '../../types';
import { SelectField, type Option } from './fields';
import { omit } from './model';

const whereKey: Record<Residency, PlainKey> = {
  norway: 'stepflows.whereNorway',
  eu: 'stepflows.whereEu',
  global: 'stepflows.whereGlobal',
};

const stateColor: Record<CheckState, 'success' | 'danger' | 'neutral'> = {
  ok: 'success',
  missing: 'danger',
  unknown: 'neutral',
};

const stateKey: Record<CheckState, PlainKey> = {
  ok: 'stepflows.checkOk',
  missing: 'stepflows.checkMissing',
  unknown: 'stepflows.checkUnknown',
};

export type InputRenderer = (
  inputs: [string, string, boolean][],
  values: Record<string, string>,
  raw: Record<string, unknown> | undefined,
  set: (v: Record<string, string>, raw: Record<string, unknown> | undefined) => void,
) => ReactNode;

interface Props {
  draft: BlockStep;
  setDraft: (next: BlockStep) => void;
  ops: OperationContext & { failed?: boolean };
  touched: boolean;
  onTouch: () => void;
  inputFields: InputRenderer;
}

const keepOnly = <V,>(values: Record<string, V> | undefined, names: Set<string>) =>
  Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => names.has(k)));

export const OperationFields = ({
  draft: d,
  setDraft,
  ops,
  touched,
  onTouch,
  inputFields,
}: Props) => {
  const t = useT();
  const id = descriptorOf(d);
  const list = ops.operations;
  const op = list?.find((o) => o.id === id);
  const model = stepModelOf(d);
  const kind = kindName(op?.operation ?? operationKindOf(id) ?? '');

  const options: Option[] = [
    ...(id && !op ? [{ value: id, label: id }] : []),
    ...(list ?? []).map((o) => ({
      value: o.id,
      label: t('stepflows.operationOption', { kind: kindName(o.operation), id: o.id }),
    })),
  ];

  const pick = (next: string) => {
    onTouch();
    const chosen: StepOperation | undefined = list?.find((o) => o.id === next);
    const names = new Set(chosen?.input.map((f) => f.name) ?? []);
    const raw = keepOnly(d.raw, names);
    const keepModel = chosen?.models.some((m) => m.id === model);
    setDraft({
      ...omit(d, 'raw'),
      in: keepOnly(d.in, names),
      ...(Object.keys(raw).length ? { raw } : {}),
      p: { ...(next ? { descriptor: next } : {}), ...(keepModel ? { model } : {}) },
    });
  };

  const setModel = (next: string) =>
    setDraft({ ...d, p: { ...omit(d.p, 'model'), ...(next ? { model: next } : {}) } });

  const description = list
    ? list.length === 0
      ? t('stepflows.operationsNone')
      : op?.summary
    : ops.failed
      ? t('stepflows.operationsFailed')
      : t('stepflows.operationsLoading');

  return (
    <>
      <SelectField
        id="p-descriptor"
        label={t('stepflows.operationLabel')}
        {...(description ? { description } : {})}
        value={id}
        placeholder={t('stepflows.operationPlaceholder')}
        options={options}
        {...(touched && !id
          ? { error: t('stepflows.chooseOperation') }
          : id && list && !op
            ? { error: t('stepflows.operationGone', { id }) }
            : {})}
        onChange={pick}
      />
      {op?.media.length ? (
        <Paragraph data-size="sm" className="meta">
          {t('stepflows.operationMedia', { media: op.media.join(', ') })}
        </Paragraph>
      ) : null}
      {op ? (
        <SelectField
          id="p-model"
          label={t('stepflows.operationModel')}
          description={t('stepflows.operationModelHelp')}
          value={model}
          options={[
            { value: '', label: t('stepflows.operationModelDefault', { kind }) },
            ...(model && !op.models.some((m) => m.id === model)
              ? [{ value: model, label: model }]
              : []),
            ...op.models.map((m) => ({
              value: m.id,
              label: t(
                m.processorRecord
                  ? 'stepflows.operationModelOption'
                  : 'stepflows.operationModelNoRecord',
                { name: m.name, where: t(whereKey[m.residency]) },
              ),
            })),
          ]}
          onChange={setModel}
        />
      ) : null}
      {op ? (
        <Fieldset>
          <Fieldset.Legend>{t('stepflows.inputLegend')}</Fieldset.Legend>
          <Fieldset.Description>
            {t('stepflows.inputHelp', { placeholder: '{{steg.verdi}}' })}
          </Fieldset.Description>
          <div className="stack-sm">
            {inputFields(
              op.input.map((f) => [f.name, t(fieldTypeKey[f.type]), f.required]),
              d.in,
              d.raw,
              (v, raw) => setDraft({ ...omit(d, 'raw'), in: v, ...(raw ? { raw } : {}) }),
            )}
          </div>
        </Fieldset>
      ) : null}
      {id ? (
        <Fieldset>
          <Fieldset.Legend>{t('stepflows.checklistLegend')}</Fieldset.Legend>
          <Fieldset.Description>{t('stepflows.checklistHelp')}</Fieldset.Description>
          <ul className="op-checklist">
            {operationChecks(d, ops).map((c) => (
              <li key={c.id}>
                <Tag data-size="sm" data-color={stateColor[c.state]}>
                  {t(stateKey[c.state])}
                </Tag>
                <span>{t(checkText[c.id])}</span>
              </li>
            ))}
          </ul>
        </Fieldset>
      ) : null}
    </>
  );
};
