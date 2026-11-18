import { Alert, Button, Dialog, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { SearchField } from '../stepflows/fields';
import { writeServiceDraft } from '../stepflows/UseInService';

export const putModelInDraft = (
  api: ApiClient,
  tenant: string,
  service: string,
  model: string,
  reason: string,
) =>
  writeServiceDraft(
    api,
    tenant,
    service,
    (d) => ({ model: { ...d.spec.model, primary: model } }),
    reason,
  );

export const UseModelInService = ({
  api,
  tenant,
  model,
  onClose,
}: {
  api: ApiClient;
  tenant: string;
  model: { id: string; name: string };
  onClose: () => void;
}) => {
  const t = useT();
  const heading = useId();
  const field = useId();
  const canSave = useRights().has('manage-services');
  const [services] = useAsync(
    async (signal) =>
      (await api.services(tenant, signal)).data
        .filter((s) => s.lifecycle !== 'archived' && s.latestVersion !== null)
        .map((s) => ({ value: s.id, label: s.name || s.id })),
    [api, tenant],
  );
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ id: string; name: string }>();
  const options = services.status === 'ready' ? services.data : [];

  const confirm = async () => {
    if (saving || !canSave) return;
    const service = options.find((o) => o.value === chosen);
    if (!service) {
      setError(t('blockTypes.useServiceRequired'));
      return;
    }
    setSaving(true);
    try {
      await putModelInDraft(
        api,
        tenant,
        service.value,
        model.id,
        t('blockTypes.useReason', { model: model.id }),
      );
      setDone({ id: service.value, name: service.label });
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t('blockTypes.useConflict')
          : t('blockTypes.useFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open modal closeButton={false} onClose={onClose} aria-labelledby={heading}>
      <div className="stack-sm">
        <Heading level={2} data-size="xs" id={heading}>
          {t('blockTypes.useTitle', { name: model.name })}
        </Heading>
        {done ? (
          <Alert data-color="success" data-size="sm">
            <Paragraph data-size="sm">
              {t('blockTypes.useDone', { model: model.name, service: done.name })}
            </Paragraph>
            <a href={`#/services/${encodeURIComponent(done.id)}/setup`}>
              {t('blockTypes.useOpenDraft', { service: done.name })}
            </a>
          </Alert>
        ) : (
          <>
            <SearchField
              id={field}
              label={t('blockTypes.useService')}
              clearLabel={t('blockTypes.useClear')}
              description={
                services.status === 'loading'
                  ? t('blockTypes.useLoading')
                  : options.length === 0
                    ? t('blockTypes.useNoServices')
                    : t('blockTypes.useHelp')
              }
              value={chosen}
              options={options}
              {...(error ? { error } : {})}
              onChange={(id) => {
                setChosen(id);
                setError('');
              }}
            />
            <Paragraph data-size="sm">{t('blockTypes.useLead')}</Paragraph>
            {canSave ? null : <p className="meta">{needsRight('manage-services', t)}</p>}
          </>
        )}
        <div className="actions">
          {done ? null : (
            <Button aria-disabled={saving || !canSave || undefined} onClick={() => void confirm()}>
              {t('blockTypes.useConfirm')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {done ? t('blockTypes.useClose') : t('blockTypes.useCancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
