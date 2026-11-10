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
  Tag,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { useT } from '../../i18n';
import { EmptyState } from '../../states';
import { TableRegion } from '../../ui';
import {
  connectionSpec,
  modelsHref,
  recordStatus,
  type AreaProps,
  type RecordStatus,
} from './area-data';
import { EndpointForm } from './Endpoints';

export const RecordTag = ({ status }: { status: RecordStatus }) => {
  const t = useT();
  if (status === 'unknown') return <span className="meta">{t('connections.recordUnknown')}</span>;
  return (
    <Tag data-size="sm" data-color={status === 'recorded' ? 'success' : 'warning'}>
      {status === 'recorded' ? t('connections.recordRegistered') : t('connections.recordMissing')}
    </Tag>
  );
};

export const ConnectionList = ({ api, data, done }: AreaProps) => {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const connections = data.connections ?? [];
  const missing = connections.filter((c) => recordStatus(data.records, c.id) === 'missing');
  const add = (
    <Button variant="secondary" data-size="sm" onClick={() => setAdding(true)}>
      {t('connections.add')}
    </Button>
  );
  return (
    <section className="stack" aria-labelledby="connections-h">
      <div className="card-head">
        <Heading level={2} data-size="xs" id="connections-h">
          {t('models.tabConnections')}
        </Heading>
        {add}
      </div>
      <Paragraph data-size="sm">{t('connections.intro')}</Paragraph>
      {missing.map((c) => (
        <Alert key={c.id} data-color="warning" data-size="sm">
          <Paragraph data-size="sm">
            <strong>{t('connections.missingTitle', { id: c.id })}</strong>{' '}
            {t('connections.missingText')}{' '}
            <Link href={modelsHref({ connection: c.id })}>{t('connections.recordAdd')}</Link>
          </Paragraph>
        </Alert>
      ))}
      {data.connections === undefined ? (
        <Alert data-color="danger" data-size="sm">
          {t('connections.loadFailed')}
        </Alert>
      ) : connections.length === 0 ? (
        <EmptyState title={t('connections.noneTitle')}>
          <Paragraph>{t('connections.noneText')}</Paragraph>
          {add}
        </EmptyState>
      ) : (
        <TableRegion label={t('connections.tableLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('connections.colConnection')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('connections.colFamilies')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('connections.colModels')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('connections.colRecord')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.map((c) => {
                const spec = connectionSpec(c);
                return (
                  <TableRow key={c.id}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <Link href={modelsHref({ connection: c.id })}>
                          <strong>{c.id}</strong>
                        </Link>
                        <span className="meta">{spec.baseURL ?? ''}</span>
                      </span>
                    </TableHeaderCell>
                    <TableCell>{Object.keys(spec.families).join(', ') || '–'}</TableCell>
                    <TableCell>{data.models.filter((m) => m.endpoint === c.id).length}</TableCell>
                    <TableCell>
                      <RecordTag status={recordStatus(data.records, c.id)} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      {adding ? (
        <EndpointForm
          api={api}
          apis={data.apis}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            done(t('connections.added', { id }));
          }}
        />
      ) : null}
    </section>
  );
};
