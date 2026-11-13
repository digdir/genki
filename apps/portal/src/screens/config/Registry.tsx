import {
  Alert,
  Button,
  Checkbox,
  Heading,
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
import { useRef, useState, type ReactNode } from 'react';
import { ApiError, type ApiClient, type ConfigEntry } from '../../api';
import { useAsync } from '../../hooks';
import { useT, type T } from '../../i18n';
import { EmptyState, ErrorState, Loading } from '../../states';
import './registry.css';
import { minimumReasonLength } from '../../components/ReasonField';

const TableRegion = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
    {children}
  </div>
);

const Flash = ({ message }: { message: { text: string } | undefined }) => (
  <div aria-live="polite">
    {message ? (
      <Alert data-color="success" data-size="sm">
        {message.text}
      </Alert>
    ) : null}
  </div>
);

const useFlash = () => {
  const [message, setMessage] = useState<{ text: string }>();
  return {
    message,
    show: (text: string) => setMessage({ text }),
    clear: () => setMessage(undefined),
  };
};

export interface RegistryPaths {
  list: string;
  item: (id: string) => string;
  history: (id: string) => string;
  create?: string;
}

interface Props {
  api: ApiClient;
  scope: string;
  label: string;
  paths: RegistryPaths;
  template: Record<string, unknown>;
  mandatory?: boolean;
  describe?: (entry: ConfigEntry) => string;
  detail?: (entry: ConfigEntry) => ReactNode;
  filter?: (entry: ConfigEntry) => boolean;
  canCreate?: boolean;
  headingLevel?: 2 | 3 | 4;
}

const who = (t: T, actor?: string) =>
  actor
    ? actor.startsWith('operator:')
      ? t('config.actorOperator')
      : t('config.actorEmployee')
    : '–';

const reasonProblem = (t: T, reason: string) =>
  reason.trim().length < minimumReasonLength
    ? t('config.reasonShort', { min: minimumReasonLength })
    : undefined;

const localId = (entry: ConfigEntry) =>
  entry.scope && entry.scope !== 'platform' && entry.id.startsWith(`${entry.scope}/`)
    ? entry.id.slice(entry.scope.length + 1)
    : entry.id;

const editableIn = (entry: ConfigEntry, scope: string) => entry.editable ?? entry.scope === scope;

const problemText = (t: T, error: unknown) => {
  const errors = error instanceof ApiError ? error.problem?.errors : undefined;
  return errors?.length
    ? errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('. ')
    : t('config.noResponse');
};

