import {
  Alert,
  Button,
  Heading,
  Label,
  Link,
  Paragraph,
  Select,
  SelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState, type ReactNode } from 'react';
import { navigate, useAsync } from '../../hooks';
import { useT, type PlainKey } from '../../i18n';
import { operationName } from '../../model-operations';
import { EmptyState, ErrorState, Loading } from '../../states';
import { useTenantNames } from '../../tenant-names';
import type { DescriptorDetail, OperationKind } from '../../types';
import { DialogError, formatWhen, ReasonDialog, TableRegion, VisuallyHidden } from '../../ui';
import {
  beforeProduction,
  boundOf,
  connectionsFor,
  familiesOf,
  firstOpenStep,
  guideSteps,
  modelsHref,
  originOf,
  recordStatus,
  stepOf,
  stepsDone,
  type AreaProps,
  type GuideStep,
  type Missing,
  type Ready,
} from './area-data';
import { ApiStatus, MaturityTag, MoveKindDialog, TestCases } from './ApiList';
import { BindDialog, type Binding } from './BindDialog';
import { Crumbs } from './ConnectionDetail';
import { RecordTag } from './ConnectionList';
import { messagesOf, TrySection, UploadDialog } from './descriptor-parts';
import { originLabel } from './ModelDetail';

const stepLabel: Record<GuideStep, PlainKey> = {
  upload: 'apis.stepUpload',
  try: 'apis.stepTry',
  record: 'apis.stepRecord',
  approve: 'apis.stepApprove',
  bind: 'apis.stepBind',
  production: 'apis.stepProduction',
};

const go = (id: string, step: GuideStep) => navigate('/models', { api: id, step });

const MissingLine = ({ item }: { item: Missing }) => {
  const t = useT();
  switch (item.item) {
    case 'approval':
      return <>{t('apis.missingApproval')}</>;
    case 'testCase':
      return <>{t('apis.missingTestCase')}</>;
    case 'noModel':
      return <>{t('apis.missingModel')}</>;
    case 'kindInTest':
      return <>{t('apis.missingKindInTest', { kind: operationName(item.kind, t) })}</>;
    case 'noFamily':
      return <>{t('apis.missingFamily', { family: item.family })}</>;
    case 'processorRecord':
      return (
        <>
          {t('apis.missingRecord', { connection: item.connection })}{' '}
          <Link href={modelsHref({ connection: item.connection })}>
            {t('connections.recordAdd')}
          </Link>
        </>
      );
  }
};

const ReadyLine = ({ item }: { item: Ready }) => {
  const t = useT();
  return item.item === 'processorRecord' ? (
    <>{t('apis.readyRecord', { connection: item.connection })}</>
  ) : (
    <>{t('apis.readyFamily', { family: item.family, connection: item.connection })}</>
  );
};

const Next = ({ id, step }: { id: string; step: GuideStep }) => {
  const t = useT();
  const next = guideSteps[guideSteps.indexOf(step) + 1];
  if (!next) return null;
  return (
    <div className="actions-row">
      <Button variant="tertiary" onClick={() => go(id, next)}>
        {t('apis.next', { step: t(stepLabel[next]) })}
      </Button>
    </div>
  );
};

type Decision = 'described' | 'review' | 'withdraw';

const decisionText: Record<Decision, { text: PlainKey; cta: PlainKey }> = {
  described: {
    text: 'modelOperations.approveText',
    cta: 'modelOperations.approve',
  },
  review: {
    text: 'modelOperations.backToReviewText',
    cta: 'modelOperations.backToReview',
  },
  withdraw: {
    text: 'modelOperations.withdrawText',
    cta: 'modelOperations.withdraw',
  },
};

