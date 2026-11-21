import {
  Alert,
  Button,
  Heading,
  Paragraph,
  Skeleton,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { productionEnvironment } from '../../api/environments';
import { asServiceDefinition, keepSharing } from '../../data/service-definition';
import { reasonProblem } from '../../components/ReasonField';
import { BusyButton } from '../../components/BusyButton';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { useRights } from '../../Shell';
import { ApiError } from '../../api/error';
import { EmptyState, ErrorState, Loading } from '../../states';
import type { PublishedDefinition } from '../../types';
import { lineDiff, type DiffOp } from '../quality/diff';
import { changeText } from '../services/setup-change-text';
import { draftChanges } from '../services/setup-diff';
import type { T } from '../../i18n';
import { clock, placeName, sameDay, shortWhen } from './dev-format';
import { definitionYaml, problemErrors, withoutVersion } from './definition';
import { servicePath } from './sections';
import './sections.css';

interface Props {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  onPublished?: (published: PublishedDefinition) => void;
}

type Selected = number | 'draft';

const context = 2;

export const changedLines = (before: string, after: string) => {
  const lines = lineDiff(before, after);
  const keep = lines.map((_, i) =>
    lines.slice(Math.max(0, i - context), i + context + 1).some(([op]) => op !== 'same'),
  );
  const out: ({ op: DiffOp; text: string; n: number } | { op: 'gap' })[] = [];
  let oldLine = 0;
  let newLine = 0;
  lines.forEach(([op, text], i) => {
    if (op !== 'add') oldLine += 1;
    if (op !== 'remove') newLine += 1;
    if (keep[i]) out.push({ op, text, n: op === 'remove' ? oldLine : newLine });
    else if (out.at(-1)?.op !== 'gap') out.push({ op: 'gap' });
  });
  return {
    rows: out,
    added: lines.filter(([op]) => op === 'add').length,
    removed: lines.filter(([op]) => op === 'remove').length,
  };
};

const sameNames = {
  dataset: (ref: string) => ref,
  model: (id: string) => id,
  tool: (ref: string) => ref,
};

export const changeSummary = (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  t: T,
) => {
  if (!before) return [t('serviceDev.firstSummary')];
  const changes = draftChanges(asServiceDefinition(before), asServiceDefinition(after));
  const texts = [...new Set(changes.map((c) => changeText(t, c, sameNames)))];
  return texts.length ? texts : [t('serviceDev.noSetupChanges')];
};

const VersionDiff = ({
  api,
  tenant,
  serviceId,
  selected,
  previous,
  full,
  latest,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  selected: Selected;
  previous: number | undefined;
  full: boolean;
  latest: PublishedDefinition;
}) => {
  const { t } = usePortalFormat();
  const [state, retry] = useAsync(
    async (signal) => {
      const load = (v: Selected) =>
        v === 'draft'
          ? api.quality.draft(tenant, serviceId, signal).then((d) => d?.definition ?? {})
          : v === latest.version
            ? Promise.resolve(latest.definition)
            : api.getVersion(tenant, 'Service', serviceId, v, signal).then((d) => d.definition);
      const [after, before] = await Promise.all([
        load(selected),
        previous === undefined ? Promise.resolve(undefined) : load(previous),
      ]);
      return {
        after: definitionYaml(after),
        before: before === undefined ? '' : definitionYaml(before),
        summary: changeSummary(before, after, t),
      };
    },
    [api, tenant, serviceId, selected, previous, latest],
  );
  if (state.status === 'loading')
    return (
      <div className="stack-sm" role="status" aria-label={t('serviceDev.loadingDiff')}>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} variant="text" width={`${50 + ((i * 13) % 45)}%`} />
        ))}
      </div>
    );
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (full)
    return (
      <pre tabIndex={0} className="version-yaml" aria-label={t('serviceDev.wholeYaml')}>
        <code>{state.data.after}</code>
      </pre>
    );
  const diff = changedLines(state.data.before, state.data.after);
  return (
    <>
      <ul className="dv-summary">
        {state.data.summary.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {previous !== undefined ? (
        <p className="meta">
          {t('serviceDev.diffCounts', { added: diff.added, removed: diff.removed })}
        </p>
      ) : null}
      {diff.rows.some((row) => row.op !== 'gap') ? (
        <div tabIndex={0} role="region" aria-label={t('serviceDev.diffLabel')} className="dv-diff">
          {diff.rows.map((row, i) =>
            row.op === 'gap' ? (
              <div key={i} className="dv-gap" aria-hidden="true">
                ⋯
              </div>
            ) : (
              <div key={i} className={`dv-line dv-${row.op}`}>
                <span className="dv-n" aria-hidden="true">
                  {row.n}
                </span>
                <span className="dv-sign">
                  {row.op === 'add' ? '+' : row.op === 'remove' ? '-' : ''}
                  <span className="visually-hidden">
                    {row.op === 'add'
                      ? t('quality.opAdd')
                      : row.op === 'remove'
                        ? t('quality.opRemove')
                        : ''}
                  </span>
                </span>
                <span className="dv-text">{row.text}</span>
              </div>
            ),
          )}
        </div>
      ) : null}
    </>
  );
};