const History = ({ api, path }: { api: ApiClient; path: string }) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.configHistory(path, signal), [api, path]);
  if (state.status === 'loading') return <Loading label={t('config.historyLoading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (state.data.length === 0)
    return <Paragraph data-size="sm">{t('config.historyEmpty')}</Paragraph>;
  return (
    <ol className="plain-list config-history">
      {[...state.data].reverse().map((v) => (
        <li key={v.version}>
          <span className="label-strong">{t('config.versionN', { version: v.version })}</span>
          {v.deleted ? (
            <Tag data-size="sm" data-color="danger">
              {t('config.deleted')}
            </Tag>
          ) : null}{' '}
          <span className="meta">
            {f.dateTime(v.at)} · {who(t, v.by)}
            {v.reason ? ` · ${v.reason}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
};

const Editor = ({
  api,
  paths,
  entry,
  template,
  mandatory,
  detail,
  onSaved,
  onCancel,
  readOnly = false,
}: {
  api: ApiClient;
  paths: RegistryPaths;
  entry: ConfigEntry | undefined;
  template: Record<string, unknown>;
  mandatory: boolean;
  detail?: ((entry: ConfigEntry) => ReactNode) | undefined;
  onSaved: (message: string) => void;
  onCancel: () => void;
  readOnly?: boolean;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [id, setId] = useState('');
  const [text, setText] = useState(JSON.stringify(entry?.spec ?? template, null, 2));
  const [required, setRequired] = useState(entry?.mandatory ?? false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = entry ? localId(entry) : id.trim();

  const save = async () => {
    const next: Record<string, string> = {};
    let spec: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      spec = parsed as Record<string, unknown>;
    } catch {
      next.spec = t('config.specInvalid');
    }
    if (!entry && !/^[a-z0-9][a-z0-9._/-]*$/.test(target)) next.id = t('config.idInvalid');
    const reasonError = reasonProblem(t, reason);
    if (reasonError) next.reason = reasonError;
    setErrors(next);
    if (Object.keys(next).length || !spec) return;
    setBusy(true);
    setFailed(undefined);
    setConflict(false);
    try {
      const body = mandatory ? { ...spec, mandatory: required } : spec;
      if (!entry && paths.create)
        await api.configSave(paths.create, { ...body, id: target }, { reason, method: 'POST' });
      else
        await api.configSave(paths.item(target), body, {
          reason,
          ifVersion: entry?.version,
        });
      onSaved(tRef.current('config.savedMessage', { id: target }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      else setFailed(problemText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    const reasonError = reasonProblem(t, reason);
    if (reasonError) {
      setErrors({ reason: reasonError });
      return;
    }
    setBusy(true);
    setFailed(undefined);
    try {
      await api.configDelete(paths.item(target), reason);
      onSaved(tRef.current('config.deletedMessage', { id: target }));
    } catch (error) {
      setFailed(problemText(tRef.current, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="config-editor stack" aria-labelledby="config-editor-h">
      <Heading level={3} data-size="xs" id="config-editor-h">
        {entry ? t('config.editTitle', { id: target }) : t('config.newTitle')}
      </Heading>
      {entry ? (
        <Paragraph data-size="sm" className="meta">
          {t('config.versionN', { version: entry.version })}
          {entry.scope
            ? ` · ${entry.scope === 'platform' ? t('config.platform') : entry.scope}`
            : ''}
          {entry.origin === 'seed' ? ` · ${t('config.fromConfigFile')}` : ''}
        </Paragraph>
      ) : (
        <Textfield
          label={t('config.idLabel')}
          value={id}
          onChange={(e) => setId(e.target.value)}
          error={errors.id}
        />
      )}
      <Textfield
        label={t('config.specLabel')}
        multiline
        rows={14}
        className="config-json"
        value={text}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        error={errors.spec}
      />
      {readOnly ? <Paragraph data-size="sm">{t('config.platformOwned')}</Paragraph> : null}
      {mandatory && !readOnly ? (
        <Checkbox
          label={t('config.requiredLabel')}
          description={t('config.requiredHelp')}
          checked={required}
          onChange={() => setRequired((v) => !v)}
        />
      ) : null}
      {readOnly ? null : (
        <Textfield
          label={t('config.reasonLabel')}
          description={t('config.reasonHelp')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
      )}
      {conflict ? (
        <Alert data-color="warning" data-size="sm" role="alert">
          {t('config.conflict')}
        </Alert>
      ) : null}
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}
      <div className="row-wrap">
        {readOnly ? null : (
          <Button data-size="sm" loading={busy} onClick={() => !busy && void save()}>
            {entry ? t('config.saveVersion') : t('config.create')}
          </Button>
        )}
        {entry && !entry.builtin && !readOnly ? (
          <Button
            variant="tertiary"
            data-color="danger"
            data-size="sm"
            onClick={() => !busy && void remove()}
          >
            {t('config.remove')}
          </Button>
        ) : null}
        <Button variant="secondary" data-size="sm" onClick={onCancel}>
          {t('config.close')}
        </Button>
      </div>
      {entry && detail ? detail(entry) : null}
      {entry && !readOnly ? (
        <div className="stack-sm">
          <Heading level={4} data-size="2xs">
            {t('config.versions')}
          </Heading>
          <History api={api} path={paths.history(target)} />
        </div>
      ) : null}
    </section>
  );
};

export const Registry = ({
  api,
  scope,
  label,
  paths,
  template,
  mandatory = false,
  describe,
  detail,
  filter,
  canCreate = true,
  headingLevel = 2,
}: Props) => {
  const t = useT();
  const f = useFormat();
  const [round, setRound] = useState(0);
  const [state, retry] = useAsync(
    (signal) => api.configList(paths.list, signal),
    [api, paths.list, round],
  );
  const [open, setOpen] = useState<string | 'new'>();
  const flash = useFlash();
  if (state.status === 'loading')
    return <Loading label={t('config.registryLoading', { label: label.toLowerCase() })} />;
  if (state.status === 'error')
    return <ErrorState error={state.error} onRetry={retry} headingLevel={headingLevel} />;
  const rows = state.data.data.filter(filter ?? (() => true));
  const selected = rows.find((r) => `${r.scope ?? ''}/${r.id}` === open);
  return (
    <div className="stack">
      <Flash message={flash.message} />
      <div className="row-between">
        <span className="meta">{t('config.entryCount', { count: rows.length })}</span>
        {canCreate ? (
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => {
              flash.clear();
              setOpen('new');
            }}
          >
            {t('config.newEntry')}
          </Button>
        ) : null}
      </div>
      {open === 'new' ? (
        <Editor
          api={api}
          paths={paths}
          entry={undefined}
          template={template}
          mandatory={mandatory}
          onCancel={() => setOpen(undefined)}
          onSaved={(message) => {
            flash.show(message);
            setOpen(undefined);
            setRound((r) => r + 1);
          }}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title={t('config.registryEmpty', { label: label.toLowerCase() })}
          headingLevel={headingLevel}
        />
      ) : (
        <TableRegion label={label}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('config.colId')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('config.colScope')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('config.colVersion')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('config.colChanged')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <span className="visually-hidden">{t('config.colActions')}</span>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.scope ?? ''}/${r.id}`}>
                  <TableHeaderCell scope="row" className="row-head">
                    <span className="two-line">
                      <span>
                        {r.id}{' '}
                        {r.mandatory ? (
                          <Tag data-size="sm" data-color="warning">
                            {t('config.mandatory')}
                          </Tag>
                        ) : null}
                        {r.builtin ? (
                          <Tag data-size="sm" data-color="neutral">
                            {t('config.builtin')}
                          </Tag>
                        ) : null}
                      </span>
                      {describe ? <span className="meta">{describe(r)}</span> : null}
                    </span>
                  </TableHeaderCell>
                  <TableCell>
                    {editableIn(r, scope) ? t('config.scopeYours') : t('config.scopePlatform')}
                  </TableCell>
                  <TableCell>{r.version}</TableCell>
                  <TableCell className="sm">
                    {r.at ? `${f.dateTime(r.at)} · ${who(t, r.by)}` : t('config.fromFile')}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      onClick={() => {
                        flash.clear();
                        setOpen(`${r.scope ?? ''}/${r.id}`);
                      }}
                    >
                      {t('config.open')}
                      <span className="visually-hidden"> {r.id}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      {selected ? (
        <Editor
          key={`${selected.id}@${selected.version}`}
          api={api}
          paths={paths}
          entry={selected}
          template={template}
          mandatory={mandatory}
          detail={detail}
          readOnly={!editableIn(selected, scope)}
          onCancel={() => setOpen(undefined)}
          onSaved={(message) => {
            flash.show(message);
            setOpen(undefined);
            setRound((r) => r + 1);
          }}
        />
      ) : null}
    </div>
  );
};
