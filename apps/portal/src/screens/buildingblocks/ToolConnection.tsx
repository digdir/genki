import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  Heading,
  Paragraph,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useState } from 'react';
import { ApiError, type ApiClient } from '../../api';
import type { ToolConnectionDetail, ToolConnectionView, ToolDetail } from '../../api/blocks';
import type { CatalogItem } from '../../api/building-blocks';
import { reasonProblem } from '../../components/ReasonField';
import { useT } from '../../i18n';
import { refusalOf } from '../../states';

export const approvalChanges = (tools: ToolDetail[], approved: Record<string, boolean>) =>
  tools
    .filter((tool) => (tool.state === 'approved') !== (approved[tool.name] ?? false))
    .map((tool) => ({ tool: tool.name, approve: approved[tool.name] ?? false }));

const initialApproved = (tools: ToolDetail[]) =>
  Object.fromEntries(tools.map((tool) => [tool.name, tool.state === 'approved']));

export const SyncButton = ({
  api,
  tenant,
  connection,
  onSynced,
}: {
  api: ApiClient;
  tenant: string;
  connection: Pick<ToolConnectionDetail, 'id' | 'name'>;
  onSynced: (message: { ok: boolean; text: string }) => void;
}) => {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const result = await api.blocks.sync(tenant, connection.id, t('blockTool.syncReason'));
      onSynced({
        ok: true,
        text: t('blockTool.synced', { active: result.active, pending: result.pending.length }),
      });
    } catch (error) {
      onSynced({ ok: false, text: refusalOf(error, t) ?? t('blockTool.syncFailed') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" aria-busy={busy} onClick={() => void run()}>
      {busy ? t('blockTool.syncing') : t('blockTool.syncNow')}
    </Button>
  );
};

export const ToolConnectionSections = ({
  api,
  tenant,
  item,
  connection,
  canChange,
  syncMessage,
  onSaved,
}: {
  api: ApiClient;
  tenant: string;
  item: CatalogItem;
  connection: ToolConnectionView | undefined;
  canChange: boolean;
  syncMessage: { ok: boolean; text: string } | null;
  onSaved: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const ids = { connection: useId(), tools: useId() };
  const details = connection?.toolDetails;
  const [approved, setApproved] = useState(() => initialApproved(details ?? []));
  const [why, setWhy] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState('');
  const known = JSON.stringify(details ?? []);
  useEffect(() => {
    setApproved(initialApproved(details ?? []));
  }, [known]);
  const changes = details ? approvalChanges(details, approved) : [];
  const dirty = changes.length > 0;
  const endpoint =
    connection?.endpoint ?? (/^https?:\/\//.test(item.description) ? item.description : '');
  const approvedCount = details?.filter((d) => approved[d.name]).length ?? 0;

  const save = async () => {
    setTried(true);
    if (reasonProblem(why, t)) return;
    if (!connection) return;
    setBusy(true);
    setProblem('');
    let current = '';
    try {
      for (const change of changes) {
        current = change.tool;
        await (change.approve
          ? api.blocks.approveTool(tenant, connection.id, change.tool, why)
          : api.blocks.revokeTool(tenant, connection.id, change.tool, why));
      }
      setSaved(t('blockTool.saved', { time: f.time(new Date().toISOString()) }));
      setWhy('');
      setTried(false);
      onSaved();
    } catch (error) {
      const moved =
        error instanceof ApiError && error.problem?.type === 'urn:genai:problem:tool-not-found';
      setProblem(
        moved
          ? t('blockTool.toolMoved', { name: current })
          : (refusalOf(error, t) ?? t('blocks.saveFailed')),
      );
      if (moved) onSaved();
    } finally {
      setBusy(false);
    }
  };

  const lastSync = connection?.lastSync;
  return (
    <>
      <section aria-labelledby={ids.connection} className="stack-sm">
        <Heading level={2} data-size="xs" id={ids.connection}>
          {t('blocks.connection')}
        </Heading>
        <dl className="kv bb-kv">
          {endpoint ? (
            <div className="bb-kv-row">
              <dt>{t('blocks.address')}</dt>
              <dd>{endpoint}</dd>
            </div>
          ) : null}
          {connection?.connectedAt ? (
            <div className="bb-kv-row">
              <dt>{t('blockTool.connected')}</dt>
              <dd>
                {connection.connectedByName
                  ? t('blockTool.connectedBy', {
                      date: f.date(connection.connectedAt),
                      name: connection.connectedByName,
                    })
                  : f.date(connection.connectedAt)}
              </dd>
            </div>
          ) : null}
          <div className="bb-kv-row">
            <dt>{t('blockTool.lastSync')}</dt>
            <dd>
              {lastSync
                ? lastSync.ok
                  ? f.dateTime(lastSync.at)
                  : t('blockTool.lastSyncFailed', { at: f.dateTime(lastSync.at) })
                : t('blockTool.neverSynced')}
            </dd>
          </div>
          {item.dataLocation ? null : (
            <div className="bb-kv-row">
              <dt>{t('blocks.whereProcessed')}</dt>
              <dd>{t('blockTool.ownServers')}</dd>
            </div>
          )}
        </dl>
        <div aria-live="polite">
          {syncMessage ? (
            <Alert data-color={syncMessage.ok ? 'success' : 'danger'} data-size="sm">
              {syncMessage.text}
            </Alert>
          ) : null}
        </div>
      </section>

      <section aria-labelledby={ids.tools} className="stack-sm">
        <div className="bb-title">
          <Heading level={2} data-size="xs" id={ids.tools}>
            {t('blocks.toolsOffered')}
          </Heading>
          {details ? (
            <span className="bb-meta">
              {t('blockTool.approvedCount', { approved: approvedCount, total: details.length })}
            </span>
          ) : null}
        </div>
        <Paragraph className="bb-measure">{t('blockTool.approvalNote')}</Paragraph>
        {details && details.length === 0 ? (
          <div className="bb-empty stack-xs">
            <strong>{t('blockTool.noToolsTitle', { name: item.name })}</strong>
            <Paragraph data-size="sm">{t('blockTool.noToolsBody')}</Paragraph>
          </div>
        ) : details ? (
          <Fieldset>
            <Fieldset.Legend>{t('blockTool.approvedLegend')}</Fieldset.Legend>
            <ul className="bb-list bb-tools">
              {details.map((tool) => (
                <li key={tool.name}>
                  <Checkbox
                    label={
                      <span className="bb-row-head">
                        <strong>{tool.name}</strong>
                        {tool.changes ? (
                          <Tag data-size="sm" data-color="warning">
                            {t('blockTool.changesData')}
                          </Tag>
                        ) : null}
                        {tool.state === 'pending' && tool.since ? (
                          <Tag data-size="sm" data-color="info">
                            {t('blockTool.newSince', { date: f.date(tool.since) })}
                          </Tag>
                        ) : null}
                      </span>
                    }
                    description={tool.description}
                    checked={approved[tool.name] ?? false}
                    disabled={!canChange || (tool.state === 'approved' && !connection?.canRevoke)}
                    onChange={(e) =>
                      setApproved((current) => ({ ...current, [tool.name]: e.target.checked }))
                    }
                  />
                </li>
              ))}
            </ul>
            {canChange && !connection?.canRevoke ? (
              <Paragraph data-size="sm" className="bb-meta">
                {t('blockTool.revokeLater')}
              </Paragraph>
            ) : null}
          </Fieldset>
        ) : (
          <ul className="bb-list bb-tools">
            {(connection?.tools ?? item.capabilities).map((c) => {
              const at = c.indexOf(': ');
              return (
                <li key={c}>
                  <strong>{at < 0 ? c : c.slice(0, at)}</strong>
                  {at < 0 ? null : <span className="bb-meta">{c.slice(at + 2)}</span>}
                </li>
              );
            })}
          </ul>
        )}
        <div aria-live="polite">
          {saved && !dirty ? (
            <p role="status" className="bb-meta">
              {saved}
            </p>
          ) : null}
          {problem && !dirty ? (
            <Alert data-color="danger" data-size="sm">
              {problem}
            </Alert>
          ) : null}
        </div>
      </section>

      {dirty ? (
        <div
          role="region"
          aria-label={t('blockTool.unsavedRegion')}
          className="bb-unsaved stack-sm"
        >
          <div className="bb-title">
            <strong>{t('blockTool.unsaved')}</strong>
            <div className="actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setApproved(initialApproved(details ?? []));
                  setWhy('');
                  setTried(false);
                }}
              >
                {t('blockPages.discard')}
              </Button>
              <Button variant="primary" aria-busy={busy} onClick={() => void save()}>
                {busy ? t('blockTool.saving') : t('blockTool.save')}
              </Button>
            </div>
          </div>
          <Textfield
            label={t('blockTool.why')}
            value={why}
            error={tried ? reasonProblem(why, t) : undefined}
            onChange={(e) => setWhy(e.target.value)}
          />
          {problem ? (
            <Alert data-color="danger" data-size="sm" role="alert">
              {problem}
            </Alert>
          ) : null}
        </div>
      ) : null}
    </>
  );
};
