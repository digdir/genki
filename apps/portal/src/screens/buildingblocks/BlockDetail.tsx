import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Link,
  Paragraph,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { ApiClient } from '../../api';
import {
  blockPath,
  changeOf,
  requestChange,
  type BlockUser,
  type BlockVersion,
  type CatalogItem,
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
import { refusalOf } from '../../states';
import {
  ApiCallButton,
  approverName,
  PermissionList,
  ReadOnlyAlert,
  rightLabelFor,
  serviceName,
  shortDate,
  useBlockRights,
  type Flash,
} from './common';
import { SettingsForm } from './SettingsForm';

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
  onChanged,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  item: CatalogItem;
  services: BlockUser[];
  versions: BlockVersion[];
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
    service: useId(),
  };
  const rights = useBlockRights();
  const canChange = rights.canChange(item.kind);
  const [pending, setPending] = useState<Pending>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addService, setAddService] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState('');
  const status = statusLabels[item.status];
  const approver = approverName(t, item.approver);
  const right = rightLabelFor(t, item.kind);
  const chosen = services.find((s) => s.id === addService) ?? services[0];
  const used = item.usedBy;
  const known = [...item.usedBy, ...services];

  const open = (next: Pending) => {
    setPending(next);
    setAddOpen(false);
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
    {
      label: item.kind === 'dataset' ? t('blocks.factContent') : t('blocks.factVersion'),
      value: item.version,
    },
    ...(item.dataLocation
      ? [{ label: t('blocks.factStorage'), value: t(storageLabels[item.dataLocation]) }]
      : []),
    ...(item.extensionPoint
      ? [{ label: t('blocks.factRuns'), value: extensionPointLabel(item.extensionPoint, t) }]
      : []),
    { label: t('blocks.factChangedBy'), value: right },
    { label: t('blocks.factId'), value: item.id },
  ];

  return (
    <div className="stack">
      <Crumbs
        items={[{ label: t('blocks.title'), href: '#/building-blocks' }, { label: item.name }]}
      />
      <div className="stack-sm">
        <span className="bb-meta">
          {kindLabel(t, item.kind)} · {item.publisher.name}
        </span>
        <div className="bb-title">
          <Heading level={1} data-size="md">
            {item.name}
          </Heading>
          <Tag data-color={status.color}>{t(status.label)}</Tag>
          {item.dataLocation ? <DataLocationTag location={item.dataLocation} /> : null}
        </div>
        <p className="lead bb-desc">{item.description}</p>
      </div>

      {!canChange ? <ReadOnlyAlert right={right} /> : null}

      {item.status === 'not_allowed' && item.policyBlock ? (
        <Alert data-color="danger">
          <Paragraph>{item.policyBlock.text}</Paragraph>
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
                  <th scope="col">
                    <span className="visually-hidden">{t('blocks.colAction')}</span>
                  </th>
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
                        {name}
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
                      <td>
                        {canChange ? (
                          <Link
                            href={`#/services/${encodeURIComponent(r.service)}?byggekloss=${encodeURIComponent(`${item.id}@${item.update?.version ?? ''}`)}`}
                            aria-label={t('blocks.tryInDraftNamed', { name })}
                          >
                            {t('blocks.tryInDraft')}
                          </Link>
                        ) : null}
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
            {item.status === 'in_use' || item.status === 'available' ? (
              <Button
                variant={item.status === 'in_use' ? 'primary' : 'secondary'}
                aria-expanded={addOpen}
                onClick={() => {
                  setAddOpen((o) => !o);
                  setPending(null);
                }}
              >
                {t('blocks.addToService')}
              </Button>
            ) : null}
            <ApiCallButton call={call} />
          </div>

          {addOpen ? (
            <div className="bb-panel">
              {chosen ? (
                <>
                  <Field>
                    <Label htmlFor={ids.service}>{t('blocks.service')}</Label>
                    <Select
                      id={ids.service}
                      value={chosen.id}
                      onChange={(e) => setAddService(e.target.value)}
                    >
                      {services.map((s) => (
                        <Select.Option key={s.id} value={s.id}>
                          {s.name}
                        </Select.Option>
                      ))}
                    </Select>
                  </Field>
                  <Paragraph data-size="sm">
                    {t('blocks.addToDraft', { name: chosen.name })}
                    {item.status !== 'in_use'
                      ? ` ${t('blocks.adoptedAtSameTime', { tenant: tenantName })}`
                      : ''}
                  </Paragraph>
                  <Button asChild variant="primary" className="bb-start">
                    <a
                      href={`#/services/${encodeURIComponent(chosen.id)}?byggekloss=${encodeURIComponent(item.id)}`}
                    >
                      {t('blocks.openDraft')}
                    </a>
                  </Button>
                </>
              ) : (
                <>
                  <Paragraph data-size="sm">
                    {t('blocks.noServices', { tenant: tenantName })}
                  </Paragraph>
                  <Button asChild variant="secondary" className="bb-start">
                    <a href="#/services/new">{t('blocks.createService')}</a>
                  </Button>
                </>
              )}
            </div>
          ) : null}

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

      <div className="bb-columns">
        <div className="bb-main">
          <section aria-labelledby={ids.caps} className="stack-sm">
            <Heading level={2} data-size="xs" id={ids.caps}>
              {t('blocks.capabilities')}
            </Heading>
            <ul className="bb-list">
              {item.capabilities.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>

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
                    <tr key={p.type}>
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

          <SettingsForm
            key={`${item.id}-${JSON.stringify(item.tenantOverrides)}`}
            api={api}
            tenant={tenant}
            tenantName={tenantName}
            item={item}
            canChange={canChange}
            onSaved={onChanged}
          />

          <section aria-labelledby={ids.versions} className="stack-sm">
            <Heading level={2} data-size="xs" id={ids.versions}>
              {t('blocks.versionsAndChanges')}
            </Heading>
            <ol className="bb-versions">
              {versionRows(t, versions).map((v) => (
                <li key={v.key}>
                  <span className="bb-version">{v.label}</span>
                  <span className="bb-version-date">{shortDate(f, v.at)}</span>
                  <span className="bb-version-notes">{v.text}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="bb-aside">
          <section aria-labelledby={ids.facts} className="bb-facts">
            <Heading level={2} data-size="2xs" id={ids.facts}>
              {t('blocks.about')}
            </Heading>
            <dl className="kv bb-kv">
              {facts.map((f) => (
                <div key={f.label} className="bb-kv-row">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section aria-labelledby={ids.used} className="stack-sm">
            <Heading level={2} data-size="2xs" id={ids.used}>
              {used.length ? t('blocks.usedBy', { count: used.length }) : t('blocks.usedByHeading')}
            </Heading>
            {used.length ? (
              <ul className="plain-list bb-used">
                {used.map((s) => (
                  <li key={s.id}>
                    <Link href={`#/services/${encodeURIComponent(s.id)}`}>{s.name}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="bb-meta">{t('blocks.usedByNoneHere', { tenant: tenantName })}</p>
            )}
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
    </div>
  );
};
