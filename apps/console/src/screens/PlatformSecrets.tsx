import {
  Button,
  Link,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { PlatformSecret } from '../types';
import { DialogError, Flash, PageHeader, ReasonDialog, TableRegion, useFlash } from '../ui';
import { modelsHref } from './models/area-data';

const namePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const maxValueLength = 16_384;

type Editing = { kind: 'new' } | { kind: 'existing'; secret: PlatformSecret };

const problemText = (error: unknown, fallback: string) => {
  if (!(error instanceof ApiError)) return fallback;
  const details = (error.problem?.errors ?? []).map((e) => e.message).join('. ');
  return [error.problem?.title, details].filter(Boolean).join(': ') || fallback;
};

export const PlatformSecrets = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.platformSecrets(signal), [api]);
  const flash = useFlash();
  const [editing, setEditing] = useState<Editing | undefined>();
  const [deleting, setDeleting] = useState<PlatformSecret | undefined>();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  const open = (next: Editing) => {
    flash.clear();
    setName(next.kind === 'existing' ? next.secret.name : '');
    setValue('');
    setEditing(next);
  };
  const close = () => {
    setEditing(undefined);
    setValue('');
  };
  const save = async (reason: string) => {
    const target = name.trim();
    if (editing?.kind === 'new') {
      if (!namePattern.test(target)) throw new DialogError(t('platformSecrets.nameInvalid'));
      if (state.status === 'ready' && state.data.some((s) => s.name === target && s.set))
        throw new DialogError(t('platformSecrets.nameTaken'));
    }
    if (!value.trim()) throw new DialogError(t('platformSecrets.valueMissing'));
    if (value.length > maxValueLength)
      throw new DialogError(t('platformSecrets.valueTooLong', { max: maxValueLength }));
    try {
      await api.saveSecret(target, value, reason);
    } catch (error) {
      throw new DialogError(problemText(error, t('platformSecrets.saveFailed')));
    }
    setValue('');
    flash.show(t('platformSecrets.saved', { name: target }));
    retry();
  };

  const remove = async (reason: string) => {
    if (!deleting) return;
    try {
      await api.deleteSecret(deleting.name, reason);
    } catch (error) {
      throw new DialogError(problemText(error, t('platformSecrets.deleteFailed')));
    }
    flash.show(t('platformSecrets.deleted', { name: deleting.name }));
    retry();
  };

  const title =
    editing?.kind === 'existing'
      ? t(editing.secret.set ? 'platformSecrets.replaceTitle' : 'platformSecrets.setTitle', {
          name: editing.secret.name,
        })
      : t('platformSecrets.addTitle');

  return (
    <>
      <PageHeader
        eyebrow={t('shell.groupPlatform')}
        title={t('platformSecrets.title')}
        intro={t('platformSecrets.intro')}
      />
      <Flash message={flash.message} />
      <div className="actions-row">
        <Button data-size="sm" onClick={() => open({ kind: 'new' })}>
          {t('platformSecrets.add')}
        </Button>
      </div>
      {state.status === 'loading' ? (
        <Loading label={t('platformSecrets.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <EmptyState title={t('platformSecrets.noneTitle')}>
          <Paragraph>{t('platformSecrets.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        <TableRegion label={t('platformSecrets.tableLabel')}>
          <Table data-size="sm">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('platformSecrets.colName')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('platformSecrets.colStatus')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('platformSecrets.colChanged')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('platformSecrets.colUsedBy')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('platformSecrets.colAction')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.data.map((secret) => (
                <TableRow key={secret.name}>
                  <TableCell>
                    <code>{secret.name}</code>
                  </TableCell>
                  <TableCell>
                    <Tag data-size="sm" data-color={secret.set ? 'success' : 'warning'}>
                      {t(secret.set ? 'platformSecrets.isSet' : 'platformSecrets.notSet')}
                    </Tag>
                  </TableCell>
                  <TableCell>
                    {secret.changedAt
                      ? f.dateTime(new Date(secret.changedAt), 'medium')
                      : t('platformSecrets.never')}
                  </TableCell>
                  <TableCell>
                    {secret.usedBy.length === 0
                      ? t('platformSecrets.unused')
                      : secret.usedBy.map((user, index) => (
                          <span key={`${user.kind}/${user.id}`}>
                            {index > 0 ? ', ' : null}
                            {user.kind === 'model-endpoint' ? (
                              <Link href={modelsHref({ connection: user.id })}>
                                {t('platformSecrets.connection', { id: user.id })}
                              </Link>
                            ) : (
                              `${user.kind} ${user.id}`
                            )}
                          </span>
                        ))}
                  </TableCell>
                  <TableCell>
                    <Button
                      data-size="sm"
                      variant="secondary"
                      aria-label={t(
                        secret.set ? 'platformSecrets.replaceLabel' : 'platformSecrets.setLabel',
                        { name: secret.name },
                      )}
                      onClick={() => open({ kind: 'existing', secret })}
                    >
                      {t(secret.set ? 'platformSecrets.replace' : 'platformSecrets.set')}
                    </Button>
                    {secret.set && secret.usedBy.length === 0 ? (
                      <Button
                        data-size="sm"
                        variant="tertiary"
                        data-color="danger"
                        aria-label={t('platformSecrets.deleteLabel', { name: secret.name })}
                        onClick={() => {
                          flash.clear();
                          setDeleting(secret);
                        }}
                      >
                        {t('platformSecrets.delete')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      <ReasonDialog
        open={deleting !== undefined}
        title={deleting ? t('platformSecrets.deleteTitle', { name: deleting.name }) : ''}
        text={t('platformSecrets.deleteText')}
        confirmLabel={t('platformSecrets.delete')}
        onClose={() => setDeleting(undefined)}
        onConfirm={remove}
      />
      <ReasonDialog
        open={editing !== undefined}
        title={title}
        text={t('platformSecrets.dialogText')}
        confirmLabel={t('platformSecrets.save')}
        onClose={close}
        onConfirm={save}
      >
        {editing?.kind === 'new' ? (
          <Textfield
            label={t('platformSecrets.name')}
            description={t('platformSecrets.nameDescription')}
            value={name}
            maxLength={63}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        <Textfield
          label={t('platformSecrets.value')}
          description={t('platformSecrets.valueDescription')}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </ReasonDialog>
    </>
  );
};
