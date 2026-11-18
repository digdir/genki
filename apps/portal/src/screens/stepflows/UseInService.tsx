import { Alert, Button, Dialog, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { applySpec, asServiceDefinition, forTenant } from '../../data/service-definition';
import { withFlow } from '../../data/service-form';
import type { Flow } from '../../data/stepflows';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { needsRight, useRights } from '../../Shell';
import { SearchField } from './fields';
import { flowName } from './model';

export const pinFlowInService = async (
  api: ApiClient,
  tenant: string,
  service: string,
  ref: string,
  reason: string,
) => {
  const [found, opened] = await Promise.all([
    api.getDefinition(tenant, 'Service', service),
    api.quality.openDraft(tenant, service, reason),
  ]);
  const current = opened ?? found.latest;
  const definition = asServiceDefinition(current.definition);
  const pinned = forTenant(applySpec(definition, withFlow(definition.spec, ref)), {
    tenant,
    id: service,
    version: found.latest.version + 1,
  });
  return api.quality.saveDraft(
    tenant,
    service,
    {
      definition: pinned as unknown as Record<string, unknown>,
      files: current.files ?? {},
      revision: opened?.revision ?? 0,
    },
    reason,
  );
};

export const UseInService = ({
  api,
  tenant,
  flow,
  onClose,
}: {
  api: ApiClient;
  tenant: string;
  flow: Flow;
  onClose: () => void;
}) => {
  const t = useT();
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
  const name = flowName(flow, t);
  const ref = `${flow.id}@${flow.version}`;
  const options = services.status === 'ready' ? services.data : [];

  const pin = async () => {
    if (saving || !canSave) return;
    const service = options.find((o) => o.value === chosen);
    if (!service) {
      setError(t('stepflows.useServiceRequired'));
      return;
    }
    setSaving(true);
    try {
      await pinFlowInService(
        api,
        tenant,
        service.value,
        ref,
        t('stepflows.useReason', { flow: ref }),
      );
      setDone({ id: service.value, name: service.label });
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t('stepflows.useConflict')
          : t('stepflows.useFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open modal onClose={onClose} aria-labelledby="use-in-service-h">
      <div className="stack-sm">
        <Heading level={2} data-size="xs" id="use-in-service-h">
          {t('stepflows.useTitle', { name })}
        </Heading>
        {done ? (
          <Alert data-color="success" data-size="sm">
            <Paragraph data-size="sm">
              {t('stepflows.useDone', { flow: ref, service: done.name })}
            </Paragraph>
            <a href={`#/services/${encodeURIComponent(done.id)}`}>
              {t('stepflows.useOpenService', { service: done.name })}
            </a>
          </Alert>
        ) : (
          <>
            <Paragraph data-size="sm">{t('stepflows.useLead', { flow: ref })}</Paragraph>
            <SearchField
              id="use-in-service"
              label={t('stepflows.useService')}
              clearLabel={t('stepflows.useClear')}
              description={
                services.status === 'loading'
                  ? t('stepflows.useLoading')
                  : options.length === 0
                    ? t('stepflows.useNoServices')
                    : t('stepflows.useHelp')
              }
              value={chosen}
              options={options}
              {...(error ? { error } : {})}
              onChange={(id) => {
                setChosen(id);
                setError('');
              }}
            />
            {canSave ? null : <p className="meta">{needsRight('manage-services', t)}</p>}
          </>
        )}
        <div className="actions">
          {done ? null : (
            <Button aria-disabled={saving || !canSave || undefined} onClick={() => void pin()}>
              {t('stepflows.usePin')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('stepflows.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
