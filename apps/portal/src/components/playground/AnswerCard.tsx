import { Button, Chip, Details, Heading, Link, Tag } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import type { PlaygroundResult, PlaygroundSource } from '../../api/playground';
import {
  fieldEntries,
  formatCount,
  formatKr,
  formatSecondsShort,
  locationShort,
  searchNoteText,
  sourceExcerpt,
  sourceFacts,
  sourceLocation,
  sourceTitle,
  sourceUrl,
} from '../../data/playground';
import { useT, type T } from '../../i18n';
import { AnswerMarkdown, type CiteRenderer } from '../AnswerMarkdown';
import { Icon, icons } from '../Icon';
import { ResultTableView, tableFrom } from '../ResultTable';

const citedOrder = (result: PlaygroundResult) => {
  const ids = [...(result.citations ?? [])]
    .sort((x, y) => x.index - y.index)
    .map((c) => c.chunkId)
    .filter((id) => result.sources.some((s) => s.chunkId === id));
  const unique = [...new Set(ids)];
  return unique.length ? unique : result.sources.map((s) => s.chunkId);
};

const documentKey = (source: PlaygroundSource) =>
  source.document ?? sourceUrl(source) ?? sourceTitle(source);

export interface SourceGroup {
  key: string;
  first: PlaygroundSource;
  chunks: PlaygroundSource[];
  numbers: number[];
}

export const groupSources = (result: PlaygroundResult): SourceGroup[] => {
  const groups = new Map<string, SourceGroup>();
  for (const source of result.sources) {
    const key = documentKey(source);
    const group = groups.get(key) ?? { key, first: source, chunks: [], numbers: [] };
    group.chunks.push(source);
    for (const c of result.citations ?? [])
      if (c.chunkId === source.chunkId && !group.numbers.includes(c.index))
        group.numbers.push(c.index);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ ...g, numbers: g.numbers.sort((x, y) => x - y) }));
};

const citeRenderer =
  (result: PlaygroundResult, onOpen: (chunkId: string) => void, t: T): CiteRenderer =>
  (n, key) => {
    const chunkId = (result.citations ?? []).find((c) => c.index === n)?.chunkId;
    const source = chunkId ? result.sources.find((s) => s.chunkId === chunkId) : undefined;
    if (!chunkId || !source) return undefined;
    return (
      <button
        key={key}
        type="button"
        className="playground-cite"
        aria-label={t('playground.sourceCite', { n, title: sourceTitle(source) })}
        onClick={() => onOpen(chunkId)}
      >
        [{n}]
      </button>
    );
  };

