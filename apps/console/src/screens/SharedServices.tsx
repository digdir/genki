import {
  Alert,
  Button,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type T } from '../i18n';
import { useReason } from '../reason';
import { EmptyState, ErrorState, Loading } from '../states';
import type { SharedService } from '../types';
import { formatOrgNumber } from './Tenants';
import { PageHeader, TableRegion } from '../ui';

const sharing = (s: SharedService, t: T) =>
  s.availableTo === '*'
    ? t('sharedServices.sharingAll')
    : s.availableTo === null
      ? t('sharedServices.sharingOwner')
      : t('sharedServices.sharingSome', { count: s.availableTo.length });

export const SharedServices = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync((signal) => api.sharedServices(signal), [api]);
  const [services, setServices] = useState<SharedService[]>([]);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const reason = useReason();

  useEffect(() => {
    if (state.status === 'ready') setServices(state.data);
  }, [state]);

  const change = async (service: SharedService, availableTo: SharedService['availableTo']) => {
    const why = reason.require();
    if (!why) return;
    const key = `${service.tenant}/${service.id}`;
    setBusy(key);
    setMessage(undefined);
    try {
      await api.shareService(service.tenant, service.id, availableTo, why);
      setServices((all) =>
        all.map((s) =>
          s.tenant === service.tenant && s.id === service.id ? { ...s, availableTo } : s,
        ),
      );
      setMessage({
        ok: true,
        text:
          availableTo === '*'
            ? tRef.current('sharedServices.sharedAll', { name: service.name })
            : tRef.current('sharedServices.unsharedAll', { name: service.name }),
      });
    } catch {
      setMessage({
        ok: false,
        text: tRef.current('sharedServices.changeFailed', { name: service.name }),
      });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader title={t('sharedServices.title')} intro={t('sharedServices.intro')} />
      <Paragraph data-size="sm">{t('sharedServices.note')}</Paragraph>
      {reason.field(t('sharedServices.reasonHint'))}
      {message ? (
        <Alert
          data-color={message.ok ? 'success' : 'danger'}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </Alert>
      ) : null}
      {state.status === 'loading' ? (
        <Loading label={t('sharedServices.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : services.length === 0 ? (
        <EmptyState title={t('sharedServices.noneTitle')}>
          <Paragraph>{t('sharedServices.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        <TableRegion label={t('sharedServices.tableLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('sharedServices.colService')}</TableHeaderCell>
                <TableHeaderCell>{t('sharedServices.colOwner')}</TableHeaderCell>
                <TableHeaderCell>{t('sharedServices.colVersion')}</TableHeaderCell>
                <TableHeaderCell>{t('sharedServices.colSharedWith')}</TableHeaderCell>
                <TableHeaderCell>{t('sharedServices.colChange')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {services.map((s) => {
                const key = `${s.tenant}/${s.id}`;
                return (
                  <TableRow key={key}>
                    <TableCell>
                      {s.name}
                      <div className="muted">{s.publicNames.join(', ')}</div>
                    </TableCell>
                    <TableCell>{formatOrgNumber(s.tenant)}</TableCell>
                    <TableCell>v{s.version}</TableCell>
                    <TableCell>
                      <Tag data-color={s.availableTo === '*' ? 'success' : 'neutral'}>
                        {sharing(s, t)}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      {s.availableTo === '*' ? (
                        <Button
                          variant="secondary"
                          data-size="sm"
                          loading={busy === key}
                          onClick={() => void change(s, null)}
                          aria-label={t('sharedServices.stopSharingFor', { name: s.name })}
                        >
                          {t('sharedServices.stopSharing')}
                        </Button>
                      ) : (
                        <Button
                          data-size="sm"
                          loading={busy === key}
                          onClick={() => void change(s, '*')}
                          aria-label={t('sharedServices.shareFor', { name: s.name })}
                        >
                          {t('sharedServices.share')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      )}
    </>
  );
};
