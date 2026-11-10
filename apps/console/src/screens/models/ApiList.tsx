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
import { maturityLabel } from '../../descriptors';
import { navigate } from '../../hooks';
import { useT } from '../../i18n';
import { operationName } from '../../model-operations';
import { EmptyState } from '../../states';
import type { Maturity, ModelApi, OperationDescriptor, OperationKind } from '../../types';
import { DialogError, ReasonDialog, TableRegion, VisuallyHidden } from '../../ui';
import { kindMaturity, modelsHref, originOf, type AreaProps } from './area-data';
import { messagesOf, UploadDialog } from './descriptor-parts';
import { originLabel } from './ModelDetail';

export const ApiStatus = ({ api }: { api: Pick<ModelApi, 'status'> }) => {
  const t = useT();
  return api.status === 'review' ? (
    <Tag data-size="sm" data-color="warning">
      {t('modelOperations.statusReview')}
    </Tag>
  ) : (
    <Tag data-size="sm" data-color="success">
      {t('modelOperations.statusDescribed')}
    </Tag>
  );
};

export const TestCases = ({ descriptor }: { descriptor: OperationDescriptor | undefined }) => {
  const t = useT();
  if (!descriptor) return <span className="meta">{t('apis.testCasesBuiltIn')}</span>;
  if (descriptor.fixtures === 0) return <>{t('modelOperations.contractNone')}</>;
  return (
    <span className="two-line">
      <span>{t('apis.testCases', { count: descriptor.fixtures })}</span>
      <Tag data-size="sm" data-color={descriptor.contract?.passed ? 'success' : 'danger'}>
        {descriptor.contract?.passed
          ? t('modelOperations.contractPassed')
          : t('modelOperations.contractFailed')}
      </Tag>
    </span>
  );
};

export const MaturityTag = ({ maturity }: { maturity: Maturity | 'built-in' | undefined }) => {
  const t = useT();
  if (maturity === 'built-in') return <span className="meta">{t('apis.kindBuiltIn')}</span>;
  if (!maturity) return <>–</>;
  return (
    <Tag data-size="sm" data-color={maturity === 'production' ? 'success' : 'warning'}>
      {t(maturityLabel[maturity])}
    </Tag>
  );
};

export const MoveKindDialog = ({
  api,
  kind,
  onClose,
  onMoved,
}: {
  api: AreaProps['api'];
  kind: OperationKind | undefined;
  onClose: () => void;
  onMoved: (message: string) => void;
}) => {
  const t = useT();
  const name = kind ? operationName(kind.kind, t) : '';
  const promote = kind?.maturity === 'test';
  return (
    <ReasonDialog
      open={Boolean(kind)}
      title={
        promote
          ? t('modelOperations.promoteTitle', { kind: name })
          : t('modelOperations.demoteTitle', { kind: name })
      }
      text={t(promote ? 'modelOperations.promoteText' : 'modelOperations.demoteText')}
      confirmLabel={t(promote ? 'modelOperations.promote' : 'modelOperations.demote')}
      onClose={onClose}
      onConfirm={async (reason) => {
        if (!kind) return;
        try {
          await api.setKindMaturity(kind.kind, promote ? 'production' : 'test', reason);
        } catch (error) {
          throw new DialogError(
            [t('modelOperations.decideFailed'), ...messagesOf(error)].join(' '),
          );
        }
        onMoved(
          t(promote ? 'modelOperations.promoted' : 'modelOperations.demoted', { kind: name }),
        );
      }}
    />
  );
};

