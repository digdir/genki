import { Alert, Button, Heading, Link, Paragraph, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import {
  blockPath,
  changeOf,
  requestChange,
  blockHref,
  type BlockUser,
  type BlockVersion,
  type CatalogItem,
  flowEditorHref,
} from '../../api/building-blocks';
import { reasonPlaceholder, type ApiCallPreview } from '../../components/ApiCall';
import { Crumbs } from '../../components/Crumbs';
import { DataLocationTag } from '../../components/DataLocationTag';
import { ReasonField, reasonProblem } from '../../components/ReasonField';
import {
  extensionPointLabel,
  kindLabel,
  permissionLabels,
  statusLabels,
  storageLabels,
  versionEventLabels,
} from '../../data/building-blocks';
import { useT, type T } from '../../i18n';
import { rightLabel } from '../../Shell';
import { ErrorState, refusalOf } from '../../states';
import {
  ApiCallButton,
  approverName,
  judgeFacts,
  judgeRefusalText,
  PermissionList,
  ReadOnlyAlert,
  rightLabelFor,
  serviceName,
  shortDate,
  useBlockRights,
  type Flash,
  type Settled,
} from './common';
import { SettingsForm } from './SettingsForm';
import { StepFlowView } from './StepFlowView';

export type BlockTab = 'about' | 'diagram' | 'yaml' | 'used-by' | 'versions';

export interface ServiceRuns extends BlockUser {
  runsThisWeek?: number;
}

export const blockTabs: Record<string, BlockTab> = {
  diagram: 'diagram',
  yaml: 'yaml',
  'used-by': 'used-by',
  versions: 'versions',
};

const tabLabels = {
  about: 'blocks.tabAbout',
  diagram: 'blocks.tabDiagram',
  yaml: 'blocks.tabYaml',
  'used-by': 'blocks.tabUsedBy',
  versions: 'blocks.tabVersions',
} as const;

export const hasFlowDefinition = (item: Pick<CatalogItem, 'kind' | 'id' | 'publisher'>) =>
  item.kind === 'step_flow' && item.publisher.type === 'own' && !item.id.includes('@');

export const tabsFor = (item: Pick<CatalogItem, 'kind' | 'id' | 'publisher'>): BlockTab[] => [
  'about',
  ...(hasFlowDefinition(item) ? (['diagram', 'yaml'] as const) : []),
  'used-by',
  'versions',
];

const modelCapabilities: Record<
  string,
  'blocks.capStream' | 'blocks.capTools' | 'blocks.capJsonSchema' | 'blocks.capReasoning'
> = {
  stream: 'blocks.capStream',
  tools: 'blocks.capTools',
  'json-schema': 'blocks.capJsonSchema',
  reasoning: 'blocks.capReasoning',
};

export const plainCapability = (t: T, item: Pick<CatalogItem, 'kind'>, capability: string) => {
  const key = item.kind === 'model' ? modelCapabilities[capability] : undefined;
  return key ? t(key) : capability;
};

const isAddress = (text: string) => /^https?:\/\/\S+$/.test(text);

const toolParts = (capability: string) => {
  const at = capability.indexOf(': ');
  return at < 0
    ? { name: capability, text: '' }
    : { name: capability.slice(0, at), text: capability.slice(at + 2) };
};

const processedText = {
  norway: ['blocks.processedNorway', 'blocks.processedBodyNorway'],
  eu: ['blocks.processedEu', 'blocks.processedBodyEu'],
  global: ['blocks.processedGlobal', 'blocks.processedBodyGlobal'],
} as const;

type Pending = 'adopt' | 'request' | null;

const versionRows = (t: T, versions: BlockVersion[]) =>
  [...versions]
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .map((v) =>
      v.source === 'tenant'
        ? {
            key: `tenant-${v.version}`,
            label: v.event ? t(versionEventLabels[v.event]) : t('blocks.eventChanged'),
            at: v.at,
            text: v.by ? `${v.by}: «${v.reason ?? ''}»` : (v.reason ?? ''),
          }
        : {
            key: `publisher-${v.version}`,
            label: /^\d/.test(v.version)
              ? t('blocks.versionCap', { version: v.version })
              : v.version,
            at: v.at,
            text: v.reason ?? '',
          },
    );

export const BlockDetail = ({
  api,
  tenant,
  tenantName,
  item,
  services,
  versions,
  tab,
  onRetry,
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  item: CatalogItem;
  services: ServiceRuns[];
  tab: BlockTab;
  versions: Settled<BlockVersion[]>;
  onRetry: () => void;
  onChanged: (flash: Flash) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const ids = {
    caps: useId(),
    access: useId(),
    versions: useId(),
    facts: useId(),
    used: useId(),
    quality: useId(),
    update: useId(),
    pending: useId(),
    where: useId(),
    connection: useId(),
  };
  const tabs = tabsFor(item);
  const current = tabs.includes(tab) ? tab : 'about';
  const rights = useBlockRights();
  const canChange = rights.canChange(item.kind);
  const editorHref = flowEditorHref(item);
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState('');
  const status = statusLabels[item.status];
  const approver = approverName(t, item.approver);
  const right = rightLabelFor(t, item.kind);
  const used = item.usedBy;
  const known = [...item.usedBy, ...services];

  const open = (next: Pending) => {
    setPending(next);
    setReason('');
    setTried(false);
    setProblem('');
  };

  const confirm = async () => {
    setTried(true);
    if (reasonProblem(reason, t) || !pending) return;
    try {
      if (pending === 'adopt') {
        const result = await api.buildingBlocks.adopt(tenant, item, reason);
        const text = t('blocks.adopted', { name: item.name, tenant: tenantName });
        const change = changeOf(result);
        onChanged(change ? { kind: 'logged', text, change } : { kind: 'plain', text });
      } else {
        const result = await api.buildingBlocks.requestApproval(tenant, item, reason);
        onChanged({
          kind: 'logged',
          text: t('blocks.requestSent', { approver }),
          change: requestChange(result),
        });
      }
      open(null);
    } catch (error) {
      setProblem(refusalOf(error) ?? t('blocks.saveFailed'));
    }
  };

  const call = (): ApiCallPreview => {
    const base = { right };
    const previewReason = reason.trim() || reasonPlaceholder;
    if (item.status === 'available')
      return {
        ...base,
        action: t('blocks.adoptHere'),
        method: 'POST',
        path: api.buildingBlocks.path(tenant, blockPath(item, '/adopt')),
        body: { reason: previewReason },
      };
    if (item.status === 'requires_approval')
      return {
        ...base,
        action: t('blocks.requestApproval'),
        method: 'POST',
        path: api.buildingBlocks.path(tenant, blockPath(item, '/approval-requests')),
        body: { reason: previewReason },
      };
    return {
      ...base,
      action: item.name,
      method: 'GET',
      path: api.buildingBlocks.path(tenant, blockPath(item)),
      right: rightLabel(t, 'use-services'),
    };
  };

  const facts = [
    { label: t('blocks.factType'), value: kindLabel(t, item.kind) },
    { label: t('blocks.publisher'), value: item.publisher.name },
    ...(item.judge
      ? judgeFacts(t, item.judge)
      : [
          {
            label: item.kind === 'dataset' ? t('blocks.factContent') : t('blocks.factVersion'),
            value: item.version,
          },
        ]),
    ...(item.dataLocation
      ? [{ label: t('blocks.factStorage'), value: t(storageLabels[item.dataLocation]) }]
      : []),
    ...(item.extensionPoint
      ? [{ label: t('blocks.factRuns'), value: extensionPointLabel(item.extensionPoint, t) }]
      : []),
    ...(item.changedBy
      ? [
          {
            label: t('blocks.factLastChanged'),
            value: t('blocks.dateBy', {
              date: f.date(item.changedBy.at),
              by: item.changedBy.by,
            }),
          },
        ]
      : []),
    { label: t('blocks.factChangedBy'), value: right },
    { label: t('blocks.factId'), value: item.id },
  ];
  const address = item.kind === 'tool' && isAddress(item.description) ? item.description : '';
  const lead = item.judge
    ? t('blocks.judgeAdvisory', { connection: item.judge.connection })
    : address
      ? ''
      : item.description;
  const publisherName = item.publisher.type === 'own' ? tenantName : item.publisher.name;
  const runsOf = (id: string) => services.find((s) => s.id === id)?.runsThisWeek;
  const tabHref = (next: BlockTab) => `${blockHref(item)}${next === 'about' ? '' : `/${next}`}`;

  return (
    <div className="stack">
      <Crumbs
        items={[{ label: t('blocks.title'), href: '#/building-blocks' }, { label: item.name }]}
      />
      <div className="stack-sm">
        <span className="bb-meta">
          {t('blocks.kindFrom', { kind: kindLabel(t, item.kind), publisher: publisherName })}
        </span>
        <div className="bb-title">
          <Heading level={1} data-size="md">
            {item.name}
          </Heading>
          <Tag data-color={status.color}>{t(status.label)}</Tag>
          {item.dataLocation ? <DataLocationTag location={item.dataLocation} /> : null}
        </div>
        <p className="lead bb-desc">
          {lead}
          {lead && used.length ? ' ' : ''}
          {used.length ? t('blocks.usedInSentence', { count: used.length }) : ''}
        </p>
      </div>

      {!canChange ? <ReadOnlyAlert right={right} /> : null}

      {item.status === 'not_allowed' && item.policyBlock ? (
        <Alert data-color="danger">
          <Paragraph>
            {item.judge?.refused ? judgeRefusalText(t, item.judge.refused) : item.policyBlock.text}
          </Paragraph>
        </Alert>
      ) : null}
      {item.status === 'requires_approval' && item.policyBlock ? (
        <Alert data-color="warning">
          <Paragraph>{item.policyBlock.text}</Paragraph>
        </Alert>
      ) : null}
      {item.status === 'pending_approval' ? (
        <Alert data-color="info">
          <Paragraph>{t('blocks.pendingNotice', { approver })}</Paragraph>
        </Alert>
      ) : null}

      {item.update && item.status === 'in_use' ? (
        <section aria-labelledby={ids.update} className="bb-update">
          <div className="bb-title">
            <Tag data-color="info" data-size="sm">
              {t('blocks.updateAvailable')}
            </Tag>
            <Heading level={2} data-size="xs" id={ids.update}>
              {t('blocks.updateHeading', {
                version: item.update.version,
                date: shortDate(f, item.update.availableFrom),
              })}
            </Heading>
          </div>
          <Paragraph className="bb-measure">
            {item.update.notes} {t('blocks.updateBody')}
          </Paragraph>
          <div
            className="table-scroll bb-table-bg"
            tabIndex={0}
            role="region"
            aria-label={t('blocks.scoresBeforeAfter')}
          >
            <table className="ds-table bb-table-wide">
              <thead>
                <tr>
                  <th scope="col">{t('blocks.colService')}</th>
                  <th scope="col">{t('blocks.colScoreNow', { version: item.version })}</th>
                  <th scope="col">{t('blocks.colScoreWith', { version: item.update.version })}</th>
                  <th scope="col">{t('blocks.colChange')}</th>
                </tr>
              </thead>
              <tbody>
                {item.update.perService.map((r) => {
                  const diff =
                    r.scoreBefore !== null && r.scoreAfter !== null
                      ? r.scoreAfter - r.scoreBefore
                      : null;
                  const name = serviceName(known, r.service);
                  return (
                    <tr key={r.service}>
                      <th scope="row" className="bb-row-head">
                        <Link href={`#/services/${encodeURIComponent(r.service)}`}>{name}</Link>
                      </th>
                      <td className="numeric">{r.scoreBefore ?? '–'}</td>
                      <td className="numeric">{r.scoreAfter ?? '–'}</td>
                      <td>
                        {diff === null ? null : (
                          <Tag
                            data-size="sm"
                            data-color={diff > 0 ? 'success' : diff < 0 ? 'danger' : 'neutral'}
                          >
                            {diff > 0
                              ? `+${diff}`
                              : diff < 0
                                ? `−${Math.abs(diff)}`
                                : t('blocks.noChange')}
                          </Tag>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {canChange ? (
        <div className="stack-sm">
          <div className="actions">
            {item.status === 'available' ? (
              <Button variant="primary" onClick={() => open('adopt')}>
                {t('blocks.adoptHere')}
              </Button>
            ) : null}
            {item.status === 'requires_approval' ? (
              <Button variant="primary" onClick={() => open('request')}>
                {t('blocks.requestApproval')}
              </Button>
            ) : null}
            {item.kind === 'skill' ? (
              <Button asChild variant="secondary">
                <a href={`#/skills?id=${encodeURIComponent(item.id)}`}>
                  {item.publisher.type === 'own' ? t('blocks.editSkill') : t('blocks.openSkill')}
                </a>
              </Button>
            ) : null}
            {editorHref ? (
              <Button asChild variant="secondary">
                <a href={editorHref}>{t('blocks.openStepFlow')}</a>
              </Button>
            ) : null}
            <ApiCallButton call={call} />
          </div>

          {pending ? (
            <section aria-labelledby={ids.pending} className="bb-confirm">
              <Heading level={2} data-size="2xs" id={ids.pending}>
                {pending === 'adopt'
                  ? t('blocks.adoptTitle', { name: item.name, tenant: tenantName })
                  : t('blocks.requestTitle', { name: item.name })}
              </Heading>
              <Paragraph data-size="sm">
                {pending === 'adopt'
                  ? t('blocks.adoptBody', { tenant: tenantName })
                  : t('blocks.requestBody', { approver })}
              </Paragraph>
              <PermissionList permissions={item.permissions} />
              <div className="bb-reason">
                <ReasonField value={reason} onChange={setReason} showError={tried} />
              </div>
              {problem ? (
                <Alert data-color="danger" data-size="sm" role="alert">
                  {problem}
                </Alert>
              ) : null}
              <div className="actions">
                <Button variant="primary" onClick={() => void confirm()}>
                  {pending === 'adopt' ? t('blocks.adopt') : t('blocks.sendRequest')}
                </Button>
                <Button variant="secondary" onClick={() => open(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      <nav aria-label={t('blocks.tabsLabel', { name: item.name })} className="bb-nav">
        <ul>
          {tabs.map((k) => (
            <li key={k}>
              <a href={tabHref(k)} aria-current={k === current ? 'page' : undefined}>
                {t(tabLabels[k])}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {current === 'diagram' || current === 'yaml' ? (
        <StepFlowView api={api} tenant={tenant} id={item.id} view={current} />
      ) : null}

      {current === 'used-by' ? (
        <section aria-labelledby={ids.used} className="stack-sm">
          <Heading level={2} data-size="xs" id={ids.used}>
            {used.length
              ? t('blocks.usedInHeading', { count: used.length })
              : t('blocks.usedByHeading')}
          </Heading>
          {used.length ? (
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label={t('blocks.usedByTable', { name: item.name })}
            >
              <table className="ds-table bb-table-access">
                <thead>
                  <tr>
                    <th scope="col">{t('blocks.colService')}</th>
                    <th scope="col" className="numeric">
                      {t('blocks.colRunsWeek')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {used.map((s) => {
                    const runs = runsOf(s.id);
                    return (
                      <tr key={s.id}>
                        <th scope="row" className="bb-row-head">
                          <Link href={`#/services/${encodeURIComponent(s.id)}`}>{s.name}</Link>
                        </th>
                        <td className="numeric">{runs === undefined ? '–' : f.number(runs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="bb-meta">{t('blocks.usedByNoneHere', { tenant: tenantName })}</p>
          )}
        </section>
      ) : null}

      {current === 'versions' ? (
        <section aria-labelledby={ids.versions} className="stack-sm">
          <Heading level={2} data-size="xs" id={ids.versions}>
            {t('blocks.versionsAndChanges')}
          </Heading>
          {!versions.ok ? (
            <ErrorState error={versions.error} onRetry={onRetry} headingLevel={3} />
          ) : versions.data.length === 0 ? (
            <p className="bb-meta">{t('blocks.noVersions')}</p>
          ) : (
            <ol className="bb-versions">
              {versionRows(t, versions.data).map((v) => (
                <li key={v.key}>
                  <span className="bb-version">{v.label}</span>
                  <span className="bb-version-date">{shortDate(f, v.at)}</span>
                  <span className="bb-version-notes">{v.text}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {current === 'about' ? (
        <div className="bb-columns">
          <div className="bb-main">
            {item.kind === 'tool' ? (
              <section aria-labelledby={ids.caps} className="stack-sm">
                <Heading level={2} data-size="xs" id={ids.caps}>
                  {t('blocks.toolsOffered')}
                </Heading>
                <ul className="bb-list bb-tools">
                  {item.capabilities.map((c) => {
                    const tool = toolParts(c);
                    return (
                      <li key={c}>
                        <strong>{tool.name}</strong>
                        {tool.text ? <span className="bb-meta">{tool.text}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : item.capabilities.length ? (
              <section aria-labelledby={ids.caps} className="stack-sm">
                <Heading level={2} data-size="xs" id={ids.caps}>
                  {item.kind === 'model' ? t('blocks.goodAt') : t('blocks.capabilities')}
                </Heading>
                <ul className="bb-list">
                  {item.capabilities.map((c) => (
                    <li key={c}>{plainCapability(t, item, c)}</li>
                  ))}
                </ul>
              </section>
            ) : null}

            {item.dataLocation ? (
              <section aria-labelledby={ids.where} className="stack-sm">
                <Heading level={2} data-size="xs" id={ids.where}>
                  {t('blocks.whereProcessed')}
                </Heading>
                <Paragraph className="bb-measure">
                  <strong>{t(processedText[item.dataLocation][0])}</strong>{' '}
                  {t(processedText[item.dataLocation][1], { name: item.name })}
                </Paragraph>
                <Link href="#/data-handling">{t('blocks.howDataIsHandled')}</Link>
              </section>
            ) : null}

            {address ? (
              <section aria-labelledby={ids.connection} className="stack-sm">
                <Heading level={2} data-size="xs" id={ids.connection}>
                  {t('blocks.connection')}
                </Heading>
                <dl className="kv bb-kv">
                  <div className="bb-kv-row">
                    <dt>{t('blocks.address')}</dt>
                    <dd>{address}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {item.kind !== 'model' && item.permissions.length ? (
              <section aria-labelledby={ids.access} className="stack-sm">
                <div className="bb-stack-xs">
                  <Heading level={2} data-size="xs" id={ids.access}>
                    {t('blocks.access')}
                  </Heading>
                  <span className="bb-meta">{t('blocks.accessNote')}</span>
                </div>
                <div
                  className="table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label={t('blocks.accessTable')}
                >
                  <table className="ds-table bb-table-access">
                    <thead>
                      <tr>
                        <th scope="col">{t('blocks.colAccess')}</th>
                        <th scope="col">{t('blocks.colWhat')}</th>
                        <th scope="col">{t('blocks.colNote')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {item.permissions.map((p) => (
                        <tr key={`${p.type}-${p.value}`}>
                          <th scope="row" className="bb-row-head">
                            {t(permissionLabels[p.type])}
                          </th>
                          <td>{p.value}</td>
                          <td>{p.note ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            <SettingsForm
              key={`${item.id}-${JSON.stringify(item.tenantOverrides)}`}
              api={api}
              tenant={tenant}
              tenantName={tenantName}
              item={item}
              canChange={canChange}
              onSaved={onChanged}
            />
          </div>

          <aside className="bb-aside">
            <section aria-labelledby={ids.facts} className="bb-facts">
              <Heading level={2} data-size="2xs" id={ids.facts}>
                {item.kind === 'model' ? t('blocks.aboutModel') : t('blocks.about')}
              </Heading>
              <dl className="kv bb-kv">
                {facts.map((fact) => (
                  <div key={fact.label} className="bb-kv-row">
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section aria-labelledby={ids.quality} className="stack-sm">
              <Heading level={2} data-size="2xs" id={ids.quality}>
                {t('blocks.testSetQuality')}
              </Heading>
              {item.scores.length ? (
                <>
                  <ul className="plain-list bb-scores">
                    {item.scores.map((s) => (
                      <li key={`${s.service}|${s.testSet}`}>
                        <div className="bb-score-row">
                          <span>
                            {serviceName(known, s.service)} · {s.testSet}
                          </span>
                          <span className="bb-score">
                            {t('blocks.scoreOf100', { score: s.score })}
                          </span>
                        </div>
                        <div className="bb-bar" aria-hidden="true">
                          <div style={{ width: `${s.score}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <ul className="plain-list">
                    {[...new Set(item.scores.map((s) => s.service))].map((service, _, all) => (
                      <li key={service}>
                        <Link href={`#/services/${encodeURIComponent(service)}/quality`}>
                          {all.length > 1
                            ? t('blocks.seeTestSetsFor', { service: serviceName(known, service) })
                            : t('blocks.seeTestSets')}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="bb-meta">{t('blocks.noTestSets', { tenant: tenantName })}</p>
              )}
            </section>
          </aside>
        </div>
      ) : null}
    </div>
  );
};
