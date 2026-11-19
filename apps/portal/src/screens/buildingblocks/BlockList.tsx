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
import type { SkillSummary } from '../../api/skills';
import type { CatalogItem, CatalogProposal, ConnectorView } from '../../api/building-blocks';
import { BackLink } from '../../components/BackLink';
import { DataLocationTag } from '../../components/DataLocationTag';
import { publisherName } from '../../data/skills';
import { useAsync } from '../../hooks';
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
import { ProposalSection } from './ProposalSection';
import { skillHref } from '../skills/SkillBlockPage';
import { SkillCreateActions } from '../skills/SkillCreateActions';
import {
  itemHref,
  typeHref,
  typeNames,
  typeOf,
  typePurposes,
  type Show,
  type TypeKey,
} from './block-types';

export interface TypeFilters {
  show: Show;
  q: string;
}

export const initialFilters: TypeFilters = { show: 'in-use', q: '' };

export const openProposals = (proposals: CatalogProposal[]) =>
  proposals.filter((p) => p.state === 'pending' || p.state === 'sent_for_approval');

export const proposalType = (proposal: CatalogProposal): TypeKey | string =>
  proposal.level === 2 || !proposal.item ? 'tool' : typeOf(proposal.item);

export const TypeHeader = ({ type }: { type: TypeKey }) => {
  const t = useT();
  const rights = useBlockRights();
  return (
    <>
      <BackLink label={t('blocks.title')} href="#/building-blocks" />
      <div className="bb-intro">
        <Heading level={1} data-size="lg">
          {t(typeNames[type])}
        </Heading>
        <p className="lead">{t(typePurposes[type])}</p>
      </div>
      {rights.readOnly ? <ReadOnlyAlert /> : null}
    </>
  );
};

export const useItemHref = (api: ApiClient, tenant: string) => {
  const [skillList] = useAsync(
    (signal) => api.skills.list(tenant, signal).catch(() => [] as SkillSummary[]),
    [api, tenant],
  );
  const skills = skillList.status === 'ready' ? skillList.data : [];
  const ownerOf = (b: CatalogItem) =>
    skills.find((s) => s.id === b.id && s.owner !== tenant && b.publisher.type !== 'own')?.owner;
  return {
    skills,
    ownerOf,
    hrefOf: (b: CatalogItem) =>
      b.kind === 'skill' ? skillHref(b.id, 'setup', ownerOf(b)) : itemHref(b),
  };
};

