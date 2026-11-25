import { Skeleton } from '@digdir/designsystemet-react';
import type { ApiClient } from '../../api';
import { asServiceDefinition } from '../../data/service-definition';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { ErrorState } from '../../states';
import type { PublishedDefinition } from '../../types';
import { lineDiff, type DiffOp } from '../quality/diff';
import { changeText } from '../services/setup-change-text';
import { draftChanges } from '../services/setup-diff';
import type { T } from '../../i18n';
import { definitionYaml } from './definition';
import './sections.css';

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

export const LineDiff = ({ rows }: { rows: ReturnType<typeof changedLines>['rows'] }) => {
  const { t } = usePortalFormat();
  if (!rows.some((row) => row.op !== 'gap')) return null;
  return (
    <div tabIndex={0} role="region" aria-label={t('serviceDev.diffLabel')} className="dv-diff">
      {rows.map((row, i) =>
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
  );
};

export const VersionDiff = ({
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
      <LineDiff rows={diff.rows} />
    </>
  );
};