export const Versions = ({ api, tenant, serviceId, onPublished }: Props) => {
  const { t, f, actor } = usePortalFormat();
  const [round, setRound] = useState(0);
  const [state, retry, pending] = useAsync(
    async (signal) => {
      const [history, draft, environments] = await Promise.all([
        api.getDefinition(tenant, 'Service', serviceId, signal),
        api.quality.draft(tenant, serviceId, signal).catch(() => undefined),
        api.environments.list(tenant, serviceId, signal).catch(() => undefined),
      ]);
      const changes = draft
        ? draftChanges(
            asServiceDefinition(history.latest.definition),
            asServiceDefinition(draft.definition),
          ).length
        : 0;
      return { history, draft, changes, pointers: environments?.environments ?? [] };
    },
    [api, tenant, serviceId, round],
    { keepPreviousFor: `${tenant}/${serviceId}` },
  );
  const canManage = useRights().has('manage-services');
  const [chosen, setChosen] = useState<Selected>();
  const [full, setFull] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  const head = (
    <div className="stack-xs">
      <Heading level={2} data-size="md">
        {t('service.sectionVersions')}
      </Heading>
      <Paragraph className="meta dv-lead">{t('serviceDev.versionsLead')}</Paragraph>
    </div>
  );

  if (state.status === 'loading')
    return (
      <div className="stack">
        {head}
        <Loading label={t('serviceVersions.loading')} shape="list" onRetry={retry} />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="stack">
        {head}
        {state.error instanceof ApiError && state.error.status === 404 ? (
          <EmptyState title={t('serviceDev.versionsEmptyTitle')}>
            <p className="body-sm">{t('serviceDev.versionsEmptyBody')}</p>
          </EmptyState>
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );
  const { history, draft, changes, pointers } = state.data;
  const staged = pointers.length > 1;
  const runningIn = (version: number) =>
    pointers.filter((e) => e.version === version).map((e) => e.name);
  const followers = pointers.filter((e) => e.followsPublishes).map((e) => e.name);
  const pinned = pointers.filter((e) => !e.followsPublishes).map((e) => e.name);
  const current = history.latest.version;
  const next = current + 1;
  const list = (names: string[]) =>
    names.length > 1
      ? t('serviceDev.and', { first: names.slice(0, -1).join(', '), last: names.at(-1) ?? '' })
      : (names[0] ?? '');
  const when = (iso: string) =>
    sameDay(iso, new Date()) ? t('serviceDev.todayAt', { time: clock(iso, f) }) : shortWhen(iso, f);
  const draftBy = draft?.byName;
  const restoreText = (version: number) =>
    !staged || pinned.length === 0
      ? t('serviceDev.restoreReplaces', { version, next, current })
      : followers.length === 0
        ? t('serviceDev.restorePinned', { version, next })
        : t('serviceDev.restoreStaged', {
            version,
            next,
            current,
            followers: list(followers),
            pinned: list(pinned),
          });
  const versions = [...history.versions].reverse();
  const selected: Selected = chosen ?? current;
  const numbers = versions.map((v) => v.version);
  const previous = selected === 'draft' ? current : numbers.find((n) => n < (selected as number));

  const restore = async (version: number) => {
    const reasonError = reasonProblem(reason);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const old = await api.getVersion(tenant, 'Service', serviceId, version);
      const published = await api.publishDefinition(
        withoutVersion({
          ...keepSharing(
            asServiceDefinition(old.definition),
            asServiceDefinition(history.latest.definition),
          ),
        }),
        old.files ?? {},
        reason.trim(),
      );
      setConfirming(false);
      setReason('');
      setMessage({
        ok: true,
        text: t('serviceVersions.republished', { version, published: published.version }),
      });
      onPublished?.(published);
      setChosen(undefined);
      setRound((r) => r + 1);
    } catch (error) {
      setMessage({
        ok: false,
        text: problemErrors(error, t)
          .map((e) => e.message)
          .join(' '),
      });
    } finally {
      setBusy(false);
    }
  };

  const pick = (next: Selected) => {
    setChosen(next);
    setConfirming(false);
    setFull(false);
  };

  const title =
    selected === 'draft'
      ? t('serviceDev.draftAgainst', { version: current })
      : previous === undefined
        ? t('serviceDev.firstVersion', { version: selected })
        : t('serviceDev.versionAgainst', { version: selected, previous });

  return (
    <div className="stack">
      {head}
      <div aria-live="polite">
        {message ? (
          <Alert data-color={message.ok ? 'success' : 'danger'} data-size="sm">
            {message.text}
          </Alert>
        ) : null}
      </div>
      <div className="dv-versions">
        <ol
          className="plain-list dv-version-list"
          aria-label={t('serviceVersions.listLabel')}
          aria-busy={pending || undefined}
        >
          {draft ? (
            <li>
              <button
                type="button"
                className="dv-version"
                data-draft="true"
                aria-current={selected === 'draft' || undefined}
                onClick={() => pick('draft')}
              >
                <span className="tag-row">
                  <strong>{t('serviceDev.draft')}</strong>{' '}
                  <Tag data-size="sm" data-color="info">
                    {t('serviceDev.notLive')}
                  </Tag>
                </span>{' '}
                <span className="meta">
                  {draftBy
                    ? t('serviceDev.draftMeta', { when: when(draft.at), who: draftBy })
                    : t('serviceDev.draftMetaAt', { when: when(draft.at) })}
                </span>
                <span className="dv-version-reason">
                  {changes
                    ? t('serviceDev.draftChanges', { count: changes, version: current })
                    : t('serviceDev.noDraftChanges', { version: current })}
                </span>
              </button>
            </li>
          ) : null}
          {versions.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                className="dv-version"
                aria-current={selected === v.version || undefined}
                onClick={() => pick(v.version)}
              >
                <span className="tag-row">
                  <strong>{t('serviceVersions.version', { version: v.version })}</strong>{' '}
                  {staged && runningIn(v.version).length ? (
                    <Tag
                      data-size="sm"
                      data-color={
                        runningIn(v.version).includes(productionEnvironment) ? 'success' : 'info'
                      }
                    >
                      {t('serviceDev.inEnvironments', {
                        list: list(runningIn(v.version).map((name) => placeName(t, name))),
                      })}
                    </Tag>
                  ) : null}
                  {!staged && v.version === current ? (
                    <Tag data-size="sm" data-color="success">
                      {t('serviceVersions.inUse')}
                    </Tag>
                  ) : null}
                </span>{' '}
                <span className="meta">
                  {t('serviceDev.versionMeta', {
                    when: shortWhen(v.publishedAt, f),
                    who: actor(v.publishedBy, v.publishedByName),
                  })}
                </span>
                {v.reason ? <span className="dv-version-reason">«{v.reason}»</span> : null}
              </button>
            </li>
          ))}
        </ol>
        <section aria-labelledby="dv-diff-h" className="dv-panel">
          <div className="row-between">
            <Heading level={3} data-size="2xs" id="dv-diff-h">
              {title}
            </Heading>
            <div className="row-wrap">
              <Button
                variant="secondary"
                data-size="sm"
                aria-pressed={full}
                onClick={() => setFull((x) => !x)}
              >
                {t('serviceDev.showYaml')}
              </Button>
              {canManage && selected !== 'draft' && selected !== current && !confirming ? (
                <Button
                  variant="primary"
                  data-size="sm"
                  onClick={() => {
                    setConfirming(true);
                    setReasonErr('');
                  }}
                >
                  {t('serviceVersions.restore')}
                </Button>
              ) : null}
            </div>
          </div>
          {confirming && selected !== 'draft' ? (
            <Alert data-color="info" data-size="sm" role="alertdialog" aria-labelledby="dv-rb">
              <strong id="dv-rb">{t('serviceVersions.publishAgain', { version: selected })}</strong>
              <Paragraph data-size="sm">{restoreText(selected)}</Paragraph>
              <Textfield
                label={t('serviceVersions.reason')}
                value={reason}
                error={reasonErr || undefined}
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonErr('');
                }}
              />
              <div className="row-wrap">
                <BusyButton
                  variant="primary"
                  data-size="sm"
                  busy={busy}
                  busyLabel={t('serviceDev.publishing')}
                  onClick={() => void restore(selected)}
                >
                  {t('serviceDev.publishAs', { version: next })}
                </BusyButton>
                <Button variant="tertiary" data-size="sm" onClick={() => setConfirming(false)}>
                  {t('serviceVersions.cancel')}
                </Button>
              </div>
            </Alert>
          ) : null}
          <VersionDiff
            key={`${selected}-${round}`}
            api={api}
            tenant={tenant}
            serviceId={serviceId}
            selected={selected}
            previous={previous}
            full={full}
            latest={history.latest}
          />
          {selected === 'draft' ? (
            <a href={`#${servicePath(serviceId, 'definition')}`}>{t('serviceDev.editYaml')}</a>
          ) : null}
        </section>
      </div>
    </div>
  );
};
