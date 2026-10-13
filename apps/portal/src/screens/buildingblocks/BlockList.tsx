import {
  Button,
  Chip,
  Field,
  Fieldset,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@digdir/designsystemet-react';
import { useId, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import {
  blockPath,
  type BlockKind,
  type CatalogItem,
  type CatalogProposal,
  type ConnectorView,
} from '../../api/building-blocks';
import { Icon, icons } from '../../components/Icon';
import { navigate } from '../../hooks';
import { useT } from '../../i18n';
import {
  blockKinds,
  emptyStateSuggestions,
  kindLabel,
  publisherOptions,
} from '../../data/building-blocks';
import { BlockCard } from './BlockCard';
import { ApiCallButton, ReadOnlyAlert, useBlockRights, type Flash } from './common';
import { rightLabel } from '../../Shell';
import { ProposalSection } from './ProposalSection';
import { ConnectorsSummary } from './Connectors';

export type ListTab = 'in-use' | 'catalog';
export type PublisherFilter = (typeof publisherOptions)[number]['value'];

export interface ListFilters {
  tab: ListTab;
  q: string;
  publisher: PublisherFilter;
  kind: BlockKind | 'all';
}

export const initialFilters: ListFilters = { tab: 'in-use', q: '', publisher: 'all', kind: 'all' };

export const BlockList = ({
  api,
  tenant,
  tenantName,
  items,
  proposals,
  connectors = [],
  filters,
  onFilters,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  items: CatalogItem[];
  proposals: CatalogProposal[];
  connectors?: ConnectorView[];
  filters: ListFilters;
  onFilters: (filters: ListFilters) => void;
  onFlash: (flash: Flash) => void;
}) => {
  const t = useT();
  const ids = { search: useId(), publisher: useId(), empty: useId() };
  const rights = useBlockRights();
  const set = (patch: Partial<ListFilters>) => onFilters({ ...filters, ...patch });
  const q = filters.q.trim().toLowerCase();
  const inUse = items.filter((b) => b.status === 'in_use');
  const pre = items.filter(
    (b) =>
      (filters.tab === 'catalog' || b.status === 'in_use') &&
      (filters.publisher === 'all' || b.publisher.type === filters.publisher) &&
      (!q || `${b.name} ${b.description}`.toLowerCase().includes(q)),
  );
  const shown = pre.filter((b) => filters.kind === 'all' || b.kind === filters.kind);
  const groups = blockKinds
    .map((k) => ({ ...k, items: shown.filter((b) => b.kind === k.kind) }))
    .filter((g) => g.items.length > 0);
  const isEmpty =
    filters.tab === 'in-use' && inUse.length === 0 && !q && filters.publisher === 'all';
  const suggestions = emptyStateSuggestions
    .map((id) => items.find((b) => b.id === id))
    .filter((b): b is CatalogItem => !!b);
  const open = proposals.filter((p) => p.state === 'pending' || p.state === 'sent_for_approval');
  const pending = open.filter((p) => p.level !== 2);
  const pendingConnectors = open.length - pending.length;

  const listCall = () => {
    const query = new URLSearchParams();
    if (filters.kind !== 'all') query.set('kind', filters.kind);
    if (filters.tab === 'in-use') query.set('status', 'in_use');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return {
      action: filters.tab === 'in-use' ? t('blocks.tabInUse') : t('blocks.tabCatalogName'),
      method: 'GET' as const,
      path: api.buildingBlocks.path(tenant, suffix),
      right: rightLabel(t, 'use-services'),
    };
  };

  const content: ReactNode = (
    <div className="stack">
      {pending.map((p) => (
        <ProposalSection key={p.id} api={api} tenant={tenant} proposal={p} onDone={onFlash} />
      ))}
      <ConnectorsSummary pending={pendingConnectors} connectors={connectors} />
      <div className="stack-sm">
        <div className="bb-filters">
          <Field className="bb-search">
            <Label htmlFor={ids.search}>{t('blocks.searchByName')}</Label>
            <Input
              id={ids.search}
              type="search"
              value={filters.q}
              onChange={(e) => set({ q: e.target.value })}
            />
          </Field>
          <Field className="bb-publisher">
            <Label htmlFor={ids.publisher}>{t('blocks.publisher')}</Label>
            <Select
              id={ids.publisher}
              value={filters.publisher}
              onChange={(e) => set({ publisher: e.target.value as PublisherFilter })}
            >
              {publisherOptions.map((o) => (
                <Select.Option key={o.value} value={o.value}>
                  {t(o.label)}
                </Select.Option>
              ))}
            </Select>
          </Field>
        </div>
        <Fieldset>
          <Fieldset.Legend>{t('blocks.type')}</Fieldset.Legend>
          <div className="tag-row">
            {[
              { kind: 'all' as const, label: t('blocks.all'), n: pre.length },
              ...blockKinds.map((k) => ({
                kind: k.kind,
                label: t(k.label),
                n: pre.filter((b) => b.kind === k.kind).length,
              })),
            ].map((o) => (
              <Chip.Radio
                key={o.kind}
                name="bb-kind"
                checked={filters.kind === o.kind}
                onChange={() => set({ kind: o.kind })}
              >
                {o.label} {o.n}
              </Chip.Radio>
            ))}
          </div>
        </Fieldset>
        <p role="status" className="bb-count">
          {filters.tab === 'in-use'
            ? t('blocks.showingInUse', { count: shown.length, tenant: tenantName })
            : t('blocks.showingCatalog', { count: shown.length })}
        </p>
      </div>

      {isEmpty ? (
        <section aria-labelledby={ids.empty} className="bb-empty">
          <div className="stack-sm">
            <Heading level={2} data-size="sm" id={ids.empty}>
              {t('blocks.emptyTitle')}
            </Heading>
            <Paragraph>{t('blocks.emptyBody')}</Paragraph>
          </div>
          <ul className="bb-suggestions">
            {suggestions.map((b) => (
              <li key={b.id}>
                <span className="bb-suggestion-kind">{kindLabel(t, b.kind)}</span>
                <span className="bb-suggestion-name">{b.name}</span>
                <span className="bb-suggestion-desc">{b.description}</span>
                <Button
                  variant="secondary"
                  data-size="sm"
                  aria-label={t('blocks.viewAndAdoptNamed', { name: b.name })}
                  onClick={() => navigate(`/building-blocks${blockPath(b)}`)}
                >
                  {t('blocks.viewAndAdopt')}
                </Button>
              </li>
            ))}
          </ul>
          <Button variant="primary" onClick={() => set({ tab: 'catalog' })}>
            {t('blocks.viewCatalog')}
          </Button>
        </section>
      ) : null}

      {groups.map((g) => (
        <section key={g.kind} aria-labelledby={`bb-group-${g.kind}`} className="stack-sm">
          <div className="bb-group-head">
            <Heading level={2} data-size="xs" id={`bb-group-${g.kind}`}>
              {t(g.label)}
            </Heading>
            <span className="bb-meta">{t(g.description)}</span>
            {g.kind === 'skill' ? <a href="#/skills">{t('blocks.goToSkills')}</a> : null}
          </div>
          <ul className="bb-grid">
            {g.items.map((b) => (
              <BlockCard key={`${b.kind}:${b.id}`} item={b} />
            ))}
          </ul>
        </section>
      ))}

      {!isEmpty && groups.length === 0 ? (
        <div className="stack-sm bb-no-hits">
          <Paragraph>{t('blocks.noHits')}</Paragraph>
          <Button
            variant="secondary"
            data-size="sm"
            onClick={() => set({ q: '', publisher: 'all', kind: 'all' })}
          >
            {t('blocks.resetFilters')}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="stack">
      <div className="bb-page-head">
        <div className="bb-intro">
          <Heading level={1} data-size="lg">
            {t('blocks.title')}
          </Heading>
          <p className="lead">{t('blocks.lead', { tenant: tenantName })}</p>
        </div>
        <div className="actions">
          <ApiCallButton call={listCall} />
          {rights.canRegister ? (
            <Button variant="secondary" onClick={() => navigate('/building-blocks/new')}>
              <Icon d={icons.plus} />
              {t('blocks.addOwn')}
            </Button>
          ) : null}
        </div>
      </div>

      {rights.readOnly ? <ReadOnlyAlert /> : null}

      <Tabs value={filters.tab} onChange={(v) => set({ tab: v as ListTab })}>
        <TabsList aria-label={t('blocks.title')}>
          <TabsTab value="in-use">{t('blocks.tabInUseCount', { count: inUse.length })}</TabsTab>
          <TabsTab value="catalog">{t('blocks.tabCatalogCount', { count: items.length })}</TabsTab>
        </TabsList>
        <TabsPanel value="in-use">{filters.tab === 'in-use' ? content : null}</TabsPanel>
        <TabsPanel value="catalog">{filters.tab === 'catalog' ? content : null}</TabsPanel>
      </Tabs>
    </div>
  );
};
