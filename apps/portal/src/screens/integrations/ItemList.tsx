import { Alert, Button, Tag } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { Icon, icons } from '../../components/Icon';
import { statusColor, statusKey, type ItemStatus } from '../../data/integrations';
import { useT } from '../../i18n';

export interface ItemAction {
  label: string;
  variant: 'primary' | 'secondary' | 'tertiary';
  onClick: () => void;
  busy?: boolean;
}

export interface ItemRowData {
  id: string;
  name: string;
  status: string;
  sub: string;
  metaLabel: string;
  meta: string;
  error?: {
    what: string;
    why: string;
    code: string;
    color: 'danger' | 'info';
    actions: ItemAction[];
  };
  rows: { k: string; v: string; copyLabel?: string; tags?: string[] }[];
  events?: { when: string; text: string; status: string; href?: string; link?: string }[];
  actions: ItemAction[];
}

const CopyValue = ({ value, label }: { value: string; label: string }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <Button
        variant="tertiary"
        data-size="sm"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
        }}
      >
        {t('common.copy')}
      </Button>
      <span role="status" className="meta">
        {copied ? t('common.copied') : ''}
      </span>
    </>
  );
};

const ActionButton = ({ a }: { a: ItemAction }) => (
  <Button
    variant={a.variant}
    data-size="sm"
    aria-disabled={a.busy || undefined}
    onClick={() => !a.busy && a.onClick()}
  >
    {a.label}
  </Button>
);

export const ItemList = ({
  items,
  open,
  onToggle,
  empty,
}: {
  items: ItemRowData[];
  open: string | undefined;
  onToggle: (id: string) => void;
  empty: { title: string; text: string };
}) => {
  const t = useT();
  const statusText = (status: string) =>
    status in statusKey ? t(statusKey[status as ItemStatus]) : status;
  if (items.length === 0)
    return (
      <div className="int-empty">
        <span className="int-empty-title">{empty.title}</span>
        <span className="meta">{empty.text}</span>
      </div>
    );
  return (
    <ul className="int-list">
      {items.map((it) => {
        const isOpen = open === it.id;
        return (
          <li key={it.id} id={`it-${it.id}`} className={isOpen ? 'open' : undefined}>
            <button
              type="button"
              className="int-row"
              aria-expanded={isOpen}
              onClick={() => onToggle(it.id)}
            >
              <span className="int-row-main">
                <span className="row-wrap">
                  <span className="int-row-name">{it.name}</span>
                  <Tag data-size="sm" data-color={statusColor[it.status] ?? 'neutral'}>
                    {statusText(it.status)}
                  </Tag>
                </span>
                <span className="meta int-wrap">{it.sub}</span>
              </span>
              <span className="int-row-meta">
                <span className="meta">{it.metaLabel}</span>
                <span className="int-wrap">{it.meta}</span>
              </span>
              <span className={isOpen ? 'int-chevron open' : 'int-chevron'}>
                <Icon d={icons.chevronDown} size={18} />
              </span>
            </button>
            {isOpen ? (
              <div className="int-detail">
                {it.error ? (
                  <Alert data-color={it.error.color} data-size="sm">
                    <p className="int-err-what">{it.error.what}</p>
                    <p className="int-err-why">{it.error.why}</p>
                    <div className="actions">
                      {it.error.actions.map((a) => (
                        <ActionButton key={a.label} a={a} />
                      ))}
                      <span className="int-code">
                        {t('integrations.technicalCode', { code: it.error.code })}
                      </span>
                    </div>
                  </Alert>
                ) : null}
                <dl className="int-rows">
                  {it.rows.map((r) => (
                    <div key={r.k} className="int-rows-pair">
                      <dt>{r.k}</dt>
                      <dd>
                        {r.v ? <span className="int-wrap">{r.v}</span> : null}
                        {r.copyLabel ? <CopyValue value={r.v} label={r.copyLabel} /> : null}
                        {(r.tags ?? []).map((tag) => (
                          <Tag key={tag} data-size="sm" data-color="neutral">
                            {tag}
                          </Tag>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
                {it.events ? (
                  <div className="stack-sm">
                    <span className="int-events-title">{t('integrations.latestEvents')}</span>
                    <ol className="int-events">
                      {it.events.map((e) => (
                        <li key={`${e.when}-${e.text}`}>
                          <span className="int-event-when">{e.when}</span>
                          <span className="int-event-text">
                            {e.text}
                            {e.href ? (
                              <>
                                {' · '}
                                <a href={e.href}>{e.link ?? e.href}</a>
                              </>
                            ) : null}
                          </span>
                          <Tag data-size="sm" data-color={statusColor[e.status] ?? 'neutral'}>
                            {statusText(e.status)}
                          </Tag>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                <div className="actions">
                  {it.actions.map((a) => (
                    <ActionButton key={a.label} a={a} />
                  ))}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};
