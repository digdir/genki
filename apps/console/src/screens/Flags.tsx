import {
  Button,
  Fieldset,
  Heading,
  Paragraph,
  Radio,
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
import { useId, useState } from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import type { FlagChange, OperatorFlag } from '../types';
import { DialogError, Flash, PageHeader, ReasonDialog, TableRegion, useFlash } from '../ui';

type Choice = 'on' | 'off' | 'clear';

const orgPattern = /^\d{9}$/;

const failedText = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.problem?.title ? error.problem.title : fallback;

const pastRemoveBy = (removeBy: string, now: Date) =>
  new Date(`${removeBy}T23:59:59Z`).getTime() < now.getTime();

export const Flags = ({ api, now = () => new Date() }: { api: ApiClient; now?: () => Date }) => {
  const t = useT();
  const f = useFormat();
  const choiceName = useId();
  const [state, retry] = useAsync((signal) => api.flags(signal), [api]);
  const flash = useFlash();
  const [editing, setEditing] = useState<OperatorFlag | undefined>();
  const [clearing, setClearing] = useState<
    { flag: OperatorFlag; row: OperatorFlag['rows'][number] } | undefined
  >();
  const [tenant, setTenant] = useState('');
  const [issuer, setIssuer] = useState('');
  const [subject, setSubject] = useState('');
  const [choice, setChoice] = useState<Choice>('on');

  const open = (flag: OperatorFlag) => {
    flash.clear();
    setTenant('');
    setIssuer('');
    setSubject('');
    setChoice('on');
    setEditing(flag);
  };

  const send = async (key: string, change: FlagChange, reason: string) => {
    try {
      await api.setFlag(key, change, reason);
    } catch (error) {
      throw new DialogError(failedText(error, t('flags.saveFailed')));
    }
    flash.show(t('flags.saved', { key }));
    retry();
  };

  const save = async (reason: string) => {
    if (!editing) return;
    if (!orgPattern.test(tenant.trim())) throw new DialogError(t('flags.tenantInvalid'));
    if (Boolean(issuer.trim()) !== Boolean(subject.trim()))
      throw new DialogError(t('flags.personIncomplete'));
    await send(
      editing.key,
      {
        tenant: tenant.trim(),
        ...(issuer.trim() ? { person: { issuer: issuer.trim(), subject: subject.trim() } } : {}),
        on: choice === 'clear' ? null : choice === 'on',
      },
      reason,
    );
  };

  const clear = async (reason: string) => {
    if (!clearing) return;
    await send(
      clearing.flag.key,
      {
        tenant: clearing.row.tenant,
        ...(clearing.row.person ? { person: clearing.row.person } : {}),
        on: null,
      },
      reason,
    );
  };

  const whereOf = (row: OperatorFlag['rows'][number]) => {
    const organisation = row.tenantName ? `${row.tenantName} (${row.tenant})` : row.tenant;
    if (!row.person) return organisation;
    return t('flags.personIn', {
      person: row.personName ?? `${row.person.issuer}:${row.person.subject}`,
      organisation,
    });
  };

  return (
    <>
      <PageHeader
        eyebrow={t('shell.groupPlatform')}
        title={t('flags.title')}
        intro={t('flags.intro')}
      />
      <Flash message={flash.message} />
      {state.status === 'loading' ? (
        <Loading label={t('flags.loading')} />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} onRetry={retry} />
      ) : state.data.length === 0 ? (
        <EmptyState title={t('flags.noneTitle')}>
          <Paragraph>{t('flags.noneText')}</Paragraph>
        </EmptyState>
      ) : (
        state.data.map((flag) => (
          <section key={flag.key} className="stack-sm" aria-labelledby={`flag-${flag.key}`}>
            <div className="actions-row">
              <Heading level={2} data-size="xs" id={`flag-${flag.key}`}>
                <code>{flag.key}</code>
              </Heading>
              <Tag data-size="sm" data-color={flag.selfService ? 'info' : 'neutral'}>
                {t(flag.selfService ? 'flags.selfService' : 'flags.operatorOnly')}
              </Tag>
              {pastRemoveBy(flag.removeBy, now()) ? (
                <Tag data-size="sm" data-color="danger">
                  {t('flags.overdue')}
                </Tag>
              ) : null}
            </div>
            <Paragraph data-size="sm" lang="en">
              {flag.description}
            </Paragraph>
            <Paragraph data-size="sm" className="meta">
              {t('flags.facts', {
                owner: flag.owner,
                removeBy: f.date(new Date(`${flag.removeBy}T12:00:00Z`), 'medium'),
              })}
            </Paragraph>
            <div className="actions-row">
              <Button data-size="sm" variant="secondary" onClick={() => open(flag)}>
                {t('flags.switch')}
              </Button>
            </div>
            {flag.rows.length === 0 ? (
              <Paragraph data-size="sm">{t('flags.offEverywhere')}</Paragraph>
            ) : (
              <TableRegion label={t('flags.tableLabel', { key: flag.key })}>
                <Table data-size="sm">
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">{t('flags.colWhere')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('flags.colState')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('flags.colBy')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('flags.colReason')}</TableHeaderCell>
                      <TableHeaderCell scope="col">{t('flags.colAction')}</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {flag.rows.map((row) => (
                      <TableRow
                        key={`${row.tenant}/${row.person?.issuer ?? ''}/${row.person?.subject ?? ''}`}
                      >
                        <TableCell>{whereOf(row)}</TableCell>
                        <TableCell>
                          <Tag data-size="sm" data-color={row.on ? 'success' : 'neutral'}>
                            {t(row.on ? 'flags.on' : 'flags.off')}
                          </Tag>
                        </TableCell>
                        <TableCell>
                          {t('flags.byAt', {
                            by: row.byName ?? row.by,
                            at: f.dateTime(new Date(row.at), 'medium'),
                          })}
                        </TableCell>
                        <TableCell>{row.reason}</TableCell>
                        <TableCell>
                          <Button
                            data-size="sm"
                            variant="tertiary"
                            aria-label={t('flags.clearLabel', { where: whereOf(row) })}
                            onClick={() => {
                              flash.clear();
                              setClearing({ flag, row });
                            }}
                          >
                            {t('flags.clear')}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableRegion>
            )}
          </section>
        ))
      )}
      <ReasonDialog
        open={editing !== undefined}
        title={editing ? t('flags.switchTitle', { key: editing.key }) : ''}
        text={t('flags.switchText')}
        confirmLabel={t('flags.save')}
        onClose={() => setEditing(undefined)}
        onConfirm={save}
      >
        <Textfield
          label={t('flags.tenant')}
          value={tenant}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => setTenant(e.target.value)}
        />
        <Textfield
          label={t('flags.issuer')}
          description={t('flags.personDescription')}
          value={issuer}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setIssuer(e.target.value)}
        />
        <Textfield
          label={t('flags.subject')}
          value={subject}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSubject(e.target.value)}
        />
        <Fieldset data-size="sm">
          <Fieldset.Legend>{t('flags.choice')}</Fieldset.Legend>
          {(['on', 'off', 'clear'] as const).map((c) => (
            <Radio
              key={c}
              name={choiceName}
              value={c}
              label={t(c === 'on' ? 'flags.turnOn' : c === 'off' ? 'flags.turnOff' : 'flags.clear')}
              checked={choice === c}
              onChange={() => setChoice(c)}
            />
          ))}
        </Fieldset>
      </ReasonDialog>
      <ReasonDialog
        open={clearing !== undefined}
        title={clearing ? t('flags.clearTitle', { key: clearing.flag.key }) : ''}
        text={clearing ? t('flags.clearText', { where: whereOf(clearing.row) }) : ''}
        confirmLabel={t('flags.clear')}
        onClose={() => setClearing(undefined)}
        onConfirm={clear}
      />
    </>
  );
};
