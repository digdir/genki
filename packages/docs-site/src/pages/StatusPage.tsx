import { Card, Heading, Link, Paragraph, Tag, ToggleGroup } from '@digdir/designsystemet-react';
import { StatusTag, statusLabels, type AnyStatus } from '../components/StatusTag';
import { blocks, models, componentsByBlock } from '@genai/docs-content';
import { href, navigate } from '../router';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';
import { NotFound } from '../components/NotFound';

const order: AnyStatus[] = ['bygd', 'delvis', 'planlagt'];
const explain = {
  bygd: 'docsStatus.builtExplain',
  delvis: 'docsStatus.partialExplain',
  planlagt: 'docsStatus.plannedExplain',
} as const satisfies Record<AnyStatus, string>;

const parts = blocks.flatMap((b) =>
  (componentsByBlock[b.id] ?? []).map((c) => ({ block: b, comp: c })),
);

const count = (f: AnyStatus) =>
  blocks.filter((b) => b.status === f).length +
  parts.filter((p) => p.comp.status === f).length +
  models.filter((m) => m.status === f).length;

/** Samleside for merkelappene: alt på nettstedet som har en gitt status. */
export function StatusPage({ id }: { id?: string }) {
  const t = useT();
  const lang = useContentLang();
  const unknown = id !== undefined && !order.includes(id as AnyStatus);
  useDocumentTitle(unknown ? t('docsStatus.notFoundTitle') : t('docsStatus.title'));
  const active: AnyStatus | 'alle' =
    id && order.includes(id as AnyStatus) ? (id as AnyStatus) : 'alle';
  const sel = (f: AnyStatus) => active === 'alle' || active === f;

  const groups = [
    {
      title: t('docsStatus.groupBlocks'),
      items: blocks
        .filter((b) => sel(b.status))
        .map((b) => ({
          key: b.id,
          name: b.name,
          sub: b.tagline,
          to: href({ page: 'byggeklosser', id: b.id }),
          status: b.status,
        })),
    },
    {
      title: t('docsStatus.groupParts'),
      items: parts
        .filter((p) => sel(p.comp.status))
        .map((p) => ({
          key: `${p.block.id}/${p.comp.id}`,
          name: p.comp.name,
          sub: `${p.block.name}: ${p.comp.tagline}`,
          to: href({ page: 'byggeklosser', id: p.block.id, sub: p.comp.id }),
          status: p.comp.status,
        })),
    },
    {
      title: t('docsStatus.groupModels'),
      items: models
        .filter((m) => sel(m.status))
        .map((m) => ({
          key: m.name,
          name: m.name,
          sub: `${m.provider}, residens ${m.residency}`,
          to: href({ page: 'byggeklosser', id: 'sprakmodeller' }),
          status: m.status,
        })),
    },
  ].filter((g) => g.items.length > 0);

  if (unknown)
    return (
      <NotFound
        title={t('docsStatus.notFoundTitle')}
        message={t('docsStatus.notFound', { id })}
        back={{ href: href({ page: 'status' }), label: t('docsStatus.toAll') }}
      />
    );

  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsStatus.title')}
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          {t('docsStatus.lede')}
        </Paragraph>
        <ToggleGroup
          value={active}
          onChange={(v) => navigate({ page: 'status', id: v === 'alle' ? undefined : v })}
          data-size="sm"
          aria-label={t('docsStatus.choose')}
        >
          <ToggleGroup.Item value="alle">{t('docsStatus.all')}</ToggleGroup.Item>
          {order.map((f) => (
            <ToggleGroup.Item key={f} value={f}>
              {t('docsStatus.option', { label: t(statusLabels[f].key), count: count(f) })}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup>
        <div className="cluster">
          {order.map((s) => (
            <span
              key={s}
              className="cluster"
              style={{ gap: 'var(--ds-size-1)', alignItems: 'center' }}
            >
              <StatusTag status={s} />
              <Paragraph
                data-size="xs"
                style={{
                  margin: 0,
                  color: 'var(--ds-color-neutral-text-subtle)',
                }}
              >
                {t(explain[s])}
              </Paragraph>
            </span>
          ))}
        </div>
      </div>

      {groups.map((g) => (
        <section key={g.title} className="stack">
          <div className="cluster" style={{ alignItems: 'baseline' }}>
            <Heading level={2} data-size="sm" style={{ margin: 0 }}>
              {g.title}
            </Heading>
            <Tag data-size="sm" data-color="neutral">
              {g.items.length}
            </Tag>
          </div>
          <ul className="status-list">
            {g.items.map((it) => (
              <li key={it.key}>
                <Card className="status-card">
                  <Card.Block>
                    <div className="status-row">
                      <div lang={lang}>
                        <Link href={it.to} data-size="md">
                          {it.name}
                        </Link>
                        <Paragraph
                          data-size="xs"
                          style={{
                            margin: 0,
                            color: 'var(--ds-color-neutral-text-subtle)',
                          }}
                        >
                          {it.sub}
                        </Paragraph>
                      </div>
                      <StatusTag status={it.status} />
                    </div>
                  </Card.Block>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
