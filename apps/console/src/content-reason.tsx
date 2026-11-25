import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiClient } from './api';
import { useT } from './i18n';
import { SupportDialog } from './support-dialog';
import { tenantLabel } from './tenant-names';

interface Asking {
  tenant: string;
  name: string;
  resolve: () => void;
  reject: () => void;
}

export const ContentReasonProvider = ({
  api,
  children,
}: {
  api: ApiClient;
  children: ReactNode;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [asking, setAsking] = useState<Asking | undefined>();
  const current = useRef<Asking | undefined>(undefined);

  useEffect(() => {
    api.onContentReason(async (tenant) => {
      const tenants = await api.listTenants(undefined, { usage: false }).catch(() => []);
      const name = tenantLabel(
        tenant,
        tenants.find((x) => x.orgNumber === tenant)?.name,
        tRef.current,
      );
      return new Promise<void>((resolve, reject) => {
        current.current?.reject();
        current.current = { tenant, name, resolve, reject: () => reject(new Error('cancelled')) };
        setAsking(current.current);
      });
    });
    return () => api.onContentReason(undefined);
  }, [api]);

  const answered = useRef(false);
  return (
    <>
      {children}
      <SupportDialog
        open={Boolean(asking)}
        title={t('support.contentReasonTitle')}
        lead={asking ? t('support.contentReasonLead', { tenant: asking.name }) : undefined}
        hint={t('support.contentReasonHint')}
        sees={t('support.contentReasonSees')}
        cta={t('support.contentReasonCta')}
        api={{
          method: 'POST',
          path: `/operator/tenants/${asking?.tenant ?? '{tenant}'}/content-reason`,
          body: (reason) => ({ reason }),
        }}
        onClose={() => {
          if (!answered.current) asking?.reject();
          answered.current = false;
          current.current = undefined;
          setAsking(undefined);
        }}
        onConfirm={async (reason) => {
          if (!asking) return;
          await api.giveContentReason(asking.tenant, reason);
          answered.current = true;
          asking.resolve();
        }}
      />
    </>
  );
};
