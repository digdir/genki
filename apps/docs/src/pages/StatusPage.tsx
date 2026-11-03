import { Card, Heading, Link, Paragraph, Tag, ToggleGroup } from '@digdir/designsystemet-react';
import { StatusTag, statusLabels, type AnyStatus } from '../components/StatusTag';
import { blocks, models } from '../data/blocks';
import { componentsByBlock } from '../data/components';
import { href, navigate } from '../router';

const order: AnyStatus[] = ['bygd', 'delvis', 'planlagt'];
const explain: Record<AnyStatus, string> = {
  bygd: 'finnes i Genki i dag',
  delvis: 'finnes delvis',
  planlagt: 'planlagt senere',
};

const parts = blocks.flatMap((b) =>
  (componentsByBlock[b.id] ?? []).map((c) => ({ block: b, comp: c })),
);

const count = (f: AnyStatus) =>
  blocks.filter((b) => b.status === f).length +
  parts.filter((p) => p.comp.status === f).length +
  models.filter((m) => m.status === f).length;

/** Samleside for merkelappene: alt på nettstedet som har en gitt status. */
export function StatusPage({ id }: { id?: string }) {
  const active: AnyStatus | 'alle' =
    id && order.includes(id as AnyStatus) ? (id as AnyStatus) : 'alle';
  const sel = (f: AnyStatus) => active === 'alle' || active === f;

  const groups = [
    {
      title: 'Overordnede byggeklosser',
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
      title: 'Byggeklosser',
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
      title: 'Modeller i katalogen',
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

  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          Merkelapper
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          Hver overordnet byggekloss, byggekloss og modell har en status som sier hvor langt den er
          kommet. Velg en merkelapp for å se alt som har den.
        </Paragraph>
        <ToggleGroup
          value={active}
          onChange={(v) => navigate({ page: 'status', id: v === 'alle' ? undefined : v })}
          data-size="sm"
          aria-label="Velg merkelapp"
        >
          <ToggleGroup.Item value="alle">Alle</ToggleGroup.Item>
          {order.map((f) => (
            <ToggleGroup.Item key={f} value={f}>
              {statusLabels[f].text} ({count(f)})
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
                {explain[s]}
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
                      <div>
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
