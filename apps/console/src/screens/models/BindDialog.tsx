import { Label, Paragraph, Select, SelectOption } from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useT } from '../../i18n';
import { operationName, rebind } from '../../model-operations';
import type { ModelApi, OperatorModel } from '../../types';
import { DialogError, ReasonDialog } from '../../ui';
import { apisFor, boundOf } from './area-data';

export interface Binding {
  model: OperatorModel;
  kind?: string;
  proposed?: string;
}

const messages = (error: unknown) =>
  error instanceof ApiError ? (error.problem?.errors ?? []).map((e) => e.message) : [];

/** Changes the API one model binds for one kind, showing the current and the new API. */
export const BindDialog = ({
  api,
  binding,
  apis,
  families,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  binding: Binding | undefined;
  apis: ModelApi[];
  families: string[] | undefined;
  onClose: () => void;
  onSaved: (model: OperatorModel) => void;
}) => {
  const t = useT();
  const id = useId();
  const model = binding?.model;
  const bound = model ? boundOf(model) : {};
  const kinds = [
    ...new Set(
      apis
        .filter((a) => !families || families.includes(a.family))
        .map((a) => a.kind)
        .filter((k) => !bound[k]),
    ),
  ].sort();
  const [kind, setKind] = useState('');
  const [chosen, setChosen] = useState('');
  const [shown, setShown] = useState<Binding | undefined>();
  if (binding !== shown) {
    setShown(binding);
    setKind(binding?.kind ?? kinds[0] ?? '');
    setChosen(binding?.proposed ?? '');
  }
  const current = bound[kind];
  const offered = apisFor(apis, families, kind).filter((a) => a.id !== current);
  const only = Boolean(current) && Object.keys(bound).length === 1;
  return (
    <ReasonDialog
      open={Boolean(binding)}
      title={
        model
          ? binding?.kind
            ? t('models.bindTitle', { kind: operationName(kind, t), model: model.deployment })
            : t('models.addKindTitle', { model: model.deployment })
          : ''
      }
      confirmLabel={t('models.bindSave')}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!model || !kind) throw new DialogError(t('models.bindChooseKind'));
        if (chosen === (current ?? '')) throw new DialogError(t('models.bindUnchanged'));
        try {
          onSaved(await api.classifyModel(model.id, { apis: rebind(bound, kind, chosen) }, reason));
        } catch (error) {
          throw new DialogError([t('models.bindFailed'), ...messages(error)].join(' '));
        }
      }}
    >
      {binding && !binding.kind ? (
        <div className="field">
          <Label htmlFor={`${id}-kind`}>{t('models.kind')}</Label>
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setChosen('');
            }}
          >
            {kinds.map((k) => (
              <SelectOption key={k} value={k}>
                {operationName(k, t)}
              </SelectOption>
            ))}
          </Select>
        </div>
      ) : null}
      <dl className="def-list">
        <dt>{t('models.bindNow')}</dt>
        <dd>{current ? <code>{current}</code> : t('models.bindNone')}</dd>
      </dl>
      <div className="field">
        <Label htmlFor={`${id}-api`}>{t('models.bindNew')}</Label>
        <Select id={`${id}-api`} value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <SelectOption value="" disabled={!current || only}>
            {current ? t('models.bindRemove') : t('models.bindChoose')}
          </SelectOption>
          {offered.map((a) => (
            <SelectOption key={a.id} value={a.id}>
              {a.id}
            </SelectOption>
          ))}
        </Select>
      </div>
      <Paragraph data-size="sm">
        {t('models.bindFamilies', { connection: model?.endpoint ?? '' })}{' '}
        {model?.usage
          ? t('models.bindAffects', {
              count: model.usage.length,
              model: model.deployment,
            })
          : null}
      </Paragraph>
    </ReasonDialog>
  );
};