const OtherSkills = ({
  skills,
  tenant,
  tenantName,
}: {
  skills: SkillSummary[];
  tenant: string;
  tenantName: string;
}) => {
  const t = useT();
  return (
    <section aria-labelledby="bb-group-other-skills" className="stack-sm">
      <Heading level={2} data-size="xs" id="bb-group-other-skills">
        {t('blockPages.otherSkills', { count: skills.length })}
      </Heading>
      <ul className="bb-rows">
        {skills.map((s) => {
          const own = s.owner === tenant;
          return (
            <li key={`${s.owner}/${s.id}`} className="bb-row">
              <div className="bb-row-main">
                <div className="bb-row-head">
                  <a
                    className="bb-card-name"
                    href={skillHref(s.id, 'setup', own ? undefined : s.owner)}
                  >
                    {s.name}
                  </a>
                  {s.status === 'draft' ? (
                    <Tag data-size="sm" data-color="neutral">
                      {t('blockPages.draftTag')}
                    </Tag>
                  ) : null}
                </div>
                <span className="bb-card-desc">{s.description}</span>
                {own ? null : (
                  <span className="bb-meta">
                    {t('blockPages.fromPublisher', {
                      publisher: publisherName(s.publisher, tenantName),
                    })}
                  </span>
                )}
              </div>
              <div className="bb-row-side">
                <span className="bb-meta">
                  {s.usedBy.length
                    ? t('blocks.usedInHeading', { count: s.usedBy.length })
                    : t('blockPages.notUsed')}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export const ListRow = ({
  item,
  href,
  catalogue,
  canAdopt,
  onAdopt,
}: {
  item: CatalogItem;
  href: string;
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
          <a className="bb-card-name" href={href}>
            {item.name}
          </a>
          {item.required ? (
            <Tag data-size="sm" data-color="info">
              {t('blockTypes.required')}
            </Tag>
          ) : null}
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

export const TypeList = ({
  api,
  tenant,
  tenantName,
  type,
  items,
  proposals,
  connectors = [],
  partialError,
  filters,
  onFilters,
  onFlash,
  onAdopted,
  refreshing = false,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  type: TypeKey;
  refreshing?: boolean;
  items: CatalogItem[];
  proposals: CatalogProposal[];
  connectors?: ConnectorView[];
  partialError?: { error: unknown; retry: () => void } | undefined;
  filters: TypeFilters;
  onFilters: (filters: TypeFilters) => void;
  onFlash: (flash: Flash) => void;
  onAdopted?: (flash: Flash, link: boolean) => void;
}) => {
  const t = useT();
  const ids = { search: useId(), empty: useId() };
  const rights = useBlockRights();
  const [adopting, setAdopting] = useState<CatalogItem | null>(null);
  const set = (patch: Partial<TypeFilters>) => onFilters({ ...filters, ...patch });
  const catalogue = filters.show === 'catalogue';
  const q = filters.q.trim().toLowerCase();
  const ofType = items.filter((b) => typeOf(b) === type);
  const inUse = ofType.filter((b) => b.status === 'in_use');
  const inCatalogue = ofType.filter((b) => b.status !== 'in_use');
  const pool = catalogue ? inCatalogue : inUse;
  const shown = pool.filter((b) => !q || `${b.name} ${b.description}`.toLowerCase().includes(q));
  const { skills, ownerOf, hrefOf } = useItemHref(api, tenant);
  const inUseSkills = new Set(inUse.map((b) => `${ownerOf(b) ?? tenant}/${b.id}`));
  const catalogueSkills = new Set(
    inCatalogue.filter((b) => b.publisher.type !== 'own').map((b) => b.id),
  );
  const otherSkills =
    type !== 'skill' || catalogue
      ? []
      : skills.filter(
          (s) =>
            !inUseSkills.has(`${s.owner}/${s.id}`) &&
            !(s.owner !== tenant && catalogueSkills.has(s.id)) &&
            (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)),
        );
  const open = openProposals(proposals).filter((p) => proposalType(p) === type);
  const pending = open.filter((p) => p.level !== 2);
  const pendingConnectors = open.length - pending.length;
  const searchLabel = t('blockTypes.searchType', { type: t(typeNames[type]).toLowerCase() });

  let body: ReactNode;
  if (pool.length === 0) {
    body = (
      <section aria-labelledby={ids.empty} className="bb-empty stack-sm">
        <Heading level={2} data-size="sm" id={ids.empty}>
          {catalogue ? t('blockTypes.emptyCatalogueTitle') : t('blockTypes.emptyInUseTitle')}
        </Heading>
        <Paragraph>
          {catalogue ? t('blockPages.emptyCatalogueBody') : t('blockTypes.emptyInUseBody')}
        </Paragraph>
        {catalogue ? (
          rights.canRegister ? (
            <a href="#/building-blocks/new">{t('blockPages.register')}</a>
          ) : null
        ) : inCatalogue.length ? (
          <a href={typeHref(type, 'catalogue')}>{t('blockPages.seeCatalogue')}</a>
        ) : null}
        {type === 'skill' && !catalogue ? <SkillCreateActions api={api} tenant={tenant} /> : null}
      </section>
    );
  } else {
    body = (
      <>
        <p aria-live="polite" className="bb-count">
          {catalogue
            ? t('blockPages.countCatalogue', { shown: shown.length, total: pool.length })
            : t('blockPages.countInUse', { shown: shown.length, total: pool.length })}
        </p>
        {shown.length === 0 ? (
          <div className="stack-sm bb-no-hits">
            <Heading level={2} data-size="xs">
              {catalogue ? t('blockPages.noMatchCatalogue') : t('blockPages.noMatchInUse')}
            </Heading>
            <Paragraph>
              {catalogue ? t('blockPages.noMatchCatalogueBody') : t('blockPages.noMatchInUseBody')}
            </Paragraph>
            <Button variant="secondary" data-size="sm" onClick={() => set({ q: '' })}>
              {t('blockTypes.resetSearch')}
            </Button>
          </div>
        ) : (
          <ul className="bb-rows">
            {shown.map((b) => (
              <ListRow
                key={`${b.kind}:${b.id}`}
                item={b}
                href={hrefOf(b)}
                catalogue={catalogue}
                canAdopt={rights.canChange(b.kind)}
                onAdopt={setAdopting}
              />
            ))}
          </ul>
        )}
        {type === 'skill' && !catalogue ? <SkillCreateActions api={api} tenant={tenant} /> : null}
      </>
    );
  }

  return (
    <div className="stack">
      <TypeHeader type={type} />
      <div className="stack refreshing" aria-busy={refreshing || undefined}>
        {partialError ? (
          <ErrorState error={partialError.error} onRetry={partialError.retry} />
        ) : null}
        {pending.map((p) => (
          <ProposalSection key={p.id} api={api} tenant={tenant} proposal={p} onDone={onFlash} />
        ))}
        {type === 'tool' ? (
          <ConnectorsSummary pending={pendingConnectors} connectors={connectors} />
        ) : null}
        <div className="bb-filters">
          <form role="search" className="bb-search" onSubmit={(e) => e.preventDefault()}>
            <Field>
              <Label htmlFor={ids.search}>{searchLabel}</Label>
              <Input
                id={ids.search}
                type="search"
                placeholder={t('blockPages.searchPlaceholder')}
                value={filters.q}
                onChange={(e) => set({ q: e.target.value })}
              />
            </Field>
          </form>
          <div role="group" aria-label={t('blockTypes.showLabel')} className="tag-row bb-chips">
            <Chip.Button aria-pressed={!catalogue} onClick={() => set({ show: 'in-use' })}>
              {t('blockTypes.showInUse', { count: inUse.length })}
            </Chip.Button>
            <Chip.Button aria-pressed={catalogue} onClick={() => set({ show: 'catalogue' })}>
              {t('blockTypes.showCatalogue', { count: inCatalogue.length })}
            </Chip.Button>
          </div>
        </div>
        {body}
        {otherSkills.length ? (
          <OtherSkills skills={otherSkills} tenant={tenant} tenantName={tenantName} />
        ) : null}
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
