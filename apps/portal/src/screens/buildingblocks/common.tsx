import { Alert, Button, Paragraph } from '@digdir/designsystemet-react';
import { intlLocale } from '@genai/i18n';
import { useState } from 'react';
import type {
  BlockKind,
  BlockUser,
  CatalogItem,
  LoggedChange,
  Permission,
} from '../../api/building-blocks';
import { ApiCallPanel, type ApiCallPreview } from '../../components/ApiCall';
import { ChangeLogged } from '../../components/ChangeLogged';
import { Icon, icons } from '../../components/Icon';
import { permissionLabels } from '../../data/building-blocks';
import { useT, type Format, type T } from '../../i18n';
import { rightLabel, useRights } from '../../Shell';
import type { PortalRight } from '../../types';

export type Flash =
  { kind: 'logged'; text: string; change: LoggedChange } | { kind: 'plain'; text: string };

export const FlashMessage = ({ flash }: { flash: Flash | null }) => (
  <div aria-live="polite">
    {flash?.kind === 'logged' ? (
      <ChangeLogged by={flash.change.by} at={flash.change.at} reason={flash.change.reason}>
        {flash.text}
      </ChangeLogged>
    ) : flash ? (
      <Alert data-color="success" data-size="sm">
        <Paragraph data-size="sm">{flash.text}</Paragraph>
      </Alert>
    ) : null}
  </div>
);

export const rightFor = (kind: BlockKind): PortalRight =>
  kind === 'dataset' || kind === 'search_engine' ? 'manage-datasets' : 'manage-services';

export const useBlockRights = () => {
  const { has } = useRights();
  return {
    canChange: (kind: BlockKind) => has(rightFor(kind)),
    canRegister: has('register-building-blocks'),
    readOnly: !has('manage-services') && !has('manage-datasets'),
  };
};

export const rightLabelFor = (t: T, kind: BlockKind) => rightLabel(t, rightFor(kind));

export const ReadOnlyAlert = ({ right }: { right?: string }) => {
  const t = useT();
  return (
    <Alert data-color="info">
      <Paragraph>
        {right
          ? t('blocks.readOnlyOne', { right })
          : t('blocks.readOnlyMany', {
              services: rightLabel(t, 'manage-services'),
              datasets: rightLabel(t, 'manage-datasets'),
            })}
      </Paragraph>
    </Alert>
  );
};

export const ApiCallButton = ({ call }: { call: () => ApiCallPreview }) => {
  const t = useT();
  const [open, setOpen] = useState<ApiCallPreview | null>(null);
  return (
    <>
      <Button variant="tertiary" data-size="sm" onClick={() => setOpen(call())}>
        <Icon d={icons.code} size={18} />
        {t('common.apiCall')}
      </Button>
      {open ? <ApiCallPanel call={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
};

export const PermissionList = ({ permissions }: { permissions: Permission[] }) => {
  const t = useT();
  return (
    <dl className="kv bb-kv">
      {permissions.map((p) => (
        <div key={p.type} className="bb-kv-row">
          <dt>{t(permissionLabels[p.type])}</dt>
          <dd>
            {p.value}
            {p.note ? <span className="bb-note">{p.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
};

export const shortDate = (f: Format, iso?: string) => {
  if (!iso) return '';
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale(f.locale), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  })
    .format(date)
    .replace(/\.$/, '');
};

export const serviceName = (services: BlockUser[], id: string) =>
  services.find((s) => s.id === id)?.name ?? id;

export const usedText = (t: T, item: CatalogItem) =>
  item.usedBy.length ? t('blocks.usedBy', { count: item.usedBy.length }) : t('blocks.usedByNone');

export const versionText = (t: T, item: CatalogItem) =>
  item.kind !== 'dataset' || /^\d+$/.test(item.version)
    ? item.version === '0'
      ? t('blocks.notVersioned')
      : t('blocks.versionLower', { version: item.version })
    : item.version.charAt(0).toLowerCase() + item.version.slice(1);

export const approverName = (t: T, approver?: string) =>
  !approver || approver === 'digdir' ? t('common.actorOperator') : approver;
