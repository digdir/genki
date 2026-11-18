import { PlusIcon, UploadIcon } from '@navikt/aksel-icons';
import { Alert, Button } from '@digdir/designsystemet-react';
import { useState, type ChangeEvent } from 'react';
import type { ApiClient } from '../../api';
import { Icon } from '../../components/Icon';
import { navigate } from '../../hooks';
import { useT } from '../../i18n';
import { useRights } from '../../Shell';
import { skillHref } from './SkillBlockPage';
import '../skills.css';

export const SkillCreateActions = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const canManage = useRights().has('manage-services');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  if (!canManage) return null;

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setFailed('');
    try {
      const created = await api.skills.create(tenant);
      navigate(skillHref(created.id).slice(1));
    } catch {
      setFailed(t('skills.createFailed'));
      setBusy(false);
    }
  };

  const importPackage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFailed('');
    try {
      const imported = await api.skills.importPackage(tenant, file);
      navigate(skillHref(imported.id).slice(1));
    } catch {
      setFailed(t('skills.importFailed', { file: file.name }));
    }
  };

  return (
    <div className="skill-create">
      <div className="actions">
        <label className="ds-button file-button" data-variant="secondary">
          <input type="file" accept=".zip,.skill" onChange={(e) => void importPackage(e)} />
          <Icon icon={UploadIcon} />
          {t('skills.importPackage')}
        </label>
        <Button variant="primary" aria-disabled={busy || undefined} onClick={() => void create()}>
          <Icon icon={PlusIcon} />
          {t('skills.newSkill')}
        </Button>
      </div>
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
    </div>
  );
};
