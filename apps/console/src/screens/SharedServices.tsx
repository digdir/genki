import { Paragraph, Radio } from '@digdir/designsystemet-react';
import { useEffect, useId, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type T } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import { useTenantNames } from '../tenant-names';
import type { SharedService } from '../types';
import { DialogError, Flash, ReasonDialog, useFlash } from '../ui';
import './platform.css';

type Sharing = SharedService['availableTo'];

const sharing = (s: SharedService, t: T) =>
  s.availableTo === '*'
    ? t('sharedServices.sharingAll')
    : s.availableTo === null
      ? t('sharedServices.sharingOwner')
      : t('sharedServices.sharingSome', { count: s.availableTo.length });

const sameSharing = (a: Sharing, b: Sharing) => JSON.stringify(a) === JSON.stringify(b);

export const SharedServices = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const choiceName = useId();
  const tenantName = useTenantNames(api);
  const [state, retry] = useAsync((signal) => api.sharedServices(signal), [api]);
  const [services, setServices] = useState<SharedService[] | undefined>();
  const [editing, setEditing] = useState<SharedService | undefined>();
  const [choice, setChoice] = useState<Sharing>(null);
  const flash = useFlash();

  useEffect(() => {
    if (state.status === 'ready') setServices(state.data);
  }, [state]);

  const open = (service: SharedService) => {
    flash.clear();
    setChoice(service.availableTo);
    setEditing(service);
  };

  const save = async (reason: string) => {
    if (!editing) return;
    if (sameSharing(choice, editing.availableTo))
      throw new DialogError(t('sharedServices.unchanged'));
    try {
      await api.shareService(editing.tenant, editing.id, choice, reason);
    } catch (error) {
      throw new DialogError(
        error instanceof ApiError && error.problem?.title
          ? error.problem.title
          : t('sharedServices.changeFailed', { name: editing.name }),
      );
    }
    const changed = editing;
    setServices((all) =>
      all?.map((s) =>
        s.tenant === changed.tenant && s.id === changed.id ? { ...s, availableTo: choice } : s,
      ),
    );
    flash.show(
      choice === '*'
        ? t('sharedServices.sharedAll', { name: changed.name })
        : choice === null
          ? t('sharedServices.ownerOnly', { name: changed.name })
          : t('sharedServices.unsharedAll', { name: changed.name }),
    );
  };

  const options: { value: Sharing; label: string }[] = editing
    ? [
        { value: '*', label: t('sharedServices.sharingAll') },
        ...(Array.isArray(editing.availableTo)
          ? [{ value: editing.availableTo, label: sharing(editing, t) }]
          : []),
        { value: null, label: t('sharedServices.sharingOwner') },
      ]
    : [];

  return (
    <>
      <h1 className="pf-title">{t('sharedServices.title')}</h1>
      <Flash message={flash.message} />
      {!services && state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : !services ? (
        <Loading label={t('sharedServices.loading')} shape="table" onRetry={retry} />
      ) : services.length === 0 ? (
        <EmptyState title={t('sharedServices.noneTitle')}>
          <Paragraph>{t('sharedServices.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        <div
          className="pf-region"
          tabIndex={0}
          role="region"
          aria-label={t('sharedServices.title')}
        >
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">{t('sharedServices.colService')}</th>
                <th scope="col">{t('sharedServices.colOwner')}</th>
                <th scope="col">{t('sharedServices.colVersion')}</th>
                <th scope="col">{t('sharedServices.colSharedWith')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('sharedServices.colChange')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={`${s.tenant}/${s.id}`}>
                  <td className="name">{s.name}</td>
                  <td>{tenantName(s.tenant)}</td>
                  <td>{s.version}</td>
                  <td>{s.availableTo === '*' ? t('sharedServices.everyone') : sharing(s, t)}</td>
                  <td className="end">
                    <button
                      type="button"
                      className="pf-link"
                      aria-label={t('sharedServices.changeFor', { name: s.name })}
                      onClick={() => open(s)}
                    >
                      {t('sharedServices.colChange')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReasonDialog
        open={editing !== undefined}
        title={editing ? t('sharedServices.changeTitle', { name: editing.name }) : ''}
        text={t('sharedServices.note')}
        confirmLabel={t('sharedServices.save')}
        onClose={() => setEditing(undefined)}
        onConfirm={save}
      >
        <fieldset className="pf-choice stacked">
          <legend>{t('sharedServices.colSharedWith')}</legend>
          {options.map((o) => (
            <Radio
              key={o.label}
              name={choiceName}
              value={o.label}
              label={o.label}
              checked={sameSharing(choice, o.value)}
              onChange={() => setChoice(o.value)}
            />
          ))}
        </fieldset>
      </ReasonDialog>
    </>
  );
};
