import {
  Alert,
  Button,
  Heading,
  Link,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { navigate } from '../../hooks';
import { useT } from '../../i18n';
import { operationName } from '../../model-operations';
import { EmptyState } from '../../states';
import { useTenantNames } from '../../tenant-names';
import { DialogError, inUseOf, InUseList, ReasonDialog, TableRegion, type InUse } from '../../ui';
import { connectionSpec, modelsHref, modelsInUse, recordStatus, type AreaProps } from './area-data';
import { RecordTag } from './ConnectionList';
import { EndpointForm } from './Endpoints';
import { ProcessorRecordForm } from './ProcessorRecord';

export const Crumbs = ({ trail }: { trail: { label: string; href?: string }[] }) => {
  const t = useT();
  return (
    <nav aria-label={t('models.crumbs')} className="crumbs">
      <a href={modelsHref()}>{t('models.title')}</a>
      {trail.map((c) => (
        <span key={c.label} className="crumbs">
          <span aria-hidden="true">/</span>
          {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
};

export const ConnectionDetail = ({ api, data, done, id }: AreaProps & { id: string }) => {
  const t = useT();
  const tenantName = useTenantNames(api);
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [inUse, setInUse] = useState<InUse[] | undefined>();
  const entry = data.connections?.find((c) => c.id === id);
  const crumbs = (
    <Crumbs
      trail={[
        { label: t('models.tabConnections'), href: modelsHref({ tab: 'connections' }) },
        { label: id },
      ]}
    />
  );
  if (!entry)
    return (
      <>
        {crumbs}
        <EmptyState title={t('connections.notFound', { id })}>
          <Link href={modelsHref({ tab: 'connections' })}>{t('connections.backToList')}</Link>
        </EmptyState>
      </>
    );
  const spec = connectionSpec(entry);
  const models = data.models.filter((m) => m.endpoint === id);
  const using = modelsInUse(id, data.models);
  const status = recordStatus(data.records, id);
  const record = data.records?.find((r) => r.endpoint === id)?.record;
  const apisIn = (family: string) => (data.apis ?? []).filter((a) => a.family === family);

  const remove = async (reason: string) => {
    try {
      await api.deleteModelEndpoint(id, reason);
    } catch (error) {
      const used = inUseOf(error, 'services');
      if (used) {
        setInUse(used);
        throw new DialogError(t('endpoints.stillInUse'));
      }
      throw error;
    }
    navigate('/models', { tab: 'connections' });
    done(t('connections.removed', { id }));
  };

  return (
    <>
      {crumbs}
      <div className="page-head-row">
        <div className="page-header">
          <span className="eyebrow">{t('connections.eyebrow')}</span>
          <Heading level={1} data-size="lg">
            {id}
          </Heading>
        </div>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          {t('connections.edit')}
        </Button>
      </div>
      {status === 'missing' ? (
        <Alert data-color="warning" data-size="sm">
          <strong>{t('connections.missingTitle', { id })}</strong> {t('connections.missingText')}
        </Alert>
      ) : null}
      <section className="card stack" aria-labelledby="connection-facts-h">
        <Heading level={2} data-size="xs" id="connection-facts-h">
          {t('connections.factsTitle')}
        </Heading>
        <dl className="def-list">
          <dt>{t('endpoints.name')}</dt>
          <dd>{id}</dd>
          <dt>{t('connections.address')}</dt>
          <dd>{spec.baseURL ?? '–'}</dd>
          <dt>{t('endpoints.login')}</dt>
          <dd>{spec.authKind === 'bearer' ? t('endpoints.bearer') : t('endpoints.apiKey')}</dd>
          <dt>{t('connections.key')}</dt>
          <dd>
            {spec.secret ?? t('endpoints.noSecret')}
            <br />
            <span className="meta">{t('connections.keyStored')}</span>
          </dd>
          <dt>{t('endpoints.settings')}</dt>
          <dd>
            {Object.keys(spec.settings).length === 0
              ? t('endpoints.noSettings')
              : Object.entries(spec.settings).map(([name, value]) => (
                  <div key={name}>
                    <code>{name}</code> = {value}
                  </div>
                ))}
          </dd>
          <dt>{t('endpoints.keys')}</dt>
          <dd>
            {Object.keys(spec.keys).length === 0
              ? t('endpoints.noKeys')
              : Object.entries(spec.keys).map(([name, secret]) => (
                  <div key={name}>
                    <code>{name}</code>: {secret}
                  </div>
                ))}
          </dd>
        </dl>
      </section>
      <section className="card stack" aria-labelledby="connection-record-h">
        <div className="card-head">
          <Heading level={2} data-size="xs" id="connection-record-h">
            {t('connections.recordTitle')}
          </Heading>
          <Button variant="secondary" data-size="sm" onClick={() => setRecording(true)}>
            {record ? t('connections.recordChange') : t('connections.recordAdd')}
          </Button>
        </div>
        <dl className="def-list">
          <dt>{t('connections.recordStatus')}</dt>
          <dd>
            <RecordTag status={status} />
          </dd>
          {record ? (
            <>
              <dt>{t('endpoints.processorAgreement')}</dt>
              <dd>{record.agreement}</dd>
              <dt>{t('connections.recordWhere')}</dt>
              <dd>
                {record.subProcessors.length
                  ? record.subProcessors.map((p) => `${p.name} (${p.location})`).join(', ')
                  : t('connections.recordNoSubProcessors')}
              </dd>
              <dt>{t('connections.recordRetention')}</dt>
              <dd>{t('connections.recordDays', { count: record.retention.days })}</dd>
            </>
          ) : (
            <>
              <dt>{t('connections.recordMeaning')}</dt>
              <dd>{t('endpoints.processorMissingHint')}</dd>
            </>
          )}
        </dl>
      </section>
      <section className="card stack" aria-labelledby="connection-families-h">
        <Heading level={2} data-size="xs" id="connection-families-h">
          {t('endpoints.families')}
        </Heading>
        <Paragraph data-size="sm">{t('connections.familiesIntro')}</Paragraph>
        <TableRegion label={t('connections.familiesTable')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('endpoints.familyName')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('endpoints.familyBase')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('connections.colApis')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {Object.entries(spec.families).map(([family, base]) => (
                <TableRow key={family}>
                  <TableHeaderCell scope="row">{family}</TableHeaderCell>
                  <TableCell>
                    <code>{base || '/'}</code>
                  </TableCell>
                  <TableCell>{apisIn(family).length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      </section>
      <section className="card stack" aria-labelledby="connection-discovery-h">
        <Heading level={2} data-size="xs" id="connection-discovery-h">
          {t('connections.discovery')}
        </Heading>
        <Paragraph data-size="sm">{t('connections.discoveryIntro')}</Paragraph>
        {spec.discovery.length === 0 ? (
          <Paragraph data-size="sm">{t('connections.discoveryNone')}</Paragraph>
        ) : (
          <TableRegion label={t('connections.discoveryTable')}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('connections.colRule')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('connections.colIncludes')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('connections.colExcludes')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('connections.colGetsApis')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {spec.discovery.map((rule, i) => (
                  <TableRow key={i}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <span>{i + 1}</span>
                        {rule.idPrefix ? <span className="meta">{rule.idPrefix}/…</span> : null}
                      </span>
                    </TableHeaderCell>
                    <TableCell>{rule.include?.join(', ') || t('connections.everything')}</TableCell>
                    <TableCell>{rule.exclude?.join(', ') || '–'}</TableCell>
                    <TableCell>
                      <span className="two-line">
                        {Object.entries(rule.apis ?? {}).map(([kind, apiId]) => (
                          <span key={kind}>
                            {operationName(kind, t)}: <code>{apiId}</code>
                          </span>
                        ))}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        )}
      </section>
      <section className="card stack" aria-labelledby="connection-models-h">
        <Heading level={2} data-size="xs" id="connection-models-h">
          {t('connections.modelsTitle', { count: models.length })}
        </Heading>
        {models.length === 0 ? (
          <Paragraph data-size="sm">{t('connections.modelsNone')}</Paragraph>
        ) : (
          <ul className="plain stack-sm">
            {models.map((m) => (
              <li key={m.id}>
                <Link href={modelsHref({ model: m.id })}>{m.deployment}</Link>{' '}
                <span className="meta">
                  {m.id} · {m.enabled ? t('models.enabled') : t('models.disabled')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card stack" aria-labelledby="connection-remove-h">
        <Heading level={2} data-size="xs" id="connection-remove-h">
          {t('connections.removeTitle')}
        </Heading>
        {using.length > 0 ? (
          <Paragraph data-size="sm">
            {t('connections.removeBlocked', { count: using.length })}
          </Paragraph>
        ) : (
          <Paragraph data-size="sm">{t('endpoints.removeText')}</Paragraph>
        )}
        <div className="actions-row">
          <Button
            variant="secondary"
            data-color="danger"
            disabled={using.length > 0}
            onClick={() => {
              setInUse(undefined);
              setRemoving(true);
            }}
          >
            {t('connections.removeTitle')}
          </Button>
        </div>
      </section>
      {editing ? (
        <EndpointForm
          api={api}
          apis={data.apis}
          existing={entry}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            done(t('connections.saved', { id }));
          }}
        />
      ) : null}
      {recording ? (
        <ProcessorRecordForm
          api={api}
          endpoint={id}
          current={data.records?.find((r) => r.endpoint === id)}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            done(t('endpoints.processorSaved', { id }));
          }}
        />
      ) : null}
      <ReasonDialog
        open={removing}
        title={t('endpoints.removeId', { id })}
        text={t('endpoints.removeText')}
        confirmLabel={t('endpoints.remove')}
        onClose={() => setRemoving(false)}
        onConfirm={remove}
      >
        {inUse?.length ? (
          <div className="stack-sm">
            <span className="label-strong">{t('endpoints.usedBy', { count: inUse.length })}</span>
            <InUseList items={inUse} tenantName={tenantName} />
          </div>
        ) : null}
      </ReasonDialog>
    </>
  );
};