export const ApiList = ({ api, data, done }: AreaProps) => {
  const t = useT();
  const [uploading, setUploading] = useState(false);
  const [moving, setMoving] = useState<OperationKind | undefined>();
  const apis = data.apis;
  const kinds = data.kinds?.data ?? [];
  const descriptorOf = (id: string) => data.descriptors?.find((d) => d.id === id);
  const upload = (
    <Button variant="secondary" data-size="sm" onClick={() => setUploading(true)}>
      {t('apis.add')}
    </Button>
  );

  return (
    <div className="stack">
      <section className="stack" aria-labelledby="apis-h">
        <div className="card-head">
          <Heading level={2} data-size="xs" id="apis-h">
            {t('models.tabApis')}
          </Heading>
          {upload}
        </div>
        <Paragraph data-size="sm">{t('apis.intro')}</Paragraph>
        {data.kinds ? (
          <Paragraph data-size="sm">
            {data.kinds.environment === 'test'
              ? t('modelOperations.environmentTest')
              : t('modelOperations.environmentProduction')}
          </Paragraph>
        ) : null}
        {apis === undefined ? (
          <Alert data-color="danger" data-size="sm">
            {t('apis.loadFailed')}
          </Alert>
        ) : apis.length === 0 ? (
          <EmptyState title={t('apis.noneTitle')}>
            <Paragraph>{t('apis.noneText')}</Paragraph>
            {upload}
          </EmptyState>
        ) : (
          <TableRegion label={t('apis.tableLabel')}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('apis.colApi')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('models.kind')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colFamily')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colSource')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colStatus')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colTestCases')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colMaturity')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colModels')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {apis.map((a) => (
                  <TableRow key={a.id}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <Link href={modelsHref({ api: a.id })}>
                          <code>{a.id}</code>
                        </Link>
                        {a.summary ? <span className="meta">{a.summary}</span> : null}
                      </span>
                    </TableHeaderCell>
                    <TableCell>{operationName(a.kind, t)}</TableCell>
                    <TableCell>{a.family}</TableCell>
                    <TableCell>{t(originLabel[originOf(a, data.descriptors)])}</TableCell>
                    <TableCell>
                      <ApiStatus api={a} />
                    </TableCell>
                    <TableCell>
                      <TestCases descriptor={descriptorOf(a.id)} />
                    </TableCell>
                    <TableCell>
                      <MaturityTag maturity={kindMaturity(kinds, a.kind)} />
                    </TableCell>
                    <TableCell>{a.models.length}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        )}
      </section>
      <section className="stack" aria-labelledby="kinds-h">
        <Heading level={2} data-size="xs" id="kinds-h">
          {t('modelOperations.kindsTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('modelOperations.kindsIntro')}</Paragraph>
        {kinds.length ? (
          <TableRegion label={t('apis.kindsTable')}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('models.kind')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('apis.colMaturity')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('models.tabApis')}</TableHeaderCell>
                  <TableHeaderCell scope="col">
                    <VisuallyHidden>{t('models.colActions')}</VisuallyHidden>
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {kinds.map((k) => (
                  <TableRow key={k.kind}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <strong>{operationName(k.kind, t)}</strong>
                        <span className="meta">{k.kind}</span>
                      </span>
                    </TableHeaderCell>
                    <TableCell>
                      <MaturityTag maturity={kindMaturity(kinds, k.kind)} />
                    </TableCell>
                    <TableCell>
                      {(apis ?? [])
                        .filter((a) => a.kind === k.kind)
                        .map((a) => a.id)
                        .join(', ') || '–'}
                    </TableCell>
                    <TableCell>
                      {k.builtIn || k.descriptors.length === 0 ? null : (
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          onClick={() => setMoving(k)}
                          aria-label={
                            k.maturity === 'test'
                              ? t('modelOperations.promoteFor', { kind: operationName(k.kind, t) })
                              : t('modelOperations.demoteFor', { kind: operationName(k.kind, t) })
                          }
                        >
                          {k.maturity === 'test'
                            ? t('modelOperations.promote')
                            : t('modelOperations.demote')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        ) : (
          <Paragraph data-size="sm">{t('apis.kindsUnavailable')}</Paragraph>
        )}
      </section>
      <UploadDialog
        api={api}
        open={uploading}
        onClose={() => setUploading(false)}
        onUploaded={(id) => {
          setUploading(false);
          navigate('/models', { api: id, step: 'try' });
          done(t('modelOperations.uploaded', { id }));
        }}
      />
      <MoveKindDialog api={api} kind={moving} onClose={() => setMoving(undefined)} onMoved={done} />
    </div>
  );
};