export const ApiGuide = ({
  api,
  data,
  done,
  id,
  step,
}: AreaProps & { id: string; step: string | null }) => {
  const t = useT();
  const f = useFormat();
  const tenantName = useTenantNames(api);
  const entry = data.apis?.find((a) => a.id === id);
  const listed = data.descriptors?.find((d) => d.id === id);
  const [detailState, reloadDetail] = useAsync(
    (signal) => (listed ? api.operationDescriptor(id, signal) : Promise.resolve(undefined)),
    [api, id, listed?.version, listed?.fixtures, listed?.status],
  );
  const [tryModel, setTryModel] = useState('');
  const [binding, setBinding] = useState<Binding | undefined>();
  const [deciding, setDeciding] = useState<Decision | undefined>();
  const [replacing, setReplacing] = useState(false);
  const [moving, setMoving] = useState<OperationKind | undefined>();
  const crumbs = (
    <Crumbs
      trail={[{ label: t('models.tabApis'), href: modelsHref({ tab: 'apis' }) }, { label: id }]}
    />
  );
  if (!entry)
    return (
      <>
        {crumbs}
        <EmptyState title={t('apis.notFound', { id })}>
          <Link href={modelsHref({ tab: 'apis' })}>{t('apis.backToList')}</Link>
        </EmptyState>
      </>
    );
  const detail: DescriptorDetail | undefined =
    detailState.status === 'ready' ? detailState.data : undefined;
  const kind = data.kinds?.data.find((k) => k.kind === entry.kind);
  const state = {
    api: entry,
    descriptor: listed,
    kind,
    models: data.models,
    connections: data.connections ?? [],
    records: data.records,
  };
  const done_ = stepsDone(state);
  const current = stepOf(step) ?? firstOpenStep(state);
  const { missing, ready } = beforeProduction(state);
  const offering = connectionsFor(state).map((c) => c.id);
  const candidates = data.models.filter((m) => offering.includes(m.endpoint));
  const chosen = candidates.find((m) => m.id === tryModel) ?? candidates[0];
  const familiesFor = (connection: string) =>
    familiesOf(data.connections?.find((c) => c.id === connection));
  const uploaded = entry.source === 'uploaded';
  const environment = data.kinds?.environment;
  const kindName = operationName(entry.kind, t);

  const decide = async (reason: string) => {
    if (!deciding) return;
    try {
      if (deciding === 'withdraw') await api.withdrawDescriptor(id, reason);
      else await api.setDescriptorStatus(id, deciding, reason);
    } catch (error) {
      throw new DialogError([t('modelOperations.decideFailed'), ...messagesOf(error)].join(' '));
    }
    if (deciding === 'withdraw') navigate('/models', { tab: 'apis' });
    done(
      t(
        deciding === 'withdraw'
          ? 'modelOperations.withdrawn'
          : deciding === 'described'
            ? 'modelOperations.approved'
            : 'modelOperations.movedBack',
        { id },
      ),
    );
  };

  const panels: Record<GuideStep, () => ReactNode> = {
    upload: () => (
      <>
        <dl className="def-list">
          <dt>{t('models.kind')}</dt>
          <dd>{kindName}</dd>
          <dt>{t('apis.colFamily')}</dt>
          <dd>{entry.family}</dd>
          <dt>{t('apis.colSource')}</dt>
          <dd>{t(originLabel[originOf(entry, data.descriptors)])}</dd>
          <dt>{t('apis.colStatus')}</dt>
          <dd>
            <ApiStatus api={entry} />
          </dd>
          {listed?.by && listed.at ? (
            <>
              <dt>{t('modelOperations.lastChange')}</dt>
              <dd>
                {t('modelOperations.lastChangeLine', {
                  who: listed.by,
                  when: formatWhen(listed.at, f, t),
                })}
                {listed.reason ? (
                  <>
                    <br />
                    <span className="muted">{listed.reason}</span>
                  </>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
        {listed?.problems?.length ? (
          <Alert data-color="danger" data-size="sm">
            <ul>
              {listed.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {uploaded ? (
          <div className="actions-row">
            {entry.status === 'review' ? (
              <Button variant="secondary" disabled={!detail} onClick={() => setReplacing(true)}>
                {t('modelOperations.replace')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              data-color="danger"
              disabled={!detail}
              onClick={() => setDeciding('withdraw')}
            >
              {t('modelOperations.withdraw')}
            </Button>
          </div>
        ) : (
          <Paragraph data-size="sm">
            {entry.source === 'built-in' ? t('apis.builtInNote') : t('modelOperations.bundledNote')}
          </Paragraph>
        )}
      </>
    ),
    try: () => {
      if (!listed) return <Paragraph data-size="sm">{t('apis.tryBuiltIn')}</Paragraph>;
      if (environment !== 'test')
        return <Paragraph data-size="sm">{t('modelOperations.tryOnlyInTest')}</Paragraph>;
      if (candidates.length === 0)
        return (
          <Paragraph data-size="sm">{t('apis.tryNoModel', { family: entry.family })}</Paragraph>
        );
      const binds = chosen ? boundOf(chosen)[entry.kind] === id : false;
      return (
        <>
          <div className="field">
            <Label htmlFor="try-model">{t('modelOperations.tryModel')}</Label>
            <Select
              id="try-model"
              value={chosen?.id ?? ''}
              onChange={(e) => setTryModel(e.target.value)}
            >
              {candidates.map((m) => (
                <SelectOption key={m.id} value={m.id}>
                  {m.deployment} ({m.endpoint})
                </SelectOption>
              ))}
            </Select>
          </div>
          {chosen && !binds ? (
            <Alert data-color="info" data-size="sm">
              <Paragraph data-size="sm">
                {boundOf(chosen)[entry.kind]
                  ? t('apis.tryBindsOther', {
                      model: chosen.deployment,
                      kind: kindName,
                      api: boundOf(chosen)[entry.kind] ?? '',
                    })
                  : t('apis.tryNotBound', { model: chosen.deployment, kind: kindName })}
              </Paragraph>
              <Button
                variant="secondary"
                data-size="sm"
                onClick={() => setBinding({ model: chosen, kind: entry.kind, proposed: id })}
              >
                {t('apis.bindTo', { model: chosen.deployment })}
              </Button>
            </Alert>
          ) : null}
          {chosen && binds && detail ? (
            <TrySection
              key={`${chosen.id}-${detail.fixtures}`}
              api={api}
              detail={detail}
              model={chosen}
              onRecorded={(name) => {
                reloadDetail();
                done(t('modelOperations.recorded', { name, id }));
              }}
            />
          ) : null}
        </>
      );
    },
    record: () => (
      <>
        <TestCases descriptor={listed} />
        {detail?.contract && !detail.contract.passed ? (
          <ul className="plain check-list">
            {detail.contract.failures.map((x) => (
              <li key={x.check}>
                <span className="two-line">
                  <span>{x.check}</span>
                  {x.problems.map((p) => (
                    <span key={p} className="meta">
                      {p}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {detail?.fixtureCases?.length ? (
          <ul className="plain">
            {detail.fixtureCases.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong>
                {c.source ? <span className="meta"> · {c.source}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!listed ? null : uploaded && entry.status === 'review' ? (
          <Paragraph data-size="sm">{t('apis.recordHow')}</Paragraph>
        ) : (
          <Paragraph data-size="sm">{t('modelOperations.recordBundled')}</Paragraph>
        )}
      </>
    ),
    approve: () =>
      !uploaded ? (
        <Paragraph data-size="sm">
          {entry.source === 'built-in' ? t('apis.builtInNote') : t('modelOperations.bundledNote')}
        </Paragraph>
      ) : entry.status === 'review' ? (
        <>
          <Paragraph data-size="sm">{t('modelOperations.whenApprovingText')}</Paragraph>
          {listed?.contract?.passed ? null : (
            <Paragraph data-size="sm">{t('apis.approveNeedsTestCase')}</Paragraph>
          )}
          <div className="actions-row">
            <Button
              disabled={!listed?.contract?.passed || !detail}
              onClick={() => setDeciding('described')}
            >
              {t('modelOperations.approve')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Paragraph data-size="sm">{t('modelOperations.statusDescribedMeaning')}</Paragraph>
          <div className="actions-row">
            <Button variant="secondary" disabled={!detail} onClick={() => setDeciding('review')}>
              {t('modelOperations.backToReview')}
            </Button>
          </div>
        </>
      ),
    bind: () =>
      candidates.length === 0 ? (
        <Paragraph data-size="sm">{t('apis.tryNoModel', { family: entry.family })}</Paragraph>
      ) : (
        <TableRegion label={t('apis.bindTable')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('models.colModel')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colConnection')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  {t('apis.bindCurrent', { kind: kindName })}
                </TableHeaderCell>
                <TableHeaderCell scope="col">{t('connections.colRecord')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <VisuallyHidden>{t('models.colActions')}</VisuallyHidden>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {candidates.map((m) => {
                const now = boundOf(m)[entry.kind];
                return (
                  <TableRow key={m.id}>
                    <TableHeaderCell scope="row">
                      <Link href={modelsHref({ model: m.id })}>{m.deployment}</Link>
                    </TableHeaderCell>
                    <TableCell>{m.endpoint}</TableCell>
                    <TableCell>{now ? <code>{now}</code> : '–'}</TableCell>
                    <TableCell>
                      <RecordTag status={recordStatus(data.records, m.endpoint)} />
                    </TableCell>
                    <TableCell>
                      {now === id ? (
                        <Tag data-size="sm" data-color="success">
                          {t('apis.bound')}
                        </Tag>
                      ) : (
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          onClick={() => setBinding({ model: m, kind: entry.kind, proposed: id })}
                        >
                          {t('apis.bindTo', { model: m.deployment })}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      ),
    production: () =>
      !kind || kind.builtIn ? (
        <Paragraph data-size="sm">{t('apis.productionBuiltIn', { kind: kindName })}</Paragraph>
      ) : (
        <>
          <dl className="def-list">
            <dt>{t('apis.colMaturity')}</dt>
            <dd>
              <MaturityTag maturity={kind.maturity} />
            </dd>
          </dl>
          <Paragraph data-size="sm">
            {kind.maturity === 'production'
              ? t('modelOperations.maturityProductionMeaning')
              : t('modelOperations.maturityTestMeaning')}
          </Paragraph>
          <div className="actions-row">
            <Button
              variant={kind.maturity === 'test' ? 'primary' : 'secondary'}
              onClick={() => setMoving(kind)}
            >
              {kind.maturity === 'test'
                ? t('modelOperations.promoteFor', { kind: kindName })
                : t('modelOperations.demoteFor', { kind: kindName })}
            </Button>
          </div>
        </>
      ),
  };

  return (
    <>
      {crumbs}
      <div className="page-header">
        <span className="eyebrow">
          {uploaded && entry.status === 'review' ? t('apis.newEyebrow') : t('apis.eyebrow')}
        </span>
        <Heading level={1} data-size="lg">
          {id}
        </Heading>
        {entry.summary ? <p className="intro">{entry.summary}</p> : null}
      </div>
      <nav aria-label={t('apis.stepsLabel')}>
        <ol className="guide-steps">
          {guideSteps.map((s, i) => (
            <li key={s}>
              <Button
                variant={s === current ? 'primary' : 'secondary'}
                data-size="sm"
                aria-current={s === current ? 'step' : undefined}
                onClick={() => go(id, s)}
              >
                <span className="two-line">
                  <span className="meta">
                    {t('apis.stepN', { n: i + 1 })} ·{' '}
                    {done_[s] ? t('apis.stepDone') : t('apis.stepOpen')}
                  </span>
                  <span>{t(stepLabel[s])}</span>
                </span>
              </Button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="guide-cols">
        <section className="card stack" aria-labelledby="guide-step-h">
          <Heading level={2} data-size="sm" id="guide-step-h">
            {t(stepLabel[current])}
          </Heading>
          {detailState.status === 'loading' && listed ? (
            <Loading label={t('modelOperations.loadingOne')} />
          ) : null}
          {detailState.status === 'error' ? (
            <ErrorState error={detailState.error} onRetry={reloadDetail} />
          ) : null}
          {panels[current]()}
          <Next id={id} step={current} />
        </section>
        <aside className="card stack" aria-labelledby="guide-missing-h">
          <Heading level={2} data-size="xs" id="guide-missing-h">
            {missing.length ? t('apis.missingTitle') : t('apis.missingNone')}
          </Heading>
          {missing.length ? (
            <ul className="stack-sm">
              {missing.map((m, i) => (
                <li key={i}>
                  <MissingLine item={m} />
                </li>
              ))}
            </ul>
          ) : null}
          {ready.length ? (
            <>
              <Heading level={3} data-size="2xs">
                {t('apis.readyTitle')}
              </Heading>
              <ul className="stack-sm">
                {ready.map((r, i) => (
                  <li key={i}>
                    <ReadyLine item={r} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
      <BindDialog
        api={api}
        binding={binding}
        apis={data.apis ?? []}
        families={binding ? familiesFor(binding.model.endpoint) : undefined}
        onClose={() => setBinding(undefined)}
        onSaved={(saved) => done(t('models.bindSaved', { model: saved.deployment }))}
      />
      <UploadDialog
        api={api}
        open={replacing}
        replacing={detail}
        onClose={() => setReplacing(false)}
        onUploaded={(uploadedId) => {
          setReplacing(false);
          done(t('modelOperations.uploaded', { id: uploadedId }));
        }}
      />
      <ReasonDialog
        open={Boolean(deciding)}
        title={
          deciding === 'described'
            ? t('modelOperations.approveTitle', { id })
            : deciding === 'review'
              ? t('modelOperations.backToReviewTitle', { id })
              : deciding === 'withdraw'
                ? t('modelOperations.withdrawTitle', { id })
                : ''
        }
        text={deciding ? t(decisionText[deciding].text) : undefined}
        confirmLabel={deciding ? t(decisionText[deciding].cta) : ''}
        onClose={() => setDeciding(undefined)}
        onConfirm={decide}
      >
        {deciding && deciding !== 'described' && detail ? (
          <div className="stack-sm">
            <span className="label-strong">
              {t('modelOperations.usedByCount', { count: detail.usedBy.length })}
            </span>
            {detail.usedBy.length ? (
              <ul className="service-list">
                {detail.usedBy.map((u) => (
                  <li key={`${u.tenant}/${u.service}`}>
                    <span>
                      <strong>{u.service}</strong> · {tenantName(u.tenant)}
                    </span>
                    <span className="meta">{t('modelOperations.versionN', { n: u.version })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Paragraph data-size="sm">{t('modelOperations.usedByNone')}</Paragraph>
            )}
          </div>
        ) : null}
      </ReasonDialog>
      <MoveKindDialog api={api} kind={moving} onClose={() => setMoving(undefined)} onMoved={done} />
    </>
  );
};