const SourceDetail = ({
  source,
  order,
  onOpen,
  onClose,
}: {
  source: PlaygroundSource;
  order: string[];
  onOpen: (chunkId: string) => void;
  onClose: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const headingId = useId();
  const at = order.indexOf(source.chunkId);
  const previous = at > 0 ? order[at - 1] : undefined;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : undefined;
  const rows: [string, string][] = [
    [t('playground.detailChunk'), source.chunkId],
    ...(source.headers?.length
      ? [[t('playground.detailHeaders'), source.headers.join(' › ')] as [string, string]]
      : []),
    ...(source.document
      ? [[t('playground.detailDocument'), source.document] as [string, string]]
      : []),
    ...(source.position === undefined
      ? []
      : [
          [t('playground.detailPosition'), t('playground.detailPart', { n: source.position })] as [
            string,
            string,
          ],
        ]),
    ...(source.score === undefined
      ? []
      : [[t('playground.detailRelevance'), f.decimal(source.score, 2)] as [string, string]]),
  ];
  return (
    <section className="playground-source-detail" aria-labelledby={headingId}>
      <Heading level={4} data-size="2xs" id={headingId}>
        {at >= 0
          ? t('playground.sourceOf', { n: at + 1, total: order.length, title: sourceTitle(source) })
          : sourceTitle(source)}
      </Heading>
      <dl className="playground-fields">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {source.text ? <div className="playground-source-text">{source.text}</div> : null}
      <div className="playground-answer-actions">
        <Button
          variant="tertiary"
          data-size="sm"
          aria-disabled={previous ? undefined : true}
          onClick={() => previous && onOpen(previous)}
        >
          {t('playground.previousSource')}
        </Button>
        <Button
          variant="tertiary"
          data-size="sm"
          aria-disabled={next ? undefined : true}
          onClick={() => next && onOpen(next)}
        >
          {t('playground.nextSource')}
        </Button>
        <Button variant="tertiary" data-size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </section>
  );
};

export const AnswerCard = ({
  label,
  result,
  saveExpanded,
  onSave,
  onShowCall,
  onReply,
}: {
  label?: string;
  result: PlaygroundResult;
  saveExpanded: boolean;
  onSave: () => void;
  onShowCall: () => void;
  onReply?: (text: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [openSource, setOpenSource] = useState<string | null>(null);
  const table = result.table === undefined ? undefined : tableFrom(result.table);
  const meta: [string, string][] = [
    [t('playground.metaTime'), formatSecondsShort(result.timeMs, f, t)],
    [
      t('playground.metaTokens'),
      t('playground.tokensInOut', {
        input: formatCount(result.tokensIn, f),
        output: formatCount(result.tokensOut, f),
      }),
    ],
    [t('playground.metaCost'), formatKr(result.costNok, f, t)],
    [
      t('playground.metaData'),
      result.dataLocation ? t(locationShort[result.dataLocation]) : t('common.unknown'),
    ],
  ];
  const byModel = result.byModel ?? [];
  const order = citedOrder(result);
  const sourceGroups = groupSources(result);
  const detail = openSource ? result.sources.find((s) => s.chunkId === openSource) : undefined;
  const clarification = result.clarification;
  return (
    <article className="playground-answer">
      {label ? <span className="playground-strong">{label}</span> : null}
      {table ? (
        <>
          <Tag data-size="sm" data-color="neutral" className="playground-ai-tag">
            {t('playground.aiAnswer')}
          </Tag>
          <ResultTableView table={table} csv={result.csv} />
        </>
      ) : result.fields ? (
        <dl className="playground-fields">
          {fieldEntries(result.fields).map((f) => (
            <div key={f.name}>
              <dt>{f.name}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : clarification ? (
        <div className="playground-clarification">
          <Tag data-size="sm" data-color="info" className="playground-ai-tag">
            {t('playground.needsClarification')}
          </Tag>
          <div className="playground-text">{clarification.question}</div>
          {clarification.options.length && onReply ? (
            <div
              className="playground-chips"
              role="group"
              aria-label={t('playground.chooseAnswer')}
            >
              {clarification.options.map((o) => (
                <Chip.Button key={o} data-size="sm" onClick={() => onReply(o)}>
                  {o}
                </Chip.Button>
              ))}
            </div>
          ) : null}
          {onReply ? (
            <span className="playground-subtle">
              {t(
                clarification.options.length ? 'playground.clarifyPick' : 'playground.clarifyType',
              )}
            </span>
          ) : null}
        </div>
      ) : result.noAnswer || !result.text?.trim() ? (
        <p className="playground-text">
          <strong>{t('playground.noAnswerInSources')}</strong>
        </p>
      ) : (
        <>
          <Tag data-size="sm" data-color="neutral" className="playground-ai-tag">
            {t('playground.aiAnswer')}
          </Tag>
          <AnswerMarkdown text={result.text} cite={citeRenderer(result, setOpenSource, t)} />
        </>
      )}
      {result.sources.length ? (
        <div className="playground-sources">
          <span className="playground-strong">{t('playground.sources')}</span>
          <ol>
            {sourceGroups.map((group) => {
              const s = group.first;
              const location = [sourceLocation(s), sourceFacts(s, f, t)]
                .filter(Boolean)
                .join(' · ');
              const url = sourceUrl(s);
              const excerpts = group.chunks.flatMap((chunk) => {
                const text = sourceExcerpt(chunk);
                return text ? [{ chunkId: chunk.chunkId, text }] : [];
              });
              return (
                <li key={group.key} {...(group.numbers[0] ? { value: group.numbers[0] } : {})}>
                  {url ? <Link href={url}>{sourceTitle(s)}</Link> : sourceTitle(s)}
                  {location ? <span className="playground-subtle"> · {location}</span> : null}
                  {group.numbers.length ? (
                    <span className="playground-subtle">
                      {' '}
                      {group.numbers.map((n) => `[${n}]`).join(' ')}
                    </span>
                  ) : null}
                  <Button
                    variant="tertiary"
                    data-size="sm"
                    icon
                    className="playground-source-open"
                    aria-label={t('playground.sourceDetails', { title: sourceTitle(s) })}
                    aria-expanded={group.chunks.some((c) => c.chunkId === openSource)}
                    onClick={() =>
                      setOpenSource(
                        group.chunks.some((c) => c.chunkId === openSource)
                          ? null
                          : (group.chunks[0]?.chunkId ?? null),
                      )
                    }
                  >
                    <Icon d={icons.info} size={16} />
                  </Button>
                  {excerpts.length ? (
                    <Details data-size="sm">
                      <Details.Summary>{t('playground.excerpt')}</Details.Summary>
                      <Details.Content>
                        {excerpts.map((e) => (
                          <p key={e.chunkId}>{e.text}</p>
                        ))}
                      </Details.Content>
                    </Details>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {detail ? (
            <SourceDetail
              source={detail}
              order={order}
              onOpen={setOpenSource}
              onClose={() => setOpenSource(null)}
            />
          ) : null}
        </div>
      ) : null}
      {result.searchNotes.length ? (
        <p className="playground-note">
          <strong>{t('playground.searchNote')}</strong>{' '}
          {searchNoteText(result.searchNotes.length, t)}
        </p>
      ) : null}
      <dl className="playground-meta">
        {meta.map(([l, v]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {byModel.length > 1 ? (
        <ul className="playground-models" aria-label={t('playground.tokensPerModel')}>
          {byModel.map((m) => (
            <li key={m.model}>
              <span className="playground-strong">{m.model}</span>
              {` · ${t('playground.tokensInOut', {
                input: formatCount(m.inputTokens, f),
                output: formatCount(m.outputTokens, f),
              })} · ${formatKr(m.costNok, f, t)}`}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="playground-answer-actions">
        <Link href={`#/log?oppgave=${encodeURIComponent(result.runId)}`}>
          {t('playground.viewRun')}
        </Link>
        <Button variant="tertiary" data-size="sm" aria-expanded={saveExpanded} onClick={onSave}>
          {t('playground.saveAsTest')}
        </Button>
        <Button variant="tertiary" data-size="sm" onClick={onShowCall}>
          <Icon d={icons.code} size={18} />
          {t('common.apiCall')}
        </Button>
      </div>
    </article>
  );
};
