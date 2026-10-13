import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useState, type ChangeEvent } from 'react';
import { useT } from '../../i18n';
import { ApiCallLink } from '../../components/ApiCall';
import { Crumbs } from '../../components/Crumbs';
import { Icon, icons } from '../../components/Icon';
import { publisherName, statusLabel } from '../../data/skills';
import { navigate, useAsync } from '../../hooks';
import type { ScreenProps } from '../../screen';
import { useRights } from '../../Shell';
import { EmptyState, ErrorState, Loading } from '../../states';

const uploadIcon = 'M12 15V4M8 8l4-4 4 4M5 15v4h14v-4';

export const SkillList = ({
  api,
  tenant,
  tenantName,
  notify,
}: ScreenProps & { notify: (text: string, at: string | null) => void }) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.skills.list(tenant, signal), [api, tenant]);
  const canManage = useRights().has('manage-services');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await api.skills.create(tenant);
      navigate(`/skills?id=${encodeURIComponent(created.id)}`);
    } catch {
      setFailed(t('skills.createFailed'));
      setBusy(false);
    }
  };

  const importPackage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = await api.skills.importPackage(tenant, file);
      notify(t('skills.importDone', { file: file.name }), imported.id);
      navigate(`/skills?id=${encodeURIComponent(imported.id)}`);
    } catch {
      setFailed(t('skills.importFailed', { file: file.name }));
    }
  };

  return (
    <div className="stack">
      <Crumbs
        items={[
          { label: t('skills.crumbBlocks'), href: '#/building-blocks' },
          { label: t('skills.title') },
        ]}
      />
      <div className="skills-head">
        <div className="skills-intro">
          <Heading level={1} data-size="md">
            {t('skills.title')}
          </Heading>
          <p className="lead">{t('skills.lead')}</p>
        </div>
        <div className="actions">
          <ApiCallLink
            call={{
              action: t('skills.title'),
              method: 'GET',
              path: api.skills.skillsPath(tenant),
              right: t('skills.rightUse'),
            }}
          />
          {canManage ? (
            <>
              <label className="ds-button file-button" data-variant="secondary">
                <input type="file" accept=".zip,.skill" onChange={(e) => void importPackage(e)} />
                <Icon d={uploadIcon} />
                {t('skills.importPackage')}
              </label>
              <Button
                variant="primary"
                aria-disabled={busy || undefined}
                onClick={() => void create()}
              >
                <Icon d={icons.plus} />
                {t('skills.newSkill')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
      {state.status === 'loading' ? <Loading label={t('skills.loadingList')} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <EmptyState title={t('skills.emptyTitle')}>
          <Paragraph>
            {canManage
              ? t('skills.emptyManage')
              : t('skills.emptyReadOnly', { tenant: tenantName })}
          </Paragraph>
        </EmptyState>
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t('skills.title')}>
          <Table className="skills-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('skills.colSkill')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.colVersion')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.colPublisher')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.colUsedBy')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('skills.colStatus')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.data.map((s) => {
                const [label, color] = statusLabel(s);
                const ownDraft =
                  s.status === 'published' && s.publisher.type === 'own' && s.draftChanged;
                return (
                  <TableRow key={`${s.owner}/${s.id}`}>
                    <th scope="row" className="skills-name-cell">
                      <span className="skills-name">
                        <a
                          className="ds-link"
                          href={`#/skills?id=${encodeURIComponent(s.id)}${s.owner === tenant ? '' : `&owner=${encodeURIComponent(s.owner)}`}`}
                        >
                          {s.name || t('skills.newSkill')}
                        </a>
                        <span className="small subtle">
                          {s.description || t('skills.noDescription')}
                        </span>
                      </span>
                    </th>
                    <TableCell className="nowrap">{s.version ?? '–'}</TableCell>
                    <TableCell>{publisherName(s.publisher, tenantName)}</TableCell>
                    <TableCell>
                      {s.usedBy.length
                        ? s.usedBy.map((u) => u.name).join(', ')
                        : t('skills.noServices')}
                    </TableCell>
                    <TableCell>
                      <span className="tag-row">
                        <Tag data-size="sm" data-color={color}>
                          {t(label)}
                        </Tag>
                        {ownDraft ? (
                          <Tag data-size="sm" data-color="neutral">
                            {t('skills.draftOf', { version: s.draftVersion })}
                          </Tag>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
};
