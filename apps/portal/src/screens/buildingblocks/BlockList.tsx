import {
  Button,
  Chip,
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import {
  blockHref,
  type BlockKind,
  type CatalogItem,
  type CatalogProposal,
  type ConnectorView,
} from '../../api/building-blocks';
import { DataLocationTag } from '../../components/DataLocationTag';
import { blockKinds } from '../../data/building-blocks';
import { useT } from '../../i18n';
import { ErrorState } from '../../states';
import { AdoptDialog } from './AdoptDialog';
import {
  approverName,
  judgeRefusalText,
  ReadOnlyAlert,
  useBlockRights,
  type Flash,
} from './common';
import { ConnectorsSummary } from './Connectors';
import { LinkTabs, type LinkTab } from './LinkTabs';
import { ProposalSection } from './ProposalSection';
import { SkillCreateActions } from '../skills/SkillCreateActions';

export type ListTab = 'in-use' | 'catalog';

export interface ListFilters {
  tab: ListTab;
  q: string;
  kind: BlockKind | 'all';
}

export const initialFilters: ListFilters = { tab: 'in-use', q: '', kind: 'all' };

export const listKinds: readonly BlockKind[] = blockKinds.map((k) => k.kind);

export const collapsedFlows = 3;

export const ListHeader = ({ tab, tenantName }: { tab: ListTab; tenantName: string }) => {
  const t = useT();
  const rights = useBlockRights();
  const tabs: LinkTab[] = [
    { key: 'in-use', label: t('blocks.tabInUse'), href: '#/building-blocks/in-use' },
    { key: 'catalog', label: t('blocks.tabCatalogName'), href: '#/building-blocks/catalogue' },
  ];
  return (
    <>
      <div className="bb-page-head">
        <div className="bb-intro">
          <Heading level={1} data-size="lg">
            {t('blocks.title')}
          </Heading>
          <p className="lead">{t('blockPages.lead', { tenant: tenantName })}</p>
        </div>
        {rights.canRegister ? (
          <Button asChild variant="secondary">
            <a href="#/building-blocks/new">{t('blockPages.register')}</a>
          </Button>
        ) : null}
      </div>
      {rights.readOnly ? <ReadOnlyAlert /> : null}
      <LinkTabs label={t('blocks.title')} tabs={tabs} current={tab} />
    </>
  );
};

const ListRow = ({
  item,
  catalogue,
  canAdopt,
  onAdopt,
}: {
  item: CatalogItem;
  catalogue: boolean;
  canAdopt: boolean;
  onAdopt: (item: CatalogItem) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const pending = item.status === 'pending_approval';
  const used = item.usedBy.length;
  return (
    <li className="bb-row">
      <div className="bb-row-main">
        <div className="bb-row-head">
          <a className="bb-card-name" href={blockHref(item)}>
            {item.name}
          </a>
          {item.dataLocation ? <DataLocationTag location={item.dataLocation} /> : null}
          {pending ? (
            <Tag data-size="sm" data-color="warning">
              {t('blockPages.pendingTag')}
            </Tag>
          ) : null}
          {!catalogue && item.update ? (
            <Tag data-size="sm" data-color="info">
              {t('blocks.updateAvailable')}
            </Tag>
          ) : null}
        </div>
        <span className="bb-card-desc">{item.description}</span>
        {catalogue ? (
          <span className="bb-meta">
            {t('blockPages.fromPublisher', { publisher: item.publisher.name })}
          </span>
        ) : null}
        {item.status === 'not_allowed' && item.policyBlock ? (
          <span className="bb-block-text">
            {item.judge?.refused ? judgeRefusalText(t, item.judge.refused) : item.policyBlock.text}
          </span>
        ) : null}
      </div>
      <div className="bb-row-side">
        {catalogue ? (
          pending ? (
            <span className="bb-meta">
              {t('blockPages.sentTo', {
                approver: approverName(t, item.approver),
                date: item.pendingRequest ? f.date(item.pendingRequest.at) : '',
              })}
            </span>
          ) : canAdopt && (item.status === 'available' || item.status === 'requires_approval') ? (
            <Button
              variant="secondary"
              data-size="sm"
              aria-label={t('blockPages.adoptNamed', { name: item.name })}
              onClick={() => onAdopt(item)}
            >
              {t('blockPages.adopt')}
            </Button>
          ) : null
        ) : (
          <span className="bb-meta">
            {used ? t('blocks.usedInHeading', { count: used }) : t('blockPages.notUsed')}
          </span>
        )}
      </div>
    </li>
  );
};

export const BlockList = ({
  api,
  tenant,
  tenantName,
  items,
  proposals,
  connectors = [],
  partialError,
  filters,
  onFilters,
  onFlash,
  onAdopted,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  items: CatalogItem[];
  proposals: CatalogProposal[];
  connectors?: ConnectorView[];
  partialError?: { error: unknown; retry: () => void } | undefined;
  filters: ListFilters;
  onFilters: (filters: ListFilters) => void;
  onFlash: (flash: Flash) => void;
  onAdopted?: (flash: Flash, link: boolean) => void;
}) => {
  const t = useT();
  const ids = { search: useId(), empty: useId() };
  const rights = useBlockRights();
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [adopting, setAdopting] = useState<CatalogItem | null>(null);
  const set = (patch: Partial<ListFilters>) => onFilters({ ...filters, ...patch });
  const catalogue = filters.tab === 'catalog';
  const q = filters.q.trim().toLowerCase();
  const pool = items.filter((b) => (catalogue ? b.status !== 'in_use' : b.status === 'in_use'));
  const matching = pool.filter((b) => !q || `${b.name} ${b.description}`.toLowerCase().includes(q));
  const shown = matching.filter((b) => filters.kind === 'all' || b.kind === filters.kind);
  const groups = blockKinds
    .map((k) => {
      const all = shown.filter((b) => b.kind === k.kind);
      const collapse =
        k.kind === 'step_flow' && !q && filters.kind === 'all' && all.length > collapsedFlows;
      return {
        ...k,
        all,
        collapse,
        items: collapse && !flowsOpen ? all.slice(0, collapsedFlows) : all,
      };
    })
    .filter((g) => g.all.length > 0);
  const kindsPresent = blockKinds.filter((k) => pool.some((b) => b.kind === k.kind));
  const open = proposals.filter((p) => p.state === 'pending' || p.state === 'sent_for_approval');
  const pending = open.filter((p) => p.level !== 2);
  const pendingConnectors = open.length - pending.length;

  let body: ReactNode;
  if (pool.length === 0) {
    body = (
      <section aria-labelledby={ids.empty} className="bb-empty stack-sm">
        <Heading level={2} data-size="sm" id={ids.empty}>
          {catalogue ? t('blockPages.emptyCatalogueTitle') : t('blockPages.emptyInUseTitle')}
        </Heading>
        <Paragraph>
          {catalogue ? t('blockPages.emptyCatalogueBody') : t('blockPages.emptyInUseBody')}
        </Paragraph>
        {catalogue ? (
          rights.canRegister ? (
            <a href="#/building-blocks/new">{t('blockPages.register')}</a>
          ) : null
        ) : (
          <a href="#/building-blocks/catalogue">{t('blockPages.seeCatalogue')}</a>
        )}
      </section>
    );
  } else {
    body = (
      <>
        <div className="stack-sm">
          <form role="search" className="bb-filters" onSubmit={(e) => e.preventDefault()}>
            <Field className="bb-search">
              <Label htmlFor={ids.search}>
                {catalogue ? t('blockPages.searchCatalogue') : t('blockPages.searchInUse')}
              </Label>
              <Input
                id={ids.search}
                type="search"
                placeholder={t('blockPages.searchPlaceholder')}
                value={filters.q}
                onChange={(e) => set({ q: e.target.value })}
              />
            </Field>
          </form>
          <div role="group" aria-label={t('blocks.type')} className="tag-row bb-chips">
            {[
              { kind: 'all' as const, label: t('blocks.all'), n: matching.length },
              ...kindsPresent.map((k) => ({
                kind: k.kind,
                label: t(k.label),
                n: matching.filter((b) => b.kind === k.kind).length,
              })),
            ].map((o) => (
              <Chip.Button
                key={o.kind}
                aria-pressed={filters.kind === o.kind}
                onClick={() => set({ kind: o.kind })}
              >
                {o.label} {o.n}
              </Chip.Button>
            ))}
          </div>
          <p aria-live="polite" className="bb-count">
            {catalogue
              ? t('blockPages.countCatalogue', { shown: shown.length, total: pool.length })
              : t('blockPages.countInUse', { shown: shown.length, total: pool.length })}
          </p>
        </div>

        {shown.length === 0 ? (
          <div className="stack-sm bb-no-hits">
            <Heading level={2} data-size="xs">
              {catalogue ? t('blockPages.noMatchCatalogue') : t('blockPages.noMatchInUse')}
            </Heading>
            <Paragraph>
              {catalogue ? t('blockPages.noMatchCatalogueBody') : t('blockPages.noMatchInUseBody')}
            </Paragraph>
            <Button variant="secondary" data-size="sm" onClick={() => set({ q: '', kind: 'all' })}>
              {t('blockPages.resetSearch')}
            </Button>
          </div>
        ) : null}

        {filters.kind === 'skill' && !groups.some((g) => g.kind === 'skill') ? (
          <SkillCreateActions api={api} tenant={tenant} />
        ) : null}

        {groups.map((g) => (
          <section key={g.kind} aria-labelledby={`bb-group-${g.kind}`} className="stack-sm">
            <div className="bb-group-head">
              <Heading level={2} data-size="xs" id={`bb-group-${g.kind}`}>
                {t('blockPages.groupTitle', { kind: t(g.label), count: g.all.length })}
              </Heading>
              {g.kind === 'skill' && !catalogue ? (
                <SkillCreateActions api={api} tenant={tenant} />
              ) : null}
            </div>
            <ul className="bb-rows">
              {g.items.map((b) => (
                <ListRow
                  key={`${b.kind}:${b.id}`}
                  item={b}
                  catalogue={catalogue}
                  canAdopt={rights.canChange(b.kind)}
                  onAdopt={setAdopting}
                />
              ))}
            </ul>
            {g.collapse ? (
              <Button
                variant="tertiary"
                data-size="sm"
                aria-expanded={flowsOpen}
                onClick={() => setFlowsOpen((v) => !v)}
              >
                {flowsOpen
                  ? t('blockPages.fewerFlows')
                  : t('blockPages.allFlows', { count: g.all.length })}
              </Button>
            ) : null}
          </section>
        ))}
      </>
    );
  }

  return (
    <div className="stack">
      <ListHeader tab={filters.tab} tenantName={tenantName} />
      <div className="stack" role="tabpanel">
        {partialError ? (
          <ErrorState error={partialError.error} onRetry={partialError.retry} />
        ) : null}
        {!catalogue
          ? pending.map((p) => (
              <ProposalSection key={p.id} api={api} tenant={tenant} proposal={p} onDone={onFlash} />
            ))
          : null}
        {!catalogue ? (
          <ConnectorsSummary pending={pendingConnectors} connectors={connectors} />
        ) : null}
        {body}
      </div>
      {adopting ? (
        <AdoptDialog
          api={api}
          tenant={tenant}
          tenantName={tenantName}
          item={adopting}
          onClose={() => setAdopting(null)}
          onDone={(flash, adopted) => {
            setAdopting(null);
            (onAdopted ?? ((next) => onFlash(next)))(flash, adopted);
          }}
        />
      ) : null}
    </div>
  );
};
